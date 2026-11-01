// Phe mua / phe bán của một mã trong 7–10 phiên gần nhất: dấu hiệu GOM (tích lũy) hay XẢ (phân phối).
// Nguồn:
//  - Giá + khối lượng ngày: khối lượng so với TB20, vị trí giá đóng cửa trong biên độ phiên (gần đỉnh = bên mua thắng).
//  - Khối ngoại và tự doanh mua/bán ròng theo ngày (VNDirect).
//  - Mua chủ động (PB) / bán chủ động (PS) từ dữ liệu khớp lệnh trong phiên. API chỉ trả phiên gần nhất nên tool
//    tự lưu tóm tắt mỗi phiên vào data/orderflow.json để dần có chuỗi lịch sử.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, cached } from './http.js';

const MIN = 60_000;
const FINFO = 'https://api-finfo.vndirect.com.vn/v4';
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'orderflow.json');
export const SESSIONS = 10;
export const BIG_ORDER_VALUE = 5e8; // lệnh khớp ≥ 500 triệu đồng coi là lệnh lớn (tổ chức / nhà đầu tư lớn)
const KEEP_DAYS = 40;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ---------- Lưu tóm tắt mua/bán chủ động theo phiên ----------
let store = null;
let saving = Promise.resolve();
async function load() {
  if (store) return store;
  try { store = JSON.parse(await readFile(FILE, 'utf8')); } catch { store = {}; }
  return store;
}
function persist() {
  saving = saving.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(store), 'utf8');
  }).catch(() => {});
  return saving;
}

/** Tóm tắt các lệnh khớp trong phiên: mua/bán chủ động, lệnh lớn, ATO/ATC. */
export function summarizeTicks(ticks, bigValue = BIG_ORDER_VALUE) {
  const s = { buy: 0, sell: 0, auction: 0, bigBuy: 0, bigSell: 0, bigBuyCount: 0, bigSellCount: 0, ticks: ticks.length };
  for (const t of ticks) {
    const vol = t.lastVol || 0;
    const big = vol * (t.last || 0) * 1000 >= bigValue;
    if (t.side === 'PB') { s.buy += vol; if (big) { s.bigBuy += vol; s.bigBuyCount++; } }
    else if (t.side === 'PS') { s.sell += vol; if (big) { s.bigSell += vol; s.bigSellCount++; } }
    else s.auction += vol; // ATO / ATC: khớp định kỳ, không xác định bên chủ động
  }
  const tot = s.buy + s.sell;
  s.buyRatio = tot ? round(s.buy / tot, 3) : null;
  const bigTot = s.bigBuy + s.bigSell;
  s.bigBuyRatio = bigTot ? round(s.bigBuy / bigTot, 3) : null;
  return s;
}

const intradayTTL = () => {
  const vn = new Date(Date.now() + 7 * 3600_000);
  const day = vn.getUTCDay();
  const m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const isTrading = day >= 1 && day <= 5 && ((m >= 540 && m <= 695) || (m >= 780 && m <= 905));
  return isTrading ? 3 * MIN : 30 * MIN;
};

/** Mua/bán chủ động của phiên gần nhất (đọc toàn bộ lệnh khớp, tối đa 6 trang × 5000 lệnh). Lưu lại theo ngày. */
export function getIntradayFlow(symbol) {
  return cached(`intraday-flow:${symbol}`, intradayTTL(), async () => {
    const ticks = [];
    let date = null;
    // Phải sắp xếp theo KL lũy kế: không sắp xếp thì các trang trùng / sót lệnh. API không trả tổng số trang,
    // nên đọc đến khi một trang không đầy.
    for (let page = 1; page <= 12; page++) {
      const r = await fetchJson(`${FINFO}/stock_intraday_latest?q=code:${symbol}&sort=accumulatedVol&size=5000&page=${page}`);
      const data = r.data || [];
      ticks.push(...data);
      date ??= data[0]?.tradingDate ?? null;
      if (data.length < 5000) break;
    }
    if (!ticks.length || !date) return null;
    const summary = { date, ...summarizeTicks(ticks), at: new Date().toISOString() };
    await load();
    store[symbol] ??= {};
    store[symbol][date] = summary;
    const dates = Object.keys(store[symbol]).sort();
    for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete store[symbol][d];
    persist();
    return summary;
  });
}

/** Các phiên đã lưu mua/bán chủ động của một mã: { [date]: summary }. */
export async function storedIntraday(symbol) {
  await load();
  return store[symbol] || {};
}

/** Tự doanh mua/bán ròng theo ngày (mới nhất trước). */
export function getProprietaryFlow(symbol, size = 15) {
  return cached(`prop:${symbol}:${size}`, 10 * MIN, async () => {
    const r = await fetchJson(`${FINFO}/proprietary_trading?q=code:${symbol}&sort=date:desc&size=${size}&fields=date,buyingVol,sellingVol,buyingVal,sellingVal,netVal,netVol`);
    return (r.data || []).map((d) => ({ date: d.date, buyVal: d.buyingVal, sellVal: d.sellingVal, netVal: d.netVal, netVol: d.netVol }));
  });
}

// ---------- Đọc từng phiên và cả giai đoạn ----------
export const READS = { GOM: 'Gom', XA: 'Xả', TRUNG_TINH: 'Trung tính' };

/**
 * Chấm từng phiên theo quy tắc (gợi ý cho AI, không phải kết luận cuối):
 * giá tăng + KL lớn + đóng cửa gần đỉnh = bên mua thắng; giá giảm + KL lớn + đóng cửa gần đáy = bị xả;
 * đi ngang + KL lớn: đóng cửa cao = hấp thụ (gom), đóng cửa thấp = phân phối; giảm với KL thấp = cạn cung.
 */
export function readSession(d) {
  let score = 0;
  const why = [];
  const { chg, volRatio: vr, clv } = d;
  if (vr != null && clv != null) {
    if (chg > 0.5 && vr >= 1.2 && clv >= 0.3) { score += 2; why.push('tăng, KL lớn, đóng cửa gần đỉnh'); }
    else if (chg < -0.5 && vr >= 1.2 && clv <= -0.3) { score -= 2; why.push('giảm, KL lớn, đóng cửa gần đáy'); }
    else if (Math.abs(chg) <= 1 && vr >= 1.3 && clv >= 0.3) { score += 1; why.push('đi ngang KL lớn, đóng cửa cao: hấp thụ'); }
    else if (Math.abs(chg) <= 1 && vr >= 1.3 && clv <= -0.3) { score -= 1; why.push('đi ngang KL lớn, đóng cửa thấp: phân phối'); }
    else if (chg > 0.5 && vr < 0.8) why.push('tăng nhưng KL thấp: cầu yếu');
    else if (chg < -0.5 && vr < 0.8) { score += 0.5; why.push('giảm với KL thấp: cạn cung'); }
    if (chg > 2 && vr >= 2 && clv <= -0.2) { score -= 1; why.push('KL đột biến nhưng đóng cửa xa đỉnh: có lực xả'); }
  }
  const inst = (d.foreignNet ?? 0) + (d.propNet ?? 0);
  if (d.value && Math.abs(inst) >= d.value * 0.05) {
    score += inst > 0 ? 1 : -1;
    why.push(`${inst > 0 ? 'khối ngoại + tự doanh mua ròng' : 'khối ngoại + tự doanh bán ròng'} ${(Math.abs(inst) / 1e9).toFixed(1)} tỷ`);
  }
  if (d.active?.buyRatio != null) {
    const br = d.active.buyRatio;
    if (br >= 0.56) { score += 1; why.push(`mua chủ động ${Math.round(br * 100)}%`); }
    else if (br <= 0.44) { score -= 1; why.push(`bán chủ động ${Math.round((1 - br) * 100)}%`); }
    const bb = d.active.bigBuyRatio;
    if (bb != null && d.active.bigBuy + d.active.bigSell > 0) {
      if (bb >= 0.6) { score += 1; why.push(`lệnh lớn nghiêng mua ${Math.round(bb * 100)}%`); }
      else if (bb <= 0.4) { score -= 1; why.push(`lệnh lớn nghiêng bán ${Math.round((1 - bb) * 100)}%`); }
    }
  }
  const read = score >= 1.5 ? 'GOM' : score <= -1.5 ? 'XA' : 'TRUNG_TINH';
  return { read, score, why };
}

/**
 * Bảng 7–10 phiên gần nhất kèm tổng hợp giai đoạn.
 * @param {object[]} bars nến ngày tăng dần
 * @param {{ foreign?: object[], prop?: object[], intraday?: Record<string, object>, n?: number }} src
 */
export function buildFlow(bars, { foreign = [], prop = [], intraday = {}, n = SESSIONS } = {}) {
  if (!bars || bars.length < 30) return null;
  const fMap = new Map((foreign || []).map((x) => [x.date, x.netVal]));
  const pMap = new Map((prop || []).map((x) => [x.date, x.netVal]));
  const start = bars.length - n;
  const sessions = [];
  for (let i = start; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1];
    let v20 = 0;
    for (let k = i - 20; k < i; k++) v20 += bars[k].volume;
    v20 /= 20;
    const range = b.high - b.low;
    const d = {
      date: b.time, close: b.close, chg: round((b.close / prev.close - 1) * 100),
      volume: b.volume, volRatio: v20 ? round(b.volume / v20) : null,
      clv: range > 0 ? round(((b.close - b.low) - (b.high - b.close)) / range) : 0,
      value: b.close * b.volume * 1000,
      foreignNet: fMap.has(b.time) ? fMap.get(b.time) : null,
      propNet: pMap.has(b.time) ? pMap.get(b.time) : null,
      active: intraday[b.time] || null,
    };
    Object.assign(d, readSession(d));
    sessions.push(d);
  }
  const sum = (f) => sessions.reduce((s, d) => s + (f(d) ?? 0), 0);
  const upVol = sum((d) => (d.chg > 0 ? d.volume : 0));
  const downVol = sum((d) => (d.chg < 0 ? d.volume : 0));
  const totalVol = sum((d) => d.volume);
  const withActive = sessions.filter((d) => d.active);
  const score = sum((d) => d.score);
  const phase = score >= 4 ? 'GOM' : score <= -4 ? 'XA' : 'GIANG_CO';
  return {
    n: sessions.length,
    from: sessions[0].date, to: sessions.at(-1).date,
    priceChg: round((bars.at(-1).close / bars[start - 1].close - 1) * 100),
    upDownVolRatio: downVol ? round(upVol / downVol) : null,
    adLine: totalVol ? round(sum((d) => d.clv * d.volume) / totalVol) : null, // −1..1: khối lượng nghiêng về đóng cửa cao hay thấp
    volVs20: round(sum((d) => d.volRatio) / sessions.length),
    foreignNet: sum((d) => d.foreignNet), propNet: sum((d) => d.propNet),
    activeDays: withActive.length,
    activeBuy: withActive.reduce((s, d) => s + d.active.buy, 0), activeSell: withActive.reduce((s, d) => s + d.active.sell, 0),
    bigBuy: withActive.reduce((s, d) => s + d.active.bigBuy, 0), bigSell: withActive.reduce((s, d) => s + d.active.bigSell, 0),
    gomDays: sessions.filter((d) => d.read === 'GOM').length, xaDays: sessions.filter((d) => d.read === 'XA').length,
    score: round(score, 1), phase,
    sessions,
  };
}

/**
 * Sau 15:10 mỗi ngày giao dịch, lưu mua/bán chủ động cả phiên cho các mã cần theo dõi (danh sách theo dõi,
 * danh mục, cổ phiếu tiềm năng…) để có chuỗi lịch sử, kể cả khi hôm đó không mở mã nào.
 * @param {() => Promise<string[]>} getSymbols
 */
export function startFlowCapture(getSymbols) {
  let doneFor = null;
  const tick = async () => {
    const vn = new Date(Date.now() + 7 * 3600_000);
    const day = vn.getUTCDay(), minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    const today = vn.toISOString().slice(0, 10);
    if (day === 0 || day === 6 || minutes < 15 * 60 + 10 || doneFor === today) return;
    doneFor = today;
    const symbols = [...new Set((await getSymbols().catch(() => [])).filter(Boolean))];
    let saved = 0;
    for (const s of symbols) {
      const r = await getIntradayFlow(s).catch(() => null);
      if (r?.date === today) saved++;
    }
    if (symbols.length) console.log(`[Phe mua/bán] Đã lưu mua/bán chủ động phiên ${today} cho ${saved}/${symbols.length} mã`);
  };
  tick();
  return setInterval(tick, 5 * MIN);
}

/** Lấy đủ nguồn và dựng bảng phe mua/bán cho một mã. */
export async function getOrderFlow(symbol, bars, foreign = null) {
  const [prop, today] = await Promise.all([
    getProprietaryFlow(symbol).catch(() => []),
    getIntradayFlow(symbol).catch(() => null),
  ]);
  const intraday = await storedIntraday(symbol);
  // Phiên giao dịch đang diễn ra: dữ liệu khớp lệnh là của hôm nay nhưng chưa có nến ngày tương ứng
  const flow = buildFlow(bars, { foreign, prop, intraday });
  if (flow) flow.today = today;
  return flow;
}
