// Bộ đo chuẩn: "nếu làm theo tín hiệu này thì thắng bao nhiêu % số lệnh, lãi/lỗ bao nhiêu R", đo theo đúng cách một người
// giao dịch thật trên HOSE sẽ làm, trên rổ theo thời điểm 4 năm (gồm mã sau này hủy niêm yết).
//
// ĐĂNG KÝ TRƯỚC (không chỉnh sau khi xem kết quả):
//  - Nhãn 3 rào (EVAL_RULE): mua giá mở cửa phiên sau tín hiệu; cắt lỗ = 2×ATR (kẹp 3–8%); mục tiêu = +2R; tối đa 20 phiên.
//    Chỉ bán được từ phiên thứ 2 sau ngày mua (T+2). Phiên giảm sàn trắng (không có giao dịch giá khác) không bán được.
//    Cùng một phiên chạm cả cắt lỗ và mục tiêu: tính cắt lỗ (thận trọng). Mở cửa vượt rào: khớp giá mở cửa.
//    Phí mua/bán, thuế bán, trượt giá như backtest. Mã ngừng giao dịch hẳn: thoát giá cuối trừ DELIST_HAIRCUT.
//  - "Thắng" = lãi ròng > 0 sau phí và thuế. R = lãi ròng / khoảng cắt lỗ.
//  - Luật tín hiệu (RULES) cố định; báo cáo luôn đủ cả luật (kể cả luật xấu) và tỷ lệ nền ALL để so.
//  - Kết luận một luật có lợi thế: t Newey-West của R trung bình theo mốc ≥ 2 VÀ R trung bình dương ở cả hai nửa thời gian.
//  - Hiệu chuẩn ngoài mẫu: xác suất thắng học từ nửa đầu (theo nhóm điểm), chấm trên nửa sau (Brier so với tỷ lệ nền).
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avgTradedValue, DELIST_HAIRCUT, DELIST_GAP } from './data.js';
import { atr, sma } from './indicators.js';
import { FACTORS, buildRef, compositeScore } from './ranking.js';
import { DEFAULTS as BT, BANDS } from './backtest.js';
import { testSeries } from './verify.js';
import { loadPanel, EXPECT_STEP } from './expectancy.js';
import { upsert, dbConfig } from './db.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'evaluation.json');

export const EVAL_RULE = {
  stopAtr: 2, minStopPct: 0.03, maxStopPct: 0.08, settle: 2,
  brokerage: BT.brokerage, sellTax: BT.sellTax, slippage: BT.slippage, band: BANDS.HOSE,
};
export const ADOPT_T = 2;
export const BREADTH_ON = 0.5; // thị trường "khỏe": ≥ 50% mã trong rổ đóng cửa trên MA50
export const SCORE_BINS = [[0, 30], [30, 50], [50, 70], [70, 85], [85, 101]];

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/** Luật tín hiệu đăng ký trước. ctx: { score, aboveMa200, breadth, breakout, pullback } */
export const RULES = [
  { key: 'ALL', label: 'Mọi mã đủ thanh khoản (tỷ lệ nền)', test: () => true },
  { key: 'CORE', label: 'Điểm ≥ 70 và trên MA200 (lõi hiện tại)', test: (c) => c.score >= 70 && c.aboveMa200 === true },
  { key: 'CORE_BREADTH', label: 'Lõi + thị trường khỏe (≥ 50% mã trên MA50)', test: (c) => RULES[1].test(c) && c.breadth >= BREADTH_ON },
  { key: 'CORE_BREAKOUT', label: 'Lõi + phá đỉnh 20 phiên, KL ≥ 1,5× TB20', test: (c) => RULES[1].test(c) && c.breakout },
  { key: 'CORE_PULLBACK', label: 'Lõi + chỉnh về MA20 trong xu hướng tăng', test: (c) => RULES[1].test(c) && c.pullback },
  { key: 'FULL', label: 'Lõi + thị trường khỏe + (phá đỉnh hoặc chỉnh về MA20)', test: (c) => RULES[1].test(c) && c.breadth >= BREADTH_ON && (c.breakout || c.pullback) },
];

// Phiên giảm sàn "trắng": đóng cửa ở giá sàn và cả phiên không có giá khác → không bán được
function lockedFloor(bars, k, band) {
  const b = bars[k], ref = bars[k - 1]?.close;
  return ref > 0 && b.high === b.low && b.close <= ref * (1 - band + 0.005);
}
// Phiên tăng trần "trắng" → không mua được
function lockedCeiling(bars, k, band) {
  const b = bars[k], ref = bars[k - 1]?.close;
  return ref > 0 && b.high === b.low && b.close >= ref * (1 + band - 0.005);
}

/**
 * Kiểu thoát lệnh đăng ký trước (cùng điểm mua, cùng cắt lỗ ban đầu 2×ATR; chỉ khác cách thoát):
 *  target    mục tiêu cố định (bội số R), null = không chốt cố định
 *  maxDays   giữ tối đa (bán giá đóng cửa phiên i + maxDays)
 *  timeStop  sau `days` phiên mà đỉnh chưa từng đạt +needR thì bán giá mở cửa phiên sau
 *  breakeven đỉnh đạt +x R thì dời cắt lỗ về hòa vốn (đã tính phí, thuế)
 *  trail     cắt lỗ đuổi = đỉnh cao nhất từ lúc mua − trail×ATR (chỉ nâng lên)
 *  ma20      đóng cửa dưới MA20 thì bán giá mở cửa phiên sau
 *  partial   đạt +at R thì bán `frac` vị thế, phần còn lại theo các luật khác
 * Luật tính theo giá đóng cửa có hiệu lực từ phiên sau; cắt lỗ (kể cả đuổi) là lệnh dừng trong phiên.
 */
export const EXITS = [
  { key: 'BASE', label: 'Cố định: mục tiêu +2R, tối đa 20 phiên', target: 2, maxDays: 20 },
  { key: 'TIME', label: 'Cố định + cắt theo thời gian (10 phiên chưa đạt +1R)', target: 2, maxDays: 20, timeStop: { days: 10, needR: 1 } },
  { key: 'BE', label: 'Cố định + dời cắt lỗ về hòa vốn khi đạt +1R', target: 2, maxDays: 20, breakeven: 1 },
  { key: 'TRAIL', label: 'Không chốt cố định, cắt lỗ đuổi 3×ATR, tối đa 60 phiên', target: null, maxDays: 60, trail: 3 },
  { key: 'PARTIAL', label: 'Chốt 1/2 ở +2R, phần còn lại đuổi 3×ATR, tối đa 60 phiên', target: null, maxDays: 60, trail: 3, partial: { at: 2, frac: 0.5 } },
  { key: 'MA20', label: 'Giữ đến khi đóng cửa dưới MA20, tối đa 60 phiên', target: null, maxDays: 60, ma20: true },
  { key: 'COMBO', label: 'Hòa vốn ở +1R + cắt thời gian 10 phiên + đuổi 3×ATR, tối đa 60 phiên', target: null, maxDays: 60, breakeven: 1, timeStop: { days: 10, needR: 1 }, trail: 3 },
  // Thêm sau bước 3 để so với luật đang chạy thật (tradeplan.js HOLD_RULE): không cắt lỗ sát, bán khi ĐÓNG CỬA dưới −15%
  // giá mua (mở cửa phiên sau), giữ 40 phiên. Các kiểu này có cắt lỗ ban đầu khác nên so bằng lãi %, không bằng R.
  { key: 'LIVE', label: 'Luật đang chạy: cảnh báo −15% theo giá đóng cửa, giữ 40 phiên', target: null, maxDays: 40, wideStop: 0.15 },
  { key: 'LIVE_TRAIL', label: 'Luật đang chạy + đuổi 3×ATR từ đỉnh, tối đa 60 phiên', target: null, maxDays: 60, wideStop: 0.15, trail: 3, vs: 'LIVE' },
  { key: 'LIVE_TRAIL_1R', label: 'Luật đang chạy + đuổi 3×ATR khi đỉnh đã lãi ≥ 2×ATR, tối đa 60 phiên', target: null, maxDays: 60, wideStop: 0.15, trail: 3, trailAfter: 1, vs: 'LIVE' },
];
const BASE_EXIT = EXITS[0];

/**
 * Mô phỏng một lệnh mua theo tín hiệu tại phiên i và thoát theo kiểu `X` (hàm thuần).
 * @param {{open:number,high:number,low:number,close:number}[]} bars
 * @param {number} i phiên có tín hiệu (dùng dữ liệu đến hết phiên i)
 * @param {number} atrI ATR tại phiên i
 * @param {object} X kiểu thoát (EXITS)
 * @param {{ delisted?: boolean, ma20?: (number|null)[] }} o delisted = mã ngừng giao dịch hẳn trước khi hết thời gian giữ
 * @returns {null | { reason: 'target'|'stop'|'protect'|'time'|'ma20'|'delist'|'nofill', entry, exit, stopPct, ret, r, days, win, entryIdx, exitIdx }}
 */
export function simulateExit(bars, i, atrI, X, { delisted = false, ma20 = null } = {}, R = EVAL_RULE) {
  const e = i + 1;
  if (e >= bars.length || !(bars[e].open > 0) || !(atrI > 0)) return null;
  if (lockedCeiling(bars, e, R.band)) return { reason: 'nofill' };
  const entry = bars[e].open * (1 + R.slippage);
  // 1R theo ATR (dùng cho các mốc +x R); wideStop: không đặt lệnh dừng trong phiên, bán khi đóng cửa dưới −wideStop
  const atrPct = Math.min(R.maxStopPct, Math.max(R.minStopPct, (R.stopAtr * atrI) / bars[i].close));
  const stopPct = X.wideStop ?? atrPct;
  const stop0 = X.wideStop ? 0 : entry * (1 - stopPct);
  const target = X.target != null ? entry * (1 + X.target * atrPct) : null;
  const level = (rr) => entry * (1 + rr * atrPct);
  const evenPrice = entry * (1 + R.brokerage) / (1 - R.slippage - R.brokerage - R.sellTax);
  const last = i + X.maxDays;
  const net = (p) => (p * (1 - R.slippage - R.brokerage - R.sellTax)) / (entry * (1 + R.brokerage)) - 1;

  let stop = stop0, peak = -Infinity, pending = null, leg = null; // leg = phần đã chốt sớm { frac, ret }
  let exit = null, reason = null, k = e;
  for (; k < bars.length; k++) {
    const b = bars[k];
    if (k >= e + R.settle) {
      if (lockedFloor(bars, k, R.band)) {
        if (k >= last + 5) { exit = b.close; reason = 'time'; break; } // kẹt sàn quá lâu: chịu giá đóng cửa
        continue;
      }
      const stopWhy = stop > stop0 ? 'protect' : 'stop';
      if (pending) { exit = b.open; reason = pending; break; }
      if (b.open <= stop) { exit = b.open; reason = stopWhy; break; }
      if (b.low <= stop) { exit = stop; reason = stopWhy; break; }
      if (target != null && b.open >= target) { exit = b.open; reason = 'target'; break; }
      if (target != null && b.high >= target) { exit = target; reason = 'target'; break; }
      if (X.partial && !leg && b.high >= level(X.partial.at)) {
        leg = { frac: X.partial.frac, ret: net(Math.max(b.open, level(X.partial.at))) };
      }
      if (k >= last) { exit = b.close; reason = 'time'; break; }
    }
    // Cập nhật sau giá đóng cửa phiên k (có hiệu lực từ phiên sau)
    peak = Math.max(peak, b.high);
    if (X.breakeven != null && peak >= level(X.breakeven)) stop = Math.max(stop, evenPrice);
    if (X.trail != null && (X.trailAfter == null || peak >= level(X.trailAfter))) stop = Math.max(stop, peak - X.trail * atrI);
    if (X.wideStop && b.close < entry * (1 - X.wideStop)) pending ??= 'stop';
    if (X.timeStop && k - e + 1 >= X.timeStop.days && peak < level(X.timeStop.needR)) pending ??= 'time';
    if (X.ma20 && ma20?.[k] != null && b.close < ma20[k]) pending ??= 'ma20';
  }
  if (exit == null) {
    if (!delisted) return null; // chưa đủ thời gian (gần hiện tại)
    k = bars.length - 1;
    exit = bars[k].close * (1 - DELIST_HAIRCUT);
    reason = 'delist';
  }
  const ret = leg ? leg.frac * leg.ret + (1 - leg.frac) * net(exit) : net(exit);
  return { reason, entry, exit, stopPct, ret, r: ret / stopPct, days: k - e, win: ret > 0, entryIdx: e, exitIdx: k };
}

/** Nhãn 3 rào cơ sở: cắt lỗ 2×ATR, mục tiêu +2R, tối đa 20 phiên. */
export function tripleBarrier(bars, i, atrI, o = {}, R = EVAL_RULE) {
  return simulateExit(bars, i, atrI, BASE_EXIT, o, R);
}

/** Khoảng tin cậy Wilson 95% cho tỷ lệ k/n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [r4(Math.max(0, c - h)), r4(Math.min(1, c + h))];
}

/**
 * Thống kê một tập lệnh. trades: { date, r, ret, win, reason, days }[].
 * t của R trung bình tính trên chuỗi trung bình theo mốc (các lệnh cùng mốc không độc lập) với độ trễ Newey-West.
 */
export function summarize(trades, step = EXPECT_STEP, horizon = BASE_EXIT.maxDays) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter((x) => x.win), losses = trades.filter((x) => !x.win);
  const sumWin = wins.reduce((s, x) => s + x.ret, 0), sumLoss = -losses.reduce((s, x) => s + x.ret, 0);
  const byDate = new Map();
  for (const x of trades) (byDate.get(x.date) ?? byDate.set(x.date, []).get(x.date)).push(x.r);
  const series = [...byDate.keys()].sort().map((d) => mean(byDate.get(d)));
  const test = testSeries(series, Math.max(0, Math.ceil(horizon / step) - 1), null, { minDates: 20, t: ADOPT_T });
  const rate = (why) => r4(trades.filter((x) => x.reason === why).length / n);
  return {
    n, dates: byDate.size,
    winRate: r4(wins.length / n), winCI: wilson(wins.length, n),
    targetRate: rate('target'), stopRate: rate('stop'), protectRate: rate('protect'), timeRate: rate('time'),
    ma20Rate: rate('ma20'), delistRate: rate('delist'),
    avgRet: r4(mean(trades.map((x) => x.ret))), avgR: r4(mean(trades.map((x) => x.r))),
    avgWinR: r4(mean(wins.map((x) => x.r))), avgLossR: r4(mean(losses.map((x) => x.r))),
    payoff: wins.length && losses.length ? r4(mean(wins.map((x) => x.ret)) / -mean(losses.map((x) => x.ret))) : null,
    profitFactor: sumLoss > 0 ? r4(sumWin / sumLoss) : null,
    avgDays: r4(mean(trades.map((x) => x.days))),
    t: test.t,
  };
}

/** Kết luận theo quy tắc đăng ký trước. */
export function edgeVerdict(all, first, second) {
  if (!all.n || all.dates < 20 || all.t == null || !first.n || !second.n) return 'insufficient';
  if (all.t >= ADOPT_T && first.avgR > 0 && second.avgR > 0) return 'edge';
  if (all.t <= -ADOPT_T) return 'negative';
  return 'unproven';
}

/** Tập tín hiệu dùng để so các kiểu thoát. */
export const EXIT_RULE_SETS = ['ALL', 'CORE', 'FULL'];

/**
 * So sánh cặp một kiểu thoát với kiểu đối chứng (X.vs, mặc định kiểu cơ sở) trên CÙNG các tín hiệu: chênh theo mốc,
 * t Newey-West. Hai kiểu cùng cắt lỗ ban đầu thì so bằng R, khác nhau (wideStop) thì so bằng lãi %.
 * 'better' = t ≥ 2 và chênh dương ở cả hai nửa; 'worse' = t ≤ −2; còn lại 'same'.
 */
export function compareExit(trades, key, mid, step = EXPECT_STEP) {
  const X = EXITS.find((x) => x.key === key);
  const V = EXITS.find((x) => x.key === (X.vs ?? BASE_EXIT.key));
  const unit = X.wideStop || V.wideStop ? 'ret' : 'r';
  const lags = Math.max(0, Math.ceil(Math.max(X.maxDays, V.maxDays) / step) - 1);
  const byDate = new Map();
  for (const x of trades) {
    const d = x.exits[key][unit] - x.exits[V.key][unit];
    (byDate.get(x.date) ?? byDate.set(x.date, []).get(x.date)).push(d);
  }
  const dates = [...byDate.keys()].sort();
  const series = (ds) => ds.map((d) => mean(byDate.get(d)));
  const R = { minDates: 20, t: ADOPT_T };
  const all = testSeries(series(dates), lags, null, R);
  const first = mean(series(dates.filter((d) => d < mid)));
  const second = mean(series(dates.filter((d) => d >= mid)));
  let verdict = 'same';
  if (all.verdict === 'insufficient') verdict = 'insufficient';
  else if (all.t >= ADOPT_T && first > 0 && second > 0) verdict = 'better';
  else if (all.t <= -ADOPT_T) verdict = 'worse';
  return { vs: V.key, unit, diffR: all.mean, t: all.t, firstDiffR: r4(first), secondDiffR: r4(second), verdict };
}

const binOf = (score) => {
  if (score == null || !Number.isFinite(score)) return null;
  const b = SCORE_BINS.find(([lo, hi]) => score >= lo && score < hi) || SCORE_BINS.at(-1);
  return `${b[0]}-${Math.min(b[1], 100)}`;
};

/**
 * Hiệu chuẩn ngoài mẫu: xác suất thắng của từng nhóm điểm học từ `train`, chấm trên `test`.
 * Brier skill > 0 nghĩa là dự báo theo nhóm điểm tốt hơn đoán bằng tỷ lệ nền của tập học.
 */
export function calibrate(train, test) {
  const base = mean(train.map((x) => (x.win ? 1 : 0)));
  const groups = {};
  for (const x of train) {
    const b = binOf(x.score);
    if (!b) continue;
    const g = (groups[b] ??= { k: 0, n: 0 });
    g.k += x.win ? 1 : 0;
    g.n++;
  }
  const pOf = (x) => { const g = groups[binOf(x.score)]; return g && g.n >= 30 ? g.k / g.n : base; };
  const rows = {};
  let brier = 0, brierBase = 0, m = 0;
  for (const x of test) {
    const p = pOf(x), y = x.win ? 1 : 0, b = binOf(x.score);
    brier += (p - y) ** 2; brierBase += (base - y) ** 2; m++;
    if (!b) continue;
    const row = (rows[b] ??= { predicted: r4(p), k: 0, n: 0 });
    row.k += y;
    row.n++;
  }
  for (const r of Object.values(rows)) { r.observed = r4(r.k / r.n); r.ci = wilson(r.k, r.n); delete r.k; }
  return {
    baseRate: r4(base), brier: r4(brier / m), brierBase: r4(brierBase / m),
    skill: m && brierBase ? r4(1 - brier / brierBase) : null, bins: rows,
  };
}

/** Các chỉ báo theo phiên dùng cho luật (tính một lần cho mỗi mã). */
export function setupReader(bars) {
  const c = bars.map((b) => b.close), v = bars.map((b) => b.volume);
  const a = atr(bars, 14), m20 = sma(c, 20), m50 = sma(c, 50), v20 = sma(v, 20);
  return (i) => {
    if (i < 60) return null;
    let hi20 = -Infinity;
    for (let k = i - 20; k < i; k++) hi20 = Math.max(hi20, c[k]);
    return {
      atr: a[i],
      above50: m50[i] != null ? c[i] > m50[i] : null,
      breakout: c[i] > hi20 && v20[i - 1] > 0 && v[i] >= 1.5 * v20[i - 1],
      pullback: m20[i] != null && m50[i] != null && m20[i] > m50[i] && c[i] >= m20[i] && c[i] <= m20[i] * 1.03 && c[i] > m50[i],
    };
  };
}

/**
 * Chạy bộ đo trên panel (hàm thuần): mỗi mốc lấy mẫu, mọi mã thuộc rổ + đủ thanh khoản được chấm điểm và gắn nhãn 3 rào.
 * @returns {{ from, to, samples, trades: object[] }}
 */
export function collectTrades(cal, data, { start, minValue, members = null, step = EXPECT_STEP }, R = EVAL_RULE) {
  const calAt = new Map(cal.map((b, k) => [b.time, k]));
  for (const d of Object.values(data)) {
    d.setup ??= setupReader(d.bars);
    d.ma20 ??= sma(d.bars.map((b) => b.close), 20);
  }
  const trades = [];
  let samples = 0;
  for (let t = start; t < cal.length - 1; t += step) {
    const date = cal[t].time;
    const inUni = members ? members(date) : null;
    const snap = [];
    for (const [s, d] of Object.entries(data)) {
      if (members && !inUni?.has(s)) continue;
      const i = d.at.get(date);
      if (i == null || avgTradedValue(d.bars, 20, i) < minValue) continue;
      const f = d.read(i), st = d.setup(i);
      if (f && st) snap.push({ s, d, i, f, st });
    }
    if (snap.length < 20) continue;
    samples++;
    const known = snap.filter((x) => x.st.above50 != null);
    const breadth = known.length ? known.filter((x) => x.st.above50).length / known.length : null;
    const ref = buildRef(snap.map((x) => x.f), FACTORS);
    for (const x of snap) {
      const last = x.d.bars.at(-1), lastT = calAt.get(last.time);
      const delisted = lastT != null && lastT < cal.length - 1 - DELIST_GAP;
      // Mọi kiểu thoát trên cùng tín hiệu; chỉ giữ tín hiệu mà kiểu nào cũng đã kết thúc (để so sánh cặp công bằng)
      const exits = {};
      for (const X of EXITS) {
        const lab = simulateExit(x.d.bars, x.i, x.st.atr, X, { delisted, ma20: x.d.ma20 }, R);
        if (!lab || lab.reason === 'nofill') { exits.skip = true; break; }
        exits[X.key] = { ret: lab.ret, r: lab.r, win: lab.win, reason: lab.reason, days: lab.days };
      }
      if (exits.skip) continue;
      const score = compositeScore(x.f, ref, FACTORS)?.score ?? null;
      const ctx = { score, aboveMa200: x.f.aboveMa200, breadth, breakout: x.st.breakout, pullback: x.st.pullback };
      // Cổ ngon theo BCTC đã công bố tại mốc (chỉ khi panel có bộ đọc quality.js; null = thiếu dữ liệu)
      const q = x.d.quality ? x.d.quality(date) : null;
      trades.push({
        date, symbol: x.s, score, breadth: r4(breadth),
        rules: RULES.filter((rl) => rl.test(ctx)).map((rl) => rl.key),
        ...exits[BASE_EXIT.key], exits,
        quality: q ? q.pass : null, checks: q?.checks ?? null,
      });
    }
  }
  return { from: cal[start]?.time, to: cal.at(-1)?.time, samples, trades };
}

/** Báo cáo đủ các luật: toàn giai đoạn, hai nửa, từng năm, theo độ rộng thị trường; kèm hiệu chuẩn ngoài mẫu. */
export function buildReport({ from, to, samples, trades }, step = EXPECT_STEP, R = EVAL_RULE) {
  const dates = [...new Set(trades.map((x) => x.date))].sort();
  const mid = dates[Math.floor(dates.length / 2)];
  const rules = RULES.map((rl) => {
    const tr = trades.filter((x) => x.rules.includes(rl.key));
    const all = summarize(tr, step);
    const first = summarize(tr.filter((x) => x.date < mid), step);
    const second = summarize(tr.filter((x) => x.date >= mid), step);
    const years = [...new Set(tr.map((x) => x.date.slice(0, 4)))].sort();
    return {
      key: rl.key, label: rl.label, all, first, second, verdict: edgeVerdict(all, first, second),
      byYear: Object.fromEntries(years.map((y) => [y, summarize(tr.filter((x) => x.date.startsWith(y)), step)])),
      strongMarket: summarize(tr.filter((x) => x.breadth >= BREADTH_ON), step),
      weakMarket: summarize(tr.filter((x) => x.breadth != null && x.breadth < BREADTH_ON), step),
    };
  });
  const exits = Object.fromEntries(EXIT_RULE_SETS.map((key) => {
    const tr = trades.filter((x) => x.rules.includes(key));
    return [key, EXITS.map((X) => {
      const as = tr.map((x) => ({ date: x.date, ...x.exits[X.key] }));
      const all = summarize(as, step, X.maxDays);
      return {
        key: X.key, label: X.label, all,
        first: summarize(as.filter((x) => x.date < mid), step, X.maxDays),
        second: summarize(as.filter((x) => x.date >= mid), step, X.maxDays),
        retPer20: all.n && all.avgDays > 0 ? r4((all.avgRet / Math.max(1, all.avgDays)) * 20) : null,
        vsBase: X === BASE_EXIT ? null : compareExit(tr, X.key, mid, step),
      };
    })];
  }));
  return {
    from, to, samples, step, rule: R, split: mid,
    rules, exits,
    calibration: calibrate(trades.filter((x) => x.date < mid), trades.filter((x) => x.date >= mid)),
  };
}

const pc = (v, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 2) => (v == null ? '–' : v.toFixed(d));
const VERDICT = { edge: 'CÓ LỢI THẾ', unproven: 'chưa chứng minh', negative: 'BẤT LỢI', insufficient: 'chưa đủ mẫu' };

/** Bản tóm tắt dạng chữ cho dòng lệnh / Telegram. */
export function formatReport(rep) {
  const lines = [
    `Bộ đo 3 rào ${rep.from} → ${rep.to} · ${rep.samples} mốc (mỗi ${rep.step} phiên) · tách nửa tại ${rep.split}`,
    `Luật: mua mở cửa phiên sau, cắt lỗ ${rep.rule.stopAtr}×ATR (${pc(rep.rule.minStopPct, 0)}–${pc(rep.rule.maxStopPct, 0)}), mục tiêu +${BASE_EXIT.target}R, tối đa ${BASE_EXIT.maxDays} phiên, T+${rep.rule.settle}, đã trừ phí/thuế.`,
    '',
  ];
  for (const r of rep.rules) {
    const a = r.all;
    lines.push(`■ ${r.key} — ${r.label}: ${VERDICT[r.verdict]}`);
    if (!a.n) { lines.push('  (không có lệnh)'); continue; }
    lines.push(`  ${a.n} lệnh / ${a.dates} mốc · thắng ${pc(a.winRate)} [${pc(a.winCI[0])}–${pc(a.winCI[1])}] · chạm mục tiêu ${pc(a.targetRate)} · cắt lỗ ${pc(a.stopRate)} · hết giờ ${pc(a.timeRate)}`);
    lines.push(`  R TB ${fx(a.avgR)} (t ${fx(a.t)}) · lãi TB ${pc(a.avgRet, 2)} · thắng TB ${fx(a.avgWinR)}R / thua TB ${fx(a.avgLossR)}R · PF ${fx(a.profitFactor)} · giữ ${fx(a.avgDays, 1)} phiên`);
    lines.push(`  Nửa đầu: thắng ${pc(r.first.winRate)}, R ${fx(r.first.avgR)} · Nửa sau: thắng ${pc(r.second.winRate)}, R ${fx(r.second.avgR)}`);
    lines.push(`  TT khỏe: ${r.strongMarket.n || 0} lệnh, thắng ${pc(r.strongMarket.winRate)}, R ${fx(r.strongMarket.avgR)} · TT yếu: ${r.weakMarket.n || 0} lệnh, thắng ${pc(r.weakMarket.winRate)}, R ${fx(r.weakMarket.avgR)}`);
    lines.push(`  Theo năm: ${Object.entries(r.byYear).map(([y, s]) => `${y} ${pc(s.winRate, 0)}/${fx(s.avgR)}R (${s.n})`).join(' · ')}`);
  }
  const CMP = { better: 'TỐT HƠN', worse: 'KÉM HƠN', same: 'không khác rõ', insufficient: 'chưa đủ mẫu' };
  for (const [set, rows] of Object.entries(rep.exits || {})) {
    lines.push('', `▶ So kiểu thoát lệnh trên tín hiệu ${set} (${rows[0]?.all.n || 0} lệnh, cùng điểm mua và cắt lỗ ban đầu):`);
    for (const x of rows) {
      const a = x.all;
      if (!a.n) continue;
      const v = x.vsBase;
      const dv = (d) => (v.unit === 'ret' ? `${d >= 0 ? '+' : ''}${pc(d, 2)}` : `${d >= 0 ? '+' : ''}${fx(d)}R`);
      const cmp = v ? ` · so ${v.vs} ${dv(v.diffR)} (t ${fx(v.t)}, nửa đầu ${dv(v.firstDiffR)} / nửa sau ${dv(v.secondDiffR)}): ${CMP[v.verdict]}` : ' · (cơ sở)';
      lines.push(`  ${x.key.padEnd(7)} thắng ${pc(a.winRate)} · R TB ${fx(a.avgR)} · thắng TB ${fx(a.avgWinR)}R / thua TB ${fx(a.avgLossR)}R · PF ${fx(a.profitFactor)} · giữ ${fx(a.avgDays, 1)} phiên · lãi/20 phiên ${pc(x.retPer20, 2)}${cmp}`);
    }
  }
  const c = rep.calibration;
  lines.push('', `Hiệu chuẩn ngoài mẫu (học nửa đầu → chấm nửa sau): tỷ lệ nền ${pc(c.baseRate)} · Brier ${fx(c.brier, 4)} vs nền ${fx(c.brierBase, 4)} · kỹ năng ${pc(c.skill, 2)}`);
  for (const [b, r] of Object.entries(c.bins).sort((x, y) => parseFloat(x[0]) - parseFloat(y[0]))) {
    lines.push(`  Điểm ${b}: dự báo ${pc(r.predicted)} → thực tế ${pc(r.observed)} [${pc(r.ci[0])}–${pc(r.ci[1])}] (${r.n} lệnh)`);
  }
  return lines.join('\n');
}

/** Chạy toàn bộ trên dữ liệu thật và lưu data/evaluation.json. */
export async function runEvaluation({ years = 4 } = {}) {
  const panel = await loadPanel({ years });
  const collected = collectTrades(panel.cal, panel.data, panel);
  const rep = { ...buildReport(collected, panel.step), survivorshipBias: panel.survivorshipBias, builtAt: new Date().toISOString() };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(rep), 'utf8');
  // Lưu thêm vào database (nếu bật) để giữ mọi lần chạy; lỗi database không làm hỏng kết quả
  if (dbConfig().enabled) {
    await upsert('evaluation_runs', ['built_at', 'date_from', 'date_to', 'raw'], [[rep.builtAt, rep.from, rep.to, rep]], ['built_at'], { update: false })
      .catch((err) => console.error('[DB] Không lưu được kết quả bộ đo:', err.message));
  }
  return rep;
}
