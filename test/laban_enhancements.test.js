import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStockRisk } from '../src/risk.js';
import { trendFeatures, applyTrendPicks, TREND_PICK_RULE } from '../src/ranking.js';
import { monteCarloForecast, classifySignal } from '../src/forecast.js';

const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);

test('detectStockRisk: phát hiện dao rơi, sụt giảm mạnh và giảm sàn liên tiếp', () => {
  // 1. Cổ phiếu bình thường biến động nhẹ
  const normalBars = Array.from({ length: 60 }, (_, i) => ({
    time: day(i), open: 50, high: 51, low: 49, close: 50 + (i % 2 === 0 ? 0.2 : -0.2), volume: 100000,
  }));
  const normalRes = detectStockRisk(normalBars, 'NORMAL');
  assert.equal(normalRes.isRisky, false);
  assert.equal(normalRes.reasons.length, 0);
  assert.equal(normalRes.riskLevel, 'NORMAL');

  // 2. Cổ phiếu rơi tự do trong 5 phiên gần nhất (-15%)
  const drop5dBars = Array.from({ length: 30 }, (_, i) => ({
    time: day(i), open: 50, high: 51, low: 49, close: 50, volume: 100000,
  }));
  // 5 phiên cuối rơi mạnh từ 50 về 41 (-18%)
  drop5dBars[25].close = 48;
  drop5dBars[26].close = 46;
  drop5dBars[27].close = 44;
  drop5dBars[28].close = 42;
  drop5dBars[29].close = 41;

  const drop5dRes = detectStockRisk(drop5dBars, 'DROP5D');
  assert.equal(drop5dRes.isRisky, true);
  assert.ok(drop5dRes.reasons.some((r) => r.includes('Rơi tự do 5 phiên')));
  assert.equal(drop5dRes.riskLevel, 'CRITICAL');

  // 3. Cổ phiếu có 2 phiên giảm sàn liên tiếp (-7% mỗi phiên)
  const limitDownBars = Array.from({ length: 30 }, (_, i) => ({
    time: day(i), open: 50, high: 51, low: 49, close: 50, volume: 100000,
  }));
  limitDownBars[28].close = 50 * 0.93; // -7%
  limitDownBars[29].close = limitDownBars[28].close * 0.93; // -7% thêm
  const limitRes = detectStockRisk(limitDownBars, 'LIMIT');
  assert.equal(limitRes.isRisky, true);
  assert.ok(limitRes.reasons.some((r) => r.includes('giảm sàn gần đây')));
});

test('trendFeatures & applyTrendPicks: phát hiện xu hướng tăng và cổ phiếu chuẩn Trend Pick', () => {
  // Tạo chuỗi tăng đều đặn, tiệm cận đỉnh 52 tuần với biến động thấp
  const trendBars = Array.from({ length: 260 }, (_, i) => ({
    time: day(i), open: 20 + i * 0.2, high: 20.3 + i * 0.2, low: 19.8 + i * 0.2, close: 20.1 + i * 0.2, volume: 500000,
  }));
  const tf = trendFeatures(trendBars);
  assert.ok(tf != null);
  assert.equal(tf.trendState, 'UP');
  assert.ok(tf.pctFrom52wHigh >= -5.0);
  assert.equal(tf.aboveMa50, true);
  assert.equal(tf.aboveMa200, true);

  // Áp dụng bộ lọc TREND_PICK_RULE
  const rows = [
    {
      symbol: 'GOOD_TREND',
      close: 70,
      value20: 10e9, // 10 tỷ > 1 tỷ
      trend: { vol60: 0.01, pctFrom52wHigh: -2.0, trendState: 'UP' },
    },
    {
      symbol: 'HIGH_VOL',
      close: 65,
      value20: 10e9,
      trend: { vol60: 0.08, pctFrom52wHigh: -3.0, trendState: 'UP' }, // biến động cao
    },
  ];
  applyTrendPicks(rows);
  assert.equal(rows[0].trendPick, true); // biến động thấp nhất -> pass
  assert.equal(rows[1].trendPick, false); // biến động cao nhất (vol rank 1.0 > 0.70) -> fail
});

test('monteCarloForecast & classifySignal: mô phỏng xác suất và phân loại tín hiệu thông minh', () => {
  // Dữ liệu giả lập 100 phiên có xu hướng tăng nhẹ
  const bars = Array.from({ length: 120 }, (_, i) => {
    const c = 30 * (1 + 0.001 * i);
    return {
      time: day(i), open: c * 0.998, high: c * 1.01, low: c * 0.99, close: c, volume: 200000,
    };
  });

  const mc = monteCarloForecast(bars, 20, 100, { exchange: 'HOSE' });
  assert.ok(mc != null);
  assert.equal(mc.h, 20);
  assert.equal(mc.numPaths, 100);
  assert.ok(mc.probUp >= 0 && mc.probUp <= 1);
  assert.ok(mc.probGain5 >= 0 && mc.probGain5 <= 1);
  assert.ok(mc.probLoss7 >= 0 && mc.probLoss7 <= 1);
  assert.ok(mc.rr > 0);
  assert.ok(['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'RISK', 'RISK_BUY'].includes(mc.signal));

  // Kiểm tra phân loại tín hiệu classifySignal
  const strongBuyStats = { peakGainMedian: 6.5, troughDdMedian: -2.5, probUp: 0.75, finalRetMedian: 3.5, probLoss7: 0.05 };
  assert.equal(classifySignal(strongBuyStats, false).signal, 'STRONG_BUY');

  const sellStats = { peakGainMedian: 2.0, troughDdMedian: -5.0, probUp: 0.30, finalRetMedian: -3.5, probLoss7: 0.30 };
  assert.equal(classifySignal(sellStats, false).signal, 'SELL');

  const riskyStats = { peakGainMedian: 4.5, troughDdMedian: -8.0, probUp: 0.45, finalRetMedian: 0.0, probLoss7: 0.55 };
  assert.equal(classifySignal(riskyStats, false).signal, 'RISK');

  // Khi isRisky = true, không được trả STRONG_BUY hay BUY
  assert.equal(classifySignal(strongBuyStats, true).signal, 'RISK_BUY');
});
