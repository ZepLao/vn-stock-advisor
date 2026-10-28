import test from 'node:test';
import assert from 'node:assert/strict';
import { ratchetStop, holderStop, levelInputs } from '../src/tradeplan.js';
import { simulateLive, liveCode, rStats } from '../src/livebacktest.js';
import { factorReader } from '../src/ranking.js';
import { rsi } from '../src/indicators.js';

const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);

test('ratchetStop: chỉ nâng, hòa vốn đã kích hoạt thì giữ khi lãi giảm lại', () => {
  let s = ratchetStop(null, { stop: 19 }, 20, 20);
  assert.equal(s, 19);
  s = ratchetStop(s, { stop: 18 }, 19.5, 20); // bậc thang hôm nay thấp hơn: không hạ
  assert.equal(s, 19);
  s = ratchetStop(s, { stop: 19.5 }, 21.4, 20); // lãi 7% ≥ 6%: hòa vốn 20,1
  assert.ok(Math.abs(s - 20.1) < 1e-9);
  s = ratchetStop(s, { stop: 18.5 }, 20.5, 20); // lãi còn 2,5%: vẫn giữ hòa vốn
  assert.ok(Math.abs(s - 20.1) < 1e-9);
});

test('holderStop: neo từ ngày mua, giá giảm thì cắt lỗ không giảm theo', () => {
  // Tăng 150 phiên rồi giảm đều 30 phiên
  const bars = Array.from({ length: 180 }, (_, i) => {
    const c = i < 150 ? 20 + i * 0.05 + Math.sin(i / 4) * 0.4 : 27.5 - (i - 150) * 0.12;
    return { time: day(i), open: c, high: c + 0.2, low: c - 0.2, close: c, volume: 1e6 };
  });
  const stop = holderStop(bars, { openedAt: day(140), avgCost: bars[140].close });
  const close = bars.at(-1).close;
  assert.ok(stop > close, `cắt lỗ ${stop} phải trên giá ${close}: đã thủng sau đợt giảm`);
  // So với cách cũ (tính lại từ giá hôm nay) thì luôn dưới giá
  const fresh = holderStop(bars, { openedAt: bars.at(-1).time, avgCost: close });
  assert.ok(fresh < close);
});

test('liveCode: luật khuyến nghị theo điểm, MA200, rủi ro và regime', () => {
  assert.equal(liveCode(80, true, { isRisky: false }, { allowNewBuys: true }), 'BUY');
  assert.equal(liveCode(80, true, { isRisky: false }, { allowNewBuys: false }), 'HOLD');
  assert.equal(liveCode(80, false, { isRisky: false }, null), 'AVOID');
  assert.equal(liveCode(20, true, { isRisky: false }, null), 'AVOID');
  assert.equal(liveCode(80, true, { isRisky: true, riskLevel: 'CRITICAL' }, null), 'SELL');
  assert.equal(liveCode(60, true, { isRisky: true, riskLevel: 'HIGH' }, null), 'HOLD');
});

// AAA tăng đều (dẫn đầu rổ) rồi lao dốc từ phiên 250; BBB, CCC đi ngang biến động mạnh
function fixture() {
  const N = 300;
  const cal = Array.from({ length: N }, (_, i) => ({ time: day(i), open: 1000 + i, high: 1001 + i, low: 999 + i, close: 1000 + i, volume: 1e6 }));
  const mk = (fn) => Array.from({ length: N }, (_, i) => {
    const [c, r] = fn(i);
    return { time: day(i), open: c, high: c * (1 + r), low: c * (1 - r), close: c, volume: 1e6 };
  });
  const series = {
    AAA: mk((i) => [i < 250 ? 20 * 1.004 ** i * (1 + 0.01 * Math.sin(i / 3)) : 20 * 1.004 ** 250 * 0.96 ** (i - 249), 0.025]),
    BBB: mk((i) => [30 * (1 + 0.06 * Math.sin(i / 2)), 0.05]),
    CCC: mk((i) => [25 * (1 + 0.06 * Math.cos(i / 2)), 0.05]),
  };
  const data = Object.fromEntries(Object.entries(series).map(([s, bars]) => [s, {
    bars, at: new Map(bars.map((b, i) => [b.time, i])), ex: 'HOSE', read: factorReader(bars), inp: levelInputs(bars), rsi: rsi(bars.map((b) => b.close), 14),
  }]));
  return { cal, data };
}

test('simulateLive: mua theo lệnh chia lần, cắt lỗ khi lao dốc, tôn trọng T+2', () => {
  const { cal, data } = fixture();
  const sim = simulateLive(cal, data, { start: 215, minValue: 0, initialCash: 1e9, regimeFilter: false });
  const aaa = sim.trades.filter((t) => t.symbol === 'AAA');
  assert.ok(sim.stats.legsFilled > 0, 'phải có lệnh mua khớp');
  assert.ok(aaa.length > 0, 'phải có giao dịch AAA đã đóng');
  const stop = aaa.find((t) => t.reason === 'stop');
  assert.ok(stop, `AAA phải bị cắt lỗ sau khi lao dốc: ${JSON.stringify(aaa)}`);
  assert.ok(stop.exitTime > day(249));
  for (const t of sim.trades) assert.ok(t.bars >= 2, 'không bán trước T+2');
  assert.ok(!sim.positions.some((p) => p.symbol === 'AAA'));
  const r = rStats(sim.trades);
  assert.ok(r.stopN >= 1 && r.stopAvgR != null);
});
