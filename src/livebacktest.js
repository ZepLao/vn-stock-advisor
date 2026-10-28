// Backtest ĐÚNG QUY TRÌNH TOOL ĐANG KHUYẾN NGHỊ (khác runRankPortfolio chỉ kiểm tra "top 8 chia đều, không cắt lỗ"):
//  - Rổ theo thời điểm (snapshot mỗi 5 phiên, gồm mã sau này hủy niêm yết), xếp hạng 4 yếu tố mỗi phiên trong rổ đó.
//  - Ứng viên = khuyến nghị NÊN MUA: điểm ≥ 70, trên MA200, không dính bộ lọc rủi ro rơi tự do, thị trường cho mua mới
//    (regime tính lại mỗi phiên từ VN-Index + độ rộng của rổ), thanh khoản đều, lời kỳ vọng tới mục tiêu ≥ 4%.
//  - Lệnh mua theo đúng tradeSteps('BUY'): chia lần (hỗ trợ gần / hỗ trợ 2 = lệnh giới hạn, bứt phá = mua giá mở cửa
//    phiên sau khi đóng cửa vượt kháng cự 1 với khối lượng > 1,5× TB20), hiệu lực ENTRY_DAYS phiên.
//  - Tỷ trọng theo positionSize (rủi ro 1% có tính lỗ vượt cắt lỗ, thanh khoản, heat 6%) với vốn = giá trị danh mục.
//  - Người đang giữ: cắt lỗ lúc vào lệnh, chỉ nâng lên hòa vốn khi lãi ≥ 6% và Chandelier khi lãi ≥ 10% (giống holderStop;
//    trail 'levels' = nâng thêm theo bậc thang mỗi phiên, chỉ để so sánh); đóng cửa dưới cắt lỗ → bán toàn bộ giá mở cửa phiên sau. Chạm mục tiêu (lệnh giới hạn) → chốt 1/3.
//    Khuyến nghị chuyển TRÁNH / BÁN (rủi ro rơi tự do) → bán toàn bộ phiên sau.
//  - Luật sàn: T+2 theo từng lô, trần/sàn, lô 100, phí 0,15% + thuế bán 0,1%, trượt giá 0,1% với lệnh thị trường.
// KHÔNG mô phỏng được (không có dữ liệu quá khứ): AI thẩm định / loại mã, tin tức rủi ro, lọc cơ bản (lỗ, ROE, nợ),
// xếp ưu tiên bằng AI và giới hạn ngành. Bước AVOID "bán một nửa khi hồi" được bỏ qua (chỉ cắt lỗ / chốt lời / BÁN).
import { getPriceHistory, getScreenUniverse, screenCriteria, avgTradedValue } from './data.js';
import { cached } from './http.js';
import { rsi } from './indicators.js';
import { BANDS, DEFAULTS, LOT, priceLimits, tickSize, roundUp, roundDown, calcMetrics, maxDrawdown } from './backtest.js';
import { FACTORS, factorReader, buildRef, compositeScore, poolMap, pointInTimeUniverse, runRankPortfolio, DELIST_HAIRCUT, DELIST_GAP } from './ranking.js';
import { levelInputs, levelsAt, tradeSteps, ratchetStop } from './tradeplan.js';
import { positionSize, portfolioHeat } from './sizing.js';
import { detectStockRisk } from './risk.js';
import { evaluateMarketRegime } from './regime.js';
import { liquidityCheck } from './screener.js';
import { MIN_REWARD } from './picks.js';
import { PRIO_RULES } from './prioritize.js';
import { getTuning } from './tuning.js';

export const LIVE_RULES = {
  entryDays: 10,      // lệnh mua chia lần còn hiệu lực bấy nhiêu phiên
  buyCount: Number(process.env.TELEGRAM_BUY_COUNT) || 5, // số mã mới tối đa mỗi phiên (như bản tin)
  newTotalMax: PRIO_RULES.totalMax, // tổng tỷ trọng mã mới mỗi phiên ≤ 50% vốn
  snapshotEvery: 5,
};

const MIN = 60_000;
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const pctile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

/** Khuyến nghị theo luật cho một mã tại phiên (như rankRecommendation, bỏ phần tin tức / cơ bản không có lịch sử). */
export function liveCode(score, aboveMa200, risk, regime) {
  if (risk?.isRisky) return risk.riskLevel === 'CRITICAL' || score < 50 ? 'SELL' : 'HOLD';
  if (score == null) return 'HOLD';
  if (score >= 70 && aboveMa200 !== false) return regime && !regime.allowNewBuys ? 'HOLD' : 'BUY';
  if (score >= 70 || score < 30) return 'AVOID';
  return 'HOLD';
}

/**
 * Mô phỏng (hàm thuần). `data[s]` = { bars, at, ex, read, inp, rsi }. `members(date)` = Set mã thuộc rổ (null = mọi mã).
 * @returns {{ equity, trades, positions, stats, blocked, fees }}
 */
export function simulateLive(cal, data, o) {
  const { start, minValue, initialCash, members = null, R = LIVE_RULES, minStopAtr = 0, regimeFilter = true, sizing = {}, trail = 'anchor' } = o;
  const { brokerage, sellTax, slippage, settlementBars } = DEFAULTS;
  const syms = Object.keys(data);
  const calAt = new Map(cal.map((b, k) => [b.time, k]));

  let cash = initialCash, fees = 0;
  const pos = new Map();     // sym → vị thế
  const orders = new Map();  // sym → { legs, expires, L, stop, target }
  const pendingSell = new Map(); // sym → lý do
  const breakoutNext = new Map(); // sym → leg (mua giá mở cửa phiên này)
  const lastClose = {};
  const trades = [], equity = [];
  const blocked = { ceiling: 0, floor: 0, settlement: 0, cash: 0 };
  const stats = { signals: 0, legsPlaced: 0, legsFilled: 0, partials: 0, regimeBlockedDays: 0, positionsMax: 0, exposure: [] };

  const valueNow = () => cash + [...pos].reduce((s, [sym, p]) => s + p.shares * (lastClose[sym] ?? p.avgCost) * 1000, 0);
  const sellable = (p, t) => p.lots.filter((l) => t - l.t >= settlementBars).reduce((s, l) => s + l.shares, 0);

  function buy(sym, shares, price, t, date) {
    const gross = shares * price * 1000, fee = gross * brokerage;
    cash -= gross + fee; fees += fee;
    let p = pos.get(sym);
    if (!p) {
      const ord = orders.get(sym);
      p = { shares: 0, cost: 0, invested: 0, lots: [], realized: 0, firstDate: date, firstT: t, stop: ord.stop, initStop: ord.stop, target: ord.target, targetDone: false, plannedRisk: 0 };
      pos.set(sym, p);
    }
    p.shares += shares; p.cost += gross + fee; p.invested += gross + fee; p.lots.push({ shares, t });
    p.avgCost = p.cost / p.shares / 1000;
    p.plannedRisk += shares * Math.max(0, price - p.initStop) * 1000;
    stats.legsFilled++;
  }

  // Bán n cổ phiếu (lô cũ trước); đóng hết thì ghi giao dịch
  function sell(sym, n, price, t, date, reason) {
    const p = pos.get(sym);
    const gross = n * price * 1000, fee = gross * (brokerage + sellTax);
    cash += gross - fee; fees += fee;
    const costPart = p.cost * (n / p.shares);
    p.realized += gross - fee - costPart;
    p.cost -= costPart; p.shares -= n;
    let left = n;
    for (const l of p.lots) { const k = Math.min(left, l.shares); l.shares -= k; left -= k; }
    p.lots = p.lots.filter((l) => l.shares > 0);
    if (p.shares <= 0) {
      const R0 = p.plannedRisk > 0 ? p.realized / p.plannedRisk : null;
      trades.push({ symbol: sym, entryTime: p.firstDate, exitTime: date, pnl: Math.round(p.realized), returnPct: round((p.realized / p.invested) * 100), bars: t - p.firstT, reason, rMultiple: round(R0, 2), partial: p.targetDone });
      pos.delete(sym);
      pendingSell.delete(sym);
    }
  }

  for (let t = start; t < cal.length; t++) {
    const date = cal[t].time;

    // ---- 0. Mã đang nắm đã ngừng giao dịch hẳn: thoát ở giá cuối trừ haircut ----
    for (const [s, p] of [...pos]) {
      const lastBar = data[s].bars.at(-1);
      const lastT = calAt.get(lastBar.time) ?? cal.findLastIndex((b) => b.time <= lastBar.time);
      if (lastBar.time < date && t - lastT >= DELIST_GAP) sell(s, p.shares, round(lastBar.close * (1 - DELIST_HAIRCUT), 3), t, date, 'delisted');
    }

    // ---- 1. Khớp lệnh trong phiên ----
    for (const [s, reason] of [...pendingSell]) {
      const d = data[s], i = d.at.get(date), p = pos.get(s);
      if (!p) { pendingSell.delete(s); continue; }
      if (i == null || i < 1) continue;
      const n = sellable(p, t);
      if (!n) { blocked.settlement++; continue; }
      const { floor } = priceLimits(d.bars[i - 1].close, BANDS[d.ex], d.ex);
      if (d.bars[i].open <= floor + tickSize(floor, d.ex) - 1e-9) { blocked.floor++; continue; }
      sell(s, n, Math.max(roundDown(d.bars[i].open * (1 - slippage), d.ex), floor), t, date, reason); // còn lô chưa về thì bán tiếp phiên sau
    }
    // Chốt 1/3 ở mục tiêu (lệnh giới hạn đặt sẵn)
    for (const [s, p] of pos) {
      if (p.targetDone || pendingSell.has(s) || !p.target) continue;
      const d = data[s], i = d.at.get(date);
      if (i == null || d.bars[i].high < p.target) continue;
      const n = Math.min(sellable(p, t), p.shares >= 300 ? Math.floor(p.shares / 3 / LOT) * LOT : p.shares);
      if (!n) continue;
      sell(s, n, Math.max(d.bars[i].open, p.target), t, date, 'target');
      p.targetDone = true;
      stats.partials++;
    }
    // Mua: bứt phá (giá mở cửa) rồi lệnh giới hạn
    const ceilingOf = (d, i) => priceLimits(d.bars[i - 1].close, BANDS[d.ex], d.ex).ceiling;
    for (const [s, leg] of [...breakoutNext]) {
      breakoutNext.delete(s);
      const d = data[s], i = d.at.get(date), ord = orders.get(s);
      if (i == null || i < 1 || !ord) continue;
      const ceil = ceilingOf(d, i);
      if (d.bars[i].open >= ceil - tickSize(ceil, d.ex) + 1e-9) { blocked.ceiling++; continue; }
      const price = Math.min(roundUp(d.bars[i].open * (1 + slippage), d.ex), ceil);
      const shares = Math.floor(Math.min(leg.budget, cash) / (price * 1000 * (1 + brokerage)) / LOT) * LOT;
      if (shares > 0) buy(s, shares, price, t, date); else blocked.cash++;
      leg.done = true;
    }
    for (const [s, ord] of orders) {
      const d = data[s], i = d.at.get(date);
      if (i == null || i < 1) continue;
      for (const leg of ord.legs) {
        if (leg.done || leg.type !== 'limit' || d.bars[i].low > leg.price) continue;
        const price = Math.min(d.bars[i].open, leg.price);
        const shares = Math.floor(Math.min(leg.budget, cash) / (price * 1000 * (1 + brokerage)) / LOT) * LOT;
        leg.done = true;
        if (shares > 0) buy(s, shares, price, t, date); else blocked.cash++;
      }
    }

    // ---- 2. Định giá cuối phiên ----
    for (const s of syms) {
      const i = data[s].at.get(date);
      if (i != null) lastClose[s] = data[s].bars[i].close;
    }
    const value = valueNow();
    equity.push({ time: date, value, index: cal[t].close });
    stats.exposure.push(value ? (value - cash) / value : 0);
    stats.positionsMax = Math.max(stats.positionsMax, pos.size);
    if (t === cal.length - 1) break;

    // ---- 3. Tín hiệu ở giá đóng cửa ----
    const inUni = members ? members(date) : null;
    const snap = [];
    let above20 = 0, above50 = 0, nb = 0;
    for (const s of syms) {
      const d = data[s], i = d.at.get(date);
      if (i == null) continue;
      if (members && !inUni?.has(s) && !pos.has(s) && !orders.has(s)) continue;
      const c = d.bars[i].close;
      if (d.inp.ma50[i] != null) { nb++; if (c > d.inp.ma20[i]) above20++; if (c > d.inp.ma50[i]) above50++; }
      if (avgTradedValue(d.bars, 20, i) < minValue) continue;
      const f = d.read(i);
      if (f) snap.push({ s, i, f, member: !members || inUni?.has(s) });
    }
    const breadth = nb >= 30 ? { total: nb, pctAboveMa20: Math.round((above20 / nb) * 100), pctAboveMa50: Math.round((above50 / nb) * 100) } : null;
    const regime = regimeFilter ? evaluateMarketRegime(cal.slice(Math.max(0, t - 260), t + 1), breadth) : null;
    if (regime && !regime.allowNewBuys) stats.regimeBlockedDays++;
    const pool = snap.filter((x) => x.member);
    const ref = buildRef(pool.map((x) => x.f), FACTORS);
    const scoreOf = new Map(snap.map((x) => [x.s, compositeScore(x.f, ref, FACTORS)?.score ?? null]));

    // Người đang giữ: nâng cắt lỗ, kiểm tra thủng / chuyển BÁN
    const heatPos = [];
    for (const [s, p] of pos) {
      const d = data[s], i = d.at.get(date);
      if (i == null) continue;
      const close = d.bars[i].close;
      const L = levelsAt(d.bars, i, d.inp, minStopAtr);
      // trail 'levels': nâng theo bậc thang mỗi phiên; 'anchor': giữ cắt lỗ lúc vào lệnh, chỉ nâng lên hòa vốn / Chandelier
      p.stop = ratchetStop(p.stop, trail === 'levels' ? L : { stop: null, chandelierStop: L.chandelierStop }, close, p.avgCost);
      if (p.targetDone) p.stop = Math.max(p.stop, roundDown(p.avgCost * 1.005, d.ex)); // đã chốt 1/3: nâng cắt lỗ về hòa vốn
      const risk = detectStockRisk(d.bars.slice(Math.max(0, i - 70), i + 1));
      const code = liveCode(scoreOf.get(s), d.read(i)?.aboveMa200, risk, null);
      if (close < p.stop) pendingSell.set(s, 'stop');
      else if (code === 'SELL') pendingSell.set(s, 'sell_signal');
      heatPos.push({ value: p.shares * close * 1000, close, stop: p.stop });
    }

    // Lệnh mua đang chờ: hết hạn, giá thủng cắt lỗ thì hủy; bứt phá thì đặt mua phiên sau
    for (const [s, ord] of [...orders]) {
      const d = data[s], i = d.at.get(date);
      const open = ord.legs.filter((l) => !l.done);
      if (!open.length || t >= ord.expires || pendingSell.has(s) || (i != null && d.bars[i].close < ord.stop)) { orders.delete(s); continue; }
      if (i == null) continue;
      const vAvg = d.bars.slice(Math.max(0, i - 19), i + 1).reduce((a, b) => a + b.volume, 0) / Math.min(20, i + 1);
      for (const leg of open) if (leg.type === 'breakout' && d.bars[i].close > leg.trigger && d.bars[i].volume > 1.5 * vAvg) breakoutNext.set(s, leg);
    }

    // Ứng viên mới
    if (regime && !regime.allowNewBuys) continue;
    const slots = Math.max(0, (regime?.maxHoldings ?? Infinity) - pos.size - orders.size);
    if (!slots) continue;
    const cand = pool
      .filter((x) => !pos.has(x.s) && !orders.has(x.s) && (scoreOf.get(x.s) ?? 0) >= 70 && x.f.aboveMa200 !== false)
      .sort((a, b) => scoreOf.get(b.s) - scoreOf.get(a.s));
    let added = 0, newWeight = 0;
    const capital = value;
    let heat = portfolioHeat(heatPos, capital) ?? 0;
    for (const x of cand) {
      if (added >= Math.min(R.buyCount, slots) || newWeight >= R.newTotalMax) break;
      const d = data[x.s], i = x.i;
      const risk = detectStockRisk(d.bars.slice(Math.max(0, i - 70), i + 1));
      if (risk.isRisky) continue;
      if (!liquidityCheck(d.bars.slice(Math.max(0, i - 59), i + 1), minValue).pass) continue;
      const L = levelsAt(d.bars, i, d.inp, minStopAtr);
      const close = d.bars[i].close;
      const target = L.r1 - close >= L.atr ? L.r1 : L.r2;
      if (target / close - 1 < MIN_REWARD) continue;
      stats.signals++;
      const size = positionSize(close, L.stop, { bars: d.bars.slice(Math.max(0, i - 260), i + 1), value20: avgTradedValue(d.bars, 20, i), capital, heat, ...sizing });
      const W = Math.min(size?.weight ?? 0, R.newTotalMax - newWeight);
      if (!(W > 0)) continue;
      const vAvg = d.bars.slice(Math.max(0, i - 19), i + 1).reduce((a, b) => a + b.volume, 0) / Math.min(20, i + 1);
      const steps = tradeSteps('BUY', L, { weight: W, rsi: d.rsi[i], avgVol20: vAvg, ma200: d.inp.ma200[i], score: scoreOf.get(x.s), aboveMa200: true });
      const legs = steps.fresh.filter((st) => st.side === 'buy').map((st) => (st.zone
        ? { type: 'limit', price: st.zone[1], budget: st.portion * capital }
        : { type: 'breakout', trigger: L.r1, budget: st.portion * capital }));
      orders.set(x.s, { legs, expires: t + R.entryDays, stop: L.stop, target });
      stats.legsPlaced += legs.length;
      added++;
      newWeight += W;
      heat += W * size.effectiveLoss;
    }
  }

  const positions = [...pos].map(([s, p]) => ({ symbol: s, since: p.firstDate, shares: p.shares, avgCost: round(p.avgCost, 3), stop: round(p.stop, 2), close: lastClose[s], returnPct: round(((lastClose[s] * p.shares * 1000) / p.cost - 1) * 100) }));
  return { equity, trades, positions, stats, blocked, fees };
}

/** Tóm tắt R (lời/lỗ ÷ rủi ro dự kiến lúc vào lệnh): R của lệnh cắt lỗ < −1 nghĩa là lỗ thật vượt thiết kế (gap, T+2). */
export function rStats(trades) {
  const rs = trades.filter((x) => x.rMultiple != null);
  const stops = rs.filter((x) => x.reason === 'stop');
  return {
    n: rs.length,
    avgR: round(mean(rs.map((x) => x.rMultiple)), 2),
    stopN: stops.length,
    stopAvgR: round(mean(stops.map((x) => x.rMultiple)), 2),
    stopWorstR: round(pctile(stops.map((x) => x.rMultiple), 0.1), 2), // 10% lệnh cắt lỗ tệ nhất
    byReason: Object.fromEntries(['stop', 'sell_signal', 'delisted'].map((k) => [k, trades.filter((x) => x.reason === k).length])),
  };
}

/**
 * Chạy backtest quy trình thực tế trên dữ liệu thật, kèm so sánh với danh mục mẫu (top 8 chia đều) cùng giai đoạn.
 * @param {{ years?: number, initialCash?: number, regimeFilter?: boolean }} opts
 */
export async function runLiveBacktest(opts = {}) {
  const years = Math.min(4, Math.max(1, Number(opts.years) || 3));
  const initialCash = Number(opts.initialCash) > 0 ? Number(opts.initialCash) : DEFAULTS.initialCash;
  const regimeFilter = opts.regimeFilter !== false && opts.regimeFilter !== '0' && opts.regimeFilter !== 'false';
  const trail = opts.trail === 'levels' ? 'levels' : 'anchor';
  const days = Math.round((years + 1.3) * 365);
  const c = screenCriteria();
  const minStopAtr = getTuning().minStopAtr;
  const key = `live-bt:${years}:${initialCash}:${regimeFilter}:${trail}:${minStopAtr}:${c.floors}:${c.minValue}`;
  return cached(key, 30 * MIN, async () => {
    const cal = (await getPriceHistory('VNINDEX', days)).bars;
    const start = Math.max(260, cal.length - Math.round(years * 252));
    const snapDates = [];
    for (let t = start; t < cal.length; t += LIVE_RULES.snapshotEvery) snapDates.push(cal[t].time);
    const pit = await pointInTimeUniverse(snapDates);
    const usePit = pit.byDate.size > 0;
    const exchangeOf = new Map();
    if (usePit) for (const d of snapDates) for (const u of pit.byDate.get(d) || []) exchangeOf.set(u.symbol, u.exchange);
    else for (const u of await getScreenUniverse()) exchangeOf.set(u.symbol, u.exchange);
    // Rổ của một phiên = snapshot gần nhất trước hoặc bằng phiên đó
    const snapSets = snapDates.map((d) => [d, new Set((pit.byDate.get(d) || []).map((u) => u.symbol))]);
    const members = usePit ? (date) => {
      let m = null;
      for (const [d, s] of snapSets) { if (d > date) break; m = s; }
      return m;
    } : null;

    const syms = [...exchangeOf.keys()];
    const all = await poolMap(syms, (s) => getPriceHistory(s, days));
    const data = {};
    const missingPrice = [];
    syms.forEach((s, k) => {
      const bars = all[k]?.bars;
      if (!bars?.length) { missingPrice.push(s); return; }
      const ex = exchangeOf.get(s);
      data[s] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), ex: BANDS[ex] ? ex : 'HOSE', read: factorReader(bars), inp: levelInputs(bars), rsi: rsi(bars.map((b) => b.close), 14) };
    });

    const sim = simulateLive(cal, data, { start, minValue: c.minValue, initialCash, members, minStopAtr, regimeFilter, trail });
    const values = sim.equity.map((e) => e.value);
    const metrics = calcMetrics(values, sim.trades, initialCash, sim.equity.map((e) => e.index));
    const plain = await runRankPortfolio({ years }).catch(() => null);
    const out = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? (Number.isFinite(v) ? round(v, 4) : null) : v]));
    const step = Math.max(1, Math.ceil(sim.equity.length / 400));
    return {
      config: { years, initialCash, regimeFilter, trail, minStopAtr, rules: LIVE_RULES, criteria: c, costs: { brokerage: DEFAULTS.brokerage, sellTax: DEFAULTS.sellTax, slippage: DEFAULTS.slippage } },
      universe: { mode: usePit ? 'point-in-time' : 'current', survivorshipBias: !usePit, snapshots: pit.byDate.size, failedSnapshots: pit.failed, symbols: syms.length, missingPrice: missingPrice.length },
      period: { from: sim.equity[0].time, to: sim.equity.at(-1).time, bars: sim.equity.length },
      metrics: out(metrics),
      maxDrawdown: round(maxDrawdown(values, initialCash), 4),
      r: rStats(sim.trades),
      stats: {
        ...sim.stats, exposure: undefined, avgExposure: round(mean(sim.stats.exposure), 3),
        legFillRate: sim.stats.legsPlaced ? round(sim.stats.legsFilled / sim.stats.legsPlaced, 3) : null,
      },
      blocked: sim.blocked, fees: Math.round(sim.fees),
      compare: plain ? { label: 'Danh mục mẫu top 8 chia đều, không cắt lỗ', totalReturn: plain.metrics.totalReturn, maxDrawdown: plain.metrics.maxDrawdown, sharpe: plain.metrics.sharpe, benchmarkReturn: plain.metrics.benchmarkReturn } : null,
      positions: sim.positions,
      trades: sim.trades.slice(-60).reverse(),
      curve: sim.equity.filter((_, k) => k % step === 0 || k === sim.equity.length - 1).map((e) => ({ time: e.time, equity: Math.round(e.value), index: Math.round((e.index / sim.equity[0].index) * initialCash) })),
      notes: [
        'Không mô phỏng được: AI thẩm định/loại mã, tin rủi ro, lọc cơ bản (lỗ, ROE, nợ), xếp ưu tiên bằng AI, giới hạn ngành.',
        'Bước TRÁNH "bán một nửa khi hồi" không mô phỏng; chỉ cắt lỗ, chốt 1/3 ở mục tiêu và bán khi chuyển BÁN.',
        `Mã hủy niêm yết đang giữ: thoát ở giá cuối trừ ${DELIST_HAIRCUT * 100}%.`,
      ],
    };
  });
}
