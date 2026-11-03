// Tool tự đầu tư (tài khoản GIẤY, không đặt lệnh thật): dùng đúng số vốn thực nạp ròng của người dùng, tự chọn mã, tự mua
// bán theo quy trình danh mục cuốn chiếu đã backtest (rolling.js: điểm ≥ 70 + MA200 hoặc xu hướng chuẩn, tối đa 10 mã,
// mỗi ngành 3 mã, xét lại mỗi 5 phiên, giữ 40 phiên, không cắt lỗ sát) để kiểm chứng tool có kiếm được lợi nhuận thật không.
//
// Vận hành theo giờ thị trường:
//  - sau giờ đóng cửa (từ 15:10) xử lý phiên vừa chốt: khớp các lệnh đã quyết định ở phiên trước bằng GIÁ MỞ CỬA của
//    phiên này (trượt giá, phí, thuế; kẹt trần/sàn thì không khớp; chỉ bán được cổ phiếu đã về T+2), định giá theo giá
//    đóng cửa, rồi nếu đến phiên quyết định thì ra lệnh cho phiên tới;
//  - lô lẻ (số cổ phiếu bất kỳ): vốn nhỏ không đủ lô 100 cho mỗi suất. Khớp lô lẻ thật thường kém hơn giá mở cửa một chút;
//  - quyết định chỉ dùng dữ liệu đến phiên đó; không bao giờ sửa lệnh đã khớp (sổ lệnh chỉ ghi thêm);
//  - vốn theo "Vốn thực nạp ròng" của danh mục thật: nạp thêm / rút ra ở danh mục thật thì tài khoản này cũng nạp / rút.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, getScreenUniverse, screenCriteria, avgTradedValue, DELIST_HAIRCUT, DELIST_GAP } from './data.js';
import { DEFAULTS } from './backtest.js';
import { factorReader, poolMap } from './ranking.js';
import { ROLLING_RULES, rollingCandidates, rollingPlan, sellFillPrice, buyFillPrice, vol60, aboveMa50, breadthOf } from './rolling.js';
import { getSectorFlows } from './sectors.js';
import { getCapitalInfo } from './portfolio.js';
import { sendMessage, telegramConfig } from './telegram.js';
import { logTelegramReport } from './db.js';

const FILE = process.env.AUTOTRADE_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'autotrade.json');
export const AUTO_RULES = { ...ROLLING_RULES, lot: 1, closeAfter: 15 * 60 + 10 };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Tài khoản mới (hàm thuần). startAfter = phiên đã chốt gần nhất lúc mở: chỉ giao dịch từ phiên sau đó. */
export function newAccount(capital, startAfter, now = new Date()) {
  return {
    openedAt: now.toISOString(), startAfter, initialCapital: Math.round(capital), funded: Math.round(capital),
    cash: Math.round(capital), session: 0, firstSession: null, lastDate: null,
    positions: {}, pendingSell: {}, pendingBuy: [], orders: [], unfilled: [], equity: [], cashFlows: [],
    fees: 0, decisions: 0,
  };
}

/**
 * Cho vốn tài khoản bằng vốn thực nạp ròng hiện tại (hàm thuần, sửa `st`): chênh dương là nạp thêm vào tiền mặt, chênh âm
 * là rút (tối đa bằng tiền mặt đang có; phần còn thiếu rút tiếp khi bán xong cổ phiếu). Trả về số tiền đã nạp (+) / rút (−).
 */
export function applyFunding(st, funded, date) {
  if (funded == null || !Number.isFinite(funded) || funded === st.funded) return 0;
  const diff = Math.round(funded - st.funded);
  const amount = diff > 0 ? diff : -Math.min(-diff, Math.max(0, Math.floor(st.cash)));
  if (!amount) return 0;
  st.cash += amount;
  st.funded += amount;
  st.cashFlows.push({ date, amount, note: amount > 0 ? 'Nạp thêm theo vốn thực nạp ròng' : amount === diff ? 'Rút theo vốn thực nạp ròng' : 'Rút một phần (tiền mặt chưa đủ, phần còn lại rút khi bán)' });
  return amount;
}

const navOf = (st, closeOf) => st.cash + Object.entries(st.positions).reduce((a, [s, p]) => a + p.shares * (closeOf(s) ?? p.price) * 1000, 0);

/**
 * Xử lý một phiên đã chốt (hàm thuần, sửa trực tiếp `st`).
 * @param {object} st trạng thái tài khoản
 * @param {{ date: string, index: number|null, data: Record<string, { bars, at: Map, ex: string, read?: Function }>,
 *   universe: Set<string>|null, minValue: number, sectorOf: (s: string) => string, funded?: number|null }} ctx
 *   data: giá các mã (cả mã đang giữ / chờ mua); universe: rổ hiện tại để chọn ứng viên; funded: vốn thực nạp ròng hiện tại
 */
export function stepSession(st, ctx, R = AUTO_RULES) {
  const { date, data, universe, minValue, sectorOf } = ctx;
  const { brokerage, sellTax, slippage } = DEFAULTS;
  st.session += 1;
  st.firstSession ??= st.session;
  const t = st.session;
  const barOf = (s) => { const d = data[s], i = d?.at.get(date); return i == null ? null : { d, i }; };
  const closeOf = (s) => barOf(s)?.d.bars[barOf(s).i].close ?? st.positions[s]?.lastClose ?? null;
  const log = (o) => st.orders.push({ date, ...o });

  // 0. Vốn theo vốn thực nạp ròng (bình thường đã đồng bộ ngay lúc nạp / rút; đây là chốt chặn cuối)
  applyFunding(st, ctx.funded, date);

  // 1. Mã đang giữ đã ngừng giao dịch hẳn: thoát ở giá cuối trừ haircut
  for (const [s, p] of Object.entries(st.positions)) {
    const bars = data[s]?.bars;
    if (bars?.length && bars.at(-1).time < date && t - (p.lastSeen ?? t) >= DELIST_GAP) {
      const price = round(bars.at(-1).close * (1 - DELIST_HAIRCUT), 3);
      const gross = p.shares * price * 1000, fee = gross * (brokerage + sellTax);
      st.cash += gross - fee; st.fees += fee;
      log({ side: 'SELL', symbol: s, shares: p.shares, price, value: Math.round(gross), fee: Math.round(fee), reason: 'delisted',
        pnl: Math.round(gross - fee - p.cost), returnPct: round(((gross - fee) / p.cost - 1) * 100), entryDate: p.entryDate, held: t - p.t0 });
      delete st.positions[s]; delete st.pendingSell[s];
    }
  }

  // 2. Khớp lệnh ở giá mở cửa: bán trước, mua sau
  for (const [s, reason] of Object.entries(st.pendingSell)) {
    const p = st.positions[s], x = barOf(s);
    if (!p) { delete st.pendingSell[s]; continue; }
    if (!x || x.i < 1 || t - p.t0 < R.sellAfter) continue; // cổ phiếu chưa về: mua phiên T, về chiều T+2, bán mở cửa từ T+3
    const price = sellFillPrice(x.d.bars, x.i, x.d.ex, slippage);
    if (price == null) { st.unfilled.push({ date, side: 'SELL', symbol: s, why: 'Mở cửa giá sàn, không bán được' }); continue; }
    const gross = p.shares * price * 1000, fee = gross * (brokerage + sellTax);
    st.cash += gross - fee; st.fees += fee;
    log({ side: 'SELL', symbol: s, shares: p.shares, price, value: Math.round(gross), fee: Math.round(fee), reason,
      pnl: Math.round(gross - fee - p.cost), returnPct: round(((gross - fee) / p.cost - 1) * 100), entryDate: p.entryDate, held: t - p.t0 });
    delete st.positions[s]; delete st.pendingSell[s];
  }
  for (const b of st.pendingBuy) {
    const x = barOf(b.s);
    if (st.positions[b.s]) continue;
    if (!x || x.i < 1) { st.unfilled.push({ date, side: 'BUY', symbol: b.s, why: 'Không có giao dịch phiên này' }); continue; }
    const price = buyFillPrice(x.d.bars, x.i, x.d.ex, slippage);
    if (price == null) { st.unfilled.push({ date, side: 'BUY', symbol: b.s, why: 'Mở cửa giá trần, không mua được' }); continue; }
    const shares = Math.floor(Math.min(b.budget, st.cash) / (price * 1000 * (1 + brokerage)) / R.lot) * R.lot;
    if (shares <= 0) { st.unfilled.push({ date, side: 'BUY', symbol: b.s, why: 'Không đủ tiền cho 1 cổ phiếu' }); continue; }
    const gross = shares * price * 1000, fee = gross * brokerage;
    st.cash -= gross + fee; st.fees += fee;
    st.positions[b.s] = { shares, cost: gross + fee, price, entryDate: date, t0: t, t, score: b.score ?? null };
    log({ side: 'BUY', symbol: b.s, shares, price, value: Math.round(gross), fee: Math.round(fee), reason: b.reason || 'Ứng viên điểm cao', score: b.score ?? null, decidedOn: b.decidedOn });
  }
  st.pendingBuy = [];

  // 3. Định giá cuối phiên
  for (const [s, p] of Object.entries(st.positions)) {
    const x = barOf(s);
    if (x) { p.lastClose = x.d.bars[x.i].close; p.lastSeen = t; }
  }
  const nav = navOf(st, closeOf);
  st.equity.push({ date, nav: Math.round(nav), cash: Math.round(st.cash), funded: st.funded, index: ctx.index ?? null });
  st.lastDate = date;

  // 4. Phiên quyết định (mỗi `step` phiên kể từ phiên đầu): ra lệnh cho phiên tới
  if ((t - st.firstSession) % R.step !== 0) return st;
  st.decisions += 1;
  const rows = [];
  for (const [s, d] of Object.entries(data)) {
    if (universe && !universe.has(s)) continue;
    const i = d.at.get(date);
    if (i == null || avgTradedValue(d.bars, 20, i) < minValue) continue;
    const f = d.read?.(i);
    if (f) rows.push({ s, f, vol: vol60(d.bars, i), up: aboveMa50(d.bars, i) });
  }
  const { cands, isCand, medVol } = rollingCandidates(rows);
  const breadth = breadthOf(rows);
  const gated = R.minBreadth != null && (breadth ?? 1) < R.minBreadth;
  st.lastGate = { date, breadth: breadth == null ? null : round(breadth, 3), min: R.minBreadth, gated };
  const held = new Map(Object.entries(st.positions).map(([s, p]) => [s, p]));
  const pendingSell = new Set(Object.keys(st.pendingSell));
  const due = rollingPlan({ t, held, pendingSell, cands, isCand, medVol, value: nav, free: 0, sectorOf, R: { ...R, slots: 0 } });
  for (const s of due.kept) st.positions[s].t = t;
  for (const s of due.sells) { st.pendingSell[s] = 'hold_end'; pendingSell.add(s); }
  st.lastCandidates = cands.slice(0, 15).map((c) => ({ symbol: c.s, score: c.score }));
  if (gated) return st; // thị trường yếu: không mua mới phiên này
  const free = st.cash + [...pendingSell].reduce((a, s) => a + (st.positions[s]?.shares || 0) * (closeOf(s) || 0) * 1000, 0);
  const scoreOf = new Map(cands.map((c) => [c.s, c.score]));
  st.pendingBuy = rollingPlan({ t, held, pendingSell, cands, isCand, medVol, value: nav, free, sectorOf, R }).buys
    .map((b) => ({ ...b, budget: Math.round(b.budget), score: scoreOf.get(b.s) ?? null, decidedOn: date, reason: `Ứng viên điểm ${scoreOf.get(b.s) ?? '–'}`,
      refPrice: barOf(b.s)?.d.bars[barOf(b.s).i].close ?? null }));
  return st;
}

// ---------- Tin Telegram ----------
const tEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d }));
const pct = (v) => (v == null || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${n0(Math.abs(v), 2)}%`);
const dm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
const REASON = { hold_end: 'hết 40 phiên, không còn là ứng viên', delisted: 'ngừng giao dịch' };

/**
 * Tin báo sau khi xử lý các phiên `dates` (hàm thuần): lệnh đã khớp, lệnh không khớp, lệnh cho phiên tới, tài sản.
 * Phiên không giao dịch vẫn gửi tin ngắn: tài sản, vì sao không giao dịch, còn mấy phiên tới lần ra quyết định tiếp.
 */
export function formatAutoTradeMessage(st, dates, R = AUTO_RULES) {
  const last = dates.at(-1);
  const fills = st.orders.filter((o) => dates.includes(o.date));
  const unfilled = st.unfilled.filter((u) => dates.includes(u.date));
  const decided = st.lastGate?.date === last;
  const quiet = !fills.length && !unfilled.length && !decided;
  const first = st.equity[0], eq = st.equity.at(-1);
  const pnl = eq.nav - st.funded;
  const idx = first?.index && eq?.index ? (eq.index / first.index - 1) * 100 : null;
  const L = [
    `🤖 <b>TOOL TỰ ĐẦU TƯ · sau phiên ${dm(last)}</b>`,
    '<i>Tài khoản giấy theo vốn thực nạp ròng của bạn, không đặt lệnh thật</i>',
    `💰 Tài sản <b>${n0(eq.nav)} đ</b> · ${pnl >= 0 ? 'lãi' : 'lỗ'} <b>${pnl >= 0 ? '+' : '−'}${n0(Math.abs(pnl))} đ (${pct((pnl / st.funded) * 100)})</b> trên vốn ${n0(st.funded)} đ${idx != null ? ` · VN-Index cùng kỳ ${pct(idx)}` : ''}`,
  ];
  if (quiet) {
    const since = st.firstSession != null ? st.session - st.firstSession : 0;
    const nextIn = R.step - (since % R.step);
    const g = st.lastGate;
    const holding = Object.keys(st.positions).length ? `đang giữ vị thế theo luật (giữ ~${R.hold} phiên)` : 'chưa có vị thế';
    const gate = g?.gated ? `, tạm dừng mua mới vì thị trường yếu (${n0(g.breadth * 100)}% mã trên MA50 phiên ${dm(g.date)})` : '';
    L.push('', `⏸ Hôm nay không giao dịch: ${holding}${gate}.`,
      `Lần ra quyết định tiếp theo: sau phiên thứ ${nextIn} kể từ hôm nay (tool xét lại mỗi ${R.step} phiên, không mua bán liên tục).`);
  }
  if (fills.length) {
    L.push('', `✅ <b>ĐÃ KHỚP</b> (giá mở cửa${dates.length > 1 ? `, ${dates.length} phiên` : ''})`);
    for (const o of fills) {
      const base = `▸ <b>${o.side === 'BUY' ? 'MUA' : 'BÁN'} ${tEsc(o.symbol)}</b> ${n0(o.shares)} cp × ${n0(o.price, 2)} = ${n0(o.value)} đ`;
      L.push(o.side === 'BUY' ? `${base}${o.score != null ? ` · điểm ${o.score}` : ''}`
        : `${base} · ${o.pnl >= 0 ? 'lãi' : 'lỗ'} ${o.pnl >= 0 ? '+' : '−'}${n0(Math.abs(o.pnl))} đ (${pct(o.returnPct)}) sau ${o.held} phiên · ${tEsc(REASON[o.reason] || o.reason)}`);
    }
  }
  if (unfilled.length) L.push('', `⛔ Không khớp: ${unfilled.map((u) => `${tEsc(u.symbol)} (${tEsc(u.why)})`).join(' · ')}`);

  const sells = Object.entries(st.pendingSell);
  if (decided || sells.length || st.pendingBuy.length) {
    L.push('', '📋 <b>LỆNH PHIÊN TỚI</b> (khớp giá mở cửa)');
    for (const [s, why] of sells) L.push(`▸ <b>BÁN ${tEsc(s)}</b> ${n0(st.positions[s]?.shares)} cp · ${tEsc(REASON[why] || why)}`);
    for (const b of st.pendingBuy) {
      const px = b.refPrice;
      const est = px ? Math.floor(b.budget / (px * 1000 * 1.0015)) : null;
      L.push(`▸ <b>MUA ${tEsc(b.s)}</b> ~${n0(est)} cp${px ? ` · tham chiếu ${n0(px, 2)}` : ''} · ngân sách ${n0(b.budget)} đ${b.score != null ? ` · điểm ${b.score}` : ''}`);
    }
    if (st.pendingBuy.length) L.push(`<i>Cổ mua phiên tới về tài khoản chiều T+2, sớm nhất bán ở phiên T+${R.sellAfter}. Mỗi mã giữ khoảng ${R.hold} phiên, không mua bán liên tục.</i>`);
    if (st.lastGate?.gated && st.lastGate.date === last) {
      L.push(`⏸ <b>Tạm dừng mua mới</b>: chỉ ${n0(st.lastGate.breadth * 100)}% mã trên MA50 (dưới ${n0(st.lastGate.min * 100)}%). Mã đang giữ vẫn theo luật giữ / bán.`);
    } else if (!sells.length && !st.pendingBuy.length) L.push('<i>Không có lệnh mới.</i>');
  }
  const pos = Object.entries(st.positions);
  if (pos.length) {
    L.push('', `💼 Đang giữ ${pos.length} mã: ${pos.map(([s, p]) => {
      const r = p.lastClose ? ((p.shares * p.lastClose * 1000 * (1 - 0.0025)) / p.cost - 1) * 100 : null;
      return `${tEsc(s)} ${n0(p.shares)} cp ${pct(r)}`;
    }).join(' · ')} · tiền mặt ${n0(st.cash)} đ`);
  }
  return L.join('\n');
}

// ---------- Lưu trữ & chạy thật ----------
let state;
async function load() {
  if (state !== undefined) return state;
  state = await readFile(FILE, 'utf8').then(JSON.parse).catch(() => null);
  return state;
}
async function save() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(state), 'utf8');
}

/** Phiên đã chốt gần nhất (bỏ nến đang chạy trước giờ đóng cửa). */
function closedSessions(indexBars, now = new Date(), R = AUTO_RULES) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const today = vn.toISOString().slice(0, 10);
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return indexBars.filter((b) => !b.partial && !(b.time === today && minutes < R.closeAfter));
}

/**
 * Mở tài khoản với vốn = vốn thực nạp ròng hiện tại. Phiên đã chốt gần nhất là phiên quyết định đầu tiên (chỉ dùng dữ
 * liệu đến hết phiên đó), lệnh đầu tiên khớp ở giá mở cửa phiên tới.
 */
export async function openAccount() {
  await load();
  if (state) throw new Error('Tài khoản tự đầu tư đã mở. Đặt lại trước nếu muốn mở mới.');
  const cap = await getCapitalInfo();
  if (!(cap.netContributed > 0)) throw new Error('Chưa có vốn thực nạp ròng: hãy nạp tiền ở trang Danh mục trước.');
  const idx = closedSessions((await getPriceHistory('VNINDEX')).bars);
  state = newAccount(cap.netContributed, idx.at(-2)?.time ?? null);
  await save();
  await runAutoTrade();
  return getAutoTrade();
}

export async function resetAccount() {
  await load();
  state = null;
  await writeFile(FILE, 'null', 'utf8').catch(() => {});
  return { opened: false };
}

let running = null;
/** Xử lý mọi phiên đã chốt chưa xử lý (bình thường là 1; server tắt vài ngày thì xử lý bù theo thứ tự). */
export function runAutoTrade() {
  running ??= (async () => {
    await load();
    if (!state) return null;
    const idx = closedSessions((await getPriceHistory('VNINDEX')).bars);
    const todo = idx.filter((b) => b.time > (state.lastDate ?? state.startAfter ?? ''));
    if (!todo.length) return state;
    const { minValue } = screenCriteria();
    const uni = await getScreenUniverse();
    const syms = [...new Set([...uni.map((u) => u.symbol), ...Object.keys(state.positions), ...state.pendingBuy.map((b) => b.s)])];
    const exOf = new Map(uni.map((u) => [u.symbol, u.exchange]));
    const prices = await poolMap(syms, (s) => getPriceHistory(s), 6);
    const data = {};
    syms.forEach((s, k) => {
      const bars = prices[k]?.bars?.filter((b) => !b.partial);
      if (bars?.length) data[s] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars), ex: exOf.get(s) || 'HOSE' };
    });
    const flows = await getSectorFlows(5).catch(() => null);
    const sec = new Map();
    for (const s of flows?.sectors || []) for (const x of s.stocks) sec.set(x.symbol, s.name);
    const funded = (await getCapitalInfo().catch(() => null))?.netContributed ?? null;
    const universe = new Set(uni.map((u) => u.symbol));
    for (const b of todo) {
      stepSession(state, { date: b.time, index: b.close, data, universe, minValue, sectorOf: (s) => sec.get(s) || 'Khác',
        funded: b === todo.at(-1) ? funded : null });
    }
    await save();
    console.log(`[Tự đầu tư] Đã xử lý ${todo.length} phiên đến ${state.lastDate}: NAV ${Math.round(state.equity.at(-1).nav).toLocaleString('vi-VN')} đ`);
    // Báo Telegram: lệnh đã khớp, lệnh cho phiên tới (chỉ khi có lệnh khớp hoặc là phiên ra quyết định)
    const msg = formatAutoTradeMessage(state, todo.map((b) => b.time));
    if (msg && telegramConfig().enabled) {
      await sendMessage(msg).then(() => logTelegramReport('autotrade', msg)).catch((err) => console.error('[Tự đầu tư] Lỗi gửi Telegram:', err.message));
    }
    return state;
  })().finally(() => (running = null));
  return running;
}

/** Mỗi 10 phút: đồng bộ vốn (kể cả nạp / rút qua bot Telegram), có phiên mới chốt (sau 15:10) thì xử lý. */
export function startAutoTradeSchedule() {
  const tick = () => syncFunding().then(() => runAutoTrade()).catch((err) => console.error('[Tự đầu tư] Lỗi:', err.message));
  setTimeout(tick, 60_000);
  return setInterval(tick, 10 * 60_000);
}

/** Đồng bộ vốn ngay với vốn thực nạp ròng (gọi sau khi nạp / rút ở danh mục thật và mỗi lần xem tab). */
export async function syncFunding() {
  await load();
  if (!state) return 0;
  const funded = (await getCapitalInfo().catch(() => null))?.netContributed ?? null;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const amount = applyFunding(state, funded, today);
  if (amount) {
    await save();
    console.log(`[Tự đầu tư] ${amount > 0 ? 'Nạp' : 'Rút'} ${Math.abs(amount).toLocaleString('vi-VN')} đ theo vốn thực nạp ròng`);
  }
  return amount;
}

/** Số liệu cho giao diện: tổng quan, vị thế (giá mới nhất), lệnh cho phiên tới, sổ lệnh, đường NAV. */
export async function getAutoTrade() {
  await syncFunding();
  await load();
  if (!state) {
    const cap = await getCapitalInfo().catch(() => null);
    return { opened: false, netContributed: cap?.netContributed ?? null, rules: AUTO_RULES };
  }
  const st = state;
  const syms = [...new Set([...Object.keys(st.positions), ...st.pendingBuy.map((b) => b.s)])];
  const latest = await poolMap(syms, (s) => getPriceHistory(s).then((r) => r.bars.at(-1)), 6);
  const last = new Map(syms.map((s, k) => [s, latest[k]]));
  const holdings = Object.entries(st.positions).map(([s, p]) => {
    const b = last.get(s), price = b?.close ?? p.lastClose ?? p.price;
    const value = p.shares * price * 1000, net = value * (1 - DEFAULTS.brokerage - DEFAULTS.sellTax);
    return {
      symbol: s, shares: p.shares, avgPrice: round(p.cost / p.shares / 1000, 3), price, priceDate: b?.time ?? null, live: !!b?.partial,
      value: Math.round(value), pnl: Math.round(net - p.cost), pnlPct: round((net / p.cost - 1) * 100), entryDate: p.entryDate,
      held: st.session - p.t0, holdLeft: Math.max(0, AUTO_RULES.hold - (st.session - p.t)), wait: Math.max(0, AUTO_RULES.sellAfter - 1 - (st.session - p.t0)), sellable: st.session - p.t0 >= AUTO_RULES.sellAfter - 1,
      selling: st.pendingSell[s] ? st.pendingSell[s] : null,
    };
  }).sort((a, b) => b.value - a.value);
  const stock = holdings.reduce((a, h) => a + h.value, 0);
  const nav = st.cash + stock;
  const sells = st.orders.filter((o) => o.side === 'SELL');
  const first = st.equity[0], lastEq = st.equity.at(-1);
  const pending = [
    ...Object.entries(st.pendingSell).map(([s, reason]) => ({ side: 'SELL', symbol: s, shares: st.positions[s]?.shares ?? null, reason, estPrice: last.get(s)?.close ?? null })),
    ...st.pendingBuy.map((b) => {
      const px = last.get(b.s)?.close ?? null;
      return { side: 'BUY', symbol: b.s, budget: b.budget, score: b.score, reason: b.reason, estPrice: px,
        estShares: px ? Math.floor(b.budget / (px * 1000 * (1 + DEFAULTS.brokerage))) : null };
    }),
  ];
  return {
    opened: true, rules: AUTO_RULES, openedAt: st.openedAt, startAfter: st.startAfter, lastDate: st.lastDate,
    sessions: st.firstSession != null ? st.session - st.firstSession + 1 : 0, decisions: st.decisions,
    initialCapital: st.initialCapital, funded: st.funded, cash: Math.round(st.cash), stock: Math.round(stock), nav: Math.round(nav),
    pnl: Math.round(nav - st.funded), pnlPct: st.funded > 0 ? round(((nav - st.funded) / st.funded) * 100) : null,
    indexPct: first?.index && lastEq?.index ? round((lastEq.index / first.index - 1) * 100) : null,
    fees: Math.round(st.fees),
    closed: { n: sells.length, wins: sells.filter((o) => o.pnl > 0).length, pnl: sells.reduce((a, o) => a + (o.pnl || 0), 0) },
    holdings, pending, orders: [...st.orders].reverse().slice(0, 200), unfilled: [...st.unfilled].reverse().slice(0, 30),
    cashFlows: st.cashFlows, equity: st.equity, candidates: st.lastCandidates || [], gate: st.lastGate || null,
  };
}
