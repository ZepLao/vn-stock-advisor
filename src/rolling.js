// Danh mục "cuốn chiếu" theo cách vận hành của Laban (I:\Co-van-chung-khoan\laban, paper_trading.py / risk_research.py /
// overlay_research.py — các quy tắc họ đã kiểm chứng trên HOSE theo thời điểm), chạy trên tín hiệu và dữ liệu của tool này:
//  - ứng viên mỗi phiên quyết định: điểm xếp hạng ≥ 70 và trên MA200, HOẶC "xu hướng chuẩn" (cách đỉnh 52 tuần ≤ 5% và
//    biến động 60 phiên trong 70% êm nhất của rổ); điểm cao trước;
//  - tối đa `slots` mã, mỗi ngành tối đa `perSector`; một suất = giá trị danh mục / slots, nhân hệ số ngược biến động
//    (biến động trung vị của các ứng viên / của mã, kẹp 0,5–1,5) nếu sizing = 'inv_vol';
//  - quyết định mỗi `step` phiên sau giờ đóng cửa, khớp giá mở cửa phiên sau; giữ `hold` phiên rồi bán, trừ khi mã vẫn
//    là ứng viên (giữ tiếp, tính lại thời hạn); KHÔNG cắt lỗ trừ khi đặt `stopPct` (đóng cửa ≤ giá vốn × (1 − stopPct));
//  - luật sàn như các backtest khác: T+2, trần/sàn, lô 100, phí, trượt giá, mã hủy niêm yết thoát giá cuối trừ haircut.
import { getPriceHistory, screenCriteria, avgTradedValue, DELIST_HAIRCUT, DELIST_GAP } from './data.js';
import { cached } from './http.js';
import { BANDS, DEFAULTS, LOT, priceLimits, tickSize, roundUp, roundDown, calcMetrics, maxDrawdown } from './backtest.js';
import { FACTORS, factorReader, buildRef, compositeScore, poolMap, pointInTimeUniverse, TREND_PICK_RULE } from './ranking.js';
import { getSectorFlows } from './sectors.js';

// minBreadth: không mua MỚI ở phiên quyết định khi tỷ lệ mã trong rổ (đủ thanh khoản) đóng cửa trên MA50 dưới ngưỡng này;
// vị thế đang giữ vẫn theo luật giữ / bán. Kiểm định 11/2026 (3 năm, rổ theo thời điểm, đặt quy tắc trước: Sharpe cao hơn ở
// cả hai nửa và sụt tối đa không tệ hơn): Sharpe 1,16 → 1,27 (nửa đầu 1,04 → 1,22, nửa sau 1,32 → 1,35), sụt −16,8% → −14,4%,
// lãi +64,5% → +63,4%. Lọc theo VN-Index dưới MA50 thì kém hẳn (Sharpe 0,76) — đúng như nghiên cứu cũ về lọc theo chỉ số.
// sellAfter: số phiên sau phiên mua mới bán được ở GIÁ MỞ CỬA. Cổ phiếu mua phiên T về tài khoản chiều T+2, nên lệnh bán
// khớp mở cửa sớm nhất ở phiên T+3 (trước đây dùng 2 = bán sáng T+2 khi cổ phiếu chưa về).
export const ROLLING_RULES = { slots: 10, perSector: 3, step: 5, hold: 40, sizing: 'inv_vol', stopPct: null, minBreadth: 0.5, sellAfter: 3 };

/** Giá đóng cửa phiên i trên MA50 (null nếu chưa đủ 50 phiên). */
export function aboveMa50(bars, i) {
  if (i < 49) return null;
  let s = 0;
  for (let k = i - 49; k <= i; k++) s += bars[k].close;
  return bars[i].close > s / 50;
}

/** Độ rộng thị trường: tỷ lệ mã có `up` = true trong các mã đã biết (hàm thuần). */
export function breadthOf(rows) {
  const known = rows.filter((x) => x.up != null);
  return known.length ? known.filter((x) => x.up).length / known.length : null;
}

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// Biến động 60 phiên (độ lệch chuẩn lãi ngày) tại phiên i
export function vol60(bars, i) {
  if (i < 61) return null;
  const r = [];
  for (let k = i - 59; k <= i; k++) r.push(bars[k].close / bars[k - 1].close - 1);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

/**
 * Ứng viên tại một phiên quyết định (hàm thuần): điểm ≥ 70 và trên MA200, hoặc xu hướng chuẩn; điểm cao trước.
 * @param {{ s: string, f: object, vol: number|null }[]} rows các mã thuộc rổ, đủ thanh khoản, có yếu tố tại phiên đó
 */
export function rollingCandidates(rows) {
  const ref = buildRef(rows.map((x) => x.f), FACTORS);
  const vols = rows.map((x) => x.vol).filter((v) => v != null).sort((a, b) => a - b);
  const volCut = vols.length ? vols[Math.floor(vols.length * TREND_PICK_RULE.maxVolPct) - 1] ?? vols.at(-1) : null;
  const cands = rows.map((x) => ({ ...x, score: compositeScore(x.f, ref, FACTORS)?.score ?? null }))
    .filter((x) => x.score != null && ((x.score >= 70 && x.f.aboveMa200 !== false)
      || (x.f.high >= TREND_PICK_RULE.nearHigh - 1 && x.vol != null && volCut != null && x.vol <= volCut)))
    .sort((a, b) => b.score - a.score);
  return { cands, isCand: new Set(cands.map((x) => x.s)), medVol: median(cands.map((x) => x.vol).filter((v) => v != null)) };
}

/**
 * Kế hoạch tại phiên quyết định t (hàm thuần): mã đến hạn giữ (`hold` phiên) mà không còn là ứng viên thì bán,
 * còn là ứng viên thì giữ tiếp; lấp suất trống bằng ứng viên điểm cao nhất (tối đa `perSector` mỗi ngành).
 * @param {{ t: number, held: Map<string, { t: number }>, pendingSell: Set<string>|Map, cands, isCand, medVol,
 *   value: number, free: number, sectorOf: (s: string) => string, R: object }} o
 *   held: vị thế đang giữ (t = phiên bắt đầu tính hạn); value: giá trị danh mục; free: tiền mua được (tiền mặt + mã sắp bán)
 * @returns {{ sells: string[], kept: string[], buys: { s: string, budget: number }[] }}
 */
export function rollingPlan({ t, held, pendingSell, cands, isCand, medVol, value, free, sectorOf, R }) {
  const sells = [], kept = [], buys = [];
  for (const [s, p] of held) {
    if (pendingSell.has(s)) continue;
    if (t - p.t >= R.hold) (isCand.has(s) ? kept : sells).push(s);
  }
  const staying = [...held.keys()].filter((s) => !pendingSell.has(s) && !sells.includes(s));
  const perSec = new Map();
  for (const s of staying) perSec.set(sectorOf(s), (perSec.get(sectorOf(s)) || 0) + 1);
  const freeSlots = R.slots - staying.length;
  if (freeSlots <= 0) return { sells, kept, buys };
  const slot = value / R.slots;
  for (const c of cands) {
    if (buys.length >= freeSlots) break;
    if (held.has(c.s)) continue;
    const sec = sectorOf(c.s);
    if ((perSec.get(sec) || 0) >= R.perSector) continue;
    const w = R.sizing === 'inv_vol' && medVol && c.vol ? Math.min(1.5, Math.max(0.5, medVol / c.vol)) : 1;
    if (free < slot * w * 0.5) break;
    buys.push({ s: c.s, budget: slot * w });
    free -= slot * w;
    perSec.set(sec, (perSec.get(sec) || 0) + 1);
  }
  return { sells, kept, buys };
}

/** Giá khớp lệnh bán ở giá mở cửa phiên i (trừ trượt giá); null nếu mở cửa ở giá sàn (kẹt, không bán được). */
export function sellFillPrice(bars, i, ex, slippage = DEFAULTS.slippage) {
  const { floor } = priceLimits(bars[i - 1].close, BANDS[ex], ex);
  if (bars[i].open <= floor + tickSize(floor, ex) - 1e-9) return null;
  return Math.max(roundDown(bars[i].open * (1 - slippage), ex), floor);
}

/** Giá khớp lệnh mua ở giá mở cửa phiên i (cộng trượt giá); null nếu mở cửa ở giá trần (không mua được). */
export function buyFillPrice(bars, i, ex, slippage = DEFAULTS.slippage) {
  const { ceiling } = priceLimits(bars[i - 1].close, BANDS[ex], ex);
  if (bars[i].open >= ceiling - tickSize(ceiling, ex) + 1e-9) return null;
  return Math.min(roundUp(bars[i].open * (1 + slippage), ex), ceiling);
}

/**
 * Mô phỏng (hàm thuần). `data[s]` = { bars, at, read, ex }. `sectorOf(sym)` → tên ngành.
 * @param {{ start, minValue, initialCash, members?, sectorOf?, slots?, perSector?, step?, hold?, sizing?, stopPct? }} o
 */
export function simulateRolling(cal, data, o) {
  const R = { ...ROLLING_RULES, ...o };
  const { start, minValue, initialCash, members = null, sectorOf = () => 'Khác' } = o;
  const { brokerage, sellTax, slippage } = DEFAULTS;
  const syms = Object.keys(data);
  const calAt = new Map(cal.map((b, k) => [b.time, k]));
  let cash = initialCash, fees = 0;
  const pos = new Map(); // sym → { shares, cost, t, entry }
  const lastClose = {};
  let pendingSell = new Map(), pendingBuy = [];
  const trades = [], equity = [];
  const blocked = { ceiling: 0, floor: 0 };
  const stats = { decisions: 0, kept: 0, stopped: 0 };

  const sell = (s, p, price, t, date, reason) => {
    const gross = p.shares * price * 1000, fee = gross * (brokerage + sellTax);
    cash += gross - fee; fees += fee;
    trades.push({ symbol: s, entryTime: p.entry, exitTime: date, pnl: Math.round(gross - fee - p.cost), returnPct: round(((gross - fee) / p.cost - 1) * 100, 2), bars: t - p.t0, reason });
    pos.delete(s);
  };

  for (let t = start; t < cal.length; t++) {
    const date = cal[t].time;
    for (const [s, p] of [...pos]) { // hủy niêm yết
      const last = data[s].bars.at(-1), lt = calAt.get(last.time);
      if (last.time < date && lt != null && t - lt >= DELIST_GAP) sell(s, p, round(last.close * (1 - DELIST_HAIRCUT), 3), t, date, 'delisted');
    }
    for (const [s, reason] of [...pendingSell]) {
      const d = data[s], i = d.at.get(date), p = pos.get(s);
      if (!p) { pendingSell.delete(s); continue; }
      if (i == null || i < 1 || t - p.t0 < R.sellAfter) continue; // cổ phiếu chưa về (về chiều T+2)
      const price = sellFillPrice(d.bars, i, d.ex, slippage);
      if (price == null) { blocked.floor++; continue; }
      sell(s, p, price, t, date, reason);
      pendingSell.delete(s);
    }
    for (const b of pendingBuy) {
      const d = data[b.s], i = d.at.get(date);
      if (i == null || i < 1 || pos.has(b.s)) continue;
      const price = buyFillPrice(d.bars, i, d.ex, slippage);
      if (price == null) { blocked.ceiling++; continue; }
      const shares = Math.floor(Math.min(b.budget, cash) / (price * 1000 * (1 + brokerage)) / LOT) * LOT;
      if (shares <= 0) continue;
      const gross = shares * price * 1000, fee = gross * brokerage;
      cash -= gross + fee; fees += fee;
      pos.set(b.s, { shares, cost: gross + fee, t0: t, t, entry: date, price });
    }
    pendingBuy = [];

    for (const s of syms) { const i = data[s].at.get(date); if (i != null) lastClose[s] = data[s].bars[i].close; }
    const value = cash + [...pos].reduce((a, [s, p]) => a + p.shares * (lastClose[s] ?? p.price) * 1000, 0);
    equity.push({ time: date, value, index: cal[t].close });
    if (t >= cal.length - 1) continue;

    // Cắt lỗ cố định (nếu bật): đánh giá mỗi phiên trên giá đóng cửa
    if (R.stopPct) {
      for (const [s, p] of pos) {
        const c = lastClose[s];
        if (c != null && !pendingSell.has(s) && c * 1000 * p.shares <= p.cost * (1 - R.stopPct)) { pendingSell.set(s, 'stop'); stats.stopped++; }
      }
    }
    if ((t - start) % R.step !== 0) continue;
    stats.decisions++;

    // Ứng viên tại phiên t
    const inUni = members ? members(date) : null;
    const rows = [];
    for (const s of syms) {
      if (members && !inUni?.has(s)) continue;
      const d = data[s], i = d.at.get(date);
      if (i == null || avgTradedValue(d.bars, 20, i) < minValue) continue;
      const f = d.read(i);
      if (!f) continue;
      rows.push({ s, f, vol: vol60(d.bars, i), up: aboveMa50(d.bars, i) });
    }
    const { cands, isCand, medVol } = rollingCandidates(rows);
    // Mã đến hạn: vẫn là ứng viên thì giữ tiếp (tính lại hạn), không thì bán. Rồi lấp suất trống.
    const due = rollingPlan({ t, held: pos, pendingSell, cands, isCand, medVol, value, free: 0, sectorOf, R: { ...R, slots: 0 } });
    for (const s of due.kept) { pos.get(s).t = t; stats.kept++; }
    for (const s of due.sells) pendingSell.set(s, 'hold_end');
    // Thị trường yếu (độ rộng dưới ngưỡng): không mua mới phiên này
    if (R.minBreadth != null && (breadthOf(rows) ?? 1) < R.minBreadth) { stats.gated = (stats.gated || 0) + 1; continue; }
    const free = cash + [...pendingSell.keys()].reduce((a, s) => a + (pos.get(s)?.shares || 0) * (lastClose[s] || 0) * 1000, 0);
    pendingBuy = rollingPlan({ t, held: pos, pendingSell, cands, isCand, medVol, value, free, sectorOf, R }).buys;
  }
  return { equity, trades, blocked, fees, stats, positions: [...pos.keys()] };
}

/**
 * Dữ liệu cho mô phỏng (rổ theo thời điểm, giá các mã, ngành theo phân loại hiện tại). Dùng chung cho runRollingPortfolio
 * và các nghiên cứu chạy nhiều biến thể trên cùng dữ liệu.
 */
export async function loadRollingData({ years = 3, step = ROLLING_RULES.step } = {}) {
  const c = screenCriteria();
  const days = Math.round((years + 1.3) * 365);
  const cal = (await getPriceHistory('VNINDEX', days)).bars;
  const start = Math.max(260, cal.length - Math.round(years * 252));
  const snapDates = [];
  for (let t = start; t < cal.length; t += step) snapDates.push(cal[t].time);
  const pit = await pointInTimeUniverse(snapDates);
  const exOf = new Map();
  for (const d of snapDates) for (const u of pit.byDate.get(d) || []) exOf.set(u.symbol, u.exchange);
  const syms = [...exOf.keys()];
  const all = await poolMap(syms, (s) => getPriceHistory(s, days));
  const data = {};
  syms.forEach((s, k) => {
    const bars = all[k]?.bars;
    if (bars?.length) data[s] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars), ex: BANDS[exOf.get(s)] ? exOf.get(s) : 'HOSE' };
  });
  // Ngành theo phân loại hiện tại (không có lịch sử phân ngành; mã không còn trong bảng ngành = "Khác")
  const flows = await getSectorFlows(5).catch(() => null);
  const sec = new Map();
  for (const s of flows?.sectors || []) for (const x of s.stocks) sec.set(x.symbol, s.name);
  return { cal, data, start, minValue: c.minValue, members: (date) => new Set((pit.byDate.get(date) || []).map((u) => u.symbol)), sectorOf: (s) => sec.get(s) || 'Khác' };
}

/** Chạy trên dữ liệu thật (rổ theo thời điểm). */
export async function runRollingPortfolio(opts = {}) {
  const years = Math.min(4, Math.max(1, Number(opts.years) || 3));
  const R = { ...ROLLING_RULES, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k in ROLLING_RULES)) };
  const initialCash = Number(opts.initialCash) > 0 ? Number(opts.initialCash) : DEFAULTS.initialCash;
  const c = screenCriteria();
  return cached(`rolling:${years}:${JSON.stringify(R)}:${initialCash}:${c.floors}:${c.minValue}`, 30 * 60_000, async () => {
    const d = await loadRollingData({ years, step: R.step });
    const sim = simulateRolling(d.cal, d.data, { ...R, ...d, initialCash });
    const values = sim.equity.map((e) => e.value);
    const metrics = calcMetrics(values, sim.trades, initialCash, sim.equity.map((e) => e.index));
    return {
      rules: R, years, period: { from: sim.equity[0].time, to: sim.equity.at(-1).time },
      metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])),
      maxDrawdown: round(maxDrawdown(values, initialCash)), fees: Math.round(sim.fees), blocked: sim.blocked, stats: sim.stats,
    };
  });
}
