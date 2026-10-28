import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrade, tradeStats, proposeChanges, gateTests, RULES } from '../src/selfreview.js';
import { priceLevels } from '../src/tradeplan.js';

// Chuỗi giá: phiên 0 là ngày gợi ý, các phiên sau theo danh sách [open, high, low, close]
const mk = (rows, start = Date.UTC(2026, 9, 1)) => rows.map(([open, high, low, close], i) => ({
  time: new Date(start + i * 86400_000).toISOString().slice(0, 10), open, high, low, close, volume: 1,
}));
const flat = (n, p = 10) => Array.from({ length: n }, () => [p, p, p, p]);

test('Chấm lệnh: đóng cửa dưới cắt lỗ thì bán mở cửa phiên sau, chạm chốt lời, hết 20 phiên, chưa đủ phiên', () => {
  const t = { date: '2026-10-01', entry: 10, stop: 9.5, target: 11 };
  // Giá thấp nhất thủng cắt lỗ nhưng đóng cửa trên: chưa bán (như khuyến nghị "đóng cửa dưới")
  assert.equal(scoreTrade(t, mk([[10, 10, 10, 10], [10, 10.2, 9.4, 9.6], ...flat(25)])).outcome, 'time');
  const stop = scoreTrade(t, mk([[10, 10, 10, 10], [10, 10.2, 9.3, 9.4], [9.2, 9.6, 9.1, 9.5], ...flat(25)]));
  assert.equal(stop.outcome, 'stop');
  assert.equal(stop.days, 1);
  assert.ok(Math.abs(stop.ret - (9.2 / 10 - 1)) < 1e-12); // bán giá mở cửa phiên sau (gap xuống)
  assert.equal(stop.ret20, 0); // giá hồi về 10 sau đó
  // Cùng phiên chạm chốt lời và đóng cửa dưới cắt lỗ: tính cắt lỗ (thận trọng)
  assert.equal(scoreTrade(t, mk([[10, 10, 10, 10], [10, 11.5, 9.2, 9.3], ...flat(25)])).outcome, 'stop');
  const tgt = scoreTrade(t, mk([[10, 10, 10, 10], ...flat(3), [10.5, 11.2, 10.4, 11], ...flat(25)]));
  assert.equal(tgt.outcome, 'target');
  assert.equal(tgt.ret, 11 / 10 - 1);
  assert.equal(scoreTrade(t, mk([[10, 10, 10, 10], ...flat(25, 10.3)])).outcome, 'time');
  const pending = scoreTrade(t, mk([[10, 10, 10, 10], ...flat(5, 10.3)]));
  assert.equal(pending.matured, false);
});

const stats = (over) => ({ n: 40, winRate: 0.5, avgRet: 0, stopRate: 0.3, stop5Rate: 0.2, targetRate: 0.3, shakeN: 12, shakeAvgRet20: -0.02, ...over });
const ex = (n, e) => ({ n, avgRet10: e, avgExcess10: e });
const T = { widen: 1.12, minStopAtr: 0, aiVeto: true, caution: false };
const none = { picks: stats(), picks10: ex(40, 0.005), rejected10: ex(40, 0), band: { n: 60, coverage90: 0.9 } };
// Kiểm định giả: đặt verdict cho từng bằng chứng
const tst = (over = {}) => ({
  shake: { verdict: 'inconclusive', n: 30, mean: 0, t: 0 }, stopLow: { verdict: 'inconclusive', n: 30, mean: 0, t: 0 },
  veto: { verdict: 'inconclusive', n: 30, mean: 0, t: 0 }, picks: { verdict: 'inconclusive', n: 30, mean: 0, t: 0 },
  band: { verdict: 'inconclusive', n: 30, mean: 0, t: 0 }, ...over,
});
const sig = (mean, t = mean > 0 ? 2.5 : -2.5) => ({ verdict: t >= 2 ? 'supported' : t <= -2 ? 'rejected' : 'inconclusive', n: 30, mean, t });

test('Tự chỉnh: không đổi gì khi bằng chứng chưa đủ ý nghĩa, dù ước lượng điểm lệch xa', () => {
  assert.deepEqual(proposeChanges(none, tst(), T), []);
  // Trước đây: ước lượng điểm vượt ngưỡng là đủ để chỉnh; nay cần |t| ≥ 2
  const loud = { picks: stats({ stop5Rate: 0.8, shakeAvgRet20: 0.05 }), picks10: ex(40, 0), rejected10: ex(40, 0.05), band: { n: 60, coverage90: 0.6 } };
  assert.deepEqual(proposeChanges(loud, tst(), T), []);
  assert.deepEqual(proposeChanges(loud, tst({ shake: { verdict: 'insufficient', n: 5, mean: 0.05, t: 3 } }), T), []);
});

test('Tự chỉnh: nới cắt lỗ chỉ khi bị quét sớm và giá hồi lại CÓ Ý NGHĨA', () => {
  const shaken = proposeChanges({ ...none, picks: stats({ stop5Rate: 0.5 }) }, tst({ shake: sig(0.03) }), T);
  assert.deepEqual(shaken.map((c) => [c.name, c.value]), [['minStopAtr', 0.25]]);
  assert.equal(shaken[0].evidence.test.t, 2.5);
  // Giá tiếp tục giảm sau khi bị cắt (t âm): cắt lỗ đúng, không nới
  assert.deepEqual(proposeChanges({ ...none, picks: stats({ stop5Rate: 0.5 }) }, tst({ shake: sig(-0.03) }), T), []);
  // Thu hẹp lại khi tỷ lệ chạm cắt lỗ thấp có ý nghĩa
  assert.deepEqual(proposeChanges(none, tst({ stopLow: sig(-0.1) }), { ...T, minStopAtr: 0.5 }).map((c) => [c.name, c.value]), [['minStopAtr', 0.25]]);
});

test('Tự chỉnh: dải giá, quyền loại mã của AI, chế độ thận trọng (bất đối xứng theo rủi ro)', () => {
  assert.equal(proposeChanges(none, tst({ band: sig(-0.1) }), T)[0].value, 1.12 * 1.04);
  assert.equal(proposeChanges(none, tst({ band: sig(0.06) }), T)[0].value, 1.12 / 1.04);
  // Tắt AI loại mã (tăng rủi ro): cần ý nghĩa
  assert.deepEqual(proposeChanges({ ...none, picks10: ex(40, 0), rejected10: ex(40, 0.03) }, tst(), T), []);
  assert.deepEqual(proposeChanges(none, tst({ veto: sig(0.02) }), T).map((c) => [c.name, c.value]), [['aiVeto', false]]);
  // Bật lại AI loại mã (về phía thận trọng): ước lượng điểm là đủ
  assert.deepEqual(proposeChanges({ ...none, picks10: ex(40, 0.01), rejected10: ex(40, -0.01) }, tst(), { ...T, aiVeto: false }).map((c) => c.name), ['aiVeto']);
  // Bật thận trọng: ước lượng điểm; tắt thận trọng: cần ý nghĩa
  assert.deepEqual(proposeChanges({ ...none, picks10: ex(40, -0.02) }, tst(), T).map((c) => [c.name, c.value]), [['caution', true]]);
  assert.deepEqual(proposeChanges({ ...none, picks10: ex(40, 0.01) }, tst(), { ...T, caution: true }), []);
  assert.deepEqual(proposeChanges({ ...none, picks10: ex(40, 0.01) }, tst({ picks: sig(0.01) }), { ...T, caution: true }).map((c) => c.name), ['caution']);
});

test('gateTests: gộp theo phiên, ít phiên thì chưa đủ dữ liệu', () => {
  const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
  // 30 phiên, mỗi phiên 3 lệnh bị cắt sớm rồi giá hồi 4–6%
  const scored = [];
  for (let d = 0; d < 30; d++) {
    for (let k = 0; k < 3; k++) {
      scored.push({ date: day(d), status: 'pick', s: { matured: true, outcome: 'stop', days: 2, ret20: 0.04 + 0.01 * ((d + k) % 3), excess10: -0.01 } });
    }
    scored.push({ date: day(d), status: 'rejected', s: { excess10: 0.01 + 0.002 * (d % 5) } });
  }
  const g = gateTests(scored, Array.from({ length: 30 }, (_, d) => ({ date: day(d), hit: d % 10 !== 0 })));
  assert.equal(g.shake.n, 30);
  assert.equal(g.shake.verdict, 'supported');
  assert.equal(g.veto.verdict, 'supported');
  assert.equal(g.picks.verdict, 'rejected');
  assert.ok(Math.abs(g.band.mean) < 1e-9); // phủ đúng 90%
  assert.equal(gateTests(scored.slice(0, 20)).shake.verdict, 'insufficient');
});


test('Thống kê lệnh: tỷ lệ cắt lỗ sớm và lợi suất sau khi bị quét', () => {
  const s = tradeStats([
    { s: { matured: true, outcome: 'stop', days: 2, ret: -0.05, ret20: 0.04 } },
    { s: { matured: true, outcome: 'target', days: 8, ret: 0.08, ret20: 0.1 } },
    { s: { matured: false } },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.stop5Rate, 0.5);
  assert.equal(s.shakeAvgRet20, 0.04);
});

test('Cắt lỗ tối thiểu theo ATR: đẩy cắt lỗ xa hơn nhưng không quá 10%', () => {
  const bars = mk([...flat(60, 50), ...Array.from({ length: 10 }, (_, i) => [50 + i * 0.1, 50.5 + i * 0.1, 49.9 + i * 0.1, 50.2 + i * 0.1])]);
  const base = priceLevels(bars, { atr: 1, ma20: null, ma50: null, ma200: null });
  const wide = priceLevels(bars, { atr: 1, ma20: null, ma50: null, ma200: null, minStopAtr: 2 });
  const close = bars.at(-1).close;
  assert.ok(wide.stop <= close - 2 + 1e-9, `cắt lỗ ${wide.stop}`);
  assert.ok(wide.stop <= base.stop);
  assert.ok(priceLevels(bars, { atr: 3, ma20: null, ma50: null, ma200: null, minStopAtr: 2 }).stop >= close * 0.9 - 0.05);
});
