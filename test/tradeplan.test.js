import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceLevels, tradeSteps, splitShares, tick } from '../src/tradeplan.js';

const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
// Chuỗi dao động quanh xu hướng tăng: có đỉnh/đáy rõ
const bars = Array.from({ length: 150 }, (_, i) => {
  const c = 20 + i * 0.03 + Math.sin(i / 5) * 0.8;
  return { time: day(i), open: c, high: c + 0.3, low: c - 0.3, close: c, volume: 1e6 };
});

test('Bậc thang giá: cắt lỗ < hỗ trợ 2 < hỗ trợ 1 < giá < kháng cự 1 < kháng cự 2, đúng bước giá', () => {
  const L = priceLevels(bars, { atr: 0.5, ma20: 24, ma50: 23.5, ma200: null });
  assert.ok(L.stop < (L.s2 ?? L.s1) && (L.s2 ?? 0) < L.s1 && L.s1 < L.close && L.close < L.r1 && L.r1 < L.r2, JSON.stringify(L));
  assert.ok(L.stop >= L.close * 0.9 - 0.05, 'rủi ro không quá 10%');
  for (const k of ['r2', 'r1', 's1', 'stop']) {
    const t = tick(L[k]);
    assert.ok(Math.abs(L[k] / t - Math.round(L[k] / t)) < 1e-6, `${k}=${L[k]} không đúng bước giá ${t}`);
  }
});

test('Chia cổ phiếu: lô 100 khi ≥ 300 cp, dư dồn vào bước cuối', () => {
  assert.deepEqual(splitShares(1000, [1 / 3, 1 / 3, 1 / 3]), [300, 300, 400]);
  assert.deepEqual(splitShares(20, [0.5, 0.5]), [10, 10]);
});

const L = { r2: 22.2, r1: 21.2, close: 20.9, s1: 20.75, s2: 20.1, stop: 19.85, atr: 0.42 };

test('NÊN MUA, chưa có: một lệnh LO ở giá đóng cửa, đủ một suất, cảnh báo xa, giữ 40 phiên', () => {
  const { fresh } = tradeSteps('BUY', { ...L, stop: 17.75 }, { weight: 0.1 });
  const buys = fresh.filter((x) => x.side === 'buy');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].price, L.close);
  assert.equal(buys[0].portion, 0.1);
  assert.match(fresh.find((x) => x.side === 'stop').condition, /dưới 17,75 \(−15% giá mua\)/);
  assert.match(fresh.at(-1).condition, /Giữ khoảng 40 phiên/);
  assert.equal(tradeSteps('ACCUMULATE', L, { weight: 0.1 }).fresh[0].portion, 0.05); // mua thăm dò nửa suất
});

test('Đang nắm giữ: giữ đến hạn 40 phiên, đến hạn mà rời nhóm mua thì bán; ⛔ cân nhắc bán sớm', () => {
  const h = { qty: 3000, avgCost: 23, pnlPct: -0.09 };
  const early = tradeSteps('HOLD', L, { holding: h, heldSessions: 10, holdStop: 19.55 }).hold;
  assert.equal(early[0].side, 'wait');
  assert.match(early[0].condition, /đã giữ 10\/40 phiên/);
  assert.equal(early.find((x) => x.side === 'stop').shares, 3000);
  const due = tradeSteps('HOLD', L, { holding: h, heldSessions: 40, holdStop: 19.55 }).hold;
  assert.equal(due[0].side, 'sell');
  assert.equal(due[0].shares, 3000);
  assert.match(tradeSteps('AVOID', L, { holding: h, avoid: true, holdStop: 19.55 }).hold[0].condition, /⛔/);
  // Đã dưới ngưỡng cảnh báo: nhắc lên đầu, không bình quân giá xuống
  const t2 = tradeSteps('HOLD', { ...L, close: 19 }, { holding: { qty: 500, avgCost: 23 }, holdStop: 19.55 });
  assert.match(t2.hold[0].condition, /dưới ngưỡng cảnh báo 19,55/);
});
