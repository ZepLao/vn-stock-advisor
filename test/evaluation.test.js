import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tripleBarrier, simulateExit, compareExit, wilson, summarize, edgeVerdict, calibrate, EVAL_RULE, EXITS } from '../src/evaluation.js';

const X = Object.fromEntries(EXITS.map((x) => [x.key, x]));

// Phiên giả: giá quanh `p`, biên độ nhỏ
const bar = (open, high, low, close) => ({ open, high, low, close, volume: 1000 });
const flat = (n, p = 20) => Array.from({ length: n }, () => bar(p, p * 1.005, p * 0.995, p));
// Không phí, không trượt giá để dễ kiểm tra số
const R0 = { ...EVAL_RULE, brokerage: 0, sellTax: 0, slippage: 0 };

test('tripleBarrier: chạm mục tiêu +2R, mua giá mở cửa phiên sau', () => {
  const bars = flat(10);
  bars[4] = bar(20, 20.1, 19.9, 20);
  bars[6] = bar(20, 21.3, 19.9, 21.2); // cắt lỗ 5% (2×ATR 0,5 / 20) → mục tiêu +10% = 22 chưa chạm
  bars[7] = bar(21.2, 22.5, 21, 22.4); // chạm 22
  const r = tripleBarrier(bars, 3, 0.5, {}, R0);
  assert.equal(r.reason, 'target');
  assert.equal(r.entry, 20);
  assert.ok(Math.abs(r.stopPct - 0.05) < 1e-9);
  assert.ok(Math.abs(r.exit - 22) < 1e-9);
  assert.ok(Math.abs(r.r - 2) < 1e-9);
  assert.equal(r.win, true);
});

test('tripleBarrier: T+2 — giá thủng cắt lỗ ngay phiên mua và phiên kế không bán được', () => {
  const bars = flat(30);
  bars[4] = bar(20, 20, 18, 19);   // phiên mua (e = 4): thủng 19 nhưng chưa có hàng
  bars[5] = bar(19, 19.2, 18.5, 19.1); // T+1: vẫn chưa bán được
  bars[6] = bar(19.6, 20, 19.5, 19.8); // T+2: hồi trên cắt lỗ → không bị cắt
  const r = tripleBarrier(bars, 3, 0.5, {}, R0);
  assert.notEqual(r.reason, 'stop');
  assert.equal(r.reason, 'time');
});

test('tripleBarrier: mở cửa giảm sâu qua cắt lỗ thì khớp giá mở cửa (không phải giá cắt lỗ)', () => {
  const bars = flat(30);
  bars[6] = bar(17, 17.5, 16.8, 17.2);
  const r = tripleBarrier(bars, 3, 0.5, {}, R0);
  assert.equal(r.reason, 'stop');
  assert.equal(r.exit, 17);
  assert.ok(r.r < -1, 'trượt giá qua cắt lỗ phải lỗ hơn 1R');
});

test('tripleBarrier: cùng phiên chạm cả hai rào thì tính cắt lỗ', () => {
  const bars = flat(30);
  bars[6] = bar(20, 23, 18.5, 20);
  assert.equal(tripleBarrier(bars, 3, 0.5, {}, R0).reason, 'stop');
});

test('tripleBarrier: phiên giảm sàn trắng không bán được, bán ở phiên sau', () => {
  const bars = flat(30);
  bars[6] = bar(18.6, 18.6, 18.6, 18.6); // sàn 7% từ 20, không có giao dịch giá khác
  bars[7] = bar(18, 18.5, 17.5, 18);
  const r = tripleBarrier(bars, 3, 0.5, {}, R0);
  assert.equal(r.reason, 'stop');
  assert.equal(r.exitIdx, 7);
  assert.equal(r.exit, 18);
});

test('tripleBarrier: tăng trần trắng phiên mua thì không khớp lệnh', () => {
  const bars = flat(30);
  bars[4] = bar(21.4, 21.4, 21.4, 21.4);
  assert.equal(tripleBarrier(bars, 3, 0.5, {}, R0).reason, 'nofill');
});

test('tripleBarrier: hết thời gian bán giá đóng cửa phiên i + horizon; chưa đủ dữ liệu trả null', () => {
  const bars = flat(30);
  const r = tripleBarrier(bars, 3, 0.5, {}, R0);
  assert.equal(r.reason, 'time');
  assert.equal(r.exitIdx, 3 + 20);
  assert.equal(tripleBarrier(flat(15), 3, 0.5, {}, R0), null);
});

test('tripleBarrier: mã hủy niêm yết thoát giá cuối trừ haircut', () => {
  const r = tripleBarrier(flat(15), 3, 0.5, { delisted: true }, R0);
  assert.equal(r.reason, 'delist');
  assert.ok(r.ret < -0.25);
});

test('tripleBarrier: cắt lỗ được kẹp trong 3–8% và phí làm lệnh hòa vốn thành thua', () => {
  const bars = flat(30);
  assert.equal(tripleBarrier(bars, 3, 0.05, {}, R0).stopPct, 0.03);
  assert.equal(tripleBarrier(bars, 3, 5, {}, R0).stopPct, 0.08);
  const withFees = tripleBarrier(bars, 3, 0.5);
  assert.equal(withFees.reason, 'time');
  assert.equal(withFees.win, false, 'giá đứng yên + phí/thuế = lỗ');
});

test('wilson: khoảng tin cậy 4/12 rộng, 0/0 trả null', () => {
  const [lo, hi] = wilson(4, 12);
  assert.ok(lo > 0.1 && lo < 0.16, `lo ${lo}`);
  assert.ok(hi > 0.58 && hi < 0.65, `hi ${hi}`);
  assert.deepEqual(wilson(0, 0), [null, null]);
});

test('summarize + edgeVerdict: R dương ổn định qua nhiều mốc là có lợi thế', () => {
  const trades = [];
  for (let d = 0; d < 40; d++) {
    const date = `2024-${String(1 + Math.floor(d / 4)).padStart(2, '0')}-${String(1 + (d % 4) * 7).padStart(2, '0')}`;
    trades.push({ date, r: 2, ret: 0.1, win: true, reason: 'target', days: 8 });
    trades.push({ date, r: -1 + (d % 3) * 0.1, ret: -0.05, win: false, reason: 'stop', days: 4 });
  }
  const all = summarize(trades);
  assert.equal(all.n, 80);
  assert.equal(all.winRate, 0.5);
  assert.equal(all.targetRate, 0.5);
  assert.equal(all.payoff, 2);
  assert.ok(all.avgR > 0.4);
  const half = (a) => summarize(trades.slice(a, a + 40));
  assert.equal(edgeVerdict(all, half(0), half(40)), 'edge');
  assert.equal(edgeVerdict({ n: 5, dates: 3, t: 5 }, all, all), 'insufficient');
});

test('calibrate: nhóm điểm phân biệt thật thì kỹ năng > 0, xác suất dự báo lấy từ tập học', () => {
  const mk = (score, win) => ({ score, win });
  const gen = () => [
    ...Array.from({ length: 100 }, (_, k) => mk(90, k < 70)),
    ...Array.from({ length: 100 }, (_, k) => mk(10, k < 30)),
  ];
  const c = calibrate(gen(), gen());
  assert.equal(c.baseRate, 0.5);
  assert.equal(c.bins['85-100'].predicted, 0.7);
  assert.equal(c.bins['85-100'].observed, 0.7);
  assert.ok(c.skill > 0.1);
});

// Đà tăng đều 0,5/phiên từ phiên mua rồi giảm: dùng cho các kiểu thoát đuổi theo
const rally = () => {
  const bars = flat(80);
  for (let k = 4; k <= 16; k++) { const p = 20 + (k - 4) * 0.5; bars[k] = bar(p, p + 0.3, p - 0.2, p + 0.2); }
  for (let k = 17; k < 80; k++) { const p = 26 - (k - 16) * 0.5; bars[k] = bar(p, p + 0.1, p - 0.4, p - 0.3); }
  return bars;
};

test('simulateExit TIME: 10 phiên chưa từng đạt +1R thì bán giá mở cửa phiên sau', () => {
  const r = simulateExit(flat(40), 3, 0.5, X.TIME, {}, R0);
  assert.equal(r.reason, 'time');
  assert.equal(r.exitIdx, 4 + 10);
  assert.equal(tripleBarrier(flat(40), 3, 0.5, {}, R0).exitIdx, 23, 'cơ sở giữ đủ 20 phiên');
});

test('simulateExit BE: đạt +1R rồi quay đầu thì thoát ở hòa vốn thay vì cắt lỗ', () => {
  const bars = flat(40);
  bars[6] = bar(20.2, 21.2, 20.1, 21);
  bars[7] = bar(20.5, 20.6, 19.5, 19.6);
  const be = simulateExit(bars, 3, 0.5, X.BE, {}, R0);
  assert.equal(be.reason, 'protect');
  assert.equal(be.exit, 20);
  assert.ok(Math.abs(be.ret) < 1e-9);
  assert.notEqual(tripleBarrier(bars, 3, 0.5, {}, R0).exitIdx, 7, 'cơ sở không bị cắt ở phiên 7');
});

test('simulateExit BE: hòa vốn đã gồm phí và thuế', () => {
  const bars = flat(40);
  bars[6] = bar(20.2, 21.5, 20.1, 21);
  bars[7] = bar(20.5, 20.6, 19.5, 19.6);
  const be = simulateExit(bars, 3, 0.5, X.BE);
  assert.ok(Math.abs(be.ret) < 1e-9, `ret ${be.ret}`);
});

test('simulateExit TRAIL: để lãi chạy vượt mục tiêu cố định, thoát khi giá rơi 3×ATR từ đỉnh', () => {
  const bars = rally();
  const base = tripleBarrier(bars, 3, 0.5, {}, R0);
  const tr = simulateExit(bars, 3, 0.5, X.TRAIL, {}, R0);
  assert.equal(base.reason, 'target');
  assert.equal(tr.reason, 'protect');
  assert.ok(tr.ret > base.ret, `đuổi ${tr.ret} > cố định ${base.ret}`);
  assert.ok(Math.abs(tr.exit - (26.3 - 1.5)) < 1e-9, 'cắt lỗ đuổi = đỉnh 26,3 − 3×0,5');
});

test('simulateExit PARTIAL: lãi = 1/2 phần chốt ở +2R + 1/2 phần đuổi', () => {
  const bars = rally();
  const p = simulateExit(bars, 3, 0.5, X.PARTIAL, {}, R0);
  const tr = simulateExit(bars, 3, 0.5, X.TRAIL, {}, R0);
  assert.ok(Math.abs(p.ret - (0.5 * 0.1 + 0.5 * tr.ret)) < 1e-9);
});

test('simulateExit MA20: đóng cửa dưới MA20 thì bán mở cửa phiên sau, không sớm hơn T+2', () => {
  const bars = flat(80);
  const ma = bars.map(() => 19);
  ma[4] = 25; // ngay phiên mua đã dưới MA20 → chỉ bán được từ phiên 6
  const early = simulateExit(bars, 3, 0.5, X.MA20, { ma20: ma }, R0);
  assert.equal(early.reason, 'ma20');
  assert.equal(early.exitIdx, 6);
  const ma2 = bars.map((_, k) => (k === 9 ? 25 : 19));
  assert.equal(simulateExit(bars, 3, 0.5, X.MA20, { ma20: ma2 }, R0).exitIdx, 10);
});

test('simulateExit: kiểu giữ lâu chưa đủ dữ liệu trả null', () => {
  assert.equal(simulateExit(flat(40), 3, 0.5, X.TRAIL, {}, R0), null);
});

test('compareExit: chênh R dương ổn định ở cả hai nửa là tốt hơn cơ sở', () => {
  const trades = [];
  for (let d = 0; d < 40; d++) {
    const date = `2024-${String(1 + Math.floor(d / 4)).padStart(2, '0')}-${String(1 + (d % 4) * 7).padStart(2, '0')}`;
    const ex = (b, t) => ({ BASE: { r: b }, TRAIL: { r: t } });
    trades.push({ date, exits: ex(-1, -0.6 + (d % 5) * 0.05) });
    trades.push({ date, exits: ex(1, 1.3 + (d % 3) * 0.1) });
  }
  const mid = '2024-06-01';
  const c = compareExit(trades, 'TRAIL', mid);
  assert.equal(c.verdict, 'better');
  assert.ok(c.diffR > 0.3);
  const worse = trades.map((x) => ({ ...x, exits: { BASE: x.exits.TRAIL, TRAIL: x.exits.BASE } }));
  assert.equal(compareExit(worse, 'TRAIL', mid).verdict, 'worse');
});

test('simulateExit LIVE: không cắt lỗ trong phiên, chỉ bán khi đóng cửa dưới −15% (mở cửa phiên sau)', () => {
  const bars = flat(60);
  bars[6] = bar(20, 20, 17.5, 19.5);   // thủng −12,5% trong phiên nhưng đóng cửa trên −15%: vẫn giữ
  bars[8] = bar(18, 18, 16.8, 16.9);   // đóng cửa dưới 17 (−15%)
  bars[9] = bar(16.5, 17, 16.2, 16.6);
  const r = simulateExit(bars, 3, 0.5, X.LIVE, {}, R0);
  assert.equal(r.reason, 'stop');
  assert.equal(r.exitIdx, 9);
  assert.equal(r.exit, 16.5);
  assert.equal(r.stopPct, 0.15);
  assert.equal(simulateExit(flat(60), 3, 0.5, X.LIVE, {}, R0).exitIdx, 3 + 40);
});

test('simulateExit LIVE_TRAIL_1R: chỉ bắt đầu đuổi khi đỉnh đã lãi ≥ 2×ATR', () => {
  const bars = flat(80);
  bars[6] = bar(20, 20.6, 18.5, 19.2); // chưa lãi đủ 2×ATR → không có cắt lỗ đuổi, giữ
  const noTrail = simulateExit(bars, 3, 0.5, X.LIVE_TRAIL_1R, {}, R0);
  assert.notEqual(noTrail.exitIdx, 6);
  const tr = simulateExit(bars, 3, 0.5, X.LIVE_TRAIL, {}, R0);
  assert.equal(tr.exitIdx, 6, 'đuổi từ đầu: đỉnh 20,1 − 1,5 = 18,6 bị thủng ngay');
  assert.ok(Math.abs(tr.exit - 18.6) < 1e-9);
  const r = rally();
  assert.equal(simulateExit(r, 3, 0.5, X.LIVE_TRAIL_1R, {}, R0).reason, 'protect');
});
