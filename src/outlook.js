// Triển vọng tuần do AI phân tích: xu hướng VN-Index tuần tới, nhóm ngành có thể bùng nổ / nên tránh, tin tức nổi bật
// và chiến lược. Đầu vào: bối cảnh VN-Index, dải dao động thống kê 5/10 phiên (neo vùng giá), dòng tiền từng ngành 5 và
// 20 phiên kèm mã mạnh nhất, khối ngoại, độ rộng, tin thị trường vài ngày gần nhất.
// Kiểm tra đầu ra: ngành/mã phải có trong dữ liệu, vùng giá kẹp trong dải 5–95%. Dự báo được ghi vào nhật ký dự đoán
// (nguồn 'outlook' cho VN-Index, 'outlook_sector' cho mã của ngành được chọn) để tự chấm sau 5 phiên.
// Gửi Telegram ngay sau phiên cuối tuần (thứ 6 từ 15:45, bù thứ 7 và chủ nhật nếu app tắt). Lưu data/outlook.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateJson } from './llm.js';
import { getPriceHistory, getMarketMovers } from './data.js';
import { marketContext } from './analyze.js';
import { getMarketNews } from './news.js';
import { getSectorFlows } from './sectors.js';
import { getRankBoard } from './ranking.js';
import { coneSummary } from './forecast.js';
import { recordMany } from './predictions.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'outlook.json');
export const TRENDS = { TANG: 'TĂNG', TANG_NHE: 'TĂNG NHẸ', DI_NGANG: 'ĐI NGANG', GIAM_NHE: 'GIẢM NHẸ', GIAM: 'GIẢM' };
const TREND_DIR = { TANG: 1, TANG_NHE: 1, DI_NGANG: 0, GIAM_NHE: -1, GIAM: -1 };
const TREND_ICON = { TANG: '📈', TANG_NHE: '↗️', DI_NGANG: '➡️', GIAM_NHE: '↘️', GIAM: '📉' };
export const SECTOR_VIEWS = { BUNG_NO: 'có thể bùng nổ', TICH_CUC: 'tích cực', THEO_DOI: 'theo dõi' };
const IMPACT = { TICH_CUC: 'tích cực', TIEU_CUC: 'tiêu cực', TRUNG_LAP: 'trung lập' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d }));
const tỷ = (v) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v) / 1e9)} tỷ`;
const pc = (v, d = 1) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${num(Math.abs(v * 100), d)}%`);

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    trend: { type: 'STRING', enum: Object.keys(TRENDS) },
    confidence: { type: 'INTEGER' },
    low: { type: 'NUMBER' },
    high: { type: 'NUMBER' },
    summary: { type: 'STRING' },
    drivers: { type: 'ARRAY', items: { type: 'STRING' } },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
    hotSectors: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, view: { type: 'STRING', enum: Object.keys(SECTOR_VIEWS) },
          reason: { type: 'STRING' }, symbols: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['name', 'view', 'reason', 'symbols'],
      },
    },
    weakSectors: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, reason: { type: 'STRING' } }, required: ['name', 'reason'] } },
    news: { type: 'ARRAY', items: { type: 'OBJECT', properties: { theme: { type: 'STRING' }, impact: { type: 'STRING', enum: Object.keys(IMPACT) } }, required: ['theme', 'impact'] } },
    strategy: { type: 'STRING' },
  },
  required: ['trend', 'confidence', 'low', 'high', 'summary', 'drivers', 'risks', 'hotSectors', 'weakSectors', 'news', 'strategy'],
};

const SYSTEM = `Bạn là chiến lược gia thị trường chứng khoán Việt Nam. Dự báo cho 5 phiên giao dịch tới dựa HOÀN TOÀN trên dữ liệu
được cung cấp (không bịa số liệu, sự kiện, tin tức). Dải dao động thống kê là phân phối lịch sử: vùng giá dự báo phải nằm
trong dải 5–95%, chỉ chọn TANG/GIAM khi dữ liệu nghiêng rõ; không chắc thì DI_NGANG và độ tin cậy thấp.
Nhóm ngành: chỉ chọn trong danh sách ngành được cung cấp, ghi đúng tên; mã cổ phiếu chỉ lấy trong danh sách mã của ngành đó.
"Bùng nổ" chỉ dùng khi dòng tiền vào mạnh, tăng tốc (tiền vào so với trung bình cao) và có mã dẫn đầu khỏe.
Viết tiếng Việt có dấu, ngắn gọn, dễ hiểu cho nhà đầu tư cá nhân.`;

/** Ngày thứ 2 và thứ 6 của tuần giao dịch kế tiếp tính từ phiên `date` (YYYY-MM-DD). */
export function nextWeek(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const d = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()));
  const dow = d.getUTCDay();
  // Thứ 2–5: tuần hiện tại; thứ 6 sau 15:00, thứ 7, CN: tuần sau
  const afterFriClose = dow === 5 && vn.getUTCHours() >= 15;
  const toMon = dow === 0 ? 1 : dow === 6 ? 2 : afterFriClose ? 3 : 1 - dow;
  const mon = new Date(d.getTime() + toMon * 86_400_000);
  const fri = new Date(mon.getTime() + 4 * 86_400_000);
  return { monday: mon.toISOString().slice(0, 10), friday: fri.toISOString().slice(0, 10) };
}

async function gather() {
  const [market, idxRes, cone, movers, f5, f20, board, news] = await Promise.all([
    marketContext(), getPriceHistory('VNINDEX'),
    getPriceHistory('VNINDEX', 1100).then((r) => coneSummary(r.bars)).catch(() => null),
    getMarketMovers('HOSE').catch(() => null), getSectorFlows(5), getSectorFlows(20).catch(() => null),
    getRankBoard(), getMarketNews({ days: 4, limit: 40 }).catch(() => []),
  ]);
  const rank = new Map(board.rows.map((r) => [r.symbol, r]));
  const s20 = new Map((f20?.sectors || []).map((s) => [s.name, s]));
  const sectors = f5.sectors.filter((s) => s.count >= 3 && s.name !== 'Khác').map((s) => {
    const leaders = s.stocks.map((x) => rank.get(x.symbol)).filter((r) => r?.score != null)
      .sort((a, b) => b.score - a.score).slice(0, 4)
      .map((r) => ({ symbol: r.symbol, score: r.score, aboveMa200: r.aboveMa200 }));
    const l = s20.get(s.name);
    return {
      name: s.name, count: s.count, net5: s.net, ret5: s.ret, valueRatio5: s.valueRatio, up5: s.up, down5: s.down,
      foreign5: s.foreignNet, net20: l?.net ?? null, ret20: l?.ret ?? null, leaders, symbols: s.stocks.map((x) => x.symbol),
    };
  });
  const buyGroup = board.rows.filter((r) => r.score >= 70 && r.aboveMa200 !== false).length;
  return { market, last10: idxRes.bars.slice(-10), cone, movers, sectors, buyGroup, universe: board.rows.length, news };
}

export function buildOutlookPrompt(g, week) {
  const m = g.market;
  const L = [`Dự báo tuần ${week.monday} → ${week.friday} (5 phiên).`, '', '## VN-Index'];
  L.push(`Đóng cửa ${m.close} (${m.changePct}% phiên gần nhất ${m.date}), MA50 ${m.ma50}, MA200 ${m.ma200}, ${m.aboveMa200 ? 'trên' : 'dưới'} MA200, xu hướng ${m.trend}, 20 phiên ${m.return20d}%.`);
  L.push(`10 phiên gần nhất: ${g.last10.map((b) => `${b.time.slice(5)} ${Math.round(b.close)}`).join(', ')}`);
  if (g.cone) for (const c of g.cone.filter((x) => x.h <= 10)) {
    L.push(`Dải thống kê ${c.h} phiên: 5% ${c.p05} · 25% ${c.p25} · 50% ${c.p50} · 75% ${c.p75} · 95% ${c.p95} (xác suất tăng ${Math.round(c.probProfit * 100)}%)`);
  }
  if (g.movers) {
    const b = g.movers.breadth;
    L.push(`Độ rộng HOSE phiên gần nhất: ${b.advancers} tăng / ${b.decliners} giảm / ${b.unchanged} đứng; giá trị ${Math.round(b.totalValue / 1e9)} tỷ; khối ngoại ròng ${Math.round(g.movers.foreignTotal.netVal / 1e9)} tỷ.`);
  }
  L.push(`Sức khỏe nhóm dẫn đầu: ${g.buyGroup}/${g.universe} mã có điểm xếp hạng ≥ 70 và trên MA200.`);
  L.push('', '## Dòng tiền theo ngành (ước tính; net = tiền vào ròng, tiền/TB = giá trị giao dịch so với TB 20 phiên trước, xếp theo tiền vào 5 phiên)');
  for (const s of g.sectors) {
    L.push(`- ${s.name} (${s.count} mã): 5 phiên ${tỷ(s.net5)}, giá ${pc(s.ret5)}, tiền/TB ${s.valueRatio5 ?? '–'}x, ${s.up5} tăng/${s.down5} giảm, khối ngoại ${s.foreign5 == null ? '–' : tỷ(s.foreign5)}`
      + `${s.net20 != null ? `; 20 phiên ${tỷ(s.net20)}, giá ${pc(s.ret20)}` : ''}`
      + `; mã mạnh nhất: ${s.leaders.map((l) => `${l.symbol} ${l.score}đ${l.aboveMa200 === false ? ' (dưới MA200)' : ''}`).join(', ') || '–'}`
      + `; mã trong ngành: ${s.symbols.slice(0, 15).join(',')}`);
  }
  if (g.news.length) {
    L.push('', '## Tin thị trường 4 ngày gần nhất (mới nhất trước)');
    for (const n of g.news.slice(0, 35)) L.push(`- ${n.publishedAt ? new Date(n.publishedAt + 7 * 3600_000).toISOString().slice(5, 10) : '?'} ${n.source}: ${n.title}`);
  }
  L.push('', 'Yêu cầu: trend + confidence (0–100) + vùng VN-Index tuần (low/high); summary 2–3 câu; drivers 3–4 ý; risks 2–3 ý;',
    'hotSectors 2–4 ngành (view BUNG_NO/TICH_CUC/THEO_DOI, lý do dựa trên số liệu, 2–4 mã); weakSectors 0–3 ngành nên tránh;',
    'news 3–5 chủ đề tin nổi bật và tác động; strategy 1–2 câu (tỷ trọng cổ phiếu, cách giải ngân).');
  return L.join('\n');
}

/** Kiểm tra đầu ra AI: ngành/mã có thật, vùng giá trong dải 5–95% 5 phiên, độ tin cậy 0–100. */
export function sanitizeOutlook(o, g) {
  const byName = new Map(g.sectors.map((s) => [s.name.toLowerCase(), s]));
  const find = (name) => byName.get(String(name || '').toLowerCase())
    || g.sectors.find((s) => s.name.toLowerCase().includes(String(name || '').toLowerCase()) || String(name || '').toLowerCase().includes(s.name.toLowerCase()));
  const c5 = g.cone?.find((c) => c.h === 5);
  let low = Number(o.low), high = Number(o.high);
  if (c5) {
    const clamp = (v) => Math.min(c5.p95, Math.max(c5.p05, Number.isFinite(v) ? v : c5.p50));
    low = clamp(low); high = clamp(high);
  }
  if (low > high) [low, high] = [high, low];
  const hot = (o.hotSectors || []).map((h) => {
    const s = find(h.name);
    if (!s || !SECTOR_VIEWS[h.view]) return null;
    const syms = (h.symbols || []).map((x) => String(x).toUpperCase()).filter((x) => s.symbols.includes(x)).slice(0, 4);
    return { name: s.name, view: h.view, reason: String(h.reason || ''), symbols: syms.length ? syms : s.leaders.slice(0, 3).map((l) => l.symbol), net5: s.net5 };
  }).filter(Boolean).slice(0, 4);
  const weak = (o.weakSectors || []).map((w) => { const s = find(w.name); return s ? { name: s.name, reason: String(w.reason || '') } : null; })
    .filter((w) => w && !hot.some((h) => h.name === w.name)).slice(0, 3);
  return {
    trend: TRENDS[o.trend] ? o.trend : 'DI_NGANG',
    confidence: Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0))),
    low: Math.round(low), high: Math.round(high),
    summary: String(o.summary || ''),
    drivers: (o.drivers || []).map(String).slice(0, 4),
    risks: (o.risks || []).map(String).slice(0, 3),
    hotSectors: hot, weakSectors: weak,
    news: (o.news || []).filter((n) => IMPACT[n.impact]).map((n) => ({ theme: String(n.theme), impact: n.impact })).slice(0, 5),
    strategy: String(o.strategy || ''),
  };
}

const ddmm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const IND = ' '.repeat(5);

export function formatOutlook(x) {
  const o = x.result;
  const L = [
    `🧭 <b>TRIỂN VỌNG TUẦN ${ddmm(x.week.monday)} – ${ddmm(x.week.friday)}</b>`,
    `VN-Index ${num(x.close)} · ${TREND_ICON[o.trend]} <b>${TRENDS[o.trend]}</b> (tin cậy ${o.confidence}%)`,
    `Vùng dự kiến <b>${num(o.low)} – ${num(o.high)}</b>`,
    '', esc(o.summary),
  ];
  if (o.drivers.length) L.push('', '<b>Động lực</b>', ...o.drivers.map((d) => `• ${esc(d)}`));
  if (o.risks.length) L.push('', '<b>Rủi ro</b>', ...o.risks.map((d) => `• ${esc(d)}`));
  if (o.hotSectors.length) {
    L.push('', '', '🚀 <b>NHÓM NGÀNH TRIỂN VỌNG</b>');
    o.hotSectors.forEach((h, k) => {
      L.push('', `<b>${k + 1}. ${esc(h.name)}</b> — ${SECTOR_VIEWS[h.view]}${h.view === 'BUNG_NO' ? ' 🔥' : ''}`,
        `${IND}<i>${esc(h.reason)}</i>`, `${IND}Mã: <b>${h.symbols.map(esc).join(', ')}</b>`);
    });
  }
  if (o.weakSectors.length) L.push('', '⚠️ <b>Ngành nên tránh</b>', ...o.weakSectors.map((w) => `• <b>${esc(w.name)}</b>: ${esc(w.reason)}`));
  if (o.news.length) L.push('', '', '📰 <b>TIN TỨC NỔI BẬT</b>', ...o.news.map((n) => `• ${esc(n.theme)} <i>(${IMPACT[n.impact]})</i>`));
  if (o.strategy) L.push('', '', '🎯 <b>Chiến lược</b>', esc(o.strategy));
  L.push('', `<i>AI phân tích từ dữ liệu giá, dòng tiền ngành và tin tức. Tham khảo, không phải lời khuyên đầu tư.</i>`);
  return L.join('\n');
}

/** Một dòng tóm tắt để chèn vào bản tin hằng ngày. */
export function outlookLine(x) {
  if (!x?.result) return '';
  const o = x.result;
  const hot = o.hotSectors.slice(0, 2).map((h) => h.name).join(', ');
  return `🧭 Tuần (AI): ${TRENDS[o.trend].toLowerCase()} · ${num(o.low)}–${num(o.high)}${hot ? ` · ngành: ${esc(hot)}` : ''}`;
}

export async function getOutlook() {
  try { return JSON.parse(await readFile(FILE, 'utf8')); } catch { return null; }
}

/** Phân tích và lưu triển vọng tuần (không gửi). */
export async function buildOutlook(now = new Date()) {
  const week = nextWeek(now);
  const g = await gather();
  const { json, model } = await generateJson(buildOutlookPrompt(g, week), { system: SYSTEM, schema: SCHEMA });
  const result = sanitizeOutlook(json, g);
  const x = { week, date: g.market.date, close: g.market.close, createdAt: new Date().toISOString(), model, result };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(x, null, 2), 'utf8');
  // Ghi dự đoán để tự chấm sau 5 phiên
  recordMany([
    { source: 'outlook', symbol: 'VNINDEX', date: x.date, direction: TREND_DIR[result.trend], label: `Tuần: ${TRENDS[result.trend]}`, price: x.close, detail: `${result.low}–${result.high}, tin cậy ${result.confidence}%`, confidence: result.confidence, band: { 5: [result.low, result.high] } },
    ...result.hotSectors.flatMap((h) => h.symbols.map((s) => ({ source: 'outlook_sector', symbol: s, date: x.date, direction: 1, label: `Ngành ${h.name} (${SECTOR_VIEWS[h.view]})` }))),
  ]).catch(() => {});
  return x;
}

/**
 * Có gửi triển vọng lúc `now` không (hàm thuần): từ 15:45 thứ 6 (sau phiên cuối tuần, sau tổng kết tuần 15:40), bù trong
 * thứ 7 và chủ nhật nếu server tắt. Không gửi sáng thứ 2 nữa: bản tin dùng giá đóng cửa thứ 6 nên gửi ngay sau phiên.
 * @returns {{ monday: string, friday: string }|null} tuần cần gửi, null nếu ngoài khung
 */
export function outlookDue(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const dow = vn.getUTCDay(), m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  if (!((dow === 5 && m >= 15 * 60 + 45) || dow === 6 || dow === 0)) return null;
  return nextWeek(now);
}

/** Gửi một lần mỗi tuần theo outlookDue. */
export function startOutlookSchedule(send) {
  if (!send) return null;
  const tick = async () => {
    try {
      const week = outlookDue();
      if (!week) return;
      const prev = await getOutlook();
      if (prev?.week?.monday === week.monday && prev.sentAt) return;
      const x = prev?.week?.monday === week.monday ? prev : await buildOutlook();
      await send(formatOutlook(x));
      x.sentAt = new Date().toISOString();
      await writeFile(FILE, JSON.stringify(x, null, 2), 'utf8');
      console.log(`[Triển vọng tuần] Đã gửi tuần ${week.monday}`);
    } catch (err) {
      console.error('[Triển vọng tuần] Lỗi:', err.message);
    }
  };
  setTimeout(tick, 150_000);
  return setInterval(tick, 20 * 60_000);
}
