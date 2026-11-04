import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newAccount, stepSession, applyFunding, formatAutoTradeMessage, AUTO_RULES } from '../src/autotrade.js';
import { simulateRolling, ROLLING_RULES } from '../src/rolling.js';
import { factorReader } from '../src/ranking.js';

// Lịch 320 phiên và 12 mã: nửa đầu đi lên đều (thành ứng viên), nửa sau đi ngang / xuống; giá trị khớp lớn (đủ thanh khoản)
const N = 320;
const day = (k) => new Date(Date.UTC(2024, 0, 1) + k * 86400_000).toISOString().slice(0, 10);
const cal = Array.from({ length: N }, (_, k) => ({ time: day(k), open: 1000, high: 1000, low: 1000, close: 1000 + k }));
function series(seed, drift) {
  let p = 20 + seed;
  return Array.from({ length: N }, (_, k) => {
    const wave = Math.sin((k + seed * 7) / 9) * 0.012;
    const prev = p;
    p = Math.max(2, p * (1 + drift + wave));
    return { time: day(k), open: +(prev * (1 + wave / 3)).toFixed(2), high: +(Math.max(prev, p) * 1.01).toFixed(2), low: +(Math.min(prev, p) * 0.99).toFixed(2), close: +p.toFixed(2), volume: 3e6 };
  });
}
function makeData() {
  const data = {};
  for (let k = 0; k < 12; k++) {
    const bars = series(k, k < 6 ? 0.002 + k * 0.0004 : -0.0005 + (k - 6) * 0.0002);
    data[`M${String.fromCharCode(65 + k)}`] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars), ex: 'HOSE' };
  }
  return data;
}
const sectorOf = (s) => (s < 'MD' ? 'A' : s < 'MH' ? 'B' : 'C');
const START = 260;

test('Tài khoản tự đầu tư đi đúng quy trình cuốn chiếu: khớp từng phiên bằng kết quả mô phỏng 3 năm (lô 100)', () => {
  const data = makeData();
  const sim = simulateRolling(cal, data, { ...ROLLING_RULES, maxExposure: AUTO_RULES.maxExposure, start: START, minValue: 1e9, initialCash: 1e9, sectorOf });
  const st = newAccount(1e9, day(START - 1));
  for (let t = START; t < N; t++) stepSession(st, { date: day(t), index: cal[t].close, data, universe: null, minValue: 1e9, sectorOf }, { ...AUTO_RULES, lot: 100 });
  const buys = st.orders.filter((o) => o.side === 'BUY').length;
  assert.ok(buys > 0, 'phải có lệnh mua');
  assert.ok(sim.trades.length > 0, 'mô phỏng phải có lệnh bán');
  assert.equal(st.orders.filter((o) => o.side === 'SELL').length, sim.trades.length, 'cùng số lệnh bán');
  assert.ok(Math.abs(st.equity.at(-1).nav - sim.equity.at(-1).value) < 1, `NAV ${st.equity.at(-1).nav} vs ${sim.equity.at(-1).value}`);
  assert.deepEqual(Object.keys(st.positions).sort(), [...sim.positions].sort());
});

test('stepSession: quyết định sau đóng cửa, khớp giá mở cửa phiên sau, lô lẻ, trừ phí', () => {
  const data = makeData();
  const st = newAccount(5_000_000, day(START - 1));
  stepSession(st, { date: day(START), data, universe: null, minValue: 1e9, sectorOf });
  assert.equal(st.orders.length, 0, 'phiên đầu chỉ ra lệnh, chưa khớp');
  assert.ok(st.pendingBuy.length > 0);
  assert.ok(st.pendingBuy.every((b) => b.decidedOn === day(START)));
  const first = st.pendingBuy[0];
  stepSession(st, { date: day(START + 1), data, universe: null, minValue: 1e9, sectorOf });
  const o = st.orders.find((x) => x.symbol === first.s);
  const open = data[first.s].bars[START + 1].open;
  assert.ok(o.price >= open && o.price <= open * 1.002, 'giá mở cửa + trượt giá');
  assert.ok(Number.isInteger(o.shares) && o.shares > 0);
  assert.ok(o.value <= first.budget, 'không vượt ngân sách suất');
  assert.ok(st.cash >= 0 && st.cash < 5_000_000);
  assert.equal(st.equity.length, 2);
});

test('stepSession: cổ mua phiên T về chiều T+2, bán mở cửa sớm nhất phiên T+3; mở cửa giá trần thì không mua', () => {
  const data = makeData();
  const st = newAccount(5_000_000, day(START - 1));
  stepSession(st, { date: day(START), data, universe: null, minValue: 1e9, sectorOf });
  const sym = st.pendingBuy[0].s;
  // Phiên sau mở cửa trần với mã đầu tiên
  const bars = data[sym].bars, i = START + 1;
  bars[i] = { ...bars[i], open: +(bars[i - 1].close * 1.07).toFixed(2), high: +(bars[i - 1].close * 1.07).toFixed(2) };
  stepSession(st, { date: day(START + 1), data, universe: null, minValue: 1e9, sectorOf });
  assert.ok(!st.positions[sym], 'không khớp ở giá trần');
  assert.ok(st.unfilled.some((u) => u.symbol === sym && /trần/.test(u.why)));
  const other = Object.keys(st.positions)[0];
  st.pendingSell[other] = 'test';
  stepSession(st, { date: day(START + 2), data, universe: null, minValue: 1e9, sectorOf });
  assert.ok(st.positions[other], 'mở cửa T+1: chưa có cổ phiếu');
  stepSession(st, { date: day(START + 3), data, universe: null, minValue: 1e9, sectorOf });
  assert.ok(st.positions[other], 'mở cửa T+2: cổ phiếu chưa về (về chiều T+2)');
  stepSession(st, { date: day(START + 4), data, universe: null, minValue: 1e9, sectorOf });
  assert.ok(!st.positions[other], 'mở cửa T+3: đã bán');
  const sell = st.orders.find((x) => x.side === 'SELL' && x.symbol === other);
  assert.equal(sell.held, 3);
  assert.ok(sell.fee > 0 && typeof sell.pnl === 'number');
});

test('stepSession: vốn đi theo vốn thực nạp ròng (nạp thêm / rút)', () => {
  const data = makeData();
  const st = newAccount(5_000_000, day(START - 1));
  stepSession(st, { date: day(START), data, universe: null, minValue: 1e9, sectorOf, funded: 7_000_000 });
  assert.equal(st.funded, 7_000_000);
  assert.equal(st.cash, 7_000_000);
  assert.equal(st.cashFlows[0].amount, 2_000_000);
  stepSession(st, { date: day(START + 1), data, universe: null, minValue: 1e9, sectorOf, funded: 1e12 });
  const before = st.cash;
  stepSession(st, { date: day(START + 2), data, universe: null, minValue: 1e9, sectorOf, funded: 0 });
  assert.ok(st.cash >= 0, 'rút tối đa bằng tiền mặt đang có');
  assert.ok(st.cash <= before);
});

test('applyFunding: nạp vào ngay tiền mặt; rút tối đa bằng tiền mặt, phần thiếu rút tiếp lần sau', () => {
  const st = newAccount(5_000_000, '2026-11-01');
  assert.equal(applyFunding(st, 5_100_000, '2026-11-02'), 100_000);
  assert.equal(st.cash, 5_100_000);
  assert.equal(st.funded, 5_100_000);
  assert.equal(applyFunding(st, 5_100_000, '2026-11-02'), 0, 'đã khớp thì không ghi thêm');
  st.cash = 300_000; // phần lớn đã mua cổ phiếu
  assert.equal(applyFunding(st, 4_600_000, '2026-11-03'), -300_000);
  assert.equal(st.cash, 0);
  assert.equal(st.funded, 4_800_000, 'còn thiếu 200 nghìn chưa rút được');
  assert.match(st.cashFlows.at(-1).note, /một phần/);
  st.cash = 1_000_000; // bán xong
  assert.equal(applyFunding(st, 4_600_000, '2026-11-05'), -200_000);
  assert.equal(st.funded, 4_600_000);
});

test('stepSession: độ rộng thị trường dưới 50% thì không mua mới, vẫn ghi lại lý do', () => {
  const data = makeData();
  // Mọi mã đóng cửa dưới MA50 ở phiên quyết định: kéo giá phiên START xuống sâu
  for (const d of Object.values(data)) { const b = d.bars[START]; d.bars[START] = { ...b, close: +(b.close * 0.7).toFixed(2), low: +(b.close * 0.69).toFixed(2) }; }
  const st = newAccount(5_000_000, day(START - 1));
  stepSession(st, { date: day(START), data, universe: null, minValue: 1e9, sectorOf });
  assert.equal(st.lastGate.gated, true);
  assert.ok(st.lastGate.breadth < 0.5);
  assert.equal(st.pendingBuy.length, 0);
  const open = stepSession(newAccount(5_000_000, day(START - 1)), { date: day(START), data, universe: null, minValue: 1e9, sectorOf }, { ...AUTO_RULES, minBreadth: null });
  assert.ok(open.pendingBuy.length > 0, 'tắt bộ lọc thì vẫn mua');
});

test('formatAutoTradeMessage: báo lệnh đã khớp, lệnh phiên tới, tài sản; phiên không giao dịch gửi tin ngắn', () => {
  const data = makeData();
  const st = newAccount(5_000_000, day(START - 1));
  stepSession(st, { date: day(START), index: 1000, data, universe: null, minValue: 1e9, sectorOf });
  const m1 = formatAutoTradeMessage(st, [day(START)]);
  assert.match(m1, /LỆNH PHIÊN TỚI/);
  assert.match(m1, /▸ <b>MUA M[A-Z]<\/b> ~\d+ cp · tham chiếu/);
  stepSession(st, { date: day(START + 1), index: 1010, data, universe: null, minValue: 1e9, sectorOf });
  const m2 = formatAutoTradeMessage(st, [day(START + 1)]);
  assert.match(m2, /ĐÃ KHỚP/);
  assert.match(m2, /▸ <b>MUA M[A-Z]<\/b> \d+ cp × [\d,]+ = [\d.]+ đ/);
  assert.match(m2, /Đang giữ \d+ mã/);
  assert.match(m2, /VN-Index cùng kỳ \+1%/);
  stepSession(st, { date: day(START + 2), index: 1010, data, universe: null, minValue: 1e9, sectorOf });
  const quiet = formatAutoTradeMessage(st, [day(START + 2)]);
  assert.match(quiet, /Hôm nay không giao dịch: đang giữ vị thế/, 'phiên không giao dịch vẫn gửi tin ngắn');
  assert.match(quiet, /Lần ra quyết định tiếp theo: sau phiên thứ 3 kể từ hôm nay/);
  assert.doesNotMatch(quiet, /ĐÃ KHỚP|LỆNH PHIÊN TỚI/);
});

test('stepSession: luôn giữ 30% tiền mặt dự phòng, vẫn chia đủ số mã', () => {
  assert.equal(AUTO_RULES.maxExposure, 0.7);
  const data = makeData();
  const st = newAccount(5_000_000, day(START - 1));
  for (let t = START; t < START + 30; t++) {
    stepSession(st, { date: day(t), data, universe: null, minValue: 1e9, sectorOf });
    const e = st.equity.at(-1);
    assert.ok(e.cash / e.nav >= 0.28, `phiên ${t}: tiền mặt ${(e.cash / e.nav * 100).toFixed(1)}% phải ≥ ~30%`);
    const planned = st.pendingBuy.reduce((a, b) => a + b.budget, 0);
    assert.ok(e.nav - e.cash + planned <= e.nav * 0.7 + 1, 'cổ phiếu + lệnh sắp mua ≤ 70% tài sản');
  }
  assert.ok(Object.keys(st.positions).length > 0, 'vẫn mua cổ phiếu');
});
