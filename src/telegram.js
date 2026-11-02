// Bot Telegram: mỗi ngày giao dịch gửi 2 bản tin (sau ATO ~9:20 và sau đóng cửa ~15:10, giờ VN) gồm gợi ý mua từ
// nhóm dẫn đầu bảng xếp hạng và việc nên làm với từng mã đang nắm giữ; chuyển tiếp cảnh báo giá trong phiên.
// Cấu hình trong .env: TELEGRAM_BOT_TOKEN (từ @BotFather) và TELEGRAM_CHAT_ID (chạy `npm run telegram` để lấy).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { analyzeSymbol, marketContext } from './analyze.js';
import { getRankBoard } from './ranking.js';
import { logTelegramReport } from './db.js';
import { getTuning, tuningLog } from './tuning.js';
import { recordTrades } from './selfreview.js';
import { getSectorFlows } from './sectors.js';
import { sectorMap, junkCheck } from './picks.js';
import { HOLD_RULE } from './tradeplan.js';
import { SLOT_RULES, accountCapital, slotsForCapital, coreConfig, coreOrder, CORE_RULES } from './sizing.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'telegram.json');
const MAX_LEN = 4000; // Telegram giới hạn 4096 ký tự / tin
const BUY_CODES = ['BUY', 'ACCUMULATE'];

export function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
  return { token, chatId, enabled: Boolean(token && chatId), buyCount: Number(process.env.TELEGRAM_BUY_COUNT) || 5 };
}

// Kết nối tới Telegram đôi lúc chập chờn (ETIMEDOUT / fetch failed): gửi lại sau 2 rồi 6 giây để không mất cảnh báo.
// getUpdates (bot nhận tin) đã tự lặp lại nên không cần.
const RETRY_DELAYS = [2000, 6000];

export async function api(method, body = {}, timeoutMs = 20_000) {
  const { token } = telegramConfig();
  if (!token) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN trong .env');
  const delays = method === 'getUpdates' ? [] : RETRY_DELAYS;
  let res;
  for (let k = 0; ; k++) {
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (err) {
      if (k >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[k]));
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
  return data.result;
}

/** Tách tin dài theo dòng để không vượt giới hạn của Telegram. */
export function splitMessage(text, max = MAX_LEN) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendMessage(text, chatId = telegramConfig().chatId) {
  if (!chatId) throw new Error('Chưa cấu hình TELEGRAM_CHAT_ID trong .env');
  for (const part of splitMessage(text)) {
    await api('sendMessage', { chat_id: chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

/** Các cuộc trò chuyện vừa nhắn cho bot (để lấy TELEGRAM_CHAT_ID). */
export async function recentChats() {
  const updates = await api('getUpdates', { timeout: 0 });
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message || u.channel_post || u.my_chat_member)?.chat;
    if (c) chats.set(c.id, { id: c.id, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username, type: c.type });
  }
  return [...chats.values()];
}

// ---------- Soạn bản tin ----------
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d }));
export const sgn = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v), d)}%`);
const money = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v) / 1e6, 2)} tr`;

const ddmm = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');

/** VN-Index + trạng thái xu hướng TRUNG HẠN (không phải phiên hôm nay, tránh "tăng 2% mà báo yếu" gây khó hiểu). */
export function marketLine(m) {
  if (!m) return '';
  const weak = m.trend === 'down' || m.aboveMa200 === false;
  const arrow = m.changePct > 0 ? '▲' : m.changePct < 0 ? '▼' : '■';
  const trend = weak ? 'xu hướng trung hạn còn yếu' : m.trend === 'up' ? 'xu hướng tăng' : 'đi ngang';
  return `📊 VN-Index <b>${num(m.close, 0)}</b> ${arrow}${num(Math.abs(m.changePct ?? 0), 2)}% · ${trend}`;
}

/** Vị trí giá so với vùng mua dạng chữ ngắn: 'buy' | 'wait' | 'unstable' | 'broken' | null. */
export function zoneState(close, L) {
  if (!L?.buyFrom || !L?.buyTo) return null;
  if (L.stop && close <= L.stop) return 'broken';
  if (close > L.buyTo * 1.005) return 'wait';
  if (close < L.buyFrom * 0.995) return 'unstable';
  return 'buy';
}

const pctTo = (from, to) => (from && to ? `${to >= from ? '+' : '−'}${num(Math.abs((to / from - 1) * 100), 0)}%` : '');

const IND = '  '; // Thụt lề 2 ký tự chuẩn thay vì non-breaking spaces cồng kềnh

/**
 * Mã gợi ý mua, mỗi mã một khối gọn gàng, trực quan:
 *   ▸ DHC  38,8 · Sản xuất giấy · thăm dò
 *     🎯 LO 38,8 (giá đóng cửa)
 *     ⏳ Giữ ~40 phiên · ⚠️ Cảnh báo &lt; 32,95 (−15%)
 */
export function buyLine(a, final, { aiNo = false } = {}) {
  const L = buyLevels(a, aiNo ? null : final);
  const close = a.price?.close;
  const tags = [
    a.sector?.name && esc(a.sector.name),
    aiNo ? 'AI chưa đồng ý' : final?.code === 'ACCUMULATE' ? 'thăm dò' : null,
  ].filter(Boolean);
  const tagStr = tags.length ? ` · <i>${tags.join(' · ')}</i>` : '';
  const out = [`▸ <b>${esc(a.symbol)}</b>  <b>${num(close)}</b>${tagStr}`];
  if (L) {
    const zone = L.buyFrom === L.buyTo ? `LO <b>${num(L.buyTo)}</b> (giá đóng cửa)` : `<b>${num(L.buyFrom)}–${num(L.buyTo)}</b>`;
    const st = zoneState(close, L);
    const where = st === 'buy' ? `🎯 ${L.buyFrom === L.buyTo ? '' : 'Mua '}${zone}`
      : st === 'wait' ? `⏳ Chờ về ${zone}`
      : st === 'unstable' ? '⚠️ Chờ ổn định lại'
      : st === 'broken' ? '⛔ Dưới ngưỡng cảnh báo, bỏ qua' : '';
    if (where) out.push(`${IND}${where}`);
    const lv = [
      `⏳ Giữ ~${L.holdSessions ?? 40} phiên`,
      L.stop != null && `⚠️ Cảnh báo &lt; ${num(L.stop)} (${pctTo(close, L.stop)})`,
    ].filter(Boolean);
    if (lv.length) out.push(`${IND}${lv.join(' · ')}`);
  }
  return out.join('\n');
}

/** Mức giá dùng trong tin: vùng mua theo kế hoạch của mức cuối (Cân nhắc mua có thể khác Nên mua). */
export function buyLevels(a, final) {
  const L = a.brief?.levels;
  if (!L) return null;
  const z = final?.steps?.fresh?.find((s) => s.side === 'buy' && s.zone)?.zone;
  return z ? { ...L, buyFrom: z[0], buyTo: z[1] } : L;
}

/** Bản ghi để tự đánh giá sau này (selfreview.js). */
export function tradeRecord(a, final, status) {
  const L = buyLevels(a, status === 'pick' ? final : null);
  // Quy tắc không có chốt lời: chấm lại bằng ngưỡng cảnh báo xa và thời hạn giữ (selfreview RULES.hold)
  return { symbol: a.symbol, date: a.price.date, entry: a.price.close, stop: L?.stop ?? null, target: null,
    buyFrom: L?.buyFrom ?? null, buyTo: L?.buyTo ?? null, code: final?.code ?? null, status };
}

/**
 * Một dòng cho mã đang giữ: lãi/lỗ và việc nên làm theo mức `code` (quyết định cuối nếu AI đã thẩm định).
 * Đang lãi ≥ 10% thì cắt lỗ nâng lên tối thiểu giá vốn.
 */
export function holdingLine(a, code = a.brief?.code, { noAi = false, final = null, detailed = false } = {}) {
  const h = a.holding, L = a.brief?.levels, close = a.price.close;
  // Quy tắc: không cắt lỗ sát; cảnh báo khi dưới −15% giá vốn; giữ ~40 phiên, đến hạn mà rời nhóm mua thì bán; ⛔ cân nhắc bán
  const stop = L?.holdStop ?? L?.stop ?? null;
  const cut = stop != null ? ` · cảnh báo &lt; ${num(stop)}` : '';
  const N = L?.holdSessions ?? 40, held = L?.heldSessions;
  const due = held != null && held >= N;
  const heldTxt = held != null ? ` (${held}/${N} phiên)` : '';
  let todo;
  if (stop != null && close < stop) todo = `⚠️ <b>Dưới ngưỡng −15%</b> (${num(stop)}): xem lại lý do nắm giữ`;
  else if (code === 'SELL') todo = '🔴 <b>Bán</b> (rủi ro rơi tự do)';
  else if (code === 'AVOID' && a.ranking?.avoid) todo = '🔴 <b>⛔ Cân nhắc bán</b> (10% thấp nhất)';
  else if ((code === 'AVOID' || code === 'HOLD') && due) todo = `🔴 <b>Bán</b> (đủ ${N} phiên, không còn trong nhóm mua)`;
  else if (code === 'AVOID' || code === 'HOLD') todo = `🟡 Giữ đến đủ ${N} phiên${heldTxt}${cut}`;
  else todo = `🟢 Giữ (vẫn trong nhóm mua)${heldTxt}${cut}`;

  const pnlTag = h?.pnlPct != null ? (h.pnlPct >= 0 ? `lãi <b>${sgn(h.pnlPct * 100)}</b>` : `lỗ <b>${sgn(h.pnlPct * 100)}</b>`) : '';
  const lines = [`▸ <b>${esc(a.symbol)}</b>  <b>${num(close)}</b>${pnlTag ? ` (${pnlTag})` : ''}`];

  if (detailed && h?.qty && h?.avgCost) {
    const val = (h.marketValue || (close * h.qty * 1000));
    lines.push(`${IND}💼 Vị thế: <b>${num(h.qty, 0)}</b> cp · Giá vốn: <b>${num(h.avgCost)}</b> (~${num(val / 1e6, 2)} tr)`);
  }

  // Kháng cự chỉ để tham khảo: luật nắm giữ không chốt lời theo mốc giá cố định
  const targetStr = detailed && L?.target ? ` · Kháng cự gần: <b>${num(L.target)}</b>` : '';
  lines.push(`${IND}👉 ${todo}${targetStr}${noAi ? ' <i>(chưa qua AI)</i>' : ''}`);

  if (detailed) {
    const aiNote = final?.note || (a.brief?.reasons || []).slice(0, 2).map((r) => r.text || r).join(' · ');
    const holderPlanText = (a.brief?.plays?.holder || []).slice(0, 2).join(' · ');
    if (aiNote) {
      lines.push(`${IND}💡 <b>AI đánh giá:</b> <i>${esc(aiNote)}</i>`);
    }
    if (holderPlanText && !final?.note) {
      lines.push(`${IND}📋 <b>Kế hoạch:</b> <i>${esc(holderPlanText)}</i>`);
    }
  }

  return lines.join('\n');
}

/** Phân tích tuần tự (tránh dội API nguồn dữ liệu), bỏ qua mã lỗi. */
async function analyzeAll(symbols) {
  const out = [];
  for (const s of symbols) out.push(await analyzeSymbol(s, { withChart: false }).catch(() => null));
  return out.filter(Boolean);
}

/**
 * AI thẩm định một mã, trả về quyết định cuối (hệ thống + AI, lấy bên thận trọng hơn).
 * Dùng lại kết quả cùng phiên nếu còn mới (GEMINI_AUTO_HOURS, mặc định 4 giờ): bản tin đóng cửa luôn chạy lại
 * vì cách bản tin mở cửa ~6 giờ và giá đã chốt.
 */
export async function aiFinal(a, tracker) {
  const maxAge = (Number(process.env.GEMINI_AUTO_HOURS) || 4) * 3600_000;
  const prev = await tracker.getAiResult(a.symbol).catch(() => null);
  if (prev?.final && prev.priceDate === a.price.date && Date.now() - Date.parse(prev.createdAt) < maxAge) return prev.final;
  const r = await tracker.runAi(a.symbol, { analysis: a });
  if (!r.final) throw new Error('AI không trả về quyết định');
  return r.final;
}

// ---------- Bản tin theo quy tắc: lệnh cho phiên tới ----------
//
// Lịch gửi (ít tin, tin nào cũng dẫn tới một việc cụ thể):
//  - 15:10 mỗi phiên: "Lệnh cho phiên tới" (bán / mua / xem lại + danh mục gọn). Quy tắc quyết định sau giờ đóng cửa,
//    lệnh LO ở giá đóng cửa nên đặt trước ATO phiên sau.
//  - 8:30–8:59 phiên sau: nhắc lại lệnh (chỉ khi có lệnh).
//  - Thứ 6 sau 15:40: tổng kết tuần (danh mục, kiểm chứng H1–H5, thông số tự chỉnh trong tuần).
//  - Trong phiên chỉ cảnh báo khẩn cho mã đang giữ (holdwatch.js); radar mua trong phiên tắt mặc định.

/**
 * Lập lệnh cho phiên tới (hàm thuần).
 * @param {{ held: { a: object, sector?: string }[], candidates: { a: object, sector?: string, final?: object, aiNo?: boolean }[],
 *   capital?: number|null, cash?: number|null, buyCount?: number, slots?: number, perSector?: number }} o
 *   cash: tiền mặt dùng được (sổ tiền mặt của Danh mục, đã trừ lõi ETF); lệnh mua không vượt quá số này.
 *   held: phân tích các mã đang giữ (a.holding, a.brief.levels.heldSessions / holdStop); candidates: mã mua đã lọc, xếp hạng giảm dần.
 * @returns {{ sells, review, keep, buys, freeSlots, slotValue }}
 */
export function planOrders({ held, candidates, capital = null, cash = null, buyCount = 5, slots = SLOT_RULES.slots, perSector = SLOT_RULES.perSector }) {
  const N = HOLD_RULE.sessions;
  const sells = [], review = [], keep = [];
  for (const { a, sector } of held) {
    const L = a.brief?.levels || {}, h = a.holding, code = a.brief?.code;
    const base = { symbol: a.symbol, sector, close: a.price.close, qty: h?.qty ?? null, sellable: h?.sellable ?? null, avgCost: h?.avgCost ?? null,
      pnlPct: h?.pnlPct ?? null, held: L.heldSessions ?? null, stop: L.holdStop ?? L.stop ?? null };
    let reason = null;
    if (code === 'SELL') reason = 'rủi ro rơi tự do';
    else if (a.ranking?.avoid) reason = '⛔ 10% thấp nhất';
    else if (base.held != null && base.held >= N && !BUY_CODES.includes(code)) reason = `đủ ${N} phiên, không còn trong nhóm mua`;
    if (reason) sells.push({ ...base, reason });
    else if (base.stop != null && base.close < base.stop) review.push(base);
    else keep.push({ ...base, inBuyGroup: BUY_CODES.includes(code) });
  }
  const staying = [...review, ...keep];
  const perSec = new Map();
  for (const x of staying) if (x.sector) perSec.set(x.sector, (perSec.get(x.sector) || 0) + 1);
  const freeSlots = Math.max(0, slots - staying.length);
  const slotValue = capital > 0 ? capital / slots : null;
  const buys = [];
  let left = cash, wanted = 0; // tiền mặt còn lại; tổng tiền cần nếu mua đủ suất
  for (const c of candidates) {
    if (buys.length >= Math.min(freeSlots, buyCount)) break;
    const sec = c.sector || null;
    if (sec && (perSec.get(sec) || 0) >= perSector) continue;
    const L = c.a.brief?.levels || {}, price = L.buyTo ?? c.a.price.close;
    const half = (c.final?.code ?? c.a.brief?.code) === 'ACCUMULATE';
    const budget = slotValue != null ? slotValue * (half ? 0.5 : 1) : null;
    let shares = budget != null && price > 0 ? Math.floor(budget / (price * 1000) / 100) * 100 : null;
    if (shares != null) wanted += shares * price * 1000;
    // Không đủ tiền mặt: mua ít lô hơn; không đủ một lô thì dừng (mã điểm cao hơn được ưu tiên)
    if (left != null && shares != null) {
      const fit = Math.floor(left / (price * 1000 * 1.0015) / 100) * 100;
      if (fit < 100) break;
      shares = Math.min(shares, fit);
      left -= shares * price * 1000 * 1.0015;
    }
    buys.push({
      symbol: c.a.symbol, sector: sec, price, shares, value: shares != null ? shares * price * 1000 : null, half,
      score: c.a.ranking?.score ?? null, trendPick: Boolean(c.a.ranking?.trendPick), stop: L.stop ?? null, aiNo: Boolean(c.aiNo),
    });
    if (sec) perSec.set(sec, (perSec.get(sec) || 0) + 1);
  }
  return { sells, review, keep, buys, freeSlots, slotValue, slots,
    cash: cash != null ? { available: Math.round(cash), used: Math.round(cash - left), short: Math.max(0, Math.round(wanted - cash)) } : null };
}

// Mua thêm chỉ khi: vẫn trong nhóm mua, thị trường đủ rộng (luật độ rộng của quy trình cuốn chiếu, đã kiểm định), mã đang
// lãi (không bình quân giá xuống) và chưa vượt một suất. Ngưỡng lãi tối thiểu theo quy tắc 5 trong 20 quy tắc của tool.
export const ADD_RULES = { minProfit: 0.03, minBreadth: 0.5, slots: 10, maxWeight: 0.3, highAtr: 0.04 };

/**
 * Phân tích một mã đang giữ (hàm thuần): việc nên làm (BÁN / XEM LẠI / MUA THÊM / GIỮ) và các rủi ro cụ thể.
 * Phần BÁN / XEM LẠI lấy đúng từ planOrders để bản tin không tự mâu thuẫn.
 * @param {object} a kết quả analyzeSymbol (có a.holding)
 * @param {{ sell?: string|null, review?: boolean, breadth?: number|null, nav?: number|null, sector?: object|null }} ctx
 *   sell: lý do bán từ planOrders; review: dưới ngưỡng −15%; breadth: tỷ lệ mã trên MA50 (0–1); nav: tổng tài sản (đồng)
 */
export function holdingAdvice(a, { sell = null, review = false, breadth = null, nav = null, sector = null } = {}, R = ADD_RULES) {
  const h = a.holding || {}, L = a.brief?.levels || {}, close = a.price?.close;
  const N = L.holdSessions ?? HOLD_RULE.sessions, held = L.heldSessions ?? null, stop = L.holdStop ?? null;
  const value = h.qty && close ? h.qty * close * 1000 : null;
  const weight = value && nav > 0 ? value / nav : null;
  const inBuyGroup = BUY_CODES.includes(a.brief?.code);

  const risks = [];
  if (stop != null && close) risks.push(close < stop ? `đã dưới ngưỡng thoát ${num(stop)}` : `cách ngưỡng thoát ${num(stop)} còn ${num((close / stop - 1) * 100, 1)}%`);
  if (a.ranking?.avoid) risks.push('⛔ thuộc 10% điểm thấp nhất rổ');
  else if (a.ranking?.aboveMa200 === false) risks.push('giá dưới MA200 (xu hướng dài hạn yếu)');
  if (a.stockRisk?.isRisky) risks.push(`rủi ro rơi tự do${a.stockRisk.reasons?.length ? `: ${a.stockRisk.reasons[0]}` : ''}`);
  for (const w of a.buyWarnings || []) risks.push(`${w.name}: ${w.text}`);
  if (a.foreign?.net5 != null && a.foreign.net5 < 0) risks.push(`khối ngoại bán ròng 5 phiên ${num(a.foreign.net5 / 1e9, 1)} tỷ`);
  if (sector?.net != null && sector.net < 0) risks.push(`ngành ${sector.name} bị rút ròng ${num(sector.net / 1e9, 0)} tỷ (5 phiên)`);
  const atrPct = a.technical?.indicators?.atr14 && close ? a.technical.indicators.atr14 / close : null;
  if (atrPct != null && atrPct >= R.highAtr) risks.push(`biến động mạnh: ATR ${num(atrPct * 100, 1)}%/phiên`);
  if (weight != null && weight > R.maxWeight) risks.push(`tập trung: chiếm ${num(weight * 100, 0)}% tài sản`);
  if (h.pending) risks.push(`${num(h.pending, 0)} cp chưa về (T+2)`);

  let action, why;
  if (sell) { action = 'BÁN'; why = sell; }
  else if (review) { action = 'XEM LẠI'; why = 'đóng cửa dưới ngưỡng thoát −15% giá vốn: bán phiên tới nếu không còn lý do giữ, không bình quân giá xuống'; }
  else {
    const noAdd = [
      !inBuyGroup && 'không còn trong nhóm mua',
      breadth != null && breadth < R.minBreadth && `thị trường yếu (${num(breadth * 100, 0)}% mã trên MA50)`,
      !(h.pnlPct >= R.minProfit) && `chưa lãi ≥ ${num(R.minProfit * 100, 0)}% (không bình quân giá xuống)`,
      weight != null && weight >= 1 / R.slots && `đã đủ một suất (${num(weight * 100, 0)}% tài sản)`,
      (a.buyWarnings || []).length > 0 && 'đang có cảnh báo khoan mua',
    ].filter(Boolean);
    if (!noAdd.length) { action = 'MUA THÊM'; why = 'vẫn trong nhóm mua, đang lãi, thị trường đủ rộng: có thể nâng lên đủ một suất'; }
    else { action = 'GIỮ'; why = `${inBuyGroup ? 'vẫn trong nhóm mua' : `giữ đến đủ ${N} phiên rồi xét lại`}; không mua thêm vì ${noAdd.join(', ')}`; }
  }
  return { symbol: a.symbol, action, why, risks, close, qty: h.qty ?? null, avgCost: h.avgCost ?? null, pnlPct: h.pnlPct ?? null, held, N, weight };
}

const ADVICE_ICON = { 'BÁN': '🔴', 'XEM LẠI': '⚠️', 'MUA THÊM': '🟢', 'GIỮ': '🟡' };

/** Khối phân tích mã đang nắm cho bản tin (hàm thuần). */
export function formatHoldingAdvice(list) {
  const L = [];
  for (const x of list) {
    const pnl = x.pnlPct != null ? ` · ${x.pnlPct >= 0 ? 'lãi' : 'lỗ'} <b>${sgn(x.pnlPct * 100)}</b>` : '';
    L.push(`▸ <b>${esc(x.symbol)}</b> ${num(x.close)}${x.qty ? ` · ${num(x.qty, 0)} cp vốn ${num(x.avgCost)}` : ''}${pnl}${x.held != null ? ` · ${x.held}/${x.N} phiên` : ''}`);
    L.push(`${IND}${ADVICE_ICON[x.action]} <b>${x.action}</b>: ${esc(x.why)}`);
    if (x.risks.length) L.push(`${IND}Rủi ro: ${x.risks.map(esc).join(' · ')}`);
  }
  return L;
}

const REGIME_LABEL = { CONFIRMED_UPTREND: '🟢 tăng', UPTREND_UNDER_PRESSURE: '🟡 tăng có áp lực', MARKET_CORRECTION: '🔴 điều chỉnh', UNKNOWN: '⚪ chưa xác định (không mua mới)' };

/** Bản tin sau phiên (hàm thuần). */
export function formatCloseReport({ date, market, regime, plan, summary = null, expectation = null, notes = [], core = null }) {
  const slots = plan.slots ?? SLOT_RULES.slots;
  const N = HOLD_RULE.sessions, D = '━━━━━━━━━━━━━━━━━━━━';
  const L = [`🏁 <b>LỆNH CHO PHIÊN TỚI · sau phiên ${ddmm(date)}</b>`, marketLine(market)];
  if (regime) L.push(`🧭 Thị trường: ${REGIME_LABEL[regime.regime] || esc(regime.label)}${regime.regime === 'UNKNOWN' ? '' : ' <i>(chỉ tham khảo, quy tắc không đổi)</i>'}`);
  L.push('', D, '📋 <b>ĐẶT TRƯỚC 9:00 · lệnh LO</b>');

  L.push('', `🔴 <b>BÁN</b>${plan.sells.length ? ` (${plan.sells.length})` : ': không có'}`);
  for (const s of plan.sells) {
    const q = s.qty ? ` · <b>${num(s.qty, 0)}</b> cp${s.sellable != null && s.sellable < s.qty ? ` (bán được ${num(s.sellable, 0)})` : ''}` : '';
    L.push(`▸ <b>${esc(s.symbol)}</b> LO ${num(s.close)}${q} · ${esc(s.reason)}`);
  }

  if (core) {
    const o = core.order;
    const what = o.side === 'hold' ? `giữ (đang ${num((o.weight ?? 0) * 100, 0)}%)` : `<b>${o.side === 'buy' ? 'mua' : 'bán'} ${num(o.shares, 0)}</b> ccq LO ${num(core.price)} ≈ ${num(o.value / 1e6, 0)} tr`;
    L.push('', `🧺 <b>LÕI ETF ${esc(core.symbol)}</b> ${Math.round(core.pct * 100)}% vốn: ${what}`);
  }
  if (plan.cash) {
    const c = plan.cash;
    L.push('', `💵 Tiền mặt dùng được <b>${num(c.available / 1e6, 1)} tr</b>${plan.buys.length ? ` · dùng ${num(c.used / 1e6, 1)} tr cho ${plan.buys.length} lệnh` : ''}`
      + `${c.short > 0 && plan.freeSlots ? ` · <b>thiếu ${num(c.short / 1e6, 1)} tr</b> để mua đủ suất (nạp thêm hoặc chờ tiền bán về)` : ''}`);
  }
  if (slots === 0) {
    L.push('', '🟢 <b>MUA</b>: <i>vốn chọn mã dưới 20 triệu, một suất không đủ lô 100 cp: nên mua ETF (vd E1VFVN30) thay vì chọn mã.</i>');
  } else {
  const slotTxt = plan.slotValue != null ? ` · 1 suất ≈ ${num(plan.slotValue / 1e6, 0)} tr` : ` · 1 suất = ${Math.round(100 / slots)}% vốn chọn mã`;
  L.push('', `🟢 <b>MUA</b>${plan.buys.length ? ` (${plan.buys.length})` : ''} · còn ${plan.freeSlots} suất trống${slotTxt}`);
  if (!plan.buys.length) L.push(plan.freeSlots ? '<i>Không có mã mới đạt quy tắc (≥ 70 trên MA200 hoặc xu hướng chuẩn, không ⛔, ≤ 3 mã/ngành).</i>' : `<i>Danh mục đã đủ ${slots} mã: không mua thêm.</i>`);
  for (const b of plan.buys) {
    const qty = b.shares === 0 ? ` · <i>${b.half ? 'nửa suất' : '1 suất'} chưa đủ 1 lô 100 cp (${num(b.price * 100 * 1000 / 1e6, 1)} tr)</i>`
      : b.shares != null ? ` · <b>${num(b.shares, 0)}</b> cp ≈ ${num(b.value / 1e6, 0)} tr` : ` · ${b.half ? 'nửa suất' : '1 suất'}`;
    const tags = [b.sector && esc(b.sector), b.score != null && `xếp hạng ${b.score}`, b.trendPick && '★ xu hướng', b.half && 'thăm dò', b.aiNo && 'AI chưa đồng ý'].filter(Boolean).join(' · ');
    L.push(`▸ <b>${esc(b.symbol)}</b> LO <b>${num(b.price)}</b>${qty}`, `${IND}${tags}${b.stop != null ? ` · cảnh báo &lt; ${num(b.stop)}` : ''}`);
  }
  }

  if (plan.review.length) {
    L.push('', `⚠️ <b>XEM LẠI</b> (dưới −${Math.round(HOLD_RULE.wideStop * 100)}% giá vốn, không bình quân giá xuống)`);
    for (const r of plan.review) L.push(`▸ <b>${esc(r.symbol)}</b> ${num(r.close)} · vốn ${num(r.avgCost)} · ${sgn((r.pnlPct ?? 0) * 100)}`);
  }

  const holding = plan.keep.length + plan.review.length + plan.sells.length;
  if (holding) {
    const perf = summary ? ` · ${summary.unrealizedPct >= 0 ? 'lãi' : 'lỗ'} <b>${sgn(summary.unrealizedPct)}</b> · hôm nay ${money(summary.dayChange)}` : '';
    L.push('', D, `💼 <b>DANH MỤC</b> ${holding}/${slots} mã${perf}`);
    if (plan.advice?.length) L.push('🔎 <b>Phân tích từng mã đang nắm</b>', ...formatHoldingAdvice(plan.advice));
    else if (plan.keep.length) L.push(`Giữ: ${plan.keep.map((k) => `${esc(k.symbol)}${k.held != null ? ` ${k.held}/${N}` : ''}${k.pnlPct != null ? ` ${sgn(k.pnlPct * 100, 0)}` : ''}`).join(' · ')}`);
  }

  const ex = expectation?.h20;
  if (ex) L.push('', D, `📊 Nhóm mua trong 4 năm: hơn rổ TB <b>${sgn(ex.meanExcess * 100)}</b>/20 phiên, 80% số lần từ ${sgn(ex.p10 * 100, 0)} đến ${sgn(ex.p90 * 100, 0)}. Lợi thế nhỏ, chỉ thấy qua nhiều lệnh.`);
  if (notes.length) L.push('', ...notes.map((n) => `<i>${n}</i>`));
  return L.join('\n');
}

/** Nhắc lệnh trước ATO (hàm thuần); null nếu không có lệnh. */
export function formatMorning(plan, date) {
  const coreSide = plan?.core && plan.core.order.side !== 'hold';
  if (!plan || (!plan.buys?.length && !plan.sells?.length && !coreSide)) return null;
  const L = [`⏰ <b>NHẮC LỆNH TRƯỚC ATO</b> · lập sau phiên ${ddmm(date)}`];
  if (coreSide) L.push(`🧺 Lõi ETF: ${plan.core.order.side === 'buy' ? 'mua' : 'bán'} <b>${esc(plan.core.symbol)}</b> ${num(plan.core.order.shares, 0)} ccq`);
  if (plan.sells.length) L.push(`🔴 Bán: ${plan.sells.map((s) => `<b>${esc(s.symbol)}</b>${s.qty ? ` ${num(s.qty, 0)} cp` : ''}`).join(' · ')}`);
  if (plan.buys.length) L.push(`🟢 Mua LO: ${plan.buys.map((b) => `<b>${esc(b.symbol)}</b> ${num(b.price)}${b.shares != null ? ` × ${num(b.shares, 0)}` : ''}`).join(' · ')}`);
  L.push('<i>Giá LO = giá đóng cửa phiên trước; không khớp thì để bản tin chiều nay xét lại, không đuổi giá.</i>');
  return L.join('\n');
}

const VERDICT_TXT = { insufficient: 'chưa đủ dữ liệu', supported: '✅ ủng hộ', rejected: '❌ bác bỏ', inconclusive: 'chưa kết luận' };

/** Tổng kết tuần (hàm thuần). */
export function formatWeekly({ date, summary = null, holdings = [], hypotheses = [], tuning = [], slots = SLOT_RULES.slots, capital = null }) {
  const L = [`📅 <b>TỔNG KẾT TUẦN · đến ${ddmm(date)}</b>`];
  if (capital?.nav && capital.source === 'portfolio') {
    L.push('', `💵 Vốn ${num(capital.netContributed / 1e6, 1)} tr · đã mua ${num((capital.invested ?? 0) / 1e6, 1)} tr · tiền mặt còn <b>${num(capital.cash / 1e6, 1)} tr</b>`);
  }
  if (summary) {
    L.push('', `💼 Danh mục ${holdings.length}/${slots} mã · giá trị ${num(summary.marketValue / 1e6, 0)} tr · ${summary.unrealizedPct >= 0 ? 'lãi' : 'lỗ'} <b>${sgn(summary.unrealizedPct)}</b> chưa chốt · đã chốt ${money(summary.realized)}`);
    const secs = {};
    for (const h of holdings) if (h.sector) secs[h.sector] = (secs[h.sector] || 0) + 1;
    const crowd = Object.entries(secs).filter(([, n]) => n > SLOT_RULES.perSector);
    if (crowd.length) L.push(`⚠️ Vượt ${SLOT_RULES.perSector} mã/ngành: ${crowd.map(([s, n]) => `${esc(s)} (${n})`).join(', ')}`);
  }
  if (hypotheses.length) {
    L.push('', '🔬 <b>Kiểm chứng (mua mở cửa phiên sau, so rổ)</b>');
    for (const h of hypotheses) L.push(`${h.id} ${esc(h.title)}: ${VERDICT_TXT[h.verdict] || h.verdict}${h.n ? ` · ${h.n} phiên` : ''}${h.t != null ? ` · t ${num(h.t, 2)}` : ''}`);
  }
  if (tuning.length) {
    L.push('', '🔧 <b>Thông số tự chỉnh tuần này</b>');
    for (const x of tuning) L.push(`${esc(x.name)}: ${esc(String(x.from))} → <b>${esc(String(x.to))}</b> · <i>${esc(x.reason || '')}</i>`);
  }
  return L.join('\n');
}

/**
 * Soạn bản tin. close: lập lệnh (mã mua qua AI thẩm định nếu có; mã AI lỗi ghi vào `unverified` để lịch thử lại);
 * morning: nhắc lệnh từ bản tin chiều hôm trước; weekly: tổng kết tuần.
 * @param {'close'|'morning'|'weekly'} kind
 * @returns {Promise<{ text: string|null, unverified: string[], trades?: object[], plan?: object }>}
 */
export async function buildReport(kind = 'close') {
  if (kind === 'morning') {
    const st = await loadSent();
    return { text: formatMorning(st.plan, st.planDate), unverified: [] };
  }
  const { getPortfolio } = await import('./portfolio.js');
  if (kind === 'weekly') {
    const [{ getVerification }, pf, flows] = await Promise.all([import('./verify.js'), getPortfolio().catch(() => null), getSectorFlows(5).catch(() => null)]);
    const v = await getVerification().catch(() => null);
    const sectors = sectorMap(flows);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const date = (await getPriceHistory('VNINDEX')).bars.at(-1).time;
    return {
      text: formatWeekly({
        date, summary: pf?.summary, capital: pf?.capital, slots: pf?.capital?.slots ?? slotsForCapital(accountCapital() != null ? accountCapital() * (1 - coreConfig().pct) : null),
        holdings: (pf?.holdings || []).filter((h) => h.symbol !== coreConfig().symbol).map((h) => ({ ...h, sector: sectors.get(h.symbol)?.name })),
        hypotheses: v?.hypotheses || [], tuning: tuningLog().filter((x) => x.at >= weekAgo),
      }),
      unverified: [],
    };
  }

  const tracker = await import('./tracker.js');
  const tune = getTuning();
  const buyCount = tune.caution ? Math.min(3, telegramConfig().buyCount) : telegramConfig().buyCount;
  const [market, board, pf, flows] = await Promise.all([
    marketContext().catch(() => null), getRankBoard(), getPortfolio().catch(() => null), getSectorFlows(5).catch(() => null),
  ]);
  const sectors = sectorMap(flows);
  const core = coreConfig();
  const heldSyms = (pf?.holdings || []).map((h) => h.symbol).filter((s) => s !== core.symbol);
  const unverified = [];
  let aiDown = false; // hết hạn mức / chưa có key: không gọi tiếp cho các mã còn lại
  const judge = async (a) => {
    if (aiDown) { unverified.push(a.symbol); return null; }
    try {
      return await aiFinal(a, tracker);
    } catch (err) {
      unverified.push(a.symbol);
      if (/hạn mức|API_KEY|Chưa cấu hình/.test(err.message)) aiDown = true;
      console.warn(`[Telegram] AI chưa thẩm định được ${a.symbol}: ${err.message}`);
      return null;
    }
  };

  // Ứng viên mua theo quy tắc: xếp hạng ≥ 70 trên MA200 hoặc xu hướng chuẩn, không ⛔, chưa nắm giữ; điểm cao trước
  const pool = board.rows.filter((r) => !r.avoid && !heldSyms.includes(r.symbol) && ((r.score >= 70 && r.aboveMa200 !== false) || r.trendPick))
    .slice(0, buyCount + 8).map((r) => r.symbol);
  const candidates = [], trades = [], rejected = [], junk = [];
  for (const a of await analyzeAll(pool)) {
    if (candidates.length >= buyCount + 3) break; // đủ dự phòng cho giới hạn ngành
    if (!BUY_CODES.includes(a.brief?.code)) continue;
    const j = junkCheck(a);
    if (j.junk) { junk.push(`${a.symbol} (${j.reasons[0]})`); continue; }
    const final = await judge(a);
    if (!final) continue;
    const ok = BUY_CODES.includes(final.code);
    trades.push(tradeRecord(a, final, ok ? 'pick' : 'rejected'));
    if (ok) candidates.push({ a, final, sector: sectors.get(a.symbol)?.name });
    else if (!tune.aiVeto) candidates.push({ a, final, aiNo: true, sector: sectors.get(a.symbol)?.name });
    else rejected.push(a.symbol);
  }
  const held = (await analyzeAll(heldSyms)).filter((a) => a.holding).map((a) => ({ a, sector: sectors.get(a.symbol)?.name }));
  // Vốn = tổng tài sản theo sổ tiền mặt của Danh mục (không có thì ACCOUNT_CAPITAL); tiền mặt khả dụng giới hạn lệnh mua
  const capital = pf?.capital?.nav ?? accountCapital();
  let cash = pf?.capital?.available ?? null;
  const satCapital = capital != null ? capital * (1 - core.pct) : null;
  const slots = slotsForCapital(satCapital);
  let coreInfo = null;
  if (core.symbol && capital) {
    const bars = (await getPriceHistory(core.symbol).catch(() => null))?.bars;
    const price = bars?.at(-1)?.close;
    const qty = (pf?.holdings || []).find((h) => h.symbol === core.symbol)?.qty ?? 0;
    if (price) {
      coreInfo = { symbol: core.symbol, pct: core.pct, price, order: coreOrder({ pct: core.pct, capital, price, qty }) };
      // Lõi ETF được ưu tiên dùng tiền mặt trước (không vượt quá tiền đang có)
      if (cash != null && coreInfo.order.side === 'buy') {
        const fit = Math.floor(Math.max(0, cash) / (price * 1000 * 1.0015) / 100) * 100;
        if (fit < coreInfo.order.shares) Object.assign(coreInfo.order, { shares: fit, value: fit * price * 1000, side: fit ? 'buy' : 'hold' });
        cash -= coreInfo.order.value * 1.0015;
      }
    }
  }
  const plan = planOrders({ held, candidates, capital: satCapital, cash, buyCount, slots });
  plan.core = coreInfo;
  const { getMarketRegime } = await import('./regime.js');
  const regime = await getMarketRegime().catch(() => null);
  // Phân tích từng mã đang nắm: rủi ro + bán / xem lại / giữ / mua thêm (bán và xem lại lấy đúng từ planOrders)
  const breadth = regime?.breadth?.pctAboveMa50 != null ? regime.breadth.pctAboveMa50 / 100 : null;
  const sellWhy = new Map(plan.sells.map((s) => [s.symbol, s.reason]));
  const reviewSet = new Set(plan.review.map((r) => r.symbol));
  plan.advice = held.map(({ a }) => holdingAdvice(a, {
    sell: sellWhy.get(a.symbol) ?? null, review: reviewSet.has(a.symbol), breadth, nav: capital, sector: sectors.get(a.symbol) ?? null,
  }));
  const expectation = plan.buys[0] ? candidates.find((c) => c.a.symbol === plan.buys[0].symbol)?.a.expectation : null;
  const notes = [
    rejected.length && `AI loại: ${rejected.map(esc).join(', ')}`,
    junk.length && `Chất lượng kém / rủi ro: ${junk.map(esc).join(', ')}`,
    unverified.length && `AI chưa thẩm định kịp: ${unverified.map(esc).join(', ')}`,
    !capital && 'Nhập số vốn ở trang Danh mục (💵 Quản lý vốn) hoặc nhắn bot "nạp 50tr" để tool tính số cổ phiếu theo vốn và tiền mặt.',
    pf?.capital?.warning && esc(pf.capital.warning),
    plan.buys.length > 0 && '💡 Khung giờ khớp lệnh: Dữ liệu thống kê > 10.000 phiên cho thấy 9h sáng thường trượt −0,32%, ưu tiên đặt lệnh sau 13:15 khi lực cầu T+2 hấp thụ tốt hơn.',
    !core.symbol && `Tùy chọn lõi ETF: CORE_ETF=${CORE_RULES.suggest.symbol}, CORE_PCT=${CORE_RULES.suggest.pct} (backtest: lãi ngang, sụt tối đa giảm ~2,5 điểm %).`,
  ].filter(Boolean);
  const date = market?.date || board.date;
  const text = formatCloseReport({ date, market, regime, plan, summary: pf?.summary, expectation, notes, core: coreInfo });
  return { text, unverified, trades, plan, date };
}

/**
 * Soạn và gửi. `waitForAi` (bản tin chiều): còn mã AI chưa thẩm định thì chưa gửi (lịch thử lại).
 * Bản tin chiều lưu lệnh để sáng hôm sau nhắc lại.
 */
export async function sendReport(kind = 'close', { waitForAi = false } = {}) {
  const r = await buildReport(kind);
  if (waitForAi && r.unverified.length) return { ok: true, sent: false, kind, unverified: r.unverified };
  if (!r.text) return { ok: true, sent: false, kind, empty: true, unverified: [] };
  await sendMessage(r.text);
  logTelegramReport(kind, r.text, r.unverified);
  if (kind === 'close') {
    await recordTrades(r.trades).catch((err) => console.error('[Telegram] Lỗi lưu gợi ý:', err.message));
    await loadSent();
    sent.plan = r.plan;
    sent.planDate = r.date;
  }
  return { ok: true, sent: true, kind, length: r.text.length, unverified: r.unverified };
}

// ---------- Lịch gửi ----------
let sent = null;
async function loadSent() {
  if (sent) return sent;
  try { sent = JSON.parse(await readFile(FILE, 'utf8')); } catch { sent = {}; }
  return sent;
}
async function markSent(kind, date) {
  await loadSent();
  sent[kind] = date;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(sent), 'utf8');
}

// Hạn chờ AI cho bản tin chiều: quá giờ này thì gửi luôn, ghi rõ mã chưa thẩm định
const AI_DEADLINE = 17 * 60;
const RETRY_MS = 15 * 60_000;

/**
 * Tin nào cần gửi lúc này: 'close' từ 15:10 phiên hôm nay (VN-Index có nến hôm nay, tự bỏ qua ngày lễ);
 * 'morning' 8:30–8:59 ngày thường sau một bản tin chiều có lệnh; 'weekly' thứ 6 từ 15:40 sau bản tin chiều.
 */
export function dueReport(now, latestBar, last = {}) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const today = vn.toISOString().slice(0, 10);
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes(), wd = vn.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  if (minutes >= 8 * 60 + 30 && minutes < 9 * 60) {
    const hasOrders = last.plan && (last.plan.buys?.length || last.plan.sells?.length);
    return hasOrders && last.planDate < today && last.morning !== today ? 'morning' : null;
  }
  if (latestBar !== today || minutes < 15 * 60 + 10) return null;
  if (last.close !== today) return 'close';
  if (wd === 5 && minutes >= 15 * 60 + 40 && last.weekly !== today) return 'weekly';
  return null;
}

let busy = false;
let retryAt = 0;
export function startTelegramSchedule() {
  if (!telegramConfig().enabled) return null;
  const tick = async () => {
    if (busy || Date.now() < retryAt) return;
    busy = true;
    try {
      const vn = new Date(Date.now() + 7 * 3600_000);
      const { bars } = await getPriceHistory('VNINDEX');
      const kind = dueReport(new Date(), bars.at(-1)?.time, await loadSent());
      if (!kind) return;
      const today = vn.toISOString().slice(0, 10);
      const waitForAi = kind === 'close' && vn.getUTCHours() * 60 + vn.getUTCMinutes() < AI_DEADLINE;
      const r = await sendReport(kind, { waitForAi });
      if (!r.sent && !r.empty) {
        retryAt = Date.now() + RETRY_MS;
        console.warn(`[Telegram] Chờ AI thẩm định ${r.unverified.join(', ')}; thử lại sau 15 phút`);
        return;
      }
      await markSent(kind, today);
      console.log(`[Telegram] Đã gửi ${{ close: 'lệnh cho phiên tới', morning: 'nhắc lệnh', weekly: 'tổng kết tuần' }[kind]} ${today}${r.unverified?.length ? ` (AI chưa thẩm định: ${r.unverified.join(', ')})` : ''}`);
    } catch (err) {
      console.error('[Telegram] Lỗi:', err.message);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 60_000); // đợi bảng xếp hạng khởi động xong
  return setInterval(tick, 2 * 60_000);
}


/** Chuyển tiếp cảnh báo trong phiên (giá chạm ngưỡng, đổi khuyến nghị) sang Telegram. */
export function forwardAlert(symbol, message) {
  if (!telegramConfig().enabled) return;
  const vn = new Date(Date.now() + 7 * 3600_000);
  const time = vn.toISOString().slice(11, 16);
  const text = [
    `⚡ <b>CẢNH BÁO TỨC THỜI · ${esc(symbol)}</b> · <code>${time}</code>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `🔔 ${esc(message)}`,
  ].join('\n');
  sendMessage(text).catch((err) => console.error('[Telegram] Lỗi gửi cảnh báo:', err.message));
}
