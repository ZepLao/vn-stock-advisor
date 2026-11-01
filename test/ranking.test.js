import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRef, compositeScore, rankLabel, factorReader } from '../src/ranking.js';
import { scoreItem, basketReturns } from '../src/predictions.js';

const day = (i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

test('Điểm tổng hợp: mã tốt nhất mọi yếu tố gần 100, biến động được tính ngược chiều', () => {
  const list = [
    { mom: 0.5, high: 0, atr: 0.01, adx: 40 },
    { mom: 0.1, high: -0.1, atr: 0.02, adx: 25 },
    { mom: -0.2, high: -0.4, atr: 0.04, adx: 10 },
  ];
  const ref = buildRef(list);
  const best = compositeScore(list[0], ref), worst = compositeScore(list[2], ref);
  assert.ok(best.score > 80, `best ${best.score}`);
  assert.ok(worst.score < 20, `worst ${worst.score}`);
  assert.ok(best.parts.atr > worst.parts.atr); // ATR thấp hơn → phân vị cao hơn
  assert.equal(compositeScore({ mom: null, high: null, atr: 0.01, adx: null }, ref), null);
});

test('Nhãn xếp hạng và lọc MA200', () => {
  assert.equal(rankLabel(80, true).direction, 1);
  assert.equal(rankLabel(80, false).code, 'WAIT');
  assert.equal(rankLabel(20, true).direction, -1);
  assert.equal(rankLabel(50, true).direction, 0);
});

test('Yếu tố chỉ dùng dữ liệu đến phiên đang xét', () => {
  const bars = Array.from({ length: 300 }, (_, i) => ({ time: day(i), open: 10 + i / 10, high: 10.2 + i / 10, low: 9.8 + i / 10, close: 10 + i / 10, volume: 1 }));
  const read = factorReader(bars);
  const f = read(260);
  assert.ok(Math.abs(f.mom - (bars[240].close / bars[10].close - 1)) < 1e-12);
  assert.equal(f.high, 0); // chuỗi tăng đều: luôn ở đỉnh
  assert.equal(f.aboveMa200, true);
  bars[299].close = 1; // thay đổi tương lai không ảnh hưởng quá khứ
  assert.deepEqual(factorReader(bars)(260), f);
  assert.equal(read(100), null);
});

test('Chấm dự đoán sau 5/10/20 phiên so với VN-Index', () => {
  const mk = (f) => Array.from({ length: 30 }, (_, i) => ({ time: day(i), close: f(i) }));
  const stock = mk((i) => 10 + i), index = mk(() => 100);
  const r = scoreItem({ date: day(0), direction: 1 }, stock, index);
  assert.equal(r[5].correct, true);
  assert.equal(r[20].beatIndex, true);
  const s = scoreItem({ date: day(0), direction: -1 }, stock, index);
  assert.equal(s[10].correct, false);
  assert.equal(scoreItem({ date: day(25), direction: 1 }, stock, index)[5], undefined); // chưa đủ phiên
});

test('Chấm so với rổ đồng tỷ trọng: VN-Index bị một mã lớn kéo', () => {
  const mk = (f) => Array.from({ length: 30 }, (_, i) => ({ time: day(i), close: f(i) }));
  const index = mk((i) => 100 + 2 * i); // +10% sau 5 phiên
  const pick = mk((i) => 10 + 0.1 * i); // +5%
  const flat = Object.fromEntries(Array.from({ length: 25 }, (_, k) => [`S${k}`, mk(() => 20)])); // rổ đứng giá
  const basket = basketReturns({ ...flat, PICK: pick }, index);
  assert.ok(Math.abs(basket(day(0), 5) - 0.05 / 26) < 1e-9);
  const r = scoreItem({ date: day(0), direction: 1 }, pick, index, basket)[5];
  assert.equal(r.beatIndex, false); // thua VN-Index
  assert.equal(r.beatBasket, true); // nhưng hơn mặt bằng cổ phiếu
  assert.equal(basketReturns(flat, index)(day(28), 5), null); // chưa đủ phiên
  assert.equal(basketReturns({ PICK: pick }, index)(day(0), 5), null); // quá ít mã
});

test('Khuyến nghị theo điểm xếp hạng và bộ lọc chặn', async () => {
  const { rankRecommendation } = await import('../src/analyze.js');
  const r = (score, above = true) => ({ score, aboveMa200: above, position: 1, universe: 100 });
  assert.equal(rankRecommendation(r(80)).code, 'BUY');
  assert.equal(rankRecommendation(r(80, false)).code, 'AVOID'); // điểm cao nhưng dưới MA200
  assert.equal(rankRecommendation(r(80), { flagged: true }).code, 'HOLD');
  assert.equal(rankRecommendation(r(80), { losing: true }).code, 'HOLD');
  assert.equal(rankRecommendation(r(80), { liquid: false }).code, 'ACCUMULATE');
  assert.equal(rankRecommendation(r(80), { overextended: true }).code, 'HOLD');
  assert.equal(rankRecommendation(r(80), { foreignDumping: true }).code, 'HOLD');
  assert.equal(rankRecommendation(r(80), { bearishDivergence: true }).code, 'HOLD');
  assert.equal(rankRecommendation(r(80), { nearResistance: true }).code, 'HOLD');
  assert.equal(rankRecommendation(r(50)).code, 'HOLD');
  assert.equal(rankRecommendation(r(20)).code, 'AVOID');
  assert.equal(rankRecommendation(r(20), { flagged: true }).code, 'SELL');
});

test('Bộ lọc thị trường: số mã nắm giữ theo trạng thái VN-Index', async () => {
  const { regimeSlots } = await import('../src/ranking.js');
  assert.equal(regimeSlots('none', true, 8), 8);
  assert.equal(regimeSlots('half', true, 8), 4);
  assert.equal(regimeSlots('cash', true, 8), 0);
  assert.equal(regimeSlots('cash', false, 8), 8);
});
