// Quá khứ → tương lai: dải dao động giá các phiên tới, kịch bản AI, lời/lỗ dự kiến và kiểm chứng trên quá khứ.
//
// Dải thống kê: phân phối lợi suất h phiên của CHÍNH mã đó trong ~2 năm trước (các cửa sổ chồng nhau), bỏ phần
// trôi trung bình (không giả định giá tự tăng hay giảm) → phân vị 5/25/50/75/95. Phương pháp chỉ ước lượng
// BIÊN ĐỘ, không dự báo hướng; hướng do AI đưa ra theo kịch bản và được đối chiếu sau khi đủ phiên.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { DEFAULTS, rng } from './backtest.js';
import { getTuning } from './tuning.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'forecasts.json');
export const LOOKBACK = 500;      // số phiên quá khứ dùng để ước lượng
export const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
export const AI_HORIZONS = [5, 10, 20];
// Nới dải: lấy phân vị từ mẫu hữu hạn (các cửa sổ chồng nhau) luôn đánh giá thấp đuôi. Kiểm chứng ~130 mã × 2 năm:
// không nới thì dải 90% chỉ chứa giá thật 86–88%, nới 1,12 lần thì về ~89–91% ở cả 5/10/20 phiên và cả hai nửa thời gian.
// (Co giãn theo biến động 20/60 phiên gần nhất đã thử, không cải thiện.) Hệ số được selfreview.js tự hiệu chỉnh tiếp
// theo tỷ lệ giá thật nằm trong dải của các dự báo đã lưu.
const widen = () => getTuning().widen;
// Phí mua + phí bán + thuế bán (đọc khi dùng: forecast.js nằm trong vòng import với backtest.js)
const roundTrip = () => DEFAULTS.brokerage * 2 + DEFAULTS.sellTax;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Lợi suất log h phiên (đã bỏ trôi trung bình quá khứ, cộng độ trôi có điều kiện dailyDrift, nới theo hệ số widen) trong cửa sổ [from, to] của chuỗi giá đóng cửa. */
function hReturns(closes, h, from, to, dailyDrift = 0) {
  const out = [];
  for (let i = Math.max(0, from); i + h <= to; i++) out.push(Math.log(closes[i + h] / closes[i]));
  if (!out.length) return out;
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  const k = widen();
  const driftH = dailyDrift * h;
  return out.map((x) => (x - mean) * k + driftH).sort((a, b) => a - b);
}

/** Các phiên giao dịch tiếp theo (thứ 2 – thứ 6; chưa trừ ngày lễ). */
export function futureDates(lastDate, n) {
  const out = [];
  const d = new Date(`${lastDate}T00:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Dải giá cho từng phiên 1..H tính từ phiên cuối.
 * @returns {{ h: number, date: string, p05: number, p25: number, p50: number, p75: number, p95: number, probProfit: number }[]}
 */
export function priceCone(bars, H, { lookback = LOOKBACK, dailyDrift = 0 } = {}) {
  const closes = bars.map((b) => b.close);
  const end = closes.length - 1, close = closes[end];
  const dates = futureDates(bars.at(-1).time, H);
  const out = [];
  for (let h = 1; h <= H; h++) {
    const r = hReturns(closes, h, end - lookback, end, dailyDrift);
    if (r.length < 30) break;
    const [p05, p25, p50, p75, p95] = QUANTILES.map((q) => round(close * Math.exp(quantile(r, q))));
    // Xác suất giá sau h phiên đủ bù phí + thuế khứ hồi
    const be = Math.log(1 + roundTrip());
    out.push({ h, date: dates[h - 1], p05, p25, p50, p75, p95, probProfit: round(r.filter((x) => x > be).length / r.length, 3) });
  }
  return out;
}

/** Tóm tắt dải ở một số mốc (dùng trong prompt AI). */
export function coneSummary(bars, horizons = AI_HORIZONS, { dailyDrift = 0 } = {}) {
  const H = Math.max(...horizons);
  const cone = priceCone(bars, H, { dailyDrift });
  return horizons.map((h) => cone.find((c) => c.h === h)).filter(Boolean);
}

/**
 * Kiểm chứng trên quá khứ: tại mỗi phiên t (cách nhau `step` phiên, trong `years` năm gần nhất), dựng dải chỉ bằng
 * dữ liệu TRƯỚC t rồi so với giá thực tế sau h phiên. Dải 50% chứa giá thật ~50% số lần, dải 90% ~90% là dải chuẩn.
 */
export function validateCone(bars, h, { years = 2, step = 5, lookback = LOOKBACK } = {}) {
  const closes = bars.map((b) => b.close);
  const end = closes.length - 1;
  const first = Math.max(lookback / 2, end - Math.round(years * 250));
  const points = [];
  for (let t = first; t + h <= end; t += step) {
    const r = hReturns(closes, h, t - lookback, t);
    if (r.length < 60) continue;
    const c = closes[t];
    const q = QUANTILES.map((p) => c * Math.exp(quantile(r, p)));
    const actual = closes[t + h];
    points.push({
      from: bars[t].time, date: bars[t + h].time, close: c, actual,
      p05: round(q[0]), p25: round(q[1]), p50: round(q[2]), p75: round(q[3]), p95: round(q[4]),
      in50: actual >= q[1] && actual <= q[3], in90: actual >= q[0] && actual <= q[4],
    });
  }
  const n = points.length;
  return {
    h, n, step, years,
    coverage50: n ? round(points.filter((p) => p.in50).length / n, 3) : null,
    coverage90: n ? round(points.filter((p) => p.in90).length / n, 3) : null,
    above95: n ? round(points.filter((p) => p.actual > p.p95).length / n, 3) : null,
    below05: n ? round(points.filter((p) => p.actual < p.p05).length / n, 3) : null,
    points,
  };
}

// Seed cố định theo mã/phiên/giá: cùng dữ liệu luôn ra cùng kết quả (không nhảy tín hiệu giữa hai lần gọi)
function seedOf(bars) {
  const s = `${bars.length}|${bars.at(-1).time}|${bars.at(-1).close}|${bars[0].close}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Mô phỏng Monte Carlo (bootstrap đường giá theo phân phối biến động thực tế của mã,
 * tuân thủ biên độ trần/sàn Việt Nam, tham khảo phương pháp Laban).
 * Tích hợp Bayesian & Regime-Conditioned Drift: kết hợp quán tính xu hướng (trend), bối cảnh
 * thị trường chung (market beta drag) và dòng tiền khối ngoại để ước tính xác suất tăng/giảm chân thực,
 * tránh rơi vào bẫy xác suất 50/50 của mô hình random walk giả định zero drift thuần túy.
 * Lấy mẫu theo khối liên tiếp `block` phiên để giữ hiện tượng biến động co cụm (volatility clustering).
 * Trả về phân phối: prob_up, prob_gain5, prob_loss7, tỷ lệ R/R, và tín hiệu rủi ro.
 */
export function monteCarloForecast(bars, H = 20, numPaths = 1000, {
  exchange = 'HOSE',
  isRisky = false,
  block = 5,
  seed = null,
  trendState = null,
  marketTrend = null,
  score = null,
  foreignRatio20 = null,
  atrRatio = null,
} = {}) {
  if (!bars || bars.length < 30) return null;
  const n = bars.length;
  const lastBar = bars[n - 1];
  const baseClose = lastBar.close;

  // Lấy mẫu biến động ngày tương đối từ 120-250 phiên gần nhất
  const lookback = Math.min(250, n - 1);
  const sampleSteps = [];
  for (let i = n - lookback; i < n; i++) {
    const prevC = bars[i - 1].close;
    if (prevC > 0) {
      sampleSteps.push({
        oRatio: bars[i].open / prevC,
        hRatio: (bars[i].high ?? bars[i].close) / prevC,
        lRatio: (bars[i].low ?? bars[i].close) / prevC,
        cRatio: bars[i].close / prevC,
      });
    }
  }

  if (sampleSteps.length < 20) return null;
  // Bỏ trôi lịch sử cũ: chuẩn hóa về trung bình log lợi suất = 0
  const drift = Math.exp(sampleSteps.reduce((s, x) => s + Math.log(x.cRatio), 0) / sampleSteps.length);
  for (const x of sampleSteps) { x.oRatio /= drift; x.hRatio /= drift; x.lRatio /= drift; x.cRatio /= drift; }

  // Tính độ trôi có điều kiện theo trạng thái (Bayesian & Regime-conditioned Drift)
  let dailyDrift = 0;
  if (trendState || marketTrend || score != null || foreignRatio20 != null) {
    // 1. Quán tính xu hướng của cổ phiếu
    if (trendState === 'UP' || (score != null && score >= 75)) dailyDrift += 0.0010; // ~ +2.0% / 20 phiên
    else if (trendState === 'DOWN' || (score != null && score < 40)) dailyDrift -= 0.0012; // ~ -2.4% / 20 phiên

    // 2. Sức cản / trợ lực từ thị trường chung (Market Beta Drag)
    if (marketTrend === 'down') dailyDrift -= 0.0006; // Áp lực thị trường giảm ~1.2%
    else if (marketTrend === 'up') dailyDrift += 0.0004;

    // 3. Dòng tiền khối ngoại gom / xả ròng
    if (foreignRatio20 != null) {
      if (foreignRatio20 >= 10) dailyDrift += 0.0004;
      else if (foreignRatio20 <= -10) dailyDrift -= 0.0005;
    }

    // Giới hạn độ trôi mỗi phiên trong [-0.25%, +0.25%] để bảo toàn tính vững chắc
    dailyDrift = Math.max(-0.0025, Math.min(0.0025, dailyDrift));
  }

  // Co giãn biến động động theo chu kỳ (Dynamic Volatility Scaling)
  const volScale = (atrRatio && Number.isFinite(atrRatio)) ? Math.max(0.8, Math.min(1.3, atrRatio)) : 1.0;
  const driftFactor = 1 + dailyDrift;

  // Cập nhật các bước nhảy ngẫu nhiên
  for (const x of sampleSteps) {
    x.cRatio = (1 + (x.cRatio - 1) * volScale) * driftFactor;
  }

  const rand = rng(seed ?? seedOf(bars));
  const B = Math.max(1, Math.min(block, sampleSteps.length));

  const band = (exchange === 'HNX' ? 0.10 : exchange === 'UPCOM' ? 0.15 : 0.07);
  const finalRets = [];
  const peakGains = [];
  const troughDds = [];
  const stepPrices = Array.from({ length: H }, () => []);

  for (let p = 0; p < numPaths; p++) {
    let currClose = baseClose;
    let pathMaxH = baseClose;
    let pathMinL = baseClose;

    let idx = 0;
    for (let step = 0; step < H; step++) {
      // Đầu mỗi khối chọn vị trí ngẫu nhiên, trong khối lấy các phiên liên tiếp
      idx = step % B === 0 ? Math.floor(rand() * (sampleSteps.length - B + 1)) : idx + 1;
      const s = sampleSteps[idx];
      const loLimit = currClose * (1 - band);
      const hiLimit = currClose * (1 + band);

      const o = Math.max(loLimit, Math.min(hiLimit, currClose * s.oRatio));
      let h = Math.max(loLimit, Math.min(hiLimit, currClose * s.hRatio));
      let l = Math.max(loLimit, Math.min(hiLimit, currClose * s.lRatio));
      const c = Math.max(loLimit, Math.min(hiLimit, currClose * s.cRatio));

      h = Math.max(h, o, c);
      l = Math.min(l, o, c);

      if (h > pathMaxH) pathMaxH = h;
      if (l < pathMinL) pathMinL = l;
      currClose = c;
      stepPrices[step].push(currClose);
    }

    finalRets.push(((currClose / baseClose) - 1) * 100);
    peakGains.push(((pathMaxH / baseClose) - 1) * 100);
    troughDds.push(((pathMinL / baseClose) - 1) * 100);
  }

  finalRets.sort((a, b) => a - b);
  peakGains.sort((a, b) => a - b);
  troughDds.sort((a, b) => a - b);

  const dates = futureDates(lastBar.time, H);
  const projectionSeries = [];
  for (let step = 0; step < H; step++) {
    const prices = stepPrices[step].sort((a, b) => a - b);
    projectionSeries.push({
      step: step + 1,
      time: dates[step],
      p10: round(quantile(prices, 0.1)),
      p50: round(quantile(prices, 0.5)),
      p90: round(quantile(prices, 0.9)),
    });
  }

  const stats = {
    h: H,
    numPaths,
    baseClose,
    dailyDriftPct: round(dailyDrift * 100, 3),
    regimeContext: (trendState || marketTrend || score != null) ? { trendState, marketTrend, score, foreignRatio20 } : null,
    finalRetMedian: round(quantile(finalRets, 0.5)),
    finalRetP10: round(quantile(finalRets, 0.1)),
    finalRetP90: round(quantile(finalRets, 0.9)),
    peakGainMedian: round(quantile(peakGains, 0.5)),
    troughDdMedian: round(quantile(troughDds, 0.5)),
    probUp: round(finalRets.filter((r) => r > 0).length / numPaths, 3),
    probGain5: round(peakGains.filter((g) => g >= 5.0).length / numPaths, 3),
    probLoss7: round(troughDds.filter((d) => d <= -7.0).length / numPaths, 3),
    projectionSeries,
  };

  const signalRes = classifySignal(stats, isRisky);
  return { ...stats, ...signalRes };
}

/**
 * Phân loại tín hiệu giao dịch dựa trên xác suất Monte Carlo (tham khảo Laban _classify_signal).
 */
export function classifySignal(st, isRisky = false) {
  const gain = st.peakGainMedian ?? 0;
  const dd = st.troughDdMedian ?? 0;
  const rr = Math.min(99.0, Math.max(gain, 1e-5) / Math.max(-dd, 1e-5));
  let signal = 'HOLD';

  if (isRisky) {
    signal = (st.probUp >= 0.60 && gain >= 4.0) ? 'RISK_BUY' : 'RISK';
  } else if (st.probUp >= 0.65 && st.finalRetMedian >= 2.0 && gain >= 5.0 && rr >= 1.5) {
    signal = 'STRONG_BUY';
  } else if (st.probUp >= 0.55 && st.finalRetMedian >= 1.0 && gain >= 2.5) {
    signal = 'BUY';
  } else if (st.probUp <= 0.35 && st.finalRetMedian <= -2.0) {
    signal = 'SELL';
  } else if (st.probLoss7 >= 0.40) {
    signal = 'RISK';
  }

  return { signal, rr: round(rr, 2) };
}


// ---------- Lưu dự báo AI để đối chiếu sau ----------
let store = null;
async function load() {
  if (store) return store;
  try { store = JSON.parse(await readFile(FILE, 'utf8')); } catch { store = {}; }
  return store;
}

/**
 * Ghi dự báo kịch bản của AI (mỗi mã/phiên giữ bản mới nhất).
 * `cone` (coneSummary lúc dự báo) được lưu thành dải 5–95% để chấm "giá thật nằm trong dải".
 */
export async function recordForecast(symbol, { date, close, forecast, cone = null, source = 'gemini' }) {
  if (!forecast?.scenarios?.length || !date) return;
  await load();
  store[symbol] ??= {};
  const band = cone?.length ? Object.fromEntries(cone.map((c) => [`p${c.h}`, [c.p05, c.p95]])) : null;
  store[symbol][date] = { date, close, source, at: new Date().toISOString(), scenarios: forecast.scenarios, expected: forecast.expected ?? null, band };
  const dates = Object.keys(store[symbol]).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - 120))) delete store[symbol][d];
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store), 'utf8');
}

/** Các dự báo AI cũ kèm giá thực tế ở mốc 5/10/20 phiên (null nếu chưa đến). */
export async function pastForecasts(symbol, bars) {
  await load();
  const at = new Map(bars.map((b, i) => [b.time, i]));
  return Object.values(store[symbol] || {}).sort((a, b) => a.date.localeCompare(b.date)).map((f) => {
    const i = at.get(f.date);
    const base = f.scenarios.find((s) => s.name === 'CO_SO') || f.scenarios[0];
    const checks = AI_HORIZONS.map((h) => {
      const actual = i != null && i + h < bars.length ? bars[i + h].close : null;
      const target = base?.[`p${h}`] ?? null;
      // Dải 5–95% lúc dự báo; bản ghi cũ chưa có dải thì dùng vùng giữa kịch bản giảm và tăng
      const [lo, hi] = f.band?.[`p${h}`] || [
        Math.min(...f.scenarios.map((s) => s[`p${h}`]).filter(Number.isFinite)),
        Math.max(...f.scenarios.map((s) => s[`p${h}`]).filter(Number.isFinite)),
      ];
      return {
        h, date: i != null && i + h < bars.length ? bars[i + h].time : null, actual, target,
        error: actual != null && target ? round((actual / target - 1) * 100, 1) : null,
        inRange: actual != null && Number.isFinite(lo) ? actual >= lo && actual <= hi : null,
        directionOk: actual != null && target ? Math.sign(actual - f.close) === Math.sign(target - f.close) : null,
      };
    });
    return { ...f, checks };
  });
}

/** Lời/lỗ khi mua `capital` đồng ở giá `entry` và bán ở `exit` (đã trừ phí mua, phí bán, thuế bán; lô 100). */
export function pnl(capital, entry, exit) {
  const shares = Math.floor(capital / (entry * 1000 * (1 + DEFAULTS.brokerage)) / 100) * 100;
  if (!shares) return { shares: 0, pnl: 0, pct: 0 };
  const cost = shares * entry * 1000 * (1 + DEFAULTS.brokerage);
  const proceeds = shares * exit * 1000 * (1 - DEFAULTS.brokerage - DEFAULTS.sellTax);
  return { shares, pnl: Math.round(proceeds - cost), pct: round((proceeds / cost - 1) * 100) };
}

/**
 * Dữ liệu cho thẻ "Quá khứ → Tương lai".
 * @param {{ horizon?: number, ai?: object|null }} opts ai = kết quả Gemini gần nhất (có forecast) nếu có
 */
export async function getForecast(symbol, { horizon = 20, ai = null } = {}) {
  const H = [5, 10, 20, 60].includes(Number(horizon)) ? Number(horizon) : 20;
  const { bars } = await getPriceHistory(symbol, 1100);
  if (bars.length < 300) throw new Error(`Mã ${symbol} có quá ít dữ liệu để dự báo (${bars.length} phiên)`);
  const close = bars.at(-1).close;
  const cone = priceCone(bars, H);
  const validation = validateCone(bars, H);
  const past = await pastForecasts(symbol, bars);
  return {
    symbol, date: bars.at(-1).time, close, horizon: H, lookback: LOOKBACK, roundTrip: roundTrip(),
    history: bars.slice(-Math.max(120, H * 3)).map((b) => ({ time: b.time, close: b.close })),
    cone,
    validation: { ...validation, points: validation.points.slice(-Math.round(250 / validation.step) * 2) },
    ai: ai?.forecast && ai.priceDate === bars.at(-1).time ? { ...ai.forecast, model: ai.model, createdAt: ai.createdAt } : null,
    aiStale: ai?.forecast && ai.priceDate !== bars.at(-1).time ? { date: ai.priceDate } : null,
    past,
  };
}
