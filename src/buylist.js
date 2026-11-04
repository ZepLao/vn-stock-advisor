// Danh sách mua của hệ thống (trang Tiềm năng): đúng luật tool tự đầu tư đã kiểm định, không qua AI.
//  - ứng viên: điểm xếp hạng ≥ 70 và trên MA200, hoặc xu hướng chuẩn; bỏ mã ⛔ (10% điểm thấp nhất); điểm cao trước;
//  - tối đa `slots` mã, mỗi ngành `perSector` mã; mỗi mã khoảng maxExposure / slots tài sản (giữ dự phòng tiền mặt);
//  - thị trường yếu (dưới minBreadth mã trên MA50): không mua mới.
import { getRankBoard } from './ranking.js';
import { getMarketRegime } from './regime.js';
import { getPortfolio } from './portfolio.js';
import { AUTO_RULES, getAutoTrade } from './autotrade.js';

/**
 * Danh sách mua (hàm thuần).
 * @param {{ rows: object[], breadth: number|null, nav: number|null, held?: string[], tool?: { held: string[], pending: string[] } }} o
 */
export function buildBuyList({ rows, breadth, nav, held = [], tool = { held: [], pending: [] } }, R = AUTO_RULES) {
  const gated = R.minBreadth != null && breadth != null && breadth < R.minBreadth;
  const perSec = new Map();
  const picks = [];
  for (const r of [...rows].filter((x) => !x.avoid && ((x.score >= 70 && x.aboveMa200 !== false) || x.trendPick)).sort((a, b) => b.score - a.score)) {
    if (picks.length >= R.slots) break;
    const sec = r.sector || 'Khác';
    if ((perSec.get(sec) || 0) >= R.perSector) continue;
    perSec.set(sec, (perSec.get(sec) || 0) + 1);
    const budget = nav ? (nav * (R.maxExposure ?? 1)) / R.slots : null;
    picks.push({
      symbol: r.symbol, name: r.shortName || r.companyName || '', sector: sec, close: r.close, changePct: r.changePct,
      score: r.score, trendPick: !!r.trendPick, from52wHigh: r.trend?.pctFrom52wHigh ?? null,
      budget: budget ? Math.round(budget) : null,
      shares: budget && r.close ? Math.floor(budget / (r.close * 1000 * 1.0015)) : null,
      held: held.includes(r.symbol), toolHeld: tool.held.includes(r.symbol), toolPending: tool.pending.includes(r.symbol),
    });
  }
  return {
    gated, breadth, minBreadth: R.minBreadth, nav, slots: R.slots, perSector: R.perSector, maxExposure: R.maxExposure ?? 1,
    action: gated ? 'Chưa mua mới: thị trường yếu' : picks.length ? 'Được mua theo danh sách, rải dần tối đa 2 mã mỗi phiên' : 'Chưa có mã đạt chuẩn',
    picks,
  };
}

export async function getBuyList() {
  const [board, regime, pf, at] = await Promise.all([
    getRankBoard(), getMarketRegime().catch(() => null), getPortfolio().catch(() => null), getAutoTrade().catch(() => null),
  ]);
  const breadth = regime?.breadth?.pctAboveMa50 != null ? regime.breadth.pctAboveMa50 / 100 : null;
  return {
    date: board.date, updatedAt: new Date().toISOString(),
    ...buildBuyList({
      rows: board.rows, breadth, nav: pf?.capital?.nav ?? null,
      held: (pf?.holdings || []).map((h) => h.symbol),
      tool: { held: (at?.holdings || []).map((h) => h.symbol), pending: (at?.pending || []).filter((p) => p.side === 'BUY').map((p) => p.symbol) },
    }),
  };
}
