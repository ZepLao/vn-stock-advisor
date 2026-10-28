// Đánh giá chế độ thị trường (Market Regime): Đếm ngày phân phối (Distribution Days) theo O'Neil,
// độ rộng thị trường (Market Breadth) và khuyến nghị phân bổ tỷ trọng danh mục (Exposure Control).
// Nguyên tắc fail-closed: không đủ dữ liệu hoặc lỗi mạng thì trả UNKNOWN (không cho mua mới), không giả định thị trường tốt.

import { getPriceHistory } from './data.js';
import { sma } from './indicators.js';

export const REGIMES = {
  CONFIRMED_UPTREND: {
    code: 'CONFIRMED_UPTREND',
    label: 'XU HƯỚNG TĂNG XÁC NHẬN',
    color: '#10b981',
    exposure: '80–100%',
    maxHoldings: 8,
    allowNewBuys: true,
    cashPct: 10,
    desc: 'Thị trường vận động lành mạnh trên MA50, số ngày phân phối thấp. Tận dụng cơ hội giải ngân vào các cổ phiếu dẫn dắt.',
  },
  UPTREND_UNDER_PRESSURE: {
    code: 'UPTREND_UNDER_PRESSURE',
    label: 'XU HƯỚNG TĂNG BỊ ÁP LỰC',
    color: '#f59e0b',
    exposure: '50–60%',
    maxHoldings: 5,
    allowNewBuys: true,
    cashPct: 40,
    desc: 'Xuất hiện 3–4 ngày phân phối hoặc tiệm cận MA50. Hạn chế mua đuổi, nâng chặn lãi và chỉ mở vị thế thăm dò với mã chuẩn setup.',
  },
  MARKET_CORRECTION: {
    code: 'MARKET_CORRECTION',
    label: 'THỊ TRƯỜNG ĐIỀU CHỈNH / RỦI RO',
    color: '#ef4444',
    exposure: '0–30%',
    maxHoldings: 2,
    allowNewBuys: false,
    cashPct: 70,
    desc: 'Số ngày phân phối lớn (≥ 5 phiên) hoặc gãy MA50. Dòng tiền lớn đang rút ra, ưu tiên tối đa bảo toàn vốn và giữ tiền mặt.',
  },
  UNKNOWN: {
    code: 'UNKNOWN',
    label: 'CHƯA XÁC ĐỊNH ĐƯỢC THỊ TRƯỜNG',
    color: '#9ca3af',
    exposure: '0–30%',
    maxHoldings: 2,
    allowNewBuys: false,
    cashPct: 70,
    desc: 'Không tải được hoặc không đủ dữ liệu VN-Index để đánh giá. Tạm không mua mới cho đến khi có dữ liệu.',
  },
};

// Chỉ số tăng vượt 5% so với giá đóng cửa ngày phân phối thì ngày đó hết hiệu lực
const DIST_EXPIRE_RALLY = 0.05;

/**
 * Đếm số ngày phân phối của chỉ số trong cửa sổ rolling (mặc định 25 phiên).
 * Ngày phân phối (theo William O'Neil): phiên chỉ số giảm ≥ 0.2% so với phiên trước với khối lượng cao hơn phiên trước.
 * Ngày phân phối bị xóa bỏ (expire) nếu sau 25 phiên hoặc khi chỉ số tăng vượt 5% từ điểm phân phối.
 */
export function countDistributionDays(indexBars, window = 25) {
  if (!indexBars || indexBars.length < 2) return { count: 0, days: [] };
  const recent = indexBars.slice(-window - 1);
  const days = [];

  for (let i = 1; i < recent.length; i++) {
    const cur = recent[i];
    const prev = recent[i - 1];
    const retPct = ((cur.close - prev.close) / prev.close) * 100;
    const volHigher = cur.volume > prev.volume;

    // Giảm ≥ 0.2% kèm khối lượng tăng hơn phiên trước
    const expired = recent.slice(i + 1).some((b) => b.close >= cur.close * (1 + DIST_EXPIRE_RALLY));
    if (retPct <= -0.2 && volHigher && !expired) {
      days.push({
        time: cur.time,
        close: cur.close,
        retPct: Math.round(retPct * 100) / 100,
        volume: cur.volume,
        volRatio: Math.round((cur.volume / (prev.volume || 1)) * 100) / 100,
      });
    }
  }

  return {
    count: days.length,
    days: days.reverse(), // ngày gần nhất lên đầu
    window: Math.min(window, indexBars.length - 1),
  };
}

/**
 * Đo độ rộng thị trường (Market Breadth): tỷ lệ cổ phiếu trên MA20 và MA50.
 * @param {Array<{bars: Array}>} stockBarsList
 */
export function calculateMarketBreadth(stockBarsList) {
  if (!stockBarsList || !stockBarsList.length) return null;
  let countAbove20 = 0, countAbove50 = 0, total = 0;

  for (const bars of stockBarsList) {
    if (!bars || bars.length < 50) continue;
    const closes = bars.map((b) => b.close);
    const lastClose = closes.at(-1);
    const ma20 = sma(closes, 20).at(-1);
    const ma50 = sma(closes, 50).at(-1);

    if (ma20 != null && lastClose > ma20) countAbove20++;
    if (ma50 != null && lastClose > ma50) countAbove50++;
    total++;
  }

  if (total === 0) return null;
  return {
    total,
    pctAboveMa20: Math.round((countAbove20 / total) * 100),
    pctAboveMa50: Math.round((countAbove50 / total) * 100),
  };
}

/**
 * Đánh giá Chế độ thị trường tổng hợp từ VN-Index và độ rộng.
 */
export function evaluateMarketRegime(indexBars, breadth = null) {
  if (!indexBars || indexBars.length < 50) {
    return { regime: REGIMES.UNKNOWN.code, ...REGIMES.UNKNOWN, distDays: null, distList: [], score: null, breadth: breadth || null };
  }

  const closes = indexBars.map((b) => b.close);
  const lastClose = closes.at(-1);
  const s20 = sma(closes, 20).at(-1);
  const s50 = sma(closes, 50).at(-1);
  const s200 = sma(closes, 200).at(-1);

  // Ngày phân phối so khối lượng hai phiên: bỏ nến trong phiên (khối lượng mới là một phần) để không đếm thiếu
  const settled = indexBars.at(-1)?.partial ? indexBars.slice(0, -1) : indexBars;
  const { count: distCount, days: distDays } = countDistributionDays(settled, 25);

  const aboveMa20 = s20 != null && lastClose > s20;
  const aboveMa50 = s50 != null && lastClose > s50;
  const aboveMa200 = s200 != null && lastClose > s200;
  const ma20AboveMa50 = s20 != null && s50 != null && s20 > s50;

  // Tính điểm sức khỏe thị trường 0 - 100
  let healthScore = 50;
  if (aboveMa20) healthScore += 15; else healthScore -= 15;
  if (aboveMa50) healthScore += 20; else healthScore -= 20;
  if (aboveMa200) healthScore += 10; else healthScore -= 10;
  if (ma20AboveMa50) healthScore += 10; else healthScore -= 10;

  // Trừ điểm theo ngày phân phối
  healthScore -= distCount * 7;

  // Điểm cộng/trừ từ độ rộng
  if (breadth) {
    if (breadth.pctAboveMa50 >= 60) healthScore += 10;
    else if (breadth.pctAboveMa50 < 35) healthScore -= 15;
  }

  healthScore = Math.max(0, Math.min(100, healthScore));

  let selectedRegime;
  if (distCount >= 5 || (!aboveMa50 && distCount >= 3) || healthScore < 35) {
    selectedRegime = REGIMES.MARKET_CORRECTION;
  } else if (distCount >= 3 || !aboveMa20 || healthScore < 60) {
    selectedRegime = REGIMES.UPTREND_UNDER_PRESSURE;
  } else {
    selectedRegime = REGIMES.CONFIRMED_UPTREND;
  }

  return {
    regime: selectedRegime.code,
    ...selectedRegime,
    score: healthScore,
    lastIndexClose: Math.round(lastClose * 100) / 100,
    aboveMa20,
    aboveMa50,
    aboveMa200,
    distDays: distCount,
    distList: distDays,
    breadth: breadth || null,
  };
}

let cachedRegime = null;
let lastRegimeFetch = 0;
const REGIME_CACHE_TTL = 5 * 60 * 1000; // 5 phút

/**
 * Lấy trạng thái chế độ thị trường hiện tại (có cache).
 */
export async function getMarketRegime({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedRegime && now - lastRegimeFetch < REGIME_CACHE_TTL) {
    return cachedRegime;
  }

  try {
    const { bars: indexBars } = await getPriceHistory('VNINDEX', 300);
    // Độ rộng tính trên cả rổ đang xếp hạng (không dùng danh sách mã lớn chọn sẵn); lỗi thì bỏ qua phần độ rộng
    const breadth = await boardBreadth().catch(() => null);
    const result = evaluateMarketRegime(indexBars, breadth);
    // Kết quả UNKNOWN không cache để lần gọi sau thử lại
    if (result.regime !== REGIMES.UNKNOWN.code) {
      cachedRegime = result;
      lastRegimeFetch = now;
    }
    return result;
  } catch (err) {
    // Fail-closed: không có dữ liệu thì không cho mua mới
    return { regime: REGIMES.UNKNOWN.code, ...REGIMES.UNKNOWN, score: null, distDays: null, distList: [], breadth: null, error: err.message };
  }
}

/** Tỷ lệ mã trên MA20 / MA50 trong rổ xếp hạng. Nạp khi cần: ranking.js nằm trong vòng import analyze → regime. */
async function boardBreadth() {
  const { getRankBoard } = await import('./ranking.js');
  const rows = (await getRankBoard()).rows.filter((r) => r.trend?.aboveMa50 != null);
  if (rows.length < 30) return null;
  const share = (k) => Math.round((rows.filter((r) => r.trend[k]).length / rows.length) * 100);
  return { total: rows.length, pctAboveMa20: share('aboveMa20'), pctAboveMa50: share('aboveMa50') };
}
