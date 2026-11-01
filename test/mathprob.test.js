import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMathProbability } from '../src/mathprob.js';

test('calculateMathProbability: từ chối giao dịch có kỳ vọng toán học (EV) âm và Kelly <= 0', () => {
  // Kèo bất lợi điển hình: mục tiêu lãi +6%, dừng lỗ -15%, xác suất thắng 45%
  const levels = { close: 50, target: 53, stop: 42.5, targetPct: 0.06, stopPct: -0.15 };
  const mc = { probUp: 0.45, probLoss7: 0.38 };
  const res = calculateMathProbability([], levels, mc);

  assert.ok(res);
  assert.equal(res.pass, false);
  assert.equal(res.verdict, 'REJECT');
  assert.ok(res.expectedValue < 0, `EV should be negative, got ${res.expectedValue}`);
  assert.ok(res.kellyFraction <= 0, `Kelly should be <= 0, got ${res.kellyFraction}`);
  assert.ok(res.breakEvenWinRate > res.pWin, `Break-even winrate ${res.breakEvenWinRate} should be > pWin ${res.pWin}`);
  assert.ok(res.reasons.length >= 2);
  assert.ok(res.reasons.some((r) => r.includes('Kỳ vọng toán học âm')));
  assert.ok(res.reasons.some((r) => r.includes('Kelly')));
});

test('calculateMathProbability: thông qua kèo có lợi thế thống kê rõ rệt (EV > 0, Kelly > 0)', () => {
  // Kèo chuẩn: mục tiêu lãi +15%, cắt lỗ -6%, xác suất thắng 55%
  const levels = { close: 50, target: 57.5, stop: 47, targetPct: 0.15, stopPct: -0.06 };
  const mc = { probUp: 0.55, probLoss7: 0.20 };
  const exp = { h20: { pBeat: 0.58 } };
  const res = calculateMathProbability([], levels, mc, exp);

  assert.ok(res);
  assert.equal(res.pass, true);
  assert.equal(res.verdict, 'PASS');
  assert.ok(res.expectedValue > 0.01, `EV should be > 1%, got ${res.expectedValue}`);
  assert.ok(res.kellyFraction > 0.1, `Kelly should be > 0.1, got ${res.kellyFraction}`);
  assert.ok(res.halfKelly > 0);
  assert.equal(res.reasons.length, 0);
});

test('calculateMathProbability: chặn mua khi rủi ro sụt giảm sâu Monte Carlo vượt 35%', () => {
  const levels = { close: 50, target: 60, stop: 46, targetPct: 0.20, stopPct: -0.08 };
  // Dù target/stop tốt nhưng xác suất sụt lỗ >= 7% lên tới 42%
  const mc = { probUp: 0.55, probLoss7: 0.42 };
  const res = calculateMathProbability([], levels, mc);

  assert.ok(res);
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => r.includes('Xác suất có lúc lỗ ≥ 7%')));
});

test('calculateMathProbability: tính rủi ro kẹt hàng T+2 và chặn mã có xác suất thủng cắt lỗ trước khi hàng về cao', () => {
  // Chuỗi nến có biến động đuôi 3 phiên cực lớn (thường xuyên giảm > 10% trong 3 phiên)
  const bars = [];
  let price = 50;
  for (let i = 0; i < 100; i++) {
    // 3 phiên giảm sốc xen kẽ
    if (i % 5 === 0) price *= 0.90;
    else price *= 1.02;
    bars.push({ close: price, high: price * 1.01, low: price * 0.99, time: `2026-01-${String(i + 1).padStart(2, '0')}` });
  }

  const levels = { close: price, target: price * 1.15, stop: price * 0.94, targetPct: 0.15, stopPct: -0.06 };
  const mc = { probUp: 0.55, probLoss7: 0.20 };
  const res = calculateMathProbability(bars, levels, mc);

  assert.ok(res);
  assert.ok(res.t2Risk);
  assert.ok(res.t2Risk.cvar3 > 0.06, `CVaR3 should be > 6%, got ${res.t2Risk.cvar3}`);
  assert.ok(res.effectiveLoss >= Math.abs(levels.stopPct));
  assert.equal(res.pass, false);
  assert.ok(res.reasons.some((r) => r.includes('T+2') || r.includes('CVaR3')));
});

