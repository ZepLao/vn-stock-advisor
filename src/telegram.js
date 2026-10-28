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
import { getTuning } from './tuning.js';
import { recordTrades } from './selfreview.js';
import { getSectorFlows } from './sectors.js';
import { sectorMap, orderBySector, junkCheck, rewardCheck, sectorLeaders } from './picks.js';
import { prioritizePicks, TIERS } from './prioritize.js';

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
  const trend = weak ? 'xu hướng trung hạn còn yếu → mua từng phần' : m.trend === 'up' ? 'xu hướng tăng' : 'đi ngang';
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
 *     🎯 Mua 38,25–38,8
 *     🚀 Chốt 42 (+8%) · 🛡️ Cắt 35,75 (−8%)
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
    const zone = `<b>${num(L.buyFrom)}–${num(L.buyTo)}</b>`;
    const st = zoneState(close, L);
    const where = st === 'buy' ? `🎯 Mua ${zone}`
      : st === 'wait' ? `⏳ Chờ về ${zone}`
      : st === 'unstable' ? '⚠️ Chờ ổn định lại'
      : st === 'broken' ? '⛔ Thủng cắt lỗ, bỏ qua' : '';
    if (where) out.push(`${IND}${where}`);
    const lv = [
      L.target != null && `🚀 Chốt ${num(L.target)} (${pctTo(close, L.target)})`,
      L.stop != null && `🛡️ Cắt ${num(L.stop)} (${pctTo(close, L.stop)})`,
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
  return { symbol: a.symbol, date: a.price.date, entry: a.price.close, stop: L?.stop ?? null, target: L?.target ?? null,
    buyFrom: L?.buyFrom ?? null, buyTo: L?.buyTo ?? null, code: final?.code ?? null, status };
}

/**
 * Một dòng cho mã đang giữ: lãi/lỗ và việc nên làm theo mức `code` (quyết định cuối nếu AI đã thẩm định).
 * Đang lãi ≥ 10% thì cắt lỗ nâng lên tối thiểu giá vốn.
 */
export function holdingLine(a, code = a.brief?.code, { noAi = false, final = null, detailed = false } = {}) {
  const h = a.holding, L = a.brief?.levels, close = a.price.close;
  // Cắt lỗ neo từ ngày mua, chỉ nâng (holderStop); chưa có vị thế thật thì dùng bậc thang hôm nay
  const stop = L?.holdStop ?? (L?.stop != null ? (h?.pnlPct >= 0.1 ? Math.max(L.stop, h.avgCost) : L.stop) : null);
  const cut = stop != null ? ` · cắt &lt; ${num(stop)}` : '';
  let todo;
  if (stop != null && close < stop) todo = `🔴 <b>BÁN</b> (thủng ${num(stop)})`;
  else if (code === 'SELL') todo = '🔴 <b>Hạ tỷ trọng</b>';
  else if (code === 'AVOID') todo = `⚠️ Giảm khi hồi${cut}`;
  else if (L?.target && close >= L.target) todo = `🟢 Chốt lời 1/3${cut}`;
  else todo = `🟢 Giữ${cut}`;

  const pnlTag = h?.pnlPct != null ? (h.pnlPct >= 0 ? `lãi <b>${sgn(h.pnlPct * 100)}</b>` : `lỗ <b>${sgn(h.pnlPct * 100)}</b>`) : '';
  const lines = [`▸ <b>${esc(a.symbol)}</b>  <b>${num(close)}</b>${pnlTag ? ` (${pnlTag})` : ''}`];

  if (detailed && h?.qty && h?.avgCost) {
    const val = (h.marketValue || (close * h.qty * 1000));
    lines.push(`${IND}💼 Vị thế: <b>${num(h.qty, 0)}</b> cp · Giá vốn: <b>${num(h.avgCost)}</b> (~${num(val / 1e6, 2)} tr)`);
  }

  const chanStr = detailed && a.plan?.trailing?.chandelierStop ? ` · Chặn lãi Chandelier: <b>${num(a.plan.trailing.chandelierStop)}</b>` : '';
  const targetStr = detailed && L?.target ? ` · Mục tiêu: <b>${num(L.target)}</b>` : '';
  lines.push(`${IND}👉 ${todo}${chanStr}${targetStr}${noAi ? ' <i>(chưa qua AI)</i>' : ''}`);

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

/**
 * Soạn bản tin. Mọi mã trong tin đều qua AI thẩm định trước; mã AI lỗi được liệt kê trong `unverified`
 * (lịch gửi sẽ chờ thử lại thay vì gửi ngay).
 * @param {'open'|'close'} kind open = sau ATO, close = sau đóng cửa
 * @returns {Promise<{ text: string, unverified: string[] }>}
 */
export async function buildReport(kind = 'close') {
  const [{ getPortfolio }, tracker] = await Promise.all([import('./portfolio.js'), import('./tracker.js')]);
  const tune = getTuning();
  const buyCount = tune.caution ? Math.min(3, telegramConfig().buyCount) : telegramConfig().buyCount;
  const [market, board, pf, flows] = await Promise.all([
    marketContext().catch(() => null), getRankBoard(), getPortfolio().catch(() => null), getSectorFlows(5).catch(() => null),
  ]);
  const sectors = sectorMap(flows);
  const held = new Set((pf?.holdings || []).map((h) => h.symbol));
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

  // Ứng viên: nhóm dẫn đầu đã lọc trên MA200, chưa nắm giữ, ưu tiên mã thuộc ngành dẫn đầu dòng tiền;
  // hệ thống khuyến nghị Mua / Mua thăm dò và không phải "mã rác". Lần lượt cho AI thẩm định, chỉ giữ mã quyết định cuối vẫn là mua.
  const pool = orderBySector(board.rows.filter((r) => r.pfRank != null && r.score >= 70 && !held.has(r.symbol)), sectors)
    .slice(0, buyCount + 8).map((r) => r.symbol);
  // Khi tự đánh giá thấy AI loại sai nhiều hơn đúng (aiVeto tắt), mã AI không đồng ý vẫn được liệt kê kèm ghi chú.
  const picks = [], rejected = [], trades = [], junk = [], lowReward = [];
  for (const a of await analyzeAll(pool)) {
    if (picks.length >= buyCount) break;
    if (!BUY_CODES.includes(a.brief?.code)) continue;
    const j = junkCheck(a);
    if (j.junk) { junk.push({ symbol: a.symbol, reason: j.reasons[0] }); continue; }
    const final = await judge(a);
    if (!final) continue;
    const ok = BUY_CODES.includes(final.code);
    const rw = rewardCheck(a.price.close, buyLevels(a, ok ? final : null));
    if (ok && !rw.ok) { lowReward.push({ symbol: a.symbol, reward: rw.reward }); continue; }
    trades.push(tradeRecord(a, final, ok ? 'pick' : 'rejected'));
    if (ok) picks.push({ a, final });
    else if (!tune.aiVeto) picks.push({ a, final, aiNo: true });
    else rejected.push(a.symbol);
  }
  const holdings = [];
  for (const a of (await analyzeAll([...held])).filter((x) => x.holding)) holdings.push({ a, final: await judge(a) });

  const date = ddmm(market?.date || board.date);
  const vn = new Date(Date.now() + 7 * 3600_000);
  const timeStr = vn.toISOString().slice(11, 16);
  const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

  const lines = [
    kind === 'open' ? `🔔 <b>BẢN TIN MỞ CỬA · ${date}</b> (${timeStr})` : `🏁 <b>BẢN TIN ĐÓNG CỬA · ${date}</b>`,
    DIVIDER,
    marketLine(market),
  ];

  // Bổ sung trạng thái thị trường & ngày phân phối O'Neil
  const { getMarketRegime } = await import('./regime.js').catch(() => ({}));
  if (getMarketRegime) {
    const reg = await getMarketRegime().catch(() => null);
    if (reg) {
      const regLabel = reg.regime === 'CONFIRMED_UPTREND' ? '🟢 TĂNG TRƯỞNG XÁC NHẬN'
        : reg.regime === 'UPTREND_UNDER_PRESSURE' ? '🟡 TĂNG CÓ ÁP LỰC'
        : reg.regime === 'MARKET_CORRECTION' ? '🔴 THỊ TRƯỜNG ĐIỀU CHỈNH'
        : reg.regime === 'UNKNOWN' ? '⚪ CHƯA XÁC ĐỊNH (không mua mới)'
        : '⚪ THEO DÕI';
      lines.push(`🧭 Trạng thái: <b>${regLabel}</b> · Phân phối: <b>${reg.distDays ?? '–'}/25</b> phiên · CP: <b>${reg.exposure}</b>`);
    }
  }

  // Triển vọng tuần (AI) còn hiệu lực cho tuần này: thêm 1 dòng tóm tắt
  const { getOutlook, outlookLine } = await import('./outlook.js');
  const ol = await getOutlook();
  const today = vn.toISOString().slice(0, 10);
  if (ol?.week && ol.week.monday <= today && today <= ol.week.friday) lines.push(`📅 ${outlookLine(ol)}`);

  // Ngành hút tiền: luôn nêu mã đầu ngành và trạng thái, kể cả khi chưa đủ điều kiện mua
  const status = new Map();
  for (const p of picks) status.set(p.a.symbol, zoneState(p.a.price.close, buyLevels(p.a, p.final)) === 'buy' ? '✅ Vào vùng mua' : '⏳ Chờ giá');
  for (const s of held) status.set(s, 'Đang giữ');
  for (const s of rejected) status.set(s, 'AI loại');
  for (const x of junk) status.set(x.symbol, 'Chất lượng kém');
  for (const x of lowReward) status.set(x.symbol, 'Biên lợi nhuận thấp');
  const leaderStatus = (l) => status.get(l.symbol)
    || (l.score >= 70 ? (l.aboveMa200 === false ? 'Chờ vượt MA200' : 'Theo dõi') : 'Chưa đủ mạnh');
  const lead = sectorLeaders(flows, board.rows);
  if (lead.length) {
    lines.push('', DIVIDER, `🔥 <b>NGÀNH DẪN DẮT DÒNG TIỀN</b> (5 phiên)`);
    for (const [k, s] of lead.entries()) {
      lines.push(`<b>${k + 1}. ${esc(s.name)}</b>  +${num(s.net / 1e9, 0)} tỷ`);
      for (const l of s.leaders) lines.push(`  • <b>${esc(l.symbol)}</b> (${l.score}đ) — <i>${leaderStatus(l)}</i>`);
    }
  }

  // AI so sánh các mã mua với nhau: ưu tiên / có thể mua / đầu cơ / để sau, kèm tỷ trọng và lý do
  const prio = await prioritizePicks(picks.map((p) => {
    const levels = buyLevels(p.a, p.aiNo ? null : p.final);
    return { ...p, levels, zone: zoneState(p.a.price.close, levels) };
  }), {
    market: marketLine(market).replace(/<[^>]+>/g, ''), caution: tune.caution,
    held: (pf?.holdings || []).map((h) => `${h.symbol}${sectors.get(h.symbol)?.name ? ` (${sectors.get(h.symbol).name})` : ''}`),
  }).catch(() => ({ items: [], best: null }));
  const bySym = new Map(picks.map((p) => [p.a.symbol, p]));
  lines.push('', DIVIDER, `🟢 <b>DANH SÁCH KHUYẾN NGHỊ MUA</b>${picks.length ? ` (${picks.length} mã)` : ''}`);
  if (tune.caution) lines.push('<i>⚠️ Thị trường thận trọng: Tối đa 3 mã, ưu tiên giải ngân nhỏ.</i>');
  if (!picks.length) lines.push('<i>Hiện chưa có mã nào đạt đủ tiêu chuẩn an toàn để giải ngân.</i>');
  if (prio.best) lines.push(`⭐ <b>LỰA CHỌN TỐI ƯU:</b> <b>${esc(prio.best)}</b>${prio.bestReason ? ` — <i>${esc(prio.bestReason)}</i>` : ''}`);
  else if (picks.length) lines.push('👉 <b>Chưa có mã vượt trội:</b> Nhà đầu tư có thể đứng ngoài quan sát hoặc thăm dò tỷ trọng thấp.');
  if (prio.summary) lines.push(`💡 <i>${esc(prio.summary)}</i>`);
  for (const tier of Object.keys(TIERS)) {
    const group = prio.items.filter((x) => x.tier === tier && bySym.has(x.symbol));
    if (!group.length) continue;
    lines.push('', `${TIERS[tier].icon} <b>${TIERS[tier].label}</b>`);
    for (const x of group) {
      const { a, final, aiNo } = bySym.get(x.symbol);
      lines.push('', buyLine(a, final, { aiNo }));
      if (tier !== 'CHUA_MUA' && x.weightPct > 0) lines.push(`  💼 Tỷ trọng: <b>~${x.weightPct}%</b> NAV`);
      if (x.reason) lines.push(`  💡 <i>${esc(x.reason)}</i>`);
    }
  }
  // Mã không có trong kết quả xếp hạng (không xảy ra khi sanitize đúng) vẫn được liệt kê
  for (const p of picks.filter((p) => !prio.items.some((x) => x.symbol === p.a.symbol))) lines.push('', buyLine(p.a, p.final, { aiNo: p.aiNo }));

  if (holdings.length) {
    const s = pf.summary;
    const pnlSign = s.unrealizedPct >= 0 ? '+' : '';
    const daySign = kind === 'close' ? ` · Hôm nay: ${money(s.dayChange)}` : '';
    lines.push('', DIVIDER, `🧾 <b>DANH MỤC NẮM GIỮ & PHÂN TÍCH AI</b> (Hiệu suất: <b>${pnlSign}${num(s.unrealizedPct, 1)}%</b>${daySign})`);
    for (const { a, final } of holdings) lines.push('', holdingLine(a, final?.code ?? a.brief?.code, { noAi: !final, final, detailed: true }));
  }

  const skipped = [
    rejected.length && `• ${rejected.map(esc).join(', ')}: AI loại sau phản biện`,
    junk.length && `• ${junk.map((x) => `${esc(x.symbol)} (${esc(x.reason)})`).join(', ')}`,
    lowReward.length && `• ${lowReward.map((x) => esc(x.symbol)).join(', ')}: Lời kỳ vọng &lt; 4%`,
  ].filter(Boolean);
  if (skipped.length) lines.push('', DIVIDER, '🛡️ <b>MÃ ĐÃ LỌC BỎ / RỦI RO</b>', ...skipped.map((x) => `<i>${x}</i>`));
  if (unverified.length) lines.push('', `⚠️ <i>AI chưa thẩm định kịp: ${unverified.map(esc).join(', ')}</i>`);
  lines.push('', DIVIDER, '<i>💡 Hệ thống phân tích tự động từ AI. Luôn tuân thủ kỷ luật cắt lỗ & bảo vệ NAV.</i>');
  return { text: lines.join('\n'), unverified, trades };
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

/**
 * Soạn và gửi bản tin. `waitForAi`: nếu có mã AI chưa thẩm định được thì không gửi (trả về sent: false)
 * để lịch thử lại sau.
 */
export async function sendReport(kind = 'close', { waitForAi = false } = {}) {
  const { text, unverified, trades } = await buildReport(kind);
  if (waitForAi && unverified.length) return { ok: true, sent: false, kind, unverified };
  await sendMessage(text);
  logTelegramReport(kind, text, unverified);
  await recordTrades(trades).catch((err) => console.error('[Telegram] Lỗi lưu gợi ý:', err.message));
  return { ok: true, sent: true, kind, length: text.length, unverified };
}

// Hạn chờ AI: quá giờ này thì gửi luôn, ghi rõ mã chưa thẩm định
const AI_DEADLINE = { open: 10 * 60 + 30, close: 17 * 60 };
const RETRY_MS = 15 * 60_000;

/**
 * Bản tin nào cần gửi lúc này: ngày giao dịch được xác nhận bằng nến VN-Index của hôm nay (tự bỏ qua ngày lễ).
 * open: 9:20–11:30; close: từ 15:10 (khởi động muộn vẫn gửi bù trong ngày).
 */
export function dueReport(now, latestBar, last = {}) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const today = vn.toISOString().slice(0, 10);
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  if (latestBar !== today) return null;
  if (minutes >= 15 * 60 + 10) return last.close === today ? null : 'close';
  if (minutes >= 9 * 60 + 20 && minutes <= 11 * 60 + 30) return last.open === today ? null : 'open';
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
      if (vn.getUTCDay() === 0 || vn.getUTCDay() === 6) return;
      const { bars } = await getPriceHistory('VNINDEX');
      const kind = dueReport(new Date(), bars.at(-1)?.time, await loadSent());
      if (!kind) return;
      const waitForAi = vn.getUTCHours() * 60 + vn.getUTCMinutes() < AI_DEADLINE[kind];
      const r = await sendReport(kind, { waitForAi });
      if (!r.sent) {
        retryAt = Date.now() + RETRY_MS;
        console.warn(`[Telegram] Chờ AI thẩm định ${r.unverified.join(', ')}; thử lại sau 15 phút`);
        return;
      }
      await markSent(kind, bars.at(-1).time);
      console.log(`[Telegram] Đã gửi bản tin ${kind === 'open' ? 'mở cửa' : 'đóng cửa'} ${bars.at(-1).time}${r.unverified.length ? ` (AI chưa thẩm định: ${r.unverified.join(', ')})` : ''}`);
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
