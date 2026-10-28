import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pot-'));
process.env.NEWS_EVENTS_FILE = join(dir, 'news.jsonl');
process.env.PREDICTION_LOG_FILE = join(dir, 'log.jsonl');
process.env.PREDICTION_LEGACY_FILE = join(dir, 'none.json');
const { bucketOf, buildExpectancy } = await import('../src/expectancy.js');
const { scorePlan, basketReturns } = await import('../src/predictions.js');
const { pctCalibration, planOutcomes, filterTests, newsImpact } = await import('../src/verify.js');
const { recordNewsEvents, newsEvents, scoreNewsEvent } = await import('../src/newsevents.js');
const { funnelRecords } = await import('../src/screener.js');
const { factorReader } = await import('../src/ranking.js');

const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

test('bucketOf: nhóm điểm cố định + trên/dưới MA200', () => {
  assert.equal(bucketOf(72, true), '70-85|tren');
  assert.equal(bucketOf(100, false), '85-100|duoi');
  assert.equal(bucketOf(0, null), '0-30|tren');
  assert.equal(bucketOf(null, true), null);
});

test('buildExpectancy: mã xu hướng mạnh rơi vào nhóm điểm cao và có lãi hơn rổ dương', () => {
  const N = 320, r = rng(5);
  const cal = Array.from({ length: N }, (_, i) => ({ time: day(i), open: 1000, close: 1000 }));
  const data = {};
  for (let k = 0; k < 30; k++) {
    const drift = (k - 15) * 0.0004; // mã k cao tăng đều hơn
    let c = 20;
    const bars = Array.from({ length: N }, (_, i) => {
      c *= 1 + drift + (r() - 0.5) * 0.02;
      return { time: day(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 };
    });
    data[`S${k}`] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars) };
  }
  const t = buildExpectancy(cal, data, { start: 260, minValue: 0, step: 5 });
  assert.ok(t.samples > 5);
  const hi = Object.entries(t.buckets).filter(([k]) => k.startsWith('85-')).map(([, b]) => b[20]).filter(Boolean);
  const lo = Object.entries(t.buckets).filter(([k]) => k.startsWith('0-30')).map(([, b]) => b[20]).filter(Boolean);
  assert.ok(hi.length && lo.length);
  assert.ok(hi[0].meanExcess > lo[0].meanExcess, 'nhóm điểm cao phải hơn nhóm điểm thấp');
  assert.ok(hi[0].p10 <= hi[0].medianExcess && hi[0].medianExcess <= hi[0].p90);
});

const mk = (rows) => rows.map(([o, h, l, c], i) => ({ time: day(i), open: o, high: h, low: l, close: c, volume: 1 }));
const flat = (n, p = 10) => Array.from({ length: n }, () => [p, p, p, p]);

test('scorePlan: lệnh giới hạn không khớp, chạm mục tiêu, cắt lỗ theo đóng cửa, hết hạn', () => {
  const item = { date: day(0), plan: { buyTo: 9.5, stop: 9, target: 11, horizonDays: 10 } };
  assert.equal(scorePlan(item, mk(flat(12)))?.outcome, 'no_fill'); // giá không về 9,5 trong 5 phiên
  const hit = scorePlan(item, mk([[10, 10, 10, 10], [9.8, 9.9, 9.4, 9.6], [9.7, 11.2, 9.6, 11], ...flat(12, 11)]));
  assert.equal(hit.outcome, 'target');
  assert.equal(hit.entry, 9.5);
  assert.ok(Math.abs(hit.ret - (11 / 9.5 - 1)) < 1e-12);
  const stop = scorePlan(item, mk([[10, 10, 10, 10], [9.5, 9.6, 9.4, 9.5], [9.2, 9.3, 8.8, 8.9], [8.7, 8.8, 8.6, 8.7], ...flat(12, 9)]));
  assert.equal(stop.outcome, 'stop');
  assert.equal(stop.exit, 8.7); // bán giá mở cửa phiên sau phiên đóng cửa dưới 9
  const time = scorePlan({ date: day(0), plan: { stop: 9, target: 12, horizonDays: 3 } }, mk(flat(10, 10)));
  assert.equal(time.outcome, 'time');
  assert.equal(scorePlan({ date: day(0), plan: { stop: 9 } }, mk(flat(10))), null);
});

test('pctCalibration / planOutcomes: đo dự báo % phóng đại và kế hoạch lệnh', () => {
  const scored = Array.from({ length: 10 }, (_, k) => ({
    source: 'ai', symbol: 'A', date: day(k), direction: 1,
    expected: { 5: 0.02 * (k - 5) }, result: { 5: { ret: 0.01 * (k - 5), excessBasket: 0 } }, // thực tế chỉ được một nửa
  }));
  const row = pctCalibration(scored).find((r) => r.source === 'ai' && r.h === 5);
  assert.equal(row.n, 10);
  assert.ok(Math.abs(row.slope - 0.5) < 1e-9);
  const bars = { A: mk([[10, 10, 10, 10], [10, 12, 9.9, 11.5], ...flat(25, 11)]) };
  const plans = planOutcomes([{ source: 'screener', symbol: 'A', date: day(0), direction: 1, plan: { stop: 9, target: 11, horizonDays: 10 } }], bars);
  assert.equal(plans[0].target, 1);
  assert.equal(plans[0].targetRate, 1);
});

test('funnelRecords / filterTests: bộ lọc giúp chọn mã tốt hơn thì chênh dương có ý nghĩa', () => {
  const r = rng(9);
  const scored = [];
  for (let d = 0; d < 30; d++) {
    const scanned = Array.from({ length: 20 }, (_, k) => ({
      symbol: `S${k}`, close: 10, quick: 50, liquidity: { pass: true }, quality: { pass: k < 10 }, sector: { pass: true },
      stockRisk: null, trendPick: false, setups: [0, 1, 10, 11].includes(k) ? [{ id: 'vcp' }] : [], // VCP không liên quan chất lượng
    }));
    for (const rec of funnelRecords(scanned, day(d), () => true)) {
      const good = rec.flags.quality;
      const ex = (good ? 0.01 : -0.01) + (r() - 0.5) * 0.01;
      scored.push({ ...rec, result: { 5: { excessBasket: ex }, 20: { excessBasket: ex } } });
    }
  }
  assert.deepEqual(Object.keys(scored[0].flags).sort(), ['final', 'liquidity', 'quality', 'risk', 'sector', 'setups', 'trend', 'trendPick']);
  const q = filterTests(scored).find((x) => x.key === 'quality' && x.h === 5);
  assert.equal(q.verdict, 'supported');
  assert.ok(q.mean > 0.015);
  const vcp = filterTests(scored).find((x) => x.key === 'setup:vcp' && x.h === 5);
  assert.notEqual(vcp.verdict, 'supported');
  assert.equal(filterTests(scored).find((x) => x.key === 'liquidity').n, 0); // ai cũng đạt: không so được
});

test('Sổ tin tức: ghi một lần mỗi tin, đo lãi bất thường từ phiên mở cửa sau giờ đăng', async () => {
  const items = [
    { title: 'Lãi quý tăng mạnh', link: 'x1', publishedAt: Date.parse(`${day(2)}T04:00:00Z`), label: 'tich_cuc', categories: ['earnings'] }, // 11:00 trong phiên
    { title: 'Không giờ đăng', link: 'x2' },
  ];
  assert.equal(await recordNewsEvents('AAA', items), 1);
  assert.equal(await recordNewsEvents('AAA', items), 0); // trùng
  assert.equal((await newsEvents()).length, 1);
  assert.equal(readFileSync(process.env.NEWS_EVENTS_FILE, 'utf8').trim().split('\n').length, 1);

  const index = Array.from({ length: 40 }, (_, i) => ({ time: day(i), open: 100, close: 100 }));
  const stock = Array.from({ length: 40 }, (_, i) => ({ time: day(i), open: i >= 3 ? 11 : 10, close: i >= 3 ? 11 : 10 }));
  const others = Object.fromEntries(Array.from({ length: 25 }, (_, k) => [`F${k}`, index.map((b) => ({ time: b.time, open: 10, close: 10 }))]));
  const basket = basketReturns(others, index);
  const ev = (await newsEvents())[0];
  const r = scoreNewsEvent(ev, stock, index, basket);
  assert.equal(r.session, day(3)); // tin 11:00 phiên 2 → mua được từ mở cửa phiên 3
  assert.ok(Math.abs(r.gap - 0.1) < 1e-12); // giá đã nhảy trước khi kịp mua
  assert.equal(r[5].abnormal, 0);
  const impact = newsImpact([ev], () => r);
  assert.equal(impact.find((x) => x.key === 'tich_cuc').events, 1);
  assert.ok(impact.some((x) => x.key === 'cat:earnings'));
});
