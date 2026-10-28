// Đo lường rủi ro từ chuỗi giá ngày (tham khảo risk_xray của Vibe-Trading).
import { returnsOf, maxDrawdown } from './backtest.js';

const BARS_PER_YEAR = 252;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

/** VaR lịch sử: mức lỗ 1 phiên chỉ bị vượt (1 − level) số phiên. Trả số dương (tỷ lệ lỗ). */
export function historicalVar(returns, level = 0.95) {
  if (returns.length < 20) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  return -sorted[Math.floor((1 - level) * sorted.length)];
}

/** CVaR (Expected Shortfall): lỗ trung bình trong các phiên tệ hơn VaR. */
export function historicalCvar(returns, level = 0.95) {
  if (returns.length < 20) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor((1 - level) * sorted.length));
  return -mean(sorted.slice(0, k));
}

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my);
    vx += (x[i] - mx) ** 2;
    vy += (y[i] - my) ** 2;
  }
  return vx && vy ? cov / Math.sqrt(vx * vy) : null;
}

export function beta(returns, benchReturns) {
  const n = Math.min(returns.length, benchReturns.length);
  if (n < 20) return null;
  const x = returns.slice(-n), y = benchReturns.slice(-n);
  const mx = mean(x), my = mean(y);
  let cov = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vy += (y[i] - my) ** 2; }
  return vy ? cov / vy : null;
}

/** Ghép lợi suất ngày của nhiều mã theo ngày chung (chỉ giữ ngày mọi mã đều có giá). */
export function alignReturns(seriesBySymbol, lookback = 250) {
  const syms = Object.keys(seriesBySymbol);
  if (!syms.length) return { dates: [], returns: {} };
  const maps = syms.map((s) => new Map(seriesBySymbol[s].map((b) => [b.time, b.close])));
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort().slice(-(lookback + 1));
  const returns = {};
  syms.forEach((s, k) => { returns[s] = returnsOf(dates.map((d) => maps[k].get(d))); });
  return { dates: dates.slice(1), returns };
}

/** Hồ sơ rủi ro một mã từ ~1 năm giá gần nhất. */
export function riskProfile(bars, indexBars = null) {
  const recent = bars.slice(-251);
  const r = returnsOf(recent.map((b) => b.close));
  const out = {
    days: r.length,
    volatility: round(stdev(r) * Math.sqrt(BARS_PER_YEAR)),
    var95: round(historicalVar(r, 0.95)),
    cvar95: round(historicalCvar(r, 0.95)),
    maxDrawdown: round(maxDrawdown(recent.map((b) => b.close))),
    worstDay: round(Math.min(...r)),
    beta: null,
    correlation: null,
  };
  if (indexBars?.length) {
    const { returns } = alignReturns({ s: bars, i: indexBars }, 250);
    out.beta = round(beta(returns.s, returns.i), 2);
    out.correlation = round(correlation(returns.s, returns.i), 2);
  }
  return out;
}

export function riskBrief(rp) {
  const p = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  return `Rủi ro 1 năm (${rp.days} phiên): biến động năm ${p(rp.volatility)}, VaR95 1 phiên ${p(rp.var95)}, CVaR95 ${p(rp.cvar95)}, `
    + `sụt giảm tối đa ${p(rp.maxDrawdown)}, phiên tệ nhất ${p(rp.worstDay)}, beta với VN-Index ${rp.beta ?? 'n/a'}, tương quan ${rp.correlation ?? 'n/a'}.`;
}

/**
 * Quét nhanh dị thường / bắt dao rơi / lao dốc mạnh (tham khảo Laban _detect_stock_risk).
 * Trả về cảnh báo rủi ro cao nếu cổ phiếu đang trong đà rơi tự do hoặc thủng sâu MA50.
 */
export function detectStockRisk(bars, ticker = '') {
  if (!bars || bars.length < 21) return { isRisky: false, reasons: [], riskLevel: 'NORMAL' };
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const lastClose = closes[n - 1];
  
  const ret5d = ((lastClose - closes[n - 6]) / closes[n - 6]) * 100;
  const ret20d = ((lastClose - closes[n - 21]) / closes[n - 21]) * 100;

  const look60 = Math.min(60, bars.length);
  const high60 = Math.max(...bars.slice(-look60).map((b) => b.high ?? b.close));
  const dropPeak = ((lastClose - high60) / high60) * 100;

  const reasons = [];
  // 1. Rơi tự do / lao dốc ngắn/trung hạn
  if (ret5d <= -12.0) {
    reasons.push(`Rơi tự do 5 phiên (${ret5d >= 0 ? '+' : ''}${ret5d.toFixed(1)}%)`);
  } else if (ret20d <= -20.0) {
    reasons.push(`Lao dốc 20 phiên (${ret20d >= 0 ? '+' : ''}${ret20d.toFixed(1)}%)`);
  }

  // 2. Sụt giảm nghiêm trọng từ đỉnh 60 phiên
  if (dropPeak <= -35.0) {
    reasons.push(`Sụt từ đỉnh 60 phiên (${dropPeak.toFixed(1)}%)`);
  }

  // 3. Thủng sâu MA50 (> 18% dưới MA50)
  if (n >= 50) {
    const ma50 = closes.slice(-50).reduce((s, v) => s + v, 0) / 50;
    if (lastClose < ma50 * 0.82) {
      const pctBelow = Math.round((1 - lastClose / ma50) * 100);
      reasons.push(`Thủng sâu MA50 (-${pctBelow}%)`);
    }
  }

  // 4. Giảm sàn liên tiếp (biên độ HOSE sàn khoảng -6.5%)
  const last10 = bars.slice(-10);
  let limitDowns = 0;
  for (let i = 1; i < last10.length; i++) {
    const cPrev = last10[i - 1].close;
    const chg = ((last10[i].close - cPrev) / cPrev) * 100;
    if (chg <= -6.5) limitDowns++;
  }
  if (limitDowns >= 2) {
    reasons.push(`${limitDowns} phiên giảm sàn gần đây`);
  }

  const isRisky = reasons.length > 0;
  return {
    isRisky,
    ticker,
    lastClose,
    ret5d: round(ret5d, 1),
    ret20d: round(ret20d, 1),
    dropPeak: round(dropPeak, 1),
    limitDowns,
    reasons,
    riskLevel: !isRisky ? 'NORMAL' : (limitDowns >= 2 || ret5d <= -15 || dropPeak <= -40 ? 'CRITICAL' : 'HIGH'),
  };
}

