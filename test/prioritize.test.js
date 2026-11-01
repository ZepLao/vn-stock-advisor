import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePriority, rulePriority, pickFacts, maxWeight } from '../src/prioritize.js';

const f = (symbol, extra = {}) => ({ symbol, zone: 'trong vùng mua', final: 'CÂN NHẮC MUA', rankScore: 80, riskReward: 1.5, rsi14: 60, atrPct: 2, maxWeightPct: 9, ...extra });

test('Trần tỷ trọng: thăm dò = một nửa tỷ trọng kế hoạch', () => {
  const a = { brief: { levels: { weight: 0.18 } } };
  assert.equal(maxWeight(a, { code: 'BUY' }), 0.18);
  assert.equal(maxWeight(a, { code: 'ACCUMULATE' }), 0.09);
  const x = pickFacts({ symbol: 'TLG', price: { close: 55.8 }, ranking: { score: 87 }, technical: { indicators: { rsi14: 58.9, atr14: 1.19 } },
    brief: { levels: { weight: 0.18, buyFrom: 55.2, buyTo: 55.8, target: 57, stop: 52.7, riskReward: 0.4 } } }, { code: 'ACCUMULATE', label: 'CÂN NHẮC MUA' }, 'buy');
  assert.equal(x.maxWeightPct, 9);
  assert.equal(x.zone, 'trong vùng mua');
  assert.equal(x.targetPct, 2.2);
});

test('Chặn kết quả AI: không thêm mã, tối đa 2 ưu tiên, trần tỷ trọng, best phải là mã ưu tiên', () => {
  const facts = [f('AAA'), f('BBB'), f('CCC'), f('DDD', { maxWeightPct: 20 })];
  const json = {
    items: [
      { symbol: 'aaa', tier: 'UU_TIEN', weightPct: 30, reason: 'mạnh nhất' }, // vượt trần 9%
      { symbol: 'BBB', tier: 'UU_TIEN', weightPct: 8, reason: 'b' },
      { symbol: 'CCC', tier: 'UU_TIEN', weightPct: 8, reason: 'c' }, // ưu tiên thứ 3 → hạ xuống
      { symbol: 'ZZZ', tier: 'UU_TIEN', weightPct: 10, reason: 'bịa' }, // không có trong danh sách
      { symbol: 'AAA', tier: 'DAU_CO', weightPct: 1, reason: 'trùng' },
    ],
    best: 'CCC', bestReason: 'x', summary: 's',
  };
  const out = sanitizePriority(json, facts);
  assert.deepEqual(out.items.map((x) => [x.symbol, x.tier]), [['AAA', 'UU_TIEN'], ['BBB', 'UU_TIEN'], ['CCC', 'NEN_MUA'], ['DDD', out.items[3].tier]]);
  assert.equal(out.items[0].weightPct, 9);
  assert.equal(out.items[2].weightPct <= 9 * 0.6, true);
  assert.ok(!out.items.some((x) => x.symbol === 'ZZZ'));
  assert.equal(out.best, 'AAA'); // CCC không còn là ưu tiên
});

test('Đầu cơ tối đa 5%, tổng tỷ trọng bị chặn, thận trọng chặn chặt hơn', () => {
  const facts = [f('AAA', { maxWeightPct: 20 }), f('BBB', { maxWeightPct: 20 }), f('CCC', { maxWeightPct: 20 }), f('DDD', { maxWeightPct: 20 })];
  const json = { items: [
    { symbol: 'AAA', tier: 'UU_TIEN', weightPct: 20, reason: '' }, { symbol: 'BBB', tier: 'UU_TIEN', weightPct: 20, reason: '' },
    { symbol: 'CCC', tier: 'NEN_MUA', weightPct: 12, reason: '' }, { symbol: 'DDD', tier: 'DAU_CO', weightPct: 15, reason: '' },
  ], best: 'AAA' };
  const out = sanitizePriority(json, facts);
  assert.equal(sanitizePriority({ items: [json.items[3]] }, [facts[3]]).items[0].weightPct, 5); // 15% → trần đầu cơ 5%
  assert.ok(out.items.find((x) => x.symbol === 'DDD').weightPct <= 5);
  assert.ok(out.items.reduce((s, x) => s + x.weightPct, 0) <= 50);
  assert.ok(sanitizePriority(json, facts, { caution: true }).items.reduce((s, x) => s + x.weightPct, 0) <= 30);
});

test('AI lỗi: xếp theo luật, mã rủi ro (RSI cao, R/R thấp) vào đầu cơ', () => {
  const facts = [f('AAA', { rankScore: 75 }), f('BBB', { rankScore: 90 }), f('CCC', { rsi14: 78 }), f('DDD', { zone: 'chờ giá về vùng mua', rankScore: 95 })];
  const r = rulePriority(facts);
  // thứ tự theo điểm: BBB, CCC (rủi ro → đầu cơ, không chiếm suất ưu tiên), AAA, DDD (chờ giá)
  assert.deepEqual(r.items.map((x) => [x.symbol, x.tier]), [['BBB', 'UU_TIEN'], ['CCC', 'DAU_CO'], ['AAA', 'UU_TIEN'], ['DDD', 'NEN_MUA']]);
  const out = sanitizePriority(null, facts);
  assert.equal(out.best, 'BBB');
  assert.equal(out.items.length, 4);
});
