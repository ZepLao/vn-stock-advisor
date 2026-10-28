// Danh mục đầu tư thực tế: nhật ký mua/bán → vị thế (giá vốn bình quân), lãi/lỗ sau phí và thuế,
// khối lượng bán được theo T+2, X-quang rủi ro danh mục (tham khảo risk_xray của Vibe-Trading)
// và chẩn đoán hành vi giao dịch từ các lệnh đã đóng (bản rút gọn của Shadow Account).
// Dữ liệu lưu ở data/portfolio.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, getCompanyInfo, screenCriteria } from './data.js';
import { technicalAnalysis } from './analyze.js';
import { DEFAULTS, maxDrawdown } from './backtest.js';
import { alignReturns, stdev, historicalVar, historicalCvar, correlation, beta } from './risk.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'portfolio.json');
const BROKERAGE = Number(process.env.FEE_BROKERAGE) || DEFAULTS.brokerage;
const SELL_TAX = DEFAULTS.sellTax;
const SETTLEMENT = DEFAULTS.settlementBars;

let state = null;
let saving = Promise.resolve();

async function load() {
  if (state) return state;
  try { state = JSON.parse(await readFile(FILE, 'utf8')); } catch { state = {}; }
  state.transactions ??= [];
  return state;
}

function save() {
  saving = saving.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(state, null, 2), 'utf8');
  }).catch((err) => console.error('Lỗi ghi danh mục:', err.message));
  return saving;
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const DAY = 86_400_000;
const byDate = (a, b) => a.date.localeCompare(b.date) || a.seq - b.seq;

/**
 * Dựng vị thế từ nhật ký giao dịch theo phương pháp giá vốn bình quân (như các CTCK Việt Nam).
 * Giá vốn gồm cả phí mua; lãi đã chốt trừ phí bán và thuế TNCN.
 */
export function buildPositions(transactions, fees = { brokerage: BROKERAGE, sellTax: SELL_TAX }) {
  const pos = new Map();
  const closed = [];
  for (const t of [...transactions].sort(byDate)) {
    const p = pos.get(t.symbol) || { symbol: t.symbol, qty: 0, cost: 0, openedAt: null, lots: [], realized: 0 };
    const gross = t.qty * t.price * 1000;
    if (t.type === 'BUY') {
      if (!p.qty) p.openedAt = t.date;
      p.qty += t.qty;
      p.cost += gross * (1 + fees.brokerage);
      p.lots.push({ date: t.date, qty: t.qty });
    } else {
      const qty = Math.min(t.qty, p.qty);
      if (!qty) continue;
      const avg = p.cost / p.qty;
      const proceeds = qty * t.price * 1000 * (1 - fees.brokerage - fees.sellTax);
      const pnl = proceeds - avg * qty;
      closed.push({
        symbol: t.symbol, date: t.date, qty, sellPrice: t.price, avgCost: round(avg / 1000, 3),
        pnl: Math.round(pnl), returnPct: round((pnl / (avg * qty)) * 100, 2),
        holdDays: p.openedAt ? Math.round((Date.parse(t.date) - Date.parse(p.openedAt)) / DAY) : null,
      });
      p.realized += pnl;
      p.cost -= avg * qty;
      p.qty -= qty;
      // Bán trừ vào lô cũ nhất trước để biết lô nào còn chờ về (T+2)
      let left = qty;
      while (left > 0 && p.lots.length) {
        const take = Math.min(left, p.lots[0].qty);
        p.lots[0].qty -= take;
        left -= take;
        if (!p.lots[0].qty) p.lots.shift();
      }
      if (!p.qty) { p.cost = 0; p.openedAt = null; }
    }
    pos.set(t.symbol, p);
  }
  return { positions: [...pos.values()], closed };
}

/** Khối lượng chưa bán được: lô mua chưa đủ `SETTLEMENT` phiên tính đến phiên gần nhất. */
export function pendingQty(lots, sessionDates, settlement = SETTLEMENT) {
  return lots.reduce((s, lot) => {
    const after = sessionDates.filter((d) => d > lot.date).length;
    return after < settlement ? s + lot.qty : s;
  }, 0);
}

/** Chẩn đoán hành vi từ các lệnh bán đã chốt. */
export function behavior(closed) {
  if (!closed.length) return null;
  const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl <= 0);
  const holdW = mean(wins.map((c) => c.holdDays).filter((v) => v != null));
  const holdL = mean(losses.map((c) => c.holdDays).filter((v) => v != null));
  const grossW = wins.reduce((s, c) => s + c.pnl, 0), grossL = -losses.reduce((s, c) => s + c.pnl, 0);
  const avgW = mean(wins.map((c) => c.returnPct)), avgL = mean(losses.map((c) => c.returnPct));
  const insights = [];
  if (closed.length >= 4 && holdW != null && holdL != null && holdL > holdW * 1.3) {
    insights.push({ tone: 'down', text: `Gồng lỗ: giữ lệnh lỗ trung bình ${Math.round(holdL)} ngày, lâu hơn lệnh lãi (${Math.round(holdW)} ngày). Đây là "hiệu ứng tâm lý bán lãi giữ lỗ" — nên đặt cắt lỗ trước khi mua.` });
  }
  if (avgW != null && avgL != null && Math.abs(avgL) > avgW * 1.2) {
    insights.push({ tone: 'down', text: `Lỗ trung bình ${avgL.toFixed(1)}% lớn hơn lãi trung bình +${avgW.toFixed(1)}%: lãi ăn non, lỗ để lâu. Cần tỷ lệ thắng trên ${Math.round((Math.abs(avgL) / (Math.abs(avgL) + avgW)) * 100)}% mới hòa vốn.` });
  }
  const bigLosses = losses.filter((c) => c.returnPct <= -10);
  if (bigLosses.length) insights.push({ tone: 'down', text: `${bigLosses.length} lệnh lỗ trên 10% (${bigLosses.map((c) => c.symbol).join(', ')}): kỷ luật cắt lỗ chưa chặt.` });
  const quick = closed.filter((c) => c.holdDays != null && c.holdDays <= 5).length;
  if (closed.length >= 4 && quick / closed.length >= 0.5) {
    insights.push({ tone: 'ref', text: `${quick}/${closed.length} lệnh nắm giữ ≤ 5 ngày: giao dịch lướt sóng nhiều, phí và thuế bào mòn lợi nhuận.` });
  }
  if (closed.length >= 4 && wins.length / closed.length >= 0.55 && grossW > grossL) {
    insights.push({ tone: 'up', text: `Tỷ lệ thắng ${Math.round((wins.length / closed.length) * 100)}% và tổng lãi lớn hơn tổng lỗ: phương pháp hiện tại đang hiệu quả.` });
  }
  return {
    closedCount: closed.length,
    winRate: wins.length / closed.length,
    avgWinPct: round(avgW), avgLossPct: round(avgL),
    avgHoldWin: round(holdW, 0), avgHoldLoss: round(holdL, 0),
    profitFactor: grossL > 0 ? round(grossW / grossL) : null,
    realized: Math.round(grossW - grossL),
    insights,
  };
}

/** X-quang rủi ro danh mục theo tỷ trọng hiện tại và ~1 năm giá. */
export function riskXray(holdings, bars, indexBars) {
  const total = holdings.reduce((s, h) => s + h.marketValue, 0);
  if (!total) return null;
  const w = Object.fromEntries(holdings.map((h) => [h.symbol, h.marketValue / total]));
  const hhi = Object.values(w).reduce((s, v) => s + v * v, 0);
  const series = Object.fromEntries(holdings.map((h) => [h.symbol, bars[h.symbol]]).filter(([, b]) => b?.length));
  if (indexBars?.length) series.__INDEX = indexBars;
  const { dates, returns } = alignReturns(series, 250);
  const syms = holdings.map((h) => h.symbol).filter((s) => returns[s]);
  const out = {
    concentration: { hhi: round(hhi, 3), effectiveN: round(1 / hhi, 1), top: holdings.reduce((a, b) => (a.marketValue >= b.marketValue ? a : b)).symbol, topWeight: round(Math.max(...Object.values(w)), 3) },
    days: dates.length,
  };
  const warnings = [];
  if (out.concentration.topWeight > 0.4 && holdings.length > 1) warnings.push(`${out.concentration.top} chiếm ${Math.round(out.concentration.topWeight * 100)}% danh mục: rủi ro tập trung cao.`);
  if (dates.length >= 20 && syms.length) {
    const port = dates.map((_, t) => syms.reduce((s, sym) => s + w[sym] * returns[sym][t], 0));
    const vol = stdev(port) * Math.sqrt(252);
    const var95 = historicalVar(port), cvar95 = historicalCvar(port);
    let eq = 1;
    const curve = port.map((r) => (eq *= 1 + r));
    const indVol = syms.reduce((s, sym) => s + w[sym] * stdev(returns[sym]) * Math.sqrt(252), 0);
    const pairs = [];
    for (let a = 0; a < syms.length; a++) {
      for (let b = a + 1; b < syms.length; b++) pairs.push({ a: syms[a], b: syms[b], corr: correlation(returns[syms[a]], returns[syms[b]]) });
    }
    const valid = pairs.filter((p) => p.corr != null);
    const top = valid.sort((x, y) => y.corr - x.corr)[0] || null;
    Object.assign(out, {
      volatility: round(vol, 4),
      var95: round(var95, 4), cvar95: round(cvar95, 4),
      var95Value: Math.round(var95 * total), cvar95Value: Math.round(cvar95 * total),
      maxDrawdown: round(maxDrawdown(curve, 1), 4),
      beta: returns.__INDEX ? round(beta(port, returns.__INDEX), 2) : null,
      diversificationRatio: vol ? round(indVol / vol, 2) : null,
      avgCorrelation: valid.length ? round(mean(valid.map((p) => p.corr)), 2) : null,
      topPair: top ? { a: top.a, b: top.b, corr: round(top.corr, 2) } : null,
    });
    if (out.avgCorrelation != null && out.avgCorrelation > 0.6) warnings.push(`Tương quan trung bình giữa các mã ${out.avgCorrelation}: các mã thường cùng tăng cùng giảm, đa dạng hóa kém.`);
    if (var95 > 0.035) warnings.push(`VaR95 1 phiên ${(var95 * 100).toFixed(1)}% (≈ ${(out.var95Value / 1e6).toFixed(1)} triệu đồng): danh mục biến động mạnh.`);
    if (out.beta != null && out.beta > 1.3) warnings.push(`Beta ${out.beta}: danh mục khuếch đại biến động của VN-Index.`);
  }
  out.warnings = warnings;
  return out;
}

/**
 * Vị thế đang nắm giữ của một mã (null nếu không có): số lượng, giá vốn, lãi/lỗ tạm tính, số bán được ngay.
 * Dùng cho phần "nếu đang nắm giữ" trong tóm tắt mỗi mã.
 */
export async function getHolding(symbol, close = null) {
  await load();
  if (!state.transactions.some((t) => t.symbol === symbol)) return null;
  const p = buildPositions(state.transactions).positions.find((x) => x.symbol === symbol && x.qty > 0);
  if (!p) return null;
  const sessions = (await getPriceHistory('VNINDEX').catch(() => null))?.bars.map((b) => b.time) || [];
  const pending = Math.min(p.qty, pendingQty(p.lots, sessions));
  const avgCost = p.cost / p.qty / 1000;
  const net = close != null ? p.qty * close * 1000 * (1 - BROKERAGE - SELL_TAX) : null;
  return {
    qty: p.qty, sellable: p.qty - pending, pending,
    avgCost: round(avgCost, 3), openedAt: p.openedAt,
    pnl: net != null ? Math.round(net - p.cost) : null,
    pnlPct: net != null ? round(net / p.cost - 1, 4) : null,
  };
}

/**
 * Vị thế đang mở để định cỡ lệnh mới: giá trị và cắt lỗ kỹ thuật (cùng cách tính với bảng danh mục).
 * @returns {Promise<{ symbol: string, value: number, close: number|null, stop: number|null }[]>}
 */
export async function getOpenRisk() {
  await load();
  const open = buildPositions(state.transactions).positions.filter((p) => p.qty > 0);
  const res = await Promise.all(open.map((p) => getPriceHistory(p.symbol).catch(() => null)));
  return open.map((p, k) => {
    const b = res[k]?.bars;
    const close = b?.at(-1)?.close ?? null;
    const stop = b?.length >= 30 ? technicalAnalysis(b, null, {}).plan?.stopLoss ?? null : null;
    return { symbol: p.symbol, value: close != null ? p.qty * close * 1000 : p.cost, close, stop };
  });
}

/** Các mã đang nắm giữ (số lượng > 0). */
export async function heldSymbols() {
  await load();
  return buildPositions(state.transactions).positions.filter((p) => p.qty > 0).map((p) => p.symbol);
}

/** Báo cáo danh mục đầy đủ cho giao diện. */
export async function getPortfolio() {
  await load();
  const { positions, closed } = buildPositions(state.transactions);
  const open = positions.filter((p) => p.qty > 0);
  const [indexRes, ...priceRes] = await Promise.all([
    getPriceHistory('VNINDEX').catch(() => null),
    ...open.map((p) => getPriceHistory(p.symbol).catch(() => null)),
  ]);
  const sessions = indexRes?.bars.map((b) => b.time) || [];
  const bars = {};
  const holdings = open.map((p, k) => {
    const b = priceRes[k]?.bars;
    bars[p.symbol] = b;
    const close = b?.at(-1)?.close ?? null;
    const prev = b?.at(-2)?.close ?? close;
    const marketValue = close != null ? p.qty * close * 1000 : 0;
    const net = marketValue * (1 - BROKERAGE - SELL_TAX);
    let tech = null;
    if (b?.length >= 30) {
      const t = technicalAnalysis(b, null, {});
      tech = { score: t.score, trend: t.overview.find((o) => o.key === 'trend')?.verdict, stopLoss: t.plan?.stopLoss, target: t.plan?.target };
    }
    const pending = Math.min(p.qty, pendingQty(p.lots, sessions));
    return {
      symbol: p.symbol, qty: p.qty, sellable: p.qty - pending, pending,
      avgCost: round(p.cost / p.qty / 1000, 3), close, priceDate: b?.at(-1)?.time ?? null,
      marketValue: Math.round(marketValue), cost: Math.round(p.cost),
      unrealized: Math.round(net - p.cost), unrealizedPct: round(((net - p.cost) / p.cost) * 100, 2),
      dayChange: close != null ? Math.round(p.qty * (close - prev) * 1000) : null,
      realized: Math.round(p.realized), openedAt: p.openedAt, tech,
      belowStop: tech?.stopLoss != null && close != null && close < tech.stopLoss,
    };
  }).sort((a, b) => b.marketValue - a.marketValue);

  const total = holdings.reduce((s, h) => s + h.marketValue, 0);
  holdings.forEach((h) => (h.weight = total ? round(h.marketValue / total, 4) : 0));
  const cost = holdings.reduce((s, h) => s + h.cost, 0);
  const unrealized = holdings.reduce((s, h) => s + h.unrealized, 0);
  return {
    updatedAt: new Date().toISOString(),
    fees: { brokerage: BROKERAGE, sellTax: SELL_TAX },
    summary: {
      marketValue: total, cost, unrealized, unrealizedPct: cost ? round((unrealized / cost) * 100, 2) : null,
      dayChange: holdings.reduce((s, h) => s + (h.dayChange || 0), 0),
      realized: Math.round(closed.reduce((s, c) => s + c.pnl, 0)),
      positions: holdings.length,
    },
    holdings,
    risk: holdings.length ? riskXray(holdings, bars, indexRes?.bars) : null,
    behavior: behavior(closed),
    closed: closed.slice().reverse(),
    transactions: [...state.transactions].sort(byDate).reverse(),
  };
}

const SYMBOL_RE = /^[A-Z0-9]{3,10}$/;

/** Thêm một giao dịch. Bán vượt số đang có (tính đến ngày bán) bị từ chối. */
export async function addTransaction(body) {
  await load();
  const type = String(body.type || '').toUpperCase();
  const symbol = String(body.symbol || '').trim().toUpperCase();
  const qty = Math.floor(Number(body.qty));
  const price = Number(body.price);
  const date = String(body.date || new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10));
  if (!['BUY', 'SELL'].includes(type)) throw new Error('Loại giao dịch phải là BUY hoặc SELL');
  if (!SYMBOL_RE.test(symbol)) throw new Error('Mã chứng khoán không hợp lệ');
  if (!(qty > 0)) throw new Error('Khối lượng phải là số nguyên dương');
  if (!(price > 0 && price < 10_000)) throw new Error('Giá không hợp lệ (đơn vị nghìn đồng, ví dụ 58.2)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error('Ngày không hợp lệ (YYYY-MM-DD)');
  if (Date.parse(date) > Date.now() + DAY) throw new Error('Ngày giao dịch không được ở tương lai');

  const { floors } = screenCriteria();
  const info = await getCompanyInfo(symbol).catch(() => undefined);
  if (info === null) throw new Error(`Không tìm thấy mã ${symbol}`);
  if (info?.exchange && !floors.includes(info.exchange)) throw new Error(`${symbol} niêm yết trên sàn ${info.exchange}. Tool chỉ theo dõi cổ phiếu sàn ${floors.join(', ')}.`);

  const seq = (state.transactions.reduce((m, t) => Math.max(m, t.seq || 0), 0)) + 1;
  const tx = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, seq, type, symbol, qty, price, date, note: String(body.note || '').slice(0, 200) };
  if (type === 'SELL') {
    const upto = buildPositions(state.transactions.filter((t) => t.date <= date)).positions.find((p) => p.symbol === symbol);
    const have = upto?.qty || 0;
    if (qty > have) throw new Error(`Không đủ cổ phiếu để bán: đến ngày ${date} chỉ có ${have} ${symbol}`);
  }
  state.transactions.push(tx);
  await save();
  return tx;
}

export async function removeTransaction(id) {
  await load();
  const before = state.transactions.length;
  state.transactions = state.transactions.filter((t) => t.id !== id);
  if (state.transactions.length === before) throw new Error('Không tìm thấy giao dịch');
  await save();
  return { ok: true };
}
