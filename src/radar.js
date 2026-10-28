// Radar cơ hội mua trong phiên: cứ RADAR_MINUTES phút (mặc định 15) tính lại bảng xếp hạng toàn bộ rổ
// (HOSE ≥ 5 tỷ/phiên), tìm mã thuộc nhóm MUA đã kiểm chứng (điểm ≥ 70, trên MA200) mà giá đang nằm trong vùng mua,
// cho AI thẩm định rồi báo ngay qua Telegram + danh sách cảnh báo trong app, không phải chờ bản tin 15:10.
// Nghiên cứu 10/2026 (2023–2026): mã vừa lọt vào nhóm MUA hơn VN-Index ngang mã đã ở sẵn trong nhóm (~+0,5%/20 phiên),
// nên radar không thêm tiêu chí mới, chỉ giúp báo kịp lúc giá vào vùng mua.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { analyzeSymbol, marketContext } from './analyze.js';
import { getRankBoard } from './ranking.js';
import { uncache } from './http.js';
import { getTuning } from './tuning.js';
import { recordTrades } from './selfreview.js';
import { telegramConfig, sendMessage, aiFinal, buyLevels, buyLine, tradeRecord, marketLine, esc, num } from './telegram.js';
import { getSectorFlows } from './sectors.js';
import { sectorMap, orderBySector, junkCheck } from './picks.js';
import { getMarketRegime } from './regime.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = join(DATA, 'radar.json');
const BUY_CODES = ['BUY', 'ACCUMULATE'];

export const RADAR = {
  minutes: Number(process.env.RADAR_MINUTES) || 15,
  maxDaily: Number(process.env.RADAR_MAX_DAILY) || 5, // số tin cơ hội tối đa mỗi ngày (chống spam)
  perTick: 6, // số mã phân tích sâu mỗi lượt (tránh dội API nguồn dữ liệu / AI)
  recheckMinutes: 45, // mã đã xem mà chưa vào vùng mua: xem lại sau
};

const vnNow = (now = new Date()) => new Date(now.getTime() + 7 * 3600_000);

/** Khung giờ radar: 9:30–14:30 thứ 2–6 (bỏ ATO/ATC, giá dễ nhiễu). */
export function radarWindow(now = new Date()) {
  const vn = vnNow(now);
  const day = vn.getUTCDay(), m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 + 30 && m <= 14 * 60 + 30;
}

/** Giá nằm trong vùng mua (cho phép lệch 0,5%) và chưa thủng cắt lỗ. */
export function inBuyZone(close, L) {
  if (!L?.buyFrom || !L?.buyTo || close == null) return false;
  if (L.stop && close <= L.stop) return false;
  return close >= L.buyFrom * 0.995 && close <= L.buyTo * 1.005;
}

/**
 * Mã cần xem lượt này: nhóm MUA của bảng xếp hạng, chưa nắm giữ, chưa báo hôm nay, chưa xem gần đây;
 * mã thuộc ngành dẫn đầu dòng tiền trước, cùng hạng ngành thì điểm cao trước.
 */
export function radarCandidates(rows, { held = new Set(), seen = new Set(), checked = {}, now = Date.now(), limit = RADAR.perTick, sectors = new Map() } = {}) {
  const list = rows
    .filter((r) => r.pfRank != null && r.score >= 70 && !held.has(r.symbol) && !seen.has(r.symbol))
    .filter((r) => !checked[r.symbol] || now - checked[r.symbol] >= RADAR.recheckMinutes * 60_000);
  // Ưu tiên các mã đạt chuẩn Trend Pick 8 năm lên trước
  list.sort((a, b) => (b.trendPick ? 1 : 0) - (a.trendPick ? 1 : 0));
  return orderBySector(list, sectors).slice(0, limit).map((r) => r.symbol);
}

let state = null;
async function load(today) {
  if (!state) {
    try { state = JSON.parse(await readFile(FILE, 'utf8')); } catch { state = {}; }
  }
  if (state.date !== today) state = { date: today, seen: [], checked: {}, sent: [], rejected: [] };
  return state;
}
async function save() {
  await mkdir(DATA, { recursive: true });
  await writeFile(FILE, JSON.stringify(state), 'utf8');
}

// Mã đã có trong bản tin hôm nay (trades.json) thì không báo lại
async function reportedToday(today) {
  try {
    const t = JSON.parse(await readFile(join(DATA, 'trades.json'), 'utf8'));
    return (t.items || []).filter((x) => x.date === today).map((x) => x.symbol);
  } catch {
    return [];
  }
}

async function openSent() {
  try { return JSON.parse(await readFile(join(DATA, 'telegram.json'), 'utf8')).open; } catch { return null; }
}

export function radarMessage(a, final, rank, market, { aiNo = false } = {}) {
  const hhmm = vnNow().toISOString().slice(11, 16);
  const badges = [];
  if (a.trendPick || rank?.trendPick) badges.push('★ TREND PICK');
  if (a.vcp?.isVcp) badges.push('★ VCP');
  if (a.pocketPivot?.isPocketPivot) badges.push('⚡ POCKET PIVOT');
  const badgeLine = badges.length ? `🏷️ <code>[ ${badges.join(' · ')} ]</code>` : null;

  const mcLine = a.monteCarlo
    ? `  🎲 Monte Carlo (20p): P(tăng) <b>${Math.round(a.monteCarlo.probUp * 100)}%</b> · R/R <b>${a.monteCarlo.rr}</b> · <b>${a.monteCarlo.signal}</b>`
    : null;
  const rankLine = `  🏆 Xếp hạng: <b>${rank.score}đ</b>${rank.pfRank ? ` (#${rank.pfRank} trên MA200)` : ''} · <i>Vừa chạm vùng mua</i>`;

  return [
    `🎯 <b>CƠ HỘI MUA TRONG PHIÊN</b> · <code>${hhmm}</code>`,
    '━━━━━━━━━━━━━━━━━━━━',
    marketLine(market),
    badgeLine,
    '',
    buyLine(a, final, { aiNo }),
    rankLine,
    mcLine,
    '',
    `<i>${aiNo ? '⚠️ AI chưa đồng ý, cân nhắc kỹ.' : '✅ Đã qua AI thẩm định.'} Khuyến nghị tự động theo dõi trong phiên.</i>`,
  ].filter((x) => x != null && x !== '').join('\n');
}

export function radarRiskMessage(a, holding) {
  const hhmm = vnNow().toISOString().slice(11, 16);
  const reasons = a.stockRisk?.reasons?.join(' · ') || 'Dấu hiệu rủi ro cao';
  const close = a.price?.close;
  const chg = a.price?.changePct != null ? `${a.price.changePct >= 0 ? '+' : ''}${a.price.changePct}%` : '–';
  const avg = holding?.avgCost || holding?.costPrice;
  const pnl = avg && close ? ((close / avg - 1) * 100).toFixed(1) : null;
  const pnlText = pnl != null ? ` (${pnl >= 0 ? 'Lãi +' : 'Lỗ '}${pnl}%)` : '';

  return [
    `🚨 <b>CẢNH BÁO NGUY HIỂM DANH MỤC</b> · <code>${hhmm}</code>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `⚠️ Mã <b>${esc(a.symbol)}</b> · Giá hiện tại: <b>${num(close)}</b> (${chg})`,
    `  • Vị thế: Đang giữ <b>${num(holding?.qty, 0)}</b> cp · Giá vốn <b>${num(avg)}</b>${pnlText}`,
    `  • Mức độ rủi ro: <b>${esc(a.stockRisk?.riskLevel || 'RẤT CAO')}</b>`,
    `  • Tín hiệu vi phạm: <i>${esc(reasons)}</i>`,
    '',
    '👉 <b>KHUYẾN NGHỊ:</b> Kích hoạt lệnh BÁN hoặc hạ tỷ trọng ngay để bảo toàn vốn!',
  ].join('\n');
}

let busy = false;

/**
 * Một lượt quét. Trả về danh sách mã đã báo trong lượt.
 * force: bỏ qua khung giờ, chạy thử (không gửi Telegram, không ghi cảnh báo/lệnh/trạng thái).
 */
export async function radarTick({ force = false } = {}) {
  if (busy) return { skipped: 'đang quét' };
  if (!force && !radarWindow()) return { skipped: 'ngoài giờ radar' };
  busy = true;
  try {
    const { bars } = await getPriceHistory('VNINDEX');
    const today = bars.at(-1)?.time;
    if (!force && today !== vnNow().toISOString().slice(0, 10)) return { skipped: 'không phải ngày giao dịch' };
    if (!force && telegramConfig().enabled && (await openSent()) !== today) return { skipped: 'chờ bản tin mở cửa gửi xong' };
    const st = force ? { date: today, seen: [], checked: {}, sent: [], rejected: [] } : await load(today);
    const tune = getTuning();
    const maxDaily = tune.caution ? Math.min(2, RADAR.maxDaily) : RADAR.maxDaily;
    if (st.sent.length >= maxDaily) return { skipped: `đã báo đủ ${maxDaily} mã hôm nay` };

    const [{ getPortfolio }, tracker] = await Promise.all([import('./portfolio.js'), import('./tracker.js')]);
    uncache('rank-board'); // bảng xếp hạng cache 30 phút: tính lại bằng giá trong phiên
    const [board, market, pf, reported, flows] = await Promise.all([
      getRankBoard(), marketContext().catch(() => null), getPortfolio().catch(() => null), reportedToday(today), getSectorFlows(5).catch(() => null),
    ]);
    const sectors = sectorMap(flows);
    const held = new Set((pf?.holdings || []).map((h) => h.symbol));
    const seen = new Set([...st.seen, ...reported]);
    // Quét cảnh báo rủi ro rơi tự do cho các mã đang nắm giữ trong danh mục
    for (const h of pf?.holdings || []) {
      if (st.riskAlerted?.[h.symbol] === today) continue;
      const ha = await analyzeSymbol(h.symbol, { withChart: false }).catch(() => null);
      if (ha?.stockRisk?.isRisky) {
        (st.riskAlerted ??= {})[h.symbol] = today;
        const alertText = radarRiskMessage(ha, h);
        if (!force && telegramConfig().enabled) {
          await sendMessage(alertText).catch((err) => console.error('[Radar] Lỗi gửi cảnh báo rủi ro:', err.message));
        }
        await tracker.pushAlert(h.symbol, 'risk', `Cảnh báo rủi ro cao: ${ha.stockRisk.reasons.join(' · ')}`);
        console.warn(`[Radar] Báo động rủi ro danh mục cho ${h.symbol}`);
      }
    }

    const now = Date.now();
    const found = [];

    // Kiểm tra chế độ thị trường chung: Nếu thị trường rủi ro cao, không báo điểm mua mới
    const regime = await getMarketRegime().catch(() => null);
    if (!force && regime && !regime.allowNewBuys) {
      const why = regime.distDays != null ? `${regime.distDays} ngày phân phối` : regime.label;
      console.warn(`[Radar] Thị trường không cho mua mới (${why}), tạm dừng phát tín hiệu MUA mới.`);
      await save();
      return { date: today, skipped: `thị trường rủi ro (${why}, ưu tiên giữ tiền)` };
    }
    for (const sym of radarCandidates(board.rows, { held, seen, checked: st.checked, now, sectors })) {
      if (st.sent.length >= maxDaily) break;
      st.checked[sym] = now;
      const a = await analyzeSymbol(sym, { withChart: false }).catch(() => null);
      if (!a || !BUY_CODES.includes(a.brief?.code) || !inBuyZone(a.price.close, a.brief?.levels)) continue;
      const j = junkCheck(a);
      if (j.junk) { st.seen.push(sym); (st.junk ??= []).push(`${sym}: ${j.reasons.join(', ')}`); continue; }
      let final;
      try {
        final = await aiFinal(a, tracker);
      } catch (err) {
        console.warn(`[Radar] AI chưa thẩm định được ${sym}: ${err.message}`);
        if (/hạn mức|API_KEY|Chưa cấu hình/.test(err.message)) break;
        continue;
      }
      const ok = BUY_CODES.includes(final.code);
      st.seen.push(sym);
      if (!force) await recordTrades([tradeRecord(a, final, ok ? 'pick' : 'rejected')]).catch(() => {});
      if (!ok && tune.aiVeto) { st.rejected.push(sym); continue; }
      // Vùng mua của quyết định cuối có thể hẹp hơn kế hoạch hệ thống: kiểm lại
      if (ok && !inBuyZone(a.price.close, buyLevels(a, final))) continue;
      const rank = board.rows.find((r) => r.symbol === sym);
      const text = radarMessage(a, final, rank, market, { aiNo: !ok });
      st.sent.push(sym);
      found.push(force ? { symbol: sym, text } : sym);
      if (force) continue;
      if (telegramConfig().enabled) await sendMessage(text).catch((err) => console.error('[Radar] Lỗi gửi Telegram:', err.message));
      await tracker.pushAlert(sym, 'opportunity', `Cơ hội mua: giá ${a.price.close} trong vùng mua, xếp hạng ${rank.score}${ok ? ', AI đồng ý' : ', AI chưa đồng ý'}`);
      console.log(`[Radar] Báo cơ hội mua ${sym} @ ${a.price.close}`);
    }
    if (!force) await save();
    return { date: today, checked: Object.keys(st.checked).length, sent: st.sent, found, rejected: st.rejected, junk: st.junk || [] };
  } finally {
    busy = false;
  }
}

export async function getRadar() {
  if (!state) {
    try { state = JSON.parse(await readFile(FILE, 'utf8')); } catch { state = {}; }
  }
  return { ...state, config: RADAR, window: radarWindow() };
}

export function startRadar() {
  const run = () => radarTick().catch((err) => console.error('[Radar] Lỗi:', err.message));
  setTimeout(run, 90_000); // đợi bảng xếp hạng và bản tin mở cửa chạy trước
  return setInterval(run, RADAR.minutes * 60_000);
}
