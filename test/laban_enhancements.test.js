import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStockRisk, detectBuyWarnings } from '../src/risk.js';
import { trendFeatures, applyTrendPicks, TREND_PICK_RULE } from '../src/ranking.js';
import { monteCarloForecast, classifySignal } from '../src/forecast.js';
import { evaluateMarketRegime } from '../src/regime.js';
import { rankRecommendation, technicalAnalysis } from '../src/analyze.js';

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

test('detectBuyWarnings: kiểm chứng 2 chốt chặn Khoan Mua (SSL Break & Weak Stock) theo nghiên cứu Laban', () => {
  // 1. Cổ phiếu bình thường: không kích hoạt cảnh báo
  const normalBars = Array.from({ length: 40 }, (_, i) => ({
    time: day(i), open: 50, high: 51, low: 49, close: 50 + (i * 0.1), volume: 500000,
  }));
  const normalWarns = detectBuyWarnings(normalBars, 10e9);
  assert.equal(normalWarns.length, 0);

  // 2. Weak stock: Giảm >= 3% trong 5 phiên và dưới MA20
  const weakBars = Array.from({ length: 30 }, (_, i) => ({
    time: day(i), open: 60, high: 61, low: 59, close: 60, volume: 500000,
  }));
  // 5 phiên cuối giảm từ 60 xuống 57 (-5.0%)
  for (let i = 25; i < 30; i++) {
    weakBars[i].close = 60 - (i - 24) * 0.6; // 59.4, 58.8, 58.2, 57.6, 57.0
    weakBars[i].low = weakBars[i].close - 0.5;
  }
  const weakWarns = detectBuyWarnings(weakBars, 10e9);
  assert.ok(weakWarns.some((w) => w.key === 'weak'));
  const wWeak = weakWarns.find((w) => w.key === 'weak');
  assert.ok(wWeak.text.includes('khoan mua khoảng 10 phiên'));

  // 3. SSL Break: Giá đóng cửa phá đáy thanh khoản (pivot low) trong 5 phiên gần nhất
  // Tạo đáy thanh khoản pivot low tại bar index 10 (thấp hơn 7 phiên trước và 6 phiên sau)
  const sslBars = Array.from({ length: 35 }, (_, i) => ({
    time: day(i), open: 50, high: 51, low: 48, close: 50, volume: 500000,
  }));
  // Làm cho bar 10 có low = 40 (pivot low)
  sslBars[10].low = 40;
  // Các bar 3-9 và 11-16 đều có low >= 45
  for (let i = 3; i <= 16; i++) {
    if (i !== 10) sslBars[i].low = 45 + (i % 3);
  }
  // Tại bar 33 (trong 5 phiên cuối), giá đóng cửa thủng dưới 40 (ví dụ 39)
  sslBars[33].close = 39;
  sslBars[34].close = 38.5;
  const sslWarns = detectBuyWarnings(sslBars, 10e9);
  assert.ok(sslWarns.some((w) => w.key === 'ssl'));
  const wSsl = sslWarns.find((w) => w.key === 'ssl');
  assert.ok(wSsl.text.includes('khoan mua khoảng 10 phiên'));
});

test('rankRecommendation & technicalAnalysis: nâng cấp RSI động lượng và rào chắn buyWarnings', () => {
  // Gating buyWarnings trong rankRecommendation
  const mockRank = { score: 85, aboveMa200: true, position: 2, universe: 100 };
  const mockWarning = [{ key: 'ssl', name: '⚠️ Thủng SSL', text: 'đóng cửa dưới đáy thanh khoản: khoan mua khoảng 10 phiên', tested: 'test' }];
  const recBlocked = rankRecommendation(mockRank, { buyWarnings: mockWarning });
  assert.equal(recBlocked.code, 'HOLD');
  assert.ok(recBlocked.desc.includes('khoan mua khoảng 10 phiên'));

  // RSI trong vùng 70–82 trong xu hướng tăng (trên MA200) được thưởng điểm động lượng dẫn sóng thay vì phạt -15
  const uptrendBars = Array.from({ length: 220 }, (_, i) => {
    const pull = (i % 4 === 0) ? -0.1 : 0.2;
    const c = 20 + i * 0.1 + pull;
    return { time: day(i), open: c * 0.99, high: c * 1.01, low: c * 0.98, close: c, volume: 500000 };
  });
  const tech = technicalAnalysis(uptrendBars, { trend: 'up' });
  assert.ok(tech.indicators.rsi14 >= 70 && tech.indicators.rsi14 <= 82);
  assert.ok(tech.signals.some((s) => s.text.includes('động lượng dẫn sóng mạnh') && s.points > 0));
  assert.ok(tech.score > 30);
});

test('evaluateMarketRegime: phát hiện chế độ sụt sâu (Quality Deep Dip) khi VN-Index giảm >= 15% từ đỉnh 1 năm', () => {
  // Tạo 250 phiên chỉ số: đỉnh tại 1200, sau đó rơi về 1000 (-16.6% từ đỉnh)
  const indexBars = Array.from({ length: 250 }, (_, i) => {
    let c = 1100 + i * 0.5;
    if (i < 100) c = 1200; // Đỉnh 1200
    else c = 1200 - (i - 100) * 1.4; // Rơi dần về ~990
    return { time: day(i), open: c, high: c + 2, low: c - 2, close: c, volume: 10000000 };
  });
  const regime = evaluateMarketRegime(indexBars);
  assert.ok(regime.high250 >= 1200);
  assert.ok(regime.from1yHighPct <= -15.0);
  assert.equal(regime.isDeepDip, true);
});
