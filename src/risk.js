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

// -----------------------------------------------------------------------------------------
// Cảnh báo "Khoan mua" (Do not buy now) đã được kiểm chứng thống kê out-of-sample trên HOSE
// 2018–2026 (tham khảo nghiên cứu Laban / international_research.py).
// Trong 10 phiên tiếp theo, hai tín hiệu này kém cổ phiếu bình quân toàn sàn ở CẢ 2 giai đoạn:
// trước tháng 7-2023 và sau tháng 7-2023. Tín hiệu này dùng để KHOAN MUA, không dùng để bán.
// -----------------------------------------------------------------------------------------
export const BUY_WARNINGS_INFO = {
  ssl: {
    name: '⚠️ Thủng SSL',
    tested: 'kém cổ phiếu bình quân −17%/năm trước 7-2023, −16%/năm từ 7-2023 (10 phiên, trước phí)',
  },
  weak: {
    name: '📉 Suy yếu',
    tested: 'kém cổ phiếu bình quân −33%/năm trước 7-2023, −14%/năm từ 7-2023 (10 phiên, trước phí)',
  },
};

export const WARNING_UNIVERSE = { minVal: 1e9, minPrice: 5.0 }; // Giá ≥ 5.0 nghìn đồng (5.000 VNĐ) và GTGD ≥ 1 tỷ/phiên
export const OUTSIDE_UNIVERSE = 'chỉ kiểm chứng trên mã GTGD ≥ 1 tỷ/phiên và giá ≥ 5.000; mã này ngoài nhóm đó nên chỉ để tham khảo';
export const WARNING_SESSIONS = 5; // Cảnh báo thủng SSL có hiệu lực trong 5 phiên sau khi xảy ra

/**
 * Phát hiện cảnh báo KHOAN MUA (Thủng đáy thanh khoản SSL hoặc Cổ phiếu suy yếu).
 * @param {Array<{close: number, low?: number, high?: number, time?: string}>} bars
 * @param {number|null} val20 GTGD trung bình 20 phiên (VNĐ)
 * @returns {Array<{key: string, name: string, date: string, level?: number, r5?: number, text: string, tested: string, outside: boolean}>}
 */
export function detectBuyWarnings(bars, val20 = null) {
  if (!bars || bars.length < 21) return [];
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const lows = bars.map((b) => b.low ?? b.close);
  const lastClose = closes[n - 1];

  const outside = lastClose < WARNING_UNIVERSE.minPrice || (val20 != null && val20 < WARNING_UNIVERSE.minVal);
  const out = [];

  // 1. SSL Break: Giá đóng cửa thủng đáy thanh khoản (pivot low đánh bại 7 phiên trước và 6 phiên sau)
  // Điểm pivot low p được xác nhận tại phiên p + 6, từ đó trở đi duy trì mức SSL cho đến pivot mới.
  const sslLevels = new Array(n).fill(null);
  let activeSSL = null;
  for (let i = 0; i < n; i++) {
    const p = i - 6;
    if (p >= 7) {
      const pLow = lows[p];
      let isPivot = true;
      for (let k = 1; k <= 7; k++) {
        if (!(pLow < lows[p - k])) { isPivot = false; break; }
      }
      if (isPivot) {
        for (let m = 1; m <= 6; m++) {
          if (!(pLow < lows[p + m])) { isPivot = false; break; }
        }
      }
      if (isPivot) {
        activeSSL = pLow;
      }
    }
    sslLevels[i] = activeSSL;
  }

  // brk = (c < ssl) & (c.shift(1) >= ssl.shift(1))
  const brkIndices = [];
  const startIdx = Math.max(1, n - WARNING_SESSIONS);
  for (let i = startIdx; i < n; i++) {
    const sCur = sslLevels[i];
    const sPrev = sslLevels[i - 1];
    if (sCur != null && sPrev != null) {
      if (closes[i] < sCur && closes[i - 1] >= sPrev) {
        brkIndices.push(i);
      }
    }
  }

  if (brkIndices.length > 0) {
    const atIdx = brkIndices[brkIndices.length - 1];
    const breakBar = bars[atIdx];
    const level = sslLevels[atIdx];
    const when = breakBar.time ? breakBar.time.slice(5) : `phiên #${atIdx}`;
    const levelVnd = level < 1000 ? Math.round(level * 1000) : Math.round(level);
    const w = BUY_WARNINGS_INFO.ssl;
    out.push({
      key: 'ssl',
      name: w.name,
      date: breakBar.time || '',
      level,
      tested: outside ? OUTSIDE_UNIVERSE : w.tested,
      text: `đóng cửa dưới đáy thanh khoản ${levelVnd.toLocaleString('vi-VN')} phiên ${when}: khoan mua khoảng 10 phiên`,
      outside,
    });
  }

  // 2. Weak Stock: Giảm >= 3% trong 5 phiên và giá đóng cửa dưới MA20
  if (n >= 21) {
    const r5 = (lastClose - closes[n - 6]) / closes[n - 6];
    const sum20 = closes.slice(-20).reduce((s, v) => s + v, 0);
    const ma20 = sum20 / 20;
    if (r5 <= -0.03 && lastClose < ma20) {
      const w = BUY_WARNINGS_INFO.weak;
      const lastBar = bars[n - 1];
      out.push({
        key: 'weak',
        name: w.name,
        date: lastBar.time || '',
        tested: outside ? OUTSIDE_UNIVERSE : w.tested,
        text: `giảm ${(Math.abs(r5) * 100).toFixed(1).replace('.', ',')}% trong 5 phiên và dưới MA20: khoan mua khoảng 10 phiên`,
        r5: Math.round(r5 * 1000) / 10,
        outside,
      });
    }
  }

  return out;
}

/**
 * Quét nhanh dị thường / bắt dao rơi / lao dốc mạnh (tham khảo Laban _detect_stock_risk).
 * Trả về cảnh báo rủi ro cao nếu cổ phiếu đang trong đà rơi tự do hoặc thủng sâu MA50.
 */
export function detectStockRisk(bars, ticker = '', val20 = null) {
  if (!bars || bars.length < 21) return { isRisky: false, reasons: [], riskLevel: 'NORMAL', buyWarnings: [] };
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

  // 5. Dấu hiệu cổ phiếu bo cung / quay tay tạo thanh khoản nhân tạo
  if (n >= 30) {
    const last30 = bars.slice(-30);
    const vols = last30.map((b) => b.volume || 0);
    const avgVol = vols.reduce((s, v) => s + v, 0) / 30;
    if (avgVol >= 500_000) {
      const stdVol = Math.sqrt(vols.reduce((s, v) => s + (v - avgVol) ** 2, 0) / 29);
      const cvVol = stdVol / avgVol;
      // Cổ phiếu bo cung thực tế trên sàn: nến có biên độ co giật nhân tạo hoặc cực hẹp (high ≈ low liên tục)
      const flatCandles = last30.filter((b) => ((b.high || b.close) - (b.low || b.close)) / b.close < 0.005).length;
      if (cvVol < 0.08 && flatCandles >= 15) {
        reasons.push(`Dấu hiệu bo cung / thao túng thanh khoản ảo (${flatCandles}/30 phiên nến phẳng không biến động)`);
      }
    }
  }

  const isRisky = reasons.length > 0;
  const buyWarnings = detectBuyWarnings(bars, val20);
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
    buyWarnings,
  };
}

