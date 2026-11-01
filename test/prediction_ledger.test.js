import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sổ dự đoán riêng cho test (đặt trước khi nạp module)
const dir = mkdtempSync(join(tmpdir(), 'pred-'));
process.env.PREDICTION_LOG_FILE = join(dir, 'log.jsonl');
process.env.PREDICTION_LEGACY_FILE = join(dir, 'legacy.json');
writeFileSync(process.env.PREDICTION_LEGACY_FILE, JSON.stringify({ items: [
  { source: 'rank_all', symbol: 'OLD', date: '2026-10-16', direction: 1, label: 'x', price: 10, at: '2026-10-16T08:30:00.000Z' },
] }));
const { recordPrediction, flushPredictions, predictionLog, canonicalItems, scoreItem, entryCutoff } = await import('../src/predictions.js');

const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const lines = () => readFileSync(process.env.PREDICTION_LOG_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('Sổ chỉ ghi thêm: chuyển bản ghi cũ, bỏ bản trùng, ghi bản đổi ý thành dòng mới kèm version', async () => {
  const p = { source: 'rule', symbol: 'AAA', date: '2026-10-28', direction: 1, label: 'NÊN MUA', price: 20, score: 82, plan: { stop: 19 } };
  await recordPrediction(p);
  await recordPrediction(p); // trùng hệt: bỏ qua
  await recordPrediction({ ...p, direction: 0, label: 'THEO DÕI', score: 68 }); // đổi ý: thêm dòng, không sửa dòng cũ
  await flushPredictions();
  const all = lines();
  assert.equal(all.filter((x) => x.version === 'legacy' && x.symbol === 'OLD').length, 1);
  const mine = all.filter((x) => x.symbol === 'AAA');
  assert.equal(mine.length, 2);
  assert.equal(mine[0].direction, 1);
  assert.equal(mine[0].score, 82);
  assert.deepEqual(mine[0].plan, { stop: 19 });
  assert.ok(mine[0].version && mine[0].version !== 'legacy');
  assert.ok(mine[0].recordedAt <= mine[1].recordedAt);
  assert.equal((await predictionLog()).length, all.length);
});

test('canonicalItems: lấy bản cuối cùng trước 9:00 phiên sau, bản muộn bị loại và đếm', () => {
  const next = (d) => ({ '2026-10-27': '2026-10-28' })[d] ?? null;
  assert.equal(entryCutoff('2026-10-28'), '2026-10-28T02:00:00.000Z');
  const items = [
    { source: 'rule', symbol: 'A', date: '2026-10-27', direction: 1, recordedAt: '2026-10-27T03:00:00.000Z' },
    { source: 'rule', symbol: 'A', date: '2026-10-27', direction: -1, recordedAt: '2026-10-28T01:30:00.000Z' }, // 8:30 sáng hôm sau: hợp lệ
    { source: 'rule', symbol: 'A', date: '2026-10-27', direction: 1, recordedAt: '2026-10-28T03:00:00.000Z' }, // 10:00: muộn
    { source: 'rule', symbol: 'B', date: '2026-10-28', direction: 1, recordedAt: '2026-10-28T09:00:00.000Z' }, // chưa có phiên sau
  ];
  const { items: out, late } = canonicalItems(items, next);
  assert.equal(out.find((x) => x.symbol === 'A').direction, -1);
  assert.equal(out.length, 2);
  assert.equal(late.rule, 1);
});

test('scoreItem: mua giá mở cửa phiên sau, bán đóng cửa phiên thứ h', () => {
  const mk = (f) => Array.from({ length: 30 }, (_, i) => ({ time: day(i), open: f(i) - 0.5, close: f(i) }));
  const stock = mk((i) => 10 + i), index = mk(() => 100);
  const r = scoreItem({ date: day(0), direction: 1 }, stock, index)[5];
  assert.ok(Math.abs(r.ret - (stock[5].close / stock[1].open - 1)) < 1e-12);
  assert.ok(Math.abs(r.excess - (r.ret - (100 / 99.5 - 1))) < 1e-12);
});

test('scoreItem: mã ngừng giao dịch trước khi đủ phiên được tính ở giá cuối trừ haircut, không bị bỏ', () => {
  const index = Array.from({ length: 40 }, (_, i) => ({ time: day(i), open: 100, close: 100 }));
  const stock = Array.from({ length: 8 }, (_, i) => ({ time: day(i), open: 10, close: 10 })); // dừng ở phiên 7
  const r = scoreItem({ date: day(0), direction: 1 }, stock, index);
  assert.equal(r[5].delisted, undefined); // đủ 5 phiên trước khi dừng
  assert.equal(r[10].delisted, true);
  assert.ok(Math.abs(r[10].ret - (10 * 0.7 / 10 - 1)) < 1e-12);
  assert.equal(r[20].delisted, true);
  // Chuỗi chỉ trễ vài phiên (nguồn chậm) thì chưa coi là hủy niêm yết
  const lag = Array.from({ length: 37 }, (_, i) => ({ time: day(i), open: 10, close: 10 }));
  assert.equal(scoreItem({ date: day(33), direction: 1 }, lag, index)[5], undefined); // cần phiên 38, mã mới dừng 3 phiên
});
