import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketRegime, countDistributionDays, REGIMES } from '../src/regime.js';
import { monteCarloForecast } from '../src/forecast.js';
import { simulateRankPortfolio, factorReader, FACTORS, DELIST_HAIRCUT } from '../src/ranking.js';

const day = (i) => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10);

test('evaluateMarketRegime: thiếu dữ liệu thì UNKNOWN và không cho mua mới (fail-closed)', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ time: day(i), close: 1000 + i, volume: 1000 }));
  const r = evaluateMarketRegime(bars, null);
  assert.equal(r.regime, REGIMES.UNKNOWN.code);
  assert.equal(r.allowNewBuys, false);
  assert.equal(evaluateMarketRegime(null).allowNewBuys, false);
});

test('countDistributionDays: ngày phân phối hết hiệu lực khi chỉ số hồi vượt 5%', () => {
  const bars = [
    { time: day(0), close: 100, volume: 1000 },
    { time: day(1), close: 99, volume: 1200 }, // ngày phân phối
    { time: day(2), close: 102, volume: 1000 },
    { time: day(3), close: 104.5, volume: 1000 }, // 104,5 ≥ 99 × 1,05 → ngày 1 hết hiệu lực
  ];
  assert.equal(countDistributionDays(bars, 25).count, 0);
  assert.equal(countDistributionDays(bars.slice(0, 3), 25).count, 1);
});

test('monteCarloForecast: cùng dữ liệu ra cùng kết quả và không ngoại suy xu hướng', () => {
  // Tăng đều 0,5%/phiên kèm dao động: mô phỏng có trôi sẽ cho probUp ~1
  const bars = Array.from({ length: 260 }, (_, i) => {
    const c = 20 * 1.005 ** i * (1 + 0.02 * Math.sin(i * 1.7));
    return { time: day(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 };
  });
  const a = monteCarloForecast(bars, 20, 500);
  const b = monteCarloForecast(bars, 20, 500);
  assert.deepEqual(a, b);
  assert.ok(a.probUp > 0.35 && a.probUp < 0.65, `probUp ${a.probUp} phải quanh 0,5 khi đã bỏ trôi`);
  assert.ok(Math.abs(a.finalRetMedian) < 2.5, `trung vị ${a.finalRetMedian}% phải gần 0`);
  assert.ok(!['BUY', 'STRONG_BUY'].includes(a.signal));
});

// Rổ giả lập: A tăng đều biên độ hẹp (điểm cao nhất) rồi ngừng giao dịch ở phiên 200; B, C đi xuống, biến động mạnh
function fixture() {
  const N = 300;
  const cal = Array.from({ length: N }, (_, i) => ({ time: day(i), open: 1000 + i, high: 1001 + i, low: 999 + i, close: 1000 + i, volume: 1e6 }));
  const mk = (len, fn) => Array.from({ length: len }, (_, i) => {
    const [c, r] = fn(i);
    return { time: day(i), open: c, high: c * (1 + r), low: c * (1 - r), close: c, volume: 1e6 };
  });
  const series = {
    AAA: mk(201, (i) => [20 * 1.003 ** i, 0.003]),
    BBB: mk(N, (i) => [30 * (1 - 0.0008 * i) * (1 + 0.03 * Math.sin(i)), 0.03]),
    CCC: mk(N, (i) => [25 * (1 - 0.0005 * i) * (1 + 0.03 * Math.cos(i)), 0.03]),
  };
  const data = Object.fromEntries(Object.entries(series).map(([s, bars]) => [s, {
    bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars), ex: 'HOSE', earn: null,
  }]));
  const opts = { start: 150, top: 1, rebalance: 20, buffer: 1, trendFilter: false, regime: 'none', factors: FACTORS, earnings: false, minValue: 0, initialCash: 1e9 };
  return { cal, data, opts };
}

test('simulateRankPortfolio: mã hủy niêm yết đang nắm bị thoát ở giá cuối trừ haircut', () => {
  const { cal, data, opts } = fixture();
  const sim = simulateRankPortfolio(cal, data, opts);
  const d = sim.trades.find((t) => t.reason === 'delisted');
  assert.ok(d, 'phải có lệnh thoát do hủy niêm yết');
  assert.equal(d.symbol, 'AAA');
  const last = data.AAA.bars.at(-1).close;
  assert.ok(Math.abs(d.exitPrice - last * (1 - DELIST_HAIRCUT)) < 0.01);
  assert.equal(sim.delisted.length, 1);
  assert.ok(!sim.pos.has('AAA'));
});

test('simulateRankPortfolio: chỉ chọn mã thuộc rổ tại ngày tái cơ cấu', () => {
  const { cal, data, opts } = fixture();
  const sim = simulateRankPortfolio(cal, data, { ...opts, members: () => new Set(['BBB', 'CCC']) });
  assert.ok(sim.periods.length > 0);
  for (const p of sim.periods) for (const x of p.picks) assert.notEqual(x.symbol, 'AAA');
  assert.ok(!sim.trades.some((t) => t.symbol === 'AAA'));
});
