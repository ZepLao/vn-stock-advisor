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

export const ROLLING_RULES = { slots: 10, perSector: 3, step: 5, hold: 40, sizing: 'inv_vol', stopPct: null };

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// Biến động 60 phiên (độ lệch chuẩn lãi ngày) tại phiên i
function vol60(bars, i) {
  if (i < 61) return null;
  const r = [];
  for (let k = i - 59; k <= i; k++) r.push(bars[k].close / bars[k - 1].close - 1);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

/**
 * Mô phỏng (hàm thuần). `data[s]` = { bars, at, read, ex }. `sectorOf(sym)` → tên ngành.
 * @param {{ start, minValue, initialCash, members?, sectorOf?, slots?, perSector?, step?, hold?, sizing?, stopPct? }} o
 */
export function simulateRolling(cal, data, o) {
  const R = { ...ROLLING_RULES, ...o };
  const { start, minValue, initialCash, members = null, sectorOf = () => 'Khác' } = o;
  const { brokerage, sellTax, slippage, settlementBars } = DEFAULTS;
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
      if (i == null || i < 1 || t - p.t0 < settlementBars) continue;
      const { floor } = priceLimits(d.bars[i - 1].close, BANDS[d.ex], d.ex);
      if (d.bars[i].open <= floor + tickSize(floor, d.ex) - 1e-9) { blocked.floor++; continue; }
      sell(s, p, Math.max(roundDown(d.bars[i].open * (1 - slippage), d.ex), floor), t, date, reason);
      pendingSell.delete(s);
    }
    for (const b of pendingBuy) {
      const d = data[b.s], i = d.at.get(date);
      if (i == null || i < 1 || pos.has(b.s)) continue;
      const { ceiling } = priceLimits(d.bars[i - 1].close, BANDS[d.ex], d.ex);
      if (d.bars[i].open >= ceiling - tickSize(ceiling, d.ex) + 1e-9) { blocked.ceiling++; continue; }
      const price = Math.min(roundUp(d.bars[i].open * (1 + slippage), d.ex), ceiling);
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
      rows.push({ s, f, vol: vol60(d.bars, i) });
    }
    const ref = buildRef(rows.map((x) => x.f), FACTORS);
    const vols = rows.map((x) => x.vol).filter((v) => v != null).sort((a, b) => a - b);
    const volCut = vols.length ? vols[Math.floor(vols.length * TREND_PICK_RULE.maxVolPct) - 1] ?? vols.at(-1) : null;
    const cands = rows.map((x) => ({ ...x, score: compositeScore(x.f, ref, FACTORS)?.score ?? null }))
      .filter((x) => x.score != null && ((x.score >= 70 && x.f.aboveMa200 !== false)
        || (x.f.high >= TREND_PICK_RULE.nearHigh - 1 && x.vol != null && volCut != null && x.vol <= volCut)))
      .sort((a, b) => b.score - a.score);
    const isCand = new Set(cands.map((x) => x.s));

    // Mã đến hạn: vẫn là ứng viên thì giữ tiếp (tính lại hạn), không thì bán
    for (const [s, p] of pos) {
      if (pendingSell.has(s)) continue;
      if (t - p.t >= R.hold) {
        if (isCand.has(s)) { p.t = t; stats.kept++; } else pendingSell.set(s, 'hold_end');
      }
    }
    // Lấp suất trống
    const staying = [...pos.keys()].filter((s) => !pendingSell.has(s));
    const perSec = new Map();
    for (const s of staying) perSec.set(sectorOf(s), (perSec.get(sectorOf(s)) || 0) + 1);
    const freeSlots = R.slots - staying.length;
    if (freeSlots <= 0) continue;
    const slot = value / R.slots;
    const medVol = median(cands.map((x) => x.vol).filter((v) => v != null));
    let free = cash + [...pendingSell.keys()].reduce((a, s) => a + (pos.get(s)?.shares || 0) * (lastClose[s] || 0) * 1000, 0);
    for (const c of cands) {
      if (pendingBuy.length >= freeSlots) break;
      if (pos.has(c.s)) continue;
      const sec = sectorOf(c.s);
      if ((perSec.get(sec) || 0) >= R.perSector) continue;
      const w = R.sizing === 'inv_vol' && medVol && c.vol ? Math.min(1.5, Math.max(0.5, medVol / c.vol)) : 1;
      if (free < slot * w * 0.5) break;
      pendingBuy.push({ s: c.s, budget: slot * w });
      free -= slot * w;
      perSec.set(sec, (perSec.get(sec) || 0) + 1);
    }
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
