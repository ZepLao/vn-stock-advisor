// Chọn mã để gợi ý mua (bản tin Telegram, radar trong phiên): ưu tiên ngành dẫn đầu dòng tiền, loại "mã rác".
// Nghiên cứu 10/2026 (2023–2026, nhóm MUA điểm ≥ 70 trên MA200, so VN-Index sau 20 phiên): mã thuộc top 5 ngành theo
// dòng tiền 5 phiên +0,9% so với nửa dưới +0,5% và ngành nhỏ/không rõ +0,2% (top hơn ở 3/4 năm) → chỉ XẾP ƯU TIÊN,
// không loại hẳn ngành khác. Lọc mã rác là quy tắc an toàn (số liệu cơ bản quá khứ không có để kiểm chứng).
import { liquidityCheck } from './screener.js';
import { screenCriteria } from './data.js';

// pinnedRange: biên độ (cao nhất − thấp nhất) 20 phiên dưới 2% giá = giá bị ghim (chào mua công khai, hoán đổi sáp nhập…),
// mua vào không có dư địa lãi. Trên 135 mã × 1,5 năm chỉ NAF (8–10/2026) chạm ngưỡng này liên tục.
export const JUNK_RULES = { minRoe: 0.05, maxDebtToEquity: 3, pennyPrice: 10, pennyMinRoe: 0.12, pinnedRange: 0.02 };
export const SECTOR_TOP = 5;
const FINANCIAL = /ngân hàng|chứng khoán|bảo hiểm|tài chính/i;

/** Mã → { name, rank, total, net } từ bảng dòng tiền ngành (getSectorFlows). */
export function sectorMap(flows) {
  const m = new Map();
  (flows?.sectors || []).forEach((s, k) => {
    const info = { name: s.name, rank: k + 1, total: flows.sectors.length, net: s.net, count: s.count };
    for (const x of s.stocks) m.set(x.symbol, info);
  });
  return m;
}

/** Hạng ưu tiên theo ngành: 0 = top ngành, 1 = ngành đang được mua ròng, 2 = ngành khác, 3 = ngành nhỏ / không rõ. */
export function sectorTier(s) {
  if (!s || s.name === 'Khác' || (s.count != null && s.count < 3)) return 3;
  if (s.rank <= SECTOR_TOP) return 0;
  return s.net > 0 ? 1 : 2;
}

/** Sắp ứng viên: ngành mạnh trước, cùng hạng ngành thì điểm xếp hạng cao trước. */
export function orderBySector(rows, sectors) {
  return [...rows].sort((a, b) => sectorTier(sectors.get(a.symbol)) - sectorTier(sectors.get(b.symbol)) || b.score - a.score);
}

/**
 * "Mã rác": không xác minh được tài chính, đang lỗ, ROE quá thấp, nợ quá cao (trừ tài chính), thanh khoản không đều,
 * hoặc cổ phiếu penny (< 10 nghìn) mà ROE dưới 12%.
 * @param {object} a kết quả analyzeSymbol
 * @returns {{ junk: boolean, reasons: string[] }}
 */
export function junkCheck(a) {
  const R = JUNK_RULES;
  const f = a.fundamental?.data;
  const reasons = [];
  if (!f) reasons.push('không có số liệu tài chính để xác minh');
  else {
    if (f.epsTTM == null || f.epsTTM <= 0) reasons.push(f.epsTTM == null ? 'chưa có EPS' : 'đang lỗ 4 quý');
    if (f.roe != null && f.roe < R.minRoe) reasons.push(`ROE ${(f.roe * 100).toFixed(1)}% quá thấp`);
    if (!FINANCIAL.test(a.sector?.name || '') && f.debtToEquity != null && f.debtToEquity > R.maxDebtToEquity) reasons.push(`nợ vay/vốn chủ ${f.debtToEquity.toFixed(1)} lần`);
    if (a.price?.close < R.pennyPrice && !(f.roe >= R.pennyMinRoe)) reasons.push('cổ phiếu penny, hiệu quả kém');
  }
  const bars = a.recentBars;
  if (bars?.length >= 20 && !liquidityCheck(bars, screenCriteria().minValue).pass) reasons.push('thanh khoản không đều');
  const pin = pinnedNote(bars);
  if (pin) reasons.push(pin);
  return { junk: reasons.length > 0, reasons };
}

/** Lý do nếu giá bị ghim (biên độ 20 phiên < JUNK_RULES.pinnedRange), ngược lại null. */
export function pinnedNote(bars) {
  if (!(bars?.length >= 20)) return null;
  const w = bars.slice(-20);
  const range = (Math.max(...w.map((b) => b.high)) - Math.min(...w.map((b) => b.low))) / w.at(-1).close;
  return range < JUNK_RULES.pinnedRange ? `giá bị ghim, đi ngang ${(range * 100).toFixed(1)}%/20 phiên — có thể đang chào mua/hoán đổi` : null;
}

// Lời kỳ vọng tối thiểu tới mức chốt: phí + thuế mua/bán ~0,35–0,4% và trượt giá, nên dưới 4% là không đáng vào lệnh
export const MIN_REWARD = 0.04;

/** Mức lời từ giá hiện tại tới chốt lời có đủ không. */
export function rewardCheck(close, L, min = MIN_REWARD) {
  if (!close || !L?.target) return { ok: true, reward: null };
  const reward = L.target / close - 1;
  return { ok: reward >= min, reward };
}

/**
 * Các ngành dẫn đầu dòng tiền và mã mạnh nhất (điểm xếp hạng) của mỗi ngành, để bản tin luôn nêu mã đầu ngành
 * kể cả khi chưa đủ điều kiện mua. Bỏ ngành nhỏ (< 3 mã trong rổ) / "Khác" và ngành bị bán ròng.
 * @returns {{ name: string, net: number, leaders: { symbol: string, score: number, aboveMa200: boolean|null }[] }[]}
 */
export function sectorLeaders(flows, rows, { sectors = 4, perSector = 2 } = {}) {
  const bySym = new Map(rows.map((r) => [r.symbol, r]));
  return (flows?.sectors || [])
    .filter((s) => s.net > 0 && s.count >= 3 && s.name !== 'Khác')
    .slice(0, sectors)
    .map((s) => ({
      name: s.name, net: s.net,
      leaders: s.stocks.map((x) => bySym.get(x.symbol)).filter((r) => r?.score != null)
        .sort((a, b) => b.score - a.score).slice(0, perSector)
        .map((r) => ({ symbol: r.symbol, score: r.score, aboveMa200: r.aboveMa200 })),
    }));
}
