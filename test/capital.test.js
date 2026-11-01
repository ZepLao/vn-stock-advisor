import test from 'node:test';
import assert from 'node:assert/strict';
import { cashLedger, capitalSummary, priceOutOfRange } from '../src/portfolio.js';
import { planOrders, formatCloseReport } from '../src/telegram.js';
import { parseCommand, parseAmount, handleMessage, capitalText } from '../src/telegrambot.js';

const fees = { brokerage: 0.0015, sellTax: 0.001 };
const sessions = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'];

test('Sổ tiền mặt: nạp / mua / bán / rút, tiền bán chưa đủ T+2 là "chờ về"', () => {
  const tx = [
    { id: 't1', seq: 1, type: 'BUY', symbol: 'HPG', qty: 1000, price: 20, date: '2026-10-20' }, // −20,03 tr
    { id: 't2', seq: 2, type: 'SELL', symbol: 'HPG', qty: 1000, price: 22, date: '2026-10-27' }, // +21,945 tr, mới 1 phiên
  ];
  const cash = [
    { id: 'c1', seq: 1, type: 'DEPOSIT', amount: 50e6, date: '2026-10-19' },
    { id: 'c2', seq: 2, type: 'WITHDRAW', amount: 5e6, date: '2026-10-21' },
  ];
  const l = cashLedger(tx, cash, sessions, fees);
  assert.equal(l.known, true);
  assert.equal(l.balance, Math.round(50e6 - 20e6 * 1.0015 - 5e6 + 22e6 * (1 - 0.0025)));
  assert.equal(l.pendingSale, Math.round(22e6 * (1 - 0.0025)));
  assert.equal(l.available, l.balance - l.pendingSale);
  assert.equal(l.netContributed, 45e6);
  assert.equal(l.events.at(-1).label, 'Bán HPG 1000 × 22');
  assert.equal(cashLedger(tx, [], sessions, fees).known, false);
});

test('Đặt số dư khớp CTCK: tính sau giao dịch cùng ngày, phần chênh là điều chỉnh', () => {
  const tx = [{ id: 't1', seq: 1, type: 'BUY', symbol: 'FPT', qty: 100, price: 100, date: '2026-10-22' }];
  const cash = [
    { id: 'c1', seq: 1, type: 'DEPOSIT', amount: 30e6, date: '2026-10-20' },
    { id: 'c2', seq: 2, type: 'SET', amount: 19e6, date: '2026-10-22' }, // số dư ở CTCK cuối ngày
  ];
  const l = cashLedger(tx, cash, sessions, fees);
  assert.equal(l.balance, 19e6);
  assert.equal(l.adjust, Math.round(19e6 - (30e6 - 10e6 * 1.0015)));
});

test('Bức tranh vốn: NAV, tỷ lệ, lãi so với tiền nạp, số suất theo vốn và cảnh báo tiền âm', () => {
  const ledger = { known: true, balance: 40e6, available: 40e6, pendingSale: 0, netContributed: 100e6, deposits: 120e6, withdrawals: 20e6 };
  const holdings = [{ symbol: 'HPG', marketValue: 35e6, cost: 30e6 }, { symbol: 'FPT', marketValue: 30e6, cost: 25e6 }];
  const c = capitalSummary(ledger, holdings, { envCapital: null, core: { symbol: null, pct: 0 } });
  assert.equal(c.nav, 105e6);
  assert.equal(c.totalPnl, 5e6);
  assert.equal(c.invested, 55e6);
  assert.equal(c.remainingCash, 45e6); // 100e6 - 55e6
  assert.equal(c.warning, undefined); // remainingCash > 0 -> không cảnh báo âm
  assert.ok(Math.abs(c.stockPct - 65 / 105) < 1e-9);
  assert.equal(c.slots, 7); // ≥ 50 triệu
  assert.equal(c.slotValue, 15e6);
  assert.equal(c.freeSlots, 5);

  // Khi tiền đã mua vượt vốn nạp: remainingCash < 0 -> cảnh báo âm
  const overInvested = capitalSummary({ known: true, balance: 10e6, available: 10e6, pendingSale: 0, netContributed: 50e6 },
    [{ symbol: 'HPG', marketValue: 60e6, cost: 65e6 }], { envCapital: null, core: { pct: 0 } });
  assert.equal(overInvested.remainingCash, -15e6);
  assert.match(overInvested.warning, /Tiền mặt âm/);

  // Lõi ETF 50%: vốn chọn mã 52,5 tr vẫn 7 suất, mã ETF không tính là một suất
  const withCore = capitalSummary(ledger, [...holdings, { symbol: 'E1VFVN30', marketValue: 0 }], { envCapital: null, core: { symbol: 'E1VFVN30', pct: 0.5 } });
  assert.equal(withCore.slotValue, 7.5e6);
  assert.equal(withCore.picks, 2);
  // Vốn nhỏ: khuyên ETF; chưa có sổ tiền mặt: dùng ACCOUNT_CAPITAL
  assert.equal(capitalSummary({ known: true, balance: 3e6, available: 3e6, pendingSale: 0, netContributed: 5e6 }, [{ symbol: 'A', marketValue: 2e6 }], { envCapital: null, core: { pct: 0 } }).slots, 0);
  const env = capitalSummary({ known: false, balance: null, available: null, pendingSale: 0 }, holdings, { envCapital: 200e6, core: { pct: 0 } });
  assert.equal(env.source, 'env');
  assert.equal(env.nav, 200e6);
  assert.match(capitalSummary({ known: true, balance: -1e6, available: -1e6, pendingSale: 0, netContributed: 0 }, [], { envCapital: null, core: { pct: 0 } }).warning, /Tiền mặt âm/);
});

test('Bản tin: lệnh mua không vượt tiền mặt, nói rõ thiếu bao nhiêu', () => {
  const cand = (symbol, close) => ({ a: { symbol, price: { close }, ranking: { score: 80 }, brief: { code: 'BUY', levels: { buyTo: close, stop: close * 0.85 } } }, sector: symbol });
  const p = planOrders({ held: [], candidates: [cand('AAA', 20), cand('BBB', 30), cand('CCC', 10)], capital: 70e6, cash: 15e6, slots: 7 });
  // 1 suất = 10 tr: AAA mua 500 cp (10 tr); còn ~5 tr: BBB chỉ đủ 100 cp (3 tr); còn ~2 tr: CCC 200 cp
  assert.deepEqual(p.buys.map((b) => [b.symbol, b.shares]), [['AAA', 500], ['BBB', 100], ['CCC', 100]]);
  assert.ok(p.cash.used <= 15e6);
  assert.ok(p.cash.short > 0);
  const t = formatCloseReport({ date: '2026-10-28', market: null, regime: null, plan: p });
  assert.match(t, /Tiền mặt dùng được <b>15 tr<\/b> · dùng .* cho 3 lệnh · <b>thiếu .* tr<\/b> để mua đủ suất/);
  // Hết tiền: không lệnh mua nào
  assert.equal(planOrders({ held: [], candidates: [cand('AAA', 20)], capital: 70e6, cash: 500e3, slots: 7 }).buys.length, 0);
});

test('Bot: đọc số tiền và lệnh nạp / rút / số dư / vốn; ghi qua portfolio và hoàn tác được', async () => {
  assert.equal(parseAmount('50tr'), 50e6);
  assert.equal(parseAmount('1,5tỷ'), 1.5e9);
  assert.equal(parseAmount('500k'), 5e5);
  assert.equal(parseAmount('50.000.000'), 50e6);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.deepEqual(parseCommand('rút 10 triệu 21/10', '2026-10-28'), { cmd: 'cash', type: 'WITHDRAW', amount: 10e6, date: '2026-10-21' });
  assert.deepEqual(parseCommand('vốn'), { cmd: 'capital' });

  const added = [];
  const cap = { source: 'portfolio', invested: 0, nav: 50e6, cash: 50e6, stockValue: 0, pendingSale: 0, netContributed: 50e6, totalPnl: 0, slots: 7, slotValue: 7.14e6, picks: 0, freeSlots: 7 };
  const portfolio = {
    addCash: async (b) => { const x = { id: `c${added.length}`, ...b }; added.push(x); return x; },
    removeCash: async (id) => { added.splice(added.findIndex((x) => x.id === id), 1); },
    getCapitalInfo: async () => cap,
    addTransaction: async () => { throw new Error('không dùng'); }, removeTransaction: async () => {}, getPortfolio: async () => ({ holdings: [] }),
  };
  const r = await handleMessage('nạp 50tr', { portfolio });
  assert.match(r, /Đã ghi nạp tiền <b>50 tr<\/b>/);
  assert.match(r, /Vốn 50 tr · đã mua 0 tr/);
  assert.match(r, /Tiền mặt còn <b>50 tr<\/b>/);
  assert.equal(added.length, 1);
  assert.match(await handleMessage('hoàn tác', { portfolio }), /Đã xóa dòng tiền: Nạp tiền 50 tr/);
  assert.equal(added.length, 0);
  assert.match(capitalText({ source: null }), /Chưa nhập vốn/);
});

test('Giá lệnh ngoài biên phiên (nhập nhầm giá) bị phát hiện, giá khớp hợp lý thì không', () => {
  const bars = [{ time: '2026-10-23', low: 23.65, high: 24.1 }];
  assert.deepEqual(priceOutOfRange({ id: 'x', symbol: 'VPB', type: 'BUY', date: '2026-10-23', price: 55.42 }, bars),
    { id: 'x', symbol: 'VPB', type: 'BUY', date: '2026-10-23', price: 55.42, low: 23.65, high: 24.1 });
  assert.equal(priceOutOfRange({ symbol: 'VPB', date: '2026-10-23', price: 24.2 }, bars), null); // lệch nhẹ ≤ 3%
  assert.equal(priceOutOfRange({ symbol: 'VPB', date: '2026-10-24', price: 55 }, bars), null); // không có dữ liệu phiên
});

test('Dòng tiền tách khỏi lời lỗ: tiền mặt = vốn − đã mua + lãi đã chốt', async () => {
  const { buildPositions } = await import('../src/portfolio.js');
  const tx = [
    { id: 't1', seq: 1, type: 'BUY', symbol: 'GMD', qty: 32, price: 55.42, date: '2026-10-22' },
    { id: 't2', seq: 2, type: 'BUY', symbol: 'VPB', qty: 100, price: 23.71, date: '2026-10-23' },
    { id: 't3', seq: 3, type: 'BUY', symbol: 'VTP', qty: 20, price: 46.81, date: '2026-10-15' },
    { id: 't4', seq: 4, type: 'SELL', symbol: 'VPB', qty: 50, price: 25, date: '2026-10-26' },
  ];
  const l = cashLedger(tx, [{ id: 'c1', seq: 1, type: 'DEPOSIT', amount: 5e6, date: '2026-10-14' }], sessions, fees);
  const { positions, closed } = buildPositions(tx, fees);
  const holdings = positions.filter((p) => p.qty > 0).map((p) => ({ symbol: p.symbol, cost: p.cost, marketValue: 1 }));
  const c = capitalSummary(l, holdings, { envCapital: null, core: { pct: 0 }, realized: closed.reduce((s, x) => s + x.pnl, 0) });
  assert.ok(Math.abs(c.cash - (c.netContributed - c.invested + c.realized + c.dividends)) <= 2);
  assert.ok(c.realized > 0);
});
