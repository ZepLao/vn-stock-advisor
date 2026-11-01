import { test } from 'node:test';
import assert from 'node:assert/strict';
import { futureDates, priceCone, validateCone, pnl, monteCarloForecast } from '../src/forecast.js';

// Chuỗi giá ngẫu nhiên có hạt giống cố định (biến động ~2%/phiên)
function randomBars(n, seed = 7) {
  let s = seed, p = 50;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const bars = [];
  const d = new Date(Date.UTC(2023, 0, 2));
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    p *= Math.exp(0.02 * z);
    bars.push({ time: d.toISOString().slice(0, 10), close: Math.round(p * 100) / 100 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

test('Phiên tương lai bỏ thứ 7, chủ nhật', () => {
  assert.deepEqual(futureDates('2026-10-16', 3), ['2026-10-19', '2026-10-20', '2026-10-21']); // 16/10 là thứ 6
});

test('Dải giá: 5% ≤ 25% ≤ trung vị ≤ 75% ≤ 95%, dải rộng dần theo số phiên', () => {
  const cone = priceCone(randomBars(800), 20);
  assert.equal(cone.length, 20);
  for (const c of cone) assert.ok(c.p05 <= c.p25 && c.p25 <= c.p50 && c.p50 <= c.p75 && c.p75 <= c.p95);
  assert.ok(cone[19].p95 - cone[19].p05 > cone[0].p95 - cone[0].p05);
});

test('Kiểm chứng trên chuỗi ngẫu nhiên: dải 50% / 90% chứa giá thật gần đúng tỷ lệ', () => {
  const v = validateCone(randomBars(1500), 10, { years: 3, step: 3 });
  assert.ok(v.n > 100);
  assert.ok(Math.abs(v.coverage50 - 0.5) < 0.15, `dải 50%: ${v.coverage50}`);
  assert.ok(Math.abs(v.coverage90 - 0.9) < 0.1, `dải 90%: ${v.coverage90}`);
});

test('Lời/lỗ: lô 100, trừ phí mua, phí bán và thuế bán', () => {
  const r = pnl(100e6, 50, 55);
  assert.equal(r.shares, 1900); // 100 triệu / (50.000 × 1,0015) = 1997 cp → 1900
  const cost = 1900 * 50000 * 1.0015, back = 1900 * 55000 * (1 - 0.0015 - 0.001);
  assert.equal(r.pnl, Math.round(back - cost));
  assert.ok(pnl(100e6, 50, 50).pnl < 0); // giá đứng yên vẫn lỗ phí
});

test('monteCarloForecast: Bayesian Conditioned Drift phân hóa rõ rệt mã Uptrend vs Downtrend', () => {
  const bars = randomBars(300, 42);
  const up = monteCarloForecast(bars, 20, 500, {
    trendState: 'UP',
    score: 85,
    marketTrend: 'up',
    foreignRatio20: 15,
    seed: 12345,
  });
  const down = monteCarloForecast(bars, 20, 500, {
    trendState: 'DOWN',
    score: 30,
    marketTrend: 'down',
    foreignRatio20: -15,
    seed: 12345,
  });

  assert.ok(up.dailyDriftPct > 0, 'Uptrend mã khỏe phải có dailyDrift dương');
  assert.ok(down.dailyDriftPct < 0, 'Downtrend mã yếu phải có dailyDrift âm');
  assert.ok(up.probUp > down.probUp, `Xác suất tăng của mã khỏe (${up.probUp}) phải vượt trội mã yếu (${down.probUp})`);
  assert.ok(up.finalRetMedian > down.finalRetMedian, 'Lợi nhuận trung vị mã khỏe phải lớn hơn mã yếu');
});
