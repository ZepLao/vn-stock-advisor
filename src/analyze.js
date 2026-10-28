// Tổng hợp phân tích kỹ thuật + cơ bản + tin tức thành khuyến nghị.
import { getPriceHistory, getFundamentals, getCompanyInfo, getForeignFlow, getMarketMovers, avgTradedValue, screenCriteria, projectedVolume } from './data.js';
import { getStockNews, getMarketNews, aggregateSentiment, attachPriceReaction, summarizeCategories } from './news.js';
import { sma, rsi, macd, bollinger, atr, pctChange, stochastic, adx, mfi, obv, rsiDivergence } from './indicators.js';
import { rankSymbol, trendFeatures } from './ranking.js';
import { recordMany } from './predictions.js';
import { getSectorFlows } from './sectors.js';
import { getOrderFlow } from './orderflow.js';
import { coneSummary, monteCarloForecast } from './forecast.js';
import { detectStockRisk } from './risk.js';
import { getMarketRegime } from './regime.js';
import { buildDynamicTrailingPlan } from './tradeplan.js';
import { getCompanyProfile } from './company.js';
import { buildBrief } from './brief.js';
import { aiFilterNews } from './newsai.js';
import { checkDataQuality } from './dataquality.js';
import { accountCapital, portfolioHeat } from './sizing.js';

const RULE_DIRECTION = { BUY: 1, ACCUMULATE: 1, HOLD: 0, AVOID: -1, SELL: -1 };

export const INDEXES = new Set(['VNINDEX', 'VN30', 'HNXINDEX', 'HNX30', 'UPCOMINDEX']);
const INDEX_FLOOR = { VNINDEX: 'HOSE', VN30: 'HOSE', HNXINDEX: 'HNX', HNX30: 'HNX', UPCOMINDEX: 'UPCOM' };

const WEIGHTS = { technical: 0.4, fundamental: 0.35, news: 0.25 };

// Từ khóa tin rủi ro nghiêm trọng: xuất hiện trong 7 ngày thì không khuyến nghị mua
const RED_FLAGS = ['khởi tố', 'bắt giam', 'bị bắt', 'hủy niêm yết', 'đình chỉ giao dịch', 'điều tra',
  'thao túng', 'lừa đảo', 'phá sản', 'vỡ nợ', 'diện cảnh báo', 'diện kiểm soát', 'hạn chế giao dịch',
  'giải chấp', 'call margin'];

export const RECOMMENDATIONS = [
  { min: 35, code: 'BUY', label: 'NÊN MUA', desc: 'Nhiều yếu tố cùng ủng hộ, có thể giải ngân theo kế hoạch.' },
  { min: 15, code: 'ACCUMULATE', label: 'CÂN NHẮC MUA', desc: 'Tín hiệu nghiêng về tích cực, có thể mua thăm dò với tỷ trọng nhỏ.' },
  { min: -15, code: 'HOLD', label: 'THEO DÕI', desc: 'Tín hiệu trái chiều, chưa có lợi thế rõ ràng. Chờ thêm xác nhận.' },
  { min: -35, code: 'AVOID', label: 'CHƯA NÊN MUA', desc: 'Nhiều yếu tố bất lợi, nên đứng ngoài.' },
  { min: -Infinity, code: 'SELL', label: 'TRÁNH / BÁN', desc: 'Tín hiệu tiêu cực mạnh. Người đang nắm giữ nên cân nhắc hạ tỷ trọng.' },
];

const REC = Object.fromEntries(RECOMMENDATIONS.map((r) => [r.code, r]));

/**
 * Khuyến nghị dựa trên điểm xếp hạng 4 yếu tố. Nghiên cứu cũ (nhóm ≥ 70 và trên MA200 vượt VN-Index +0,7–0,9%/20 phiên,
 * nhóm ≥ 70 dưới MA200 thua 1–1,5%) chạy trên rổ HIỆN TẠI nên có thiên lệch sống sót: không trích các con số đó cho
 * người dùng như sự thật; kết quả đối chiếu là backtest danh mục với rổ theo thời điểm (runRankPortfolio).
 * Tích hợp bộ lọc rủi ro sụt giảm (Laban risk detection) và phân phối xác suất Monte Carlo.
 */
export function rankRecommendation(r, { flagged = false, losing = false, liquid = true, stockRisk = null, mc = null, marketRegime = null } = {}) {
  const above = r.aboveMa200 !== false;
  let rec;
  if (r.score >= 70 && above) {
    let desc = `Điểm xếp hạng ${r.score} (hạng ${r.position}/${r.universe}) và giá trên MA200: thuộc nhóm dẫn đầu về động lượng và xu hướng. Hiệu quả lịch sử của nhóm này xem ở Backtest danh mục (rổ theo thời điểm); quá khứ không đảm bảo tương lai.`;
    if (mc) {
      desc += ` Rủi ro 20 phiên (mô phỏng, không tính xu hướng): xác suất có lúc lỗ ≥ 7% là ${Math.round(mc.probLoss7 * 100)}%, mức sụt trung vị ${mc.troughDdMedian}%.`;
    }
    rec = { ...REC.BUY, desc };
    if (flagged) rec = { ...REC.HOLD, desc: 'Thuộc nhóm dẫn đầu nhưng có tin rủi ro nghiêm trọng trong 7 ngày: chờ làm rõ trước khi mua.' };
    else if (losing) rec = { ...REC.HOLD, desc: 'Thuộc nhóm dẫn đầu về giá nhưng doanh nghiệp đang lỗ 4 quý gần nhất: chỉ theo dõi.' };
    else if (!liquid) rec = { ...REC.ACCUMULATE, desc: 'Thuộc nhóm dẫn đầu nhưng thanh khoản dưới ngưỡng 5 tỷ/phiên: chỉ mua tỷ trọng nhỏ.' };
  } else if (r.score >= 70) {
    rec = { ...REC.AVOID, desc: `Điểm xếp hạng cao (${r.score}) nhưng giá dưới MA200: trong nghiên cứu trước nhóm này thường kém VN-Index. Chờ giá vượt MA200.` };
  } else if (r.score >= 30) {
    rec = { ...REC.HOLD, desc: `Điểm xếp hạng ${r.score} (hạng ${r.position}/${r.universe}): nhóm giữa, chưa có lợi thế rõ so với thị trường.` };
  } else {
    rec = { ...REC.AVOID, desc: `Điểm xếp hạng ${r.score} (hạng ${r.position}/${r.universe}): nhóm đội sổ về động lượng, xu hướng và độ ổn định. Trong nghiên cứu trước nhóm này thường kém VN-Index; đây là so với thị trường, phiên cả thị trường tăng mạnh mã vẫn có thể tăng.` };
  }

  // Chặn dao rơi / sụt giảm mạnh (tham khảo Laban _detect_stock_risk)
  if (stockRisk?.isRisky) {
    if (stockRisk.riskLevel === 'CRITICAL' || r.score < 50) {
      rec = { ...REC.SELL, desc: `RỦI RO CAO: ${stockRisk.reasons.join(', ')}. Tuyệt đối tránh bắt dao rơi, ưu tiên quản trị vốn.` };
    } else {
      rec = { ...REC.HOLD, desc: `CẢNH BÁO RỦI RO: ${stockRisk.reasons.join(', ')}. Tạm hoãn mua mới cho đến khi đà rơi chững lại.` };
    }
  } else if (r.score < 30 && (flagged || losing)) {
    rec = { ...REC.SELL, desc: `Nhóm đội sổ (điểm ${r.score}) kèm ${flagged ? 'tin rủi ro nghiêm trọng' : 'doanh nghiệp đang lỗ'}: người đang nắm giữ nên cân nhắc hạ tỷ trọng.` };
  } else if (['BUY', 'ACCUMULATE'].includes(rec.code) && marketRegime && !marketRegime.allowNewBuys) {
    const why = marketRegime.distDays != null ? `${marketRegime.label}, ${marketRegime.distDays} ngày phân phối` : marketRegime.label;
    rec = {
      ...REC.HOLD,
      desc: `Cổ phiếu tốt (${r.score} điểm) nhưng thị trường chung không cho mua mới (${why}). Tạm hoãn mua mới, ưu tiên bảo toàn vốn.`,
    };
  }
  return rec;
}

const clamp = (v, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, v));
const last = (arr) => arr[arr.length - 1];
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function signal(list, points, text) {
  list.push({ points, text });
  return points;
}

// Tổng điểm thô của các tín hiệu kỹ thuật có thể vượt ±150; nhân hệ số để đưa về thang ±100
const TECH_SCALE = 0.75;

export function technicalAnalysis(bars, market, { indexBars = null, foreign = null } = {}) {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);
  const n = closes.length;
  const close = closes[n - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const a = atr(bars, 14);
  const vol20 = sma(vols, 20);
  const signals = [];
  let sum = 0;

  const v20 = last(s20), v50 = last(s50), v200 = last(s200);
  if (v20 != null) sum += close > v20
    ? signal(signals, 10, 'Giá nằm trên MA20: xu hướng ngắn hạn tăng')
    : signal(signals, -10, 'Giá nằm dưới MA20: xu hướng ngắn hạn yếu');
  if (v20 != null && v50 != null) sum += v20 > v50
    ? signal(signals, 10, 'MA20 trên MA50: xu hướng trung hạn tăng')
    : signal(signals, -10, 'MA20 dưới MA50: xu hướng trung hạn giảm');
  if (v50 != null && v200 != null) sum += v50 > v200
    ? signal(signals, 15, 'MA50 trên MA200: xu hướng dài hạn tăng')
    : signal(signals, -15, 'MA50 dưới MA200: xu hướng dài hạn giảm');
  if (v200 != null) sum += close > v200
    ? signal(signals, 10, 'Giá trên MA200')
    : signal(signals, -10, 'Giá dưới MA200, chưa thoát xu hướng giảm dài hạn');

  const rv = last(r);
  if (rv != null) {
    if (rv < 30) sum += signal(signals, 15, `RSI ${rv.toFixed(0)} < 30: vùng quá bán, khả năng hồi phục kỹ thuật`);
    else if (rv > 70) sum += signal(signals, -15, `RSI ${rv.toFixed(0)} > 70: vùng quá mua, rủi ro điều chỉnh`);
    else if (rv >= 50) sum += signal(signals, 5, `RSI ${rv.toFixed(0)}: động lượng tích cực`);
    else sum += signal(signals, -5, `RSI ${rv.toFixed(0)}: động lượng yếu`);
  }

  const h = m.hist;
  const hNow = h[n - 1], hPrev = h[n - 2];
  if (hNow != null) {
    sum += hNow > 0
      ? signal(signals, 10, 'MACD nằm trên đường tín hiệu')
      : signal(signals, -10, 'MACD nằm dưới đường tín hiệu');
    const crossedUp = [1, 2, 3].some((k) => h[n - k] > 0 && h[n - k - 1] <= 0);
    const crossedDown = [1, 2, 3].some((k) => h[n - k] < 0 && h[n - k - 1] >= 0);
    if (crossedUp) sum += signal(signals, 10, 'MACD vừa cắt lên đường tín hiệu (tín hiệu mua)');
    else if (crossedDown) sum += signal(signals, -10, 'MACD vừa cắt xuống đường tín hiệu (tín hiệu bán)');
    else if (hPrev != null && hNow > hPrev && hNow < 0) sum += signal(signals, 3, 'Histogram MACD đang thu hẹp phần âm');
  }

  const lo = last(bb.lower), up = last(bb.upper);
  if (lo != null && close < lo) sum += signal(signals, 5, 'Giá thủng dải Bollinger dưới: có thể bị bán quá đà');
  if (up != null && close > up) sum += signal(signals, -5, 'Giá vượt dải Bollinger trên: dễ rung lắc');

  const vAvg = last(vol20);
  const prevClose = closes[n - 2];
  // Nến trong phiên: so khối lượng ước tính cả phiên với TB20 (khối lượng một phần luôn thấp hơn phiên đủ)
  const lastBar = bars[n - 1];
  const volNow = projectedVolume(lastBar);
  const est = lastBar.partial ? ' (ước tính cả phiên)' : '';
  if (vAvg && volNow > 1.5 * vAvg) {
    const ratio = (volNow / vAvg).toFixed(1);
    sum += close >= prevClose
      ? signal(signals, 10, `Khối lượng gấp ${ratio} lần TB20${est} trong phiên tăng: dòng tiền vào mạnh`)
      : signal(signals, -10, `Khối lượng gấp ${ratio} lần TB20${est} trong phiên giảm: áp lực bán mạnh`);
  }

  const ret20 = pctChange(closes, 20);
  if (ret20 != null) {
    if (ret20 > 10) sum += signal(signals, 5, `Tăng ${ret20.toFixed(1)}% trong 20 phiên`);
    else if (ret20 < -10) sum += signal(signals, -5, `Giảm ${Math.abs(ret20).toFixed(1)}% trong 20 phiên`);
  }

  // --- Độ mạnh xu hướng (ADX) ---
  const dmi = adx(bars, 14);
  const adxV = last(dmi.adx), pDI = last(dmi.plusDI), mDI = last(dmi.minusDI);
  if (adxV != null) {
    if (adxV >= 25 && pDI > mDI) sum += signal(signals, 10, `ADX ${adxV.toFixed(0)} và +DI > −DI: xu hướng tăng mạnh`);
    else if (adxV >= 25 && mDI > pDI) sum += signal(signals, -10, `ADX ${adxV.toFixed(0)} và −DI > +DI: xu hướng giảm mạnh`);
    else if (adxV < 20) signal(signals, 0, `ADX ${adxV.toFixed(0)} < 20: chưa có xu hướng rõ, tín hiệu MA kém tin cậy`);
  }

  // --- Stochastic ---
  const st = stochastic(bars);
  const kNow = last(st.k), dNow = last(st.d), kPrev = st.k[n - 2], dPrev = st.d[n - 2];
  if (kNow != null && dNow != null) {
    const crossUp = kPrev != null && dPrev != null && kPrev <= dPrev && kNow > dNow;
    const crossDown = kPrev != null && dPrev != null && kPrev >= dPrev && kNow < dNow;
    if (kNow < 20 && crossUp) sum += signal(signals, 10, `Stochastic ${kNow.toFixed(0)} cắt lên trong vùng quá bán: tín hiệu mua sớm`);
    else if (kNow < 20) sum += signal(signals, 4, `Stochastic ${kNow.toFixed(0)}: vùng quá bán`);
    else if (kNow > 80 && crossDown) sum += signal(signals, -10, `Stochastic ${kNow.toFixed(0)} cắt xuống trong vùng quá mua: tín hiệu bán sớm`);
    else if (kNow > 80) sum += signal(signals, -4, `Stochastic ${kNow.toFixed(0)}: vùng quá mua`);
  }

  // --- Dòng tiền theo khối lượng (MFI, OBV) ---
  const mf = last(mfi(bars, 14));
  if (mf != null) {
    if (mf < 20) sum += signal(signals, 8, `MFI ${mf.toFixed(0)} < 20: dòng tiền bị rút quá mức, dễ hồi phục`);
    else if (mf > 80) sum += signal(signals, -8, `MFI ${mf.toFixed(0)} > 80: dòng tiền vào quá nóng`);
  }
  const ob = obv(bars);
  const obSma = sma(ob, 20);
  const obvUp = last(obSma) != null ? last(ob) > last(obSma) : null;
  if (obvUp != null) {
    sum += obvUp
      ? signal(signals, 5, 'OBV trên trung bình 20 phiên: khối lượng đang tích lũy')
      : signal(signals, -5, 'OBV dưới trung bình 20 phiên: khối lượng đang phân phối');
  }

  // --- Phân kỳ RSI ---
  const div = rsiDivergence(closes, r);
  if (div === 'bullish') sum += signal(signals, 10, 'Phân kỳ dương RSI: giá tạo đáy thấp hơn nhưng RSI đáy cao hơn, lực bán yếu dần');
  else if (div === 'bearish') sum += signal(signals, -10, 'Phân kỳ âm RSI: giá tạo đỉnh cao hơn nhưng RSI đỉnh thấp hơn, lực mua yếu dần');

  // --- Sức mạnh tương đối so với VN-Index ---
  let rs20 = null, rs60 = null;
  if (indexBars?.length) {
    const ic = indexBars.map((b) => b.close);
    const i20 = pctChange(ic, 20), i60 = pctChange(ic, 60);
    rs20 = ret20 != null && i20 != null ? ret20 - i20 : null;
    const r60 = pctChange(closes, 60);
    rs60 = r60 != null && i60 != null ? r60 - i60 : null;
    if (rs20 != null) {
      if (rs20 > 5) sum += signal(signals, 6, `Mạnh hơn VN-Index ${rs20.toFixed(1)} điểm % trong 20 phiên`);
      else if (rs20 < -5) sum += signal(signals, -6, `Yếu hơn VN-Index ${Math.abs(rs20).toFixed(1)} điểm % trong 20 phiên`);
    }
  }

  // --- Khối ngoại ---
  let flow = null;
  if (foreign?.length) {
    const sumNet = (k) => foreign.slice(0, k).reduce((s, d) => s + (d.netVal || 0), 0);
    const net5 = sumNet(5), net20 = sumNet(20);
    const buyDays5 = foreign.slice(0, 5).filter((d) => d.netVal > 0).length;
    // So với giá trị khớp lệnh 20 phiên (giá nghìn đồng → nhân 1000)
    const traded20 = (vAvg || 0) * close * 1000 * Math.min(20, foreign.length);
    const ratio = traded20 ? net20 / traded20 : 0;
    flow = { net1: foreign[0].netVal, net5, net20, buyDays5, ratio20: round(ratio * 100, 2), days: foreign.length };
    const ty = (v) => `${(v / 1e9).toFixed(1)} tỷ`;
    if (ratio > 0.03) sum += signal(signals, 8, `Khối ngoại mua ròng ${ty(net20)} trong 20 phiên (${(ratio * 100).toFixed(1)}% giá trị giao dịch)`);
    else if (ratio < -0.03) sum += signal(signals, -8, `Khối ngoại bán ròng ${ty(-net20)} trong 20 phiên (${(-ratio * 100).toFixed(1)}% giá trị giao dịch)`);
    if (buyDays5 >= 4) sum += signal(signals, 4, `Khối ngoại mua ròng ${buyDays5}/5 phiên gần nhất (${ty(net5)})`);
    else if (buyDays5 <= 1) sum += signal(signals, -4, `Khối ngoại bán ròng ${5 - buyDays5}/5 phiên gần nhất (${ty(net5)})`);
  }

  if (market?.trend === 'up') sum += signal(signals, 5, 'Thị trường chung (VN-Index) đang trong xu hướng tăng');
  else if (market?.trend === 'down') sum += signal(signals, -5, 'Thị trường chung (VN-Index) đang yếu');

  // Vùng giá tham khảo
  const recent = bars.slice(-20);
  const atrV = last(a);
  const support = Math.min(...recent.map((b) => b.low));
  const resistance = Math.max(...recent.map((b) => b.high));
  const plan = atrV ? {
    support: round(support),
    resistance: round(resistance),
    stopLoss: round(Math.max(close - 2 * atrV, support * 0.97)),
    target: round(Math.max(close + 3 * atrV, resistance)),
    atr: round(atrV),
  } : null;
  if (plan) plan.riskReward = round((plan.target - close) / Math.max(close - plan.stopLoss, 1e-9), 1);

  const indicators = {
    sma20: round(v20), sma50: round(v50), sma200: round(v200), rsi14: round(rv, 1),
    macd: round(last(m.line), 3), macdSignal: round(last(m.signal), 3), macdHist: round(hNow, 3),
    bbUpper: round(up), bbLower: round(lo), atr14: round(atrV),
    volume: vols[n - 1], avgVolume20: Math.round(vAvg || 0),
    avgVolume5: Math.round(last(sma(vols, 5)) || 0),
    return5d: round(pctChange(closes, 5), 1), return20d: round(ret20, 1),
    return60d: round(pctChange(closes, 60), 1), return250d: round(pctChange(closes, 250), 1),
    adx14: round(adxV, 1), plusDI: round(pDI, 1), minusDI: round(mDI, 1),
    stochK: round(kNow, 1), stochD: round(dNow, 1), mfi14: round(mf, 1),
    obvTrend: obvUp == null ? null : obvUp ? 'up' : 'down', rsiDivergence: div,
    rs20: round(rs20, 1), rs60: round(rs60, 1),
  };

  return {
    score: Math.round(clamp(sum * TECH_SCALE)),
    signals,
    indicators,
    flow,
    overview: buildOverview({ close, v20, v50, v200, indicators, flow, market }),
    plan,
    series: { sma20: s20, sma50: s50, sma200: s200 },
  };
}

/**
 * Bảng tổng hợp nhanh: mỗi khía cạnh một nhận định ngắn (tone: up/down/ref).
 * Kết hợp nhiều chỉ báo để tránh dựa vào một tín hiệu đơn lẻ.
 */
function buildOverview({ close, v20, v50, v200, indicators: i, flow, market }) {
  const rows = [];
  const add = (key, label, tone, verdict, detail) => rows.push({ key, label, tone, verdict, detail });

  // Xu hướng: vị trí MA + ADX
  const above = [v20, v50, v200].filter((v) => v != null && close > v).length;
  const maCount = [v20, v50, v200].filter((v) => v != null).length;
  const strong = i.adx14 != null && i.adx14 >= 25;
  const weak = i.adx14 != null && i.adx14 < 20;
  let trendTone = 'ref', trendVerdict = 'Đi ngang';
  if (above === maCount && maCount) { trendTone = 'up'; trendVerdict = strong ? 'Tăng mạnh' : 'Tăng'; }
  else if (above === 0 && maCount) { trendTone = 'down'; trendVerdict = strong ? 'Giảm mạnh' : 'Giảm'; }
  else if (above >= 2) { trendTone = 'up'; trendVerdict = 'Hồi phục / tăng yếu'; }
  else if (above === 1) { trendTone = 'down'; trendVerdict = 'Suy yếu'; }
  if (weak && trendVerdict !== 'Đi ngang') trendVerdict += ' (ADX thấp, xu hướng chưa chắc)';
  add('trend', 'Xu hướng', trendTone, trendVerdict,
    `Giá trên ${above}/${maCount} đường MA (20/50/200) · ADX ${i.adx14 ?? '–'} · +DI ${i.plusDI ?? '–'} / −DI ${i.minusDI ?? '–'}`);

  // Động lượng: RSI + MACD + Stochastic
  let mom = 0;
  if (i.rsi14 != null) mom += i.rsi14 >= 55 ? 1 : i.rsi14 <= 45 ? -1 : 0;
  if (i.macdHist != null) mom += i.macdHist > 0 ? 1 : -1;
  if (i.stochK != null && i.stochD != null) mom += i.stochK > i.stochD ? 1 : -1;
  let momVerdict = mom >= 2 ? 'Tích cực' : mom <= -2 ? 'Tiêu cực' : 'Trung tính';
  if (i.rsi14 > 70 || i.stochK > 80) momVerdict += ' · quá mua';
  if (i.rsi14 < 30 || i.stochK < 20) momVerdict += ' · quá bán';
  if (i.rsiDivergence === 'bullish') momVerdict += ' · phân kỳ dương';
  if (i.rsiDivergence === 'bearish') momVerdict += ' · phân kỳ âm';
  add('momentum', 'Động lượng', mom >= 2 ? 'up' : mom <= -2 ? 'down' : 'ref', momVerdict,
    `RSI ${i.rsi14 ?? '–'} · MACD hist ${i.macdHist ?? '–'} · Stoch %K ${i.stochK ?? '–'} / %D ${i.stochD ?? '–'}`);

  // Dòng tiền: MFI + OBV + khối lượng 5 phiên so với 20 phiên
  const volRatio = i.avgVolume20 ? i.avgVolume5 / i.avgVolume20 : null;
  let money = 0;
  if (i.obvTrend) money += i.obvTrend === 'up' ? 1 : -1;
  if (i.mfi14 != null) money += i.mfi14 >= 55 ? 1 : i.mfi14 <= 45 ? -1 : 0;
  add('money', 'Dòng tiền', money >= 1 ? 'up' : money <= -1 ? 'down' : 'ref',
    money >= 1 ? 'Đang vào' : money <= -1 ? 'Đang rút ra' : 'Cân bằng',
    `MFI ${i.mfi14 ?? '–'} · OBV ${i.obvTrend === 'up' ? 'tích lũy' : i.obvTrend === 'down' ? 'phân phối' : '–'} · KL 5 phiên = ${volRatio ? (volRatio * 100).toFixed(0) : '–'}% TB20`);

  if (flow) {
    const ty = (v) => `${v >= 0 ? '+' : ''}${(v / 1e9).toFixed(1)} tỷ`;
    add('foreign', 'Khối ngoại', flow.net20 > 0 ? 'up' : flow.net20 < 0 ? 'down' : 'ref',
      flow.net20 > 0 ? 'Mua ròng' : flow.net20 < 0 ? 'Bán ròng' : 'Cân bằng',
      `Phiên gần nhất ${ty(flow.net1)} · 5 phiên ${ty(flow.net5)} (${flow.buyDays5}/5 phiên mua) · 20 phiên ${ty(flow.net20)}`);
  }

  if (i.rs20 != null) {
    add('rs', 'So với VN-Index', i.rs20 > 2 ? 'up' : i.rs20 < -2 ? 'down' : 'ref',
      i.rs20 > 2 ? 'Mạnh hơn thị trường' : i.rs20 < -2 ? 'Yếu hơn thị trường' : 'Tương đương thị trường',
      `20 phiên ${i.rs20 > 0 ? '+' : ''}${i.rs20} điểm % · 60 phiên ${i.rs60 != null ? `${i.rs60 > 0 ? '+' : ''}${i.rs60}` : '–'} điểm %`);
  }

  if (market) {
    add('market', 'Thị trường chung', market.trend === 'up' ? 'up' : market.trend === 'down' ? 'down' : 'ref',
      { up: 'Xu hướng tăng', down: 'Xu hướng giảm', sideways: 'Đi ngang' }[market.trend],
      `VN-Index ${market.close} (${market.changePct > 0 ? '+' : ''}${market.changePct}%)`);
  }
  return rows;
}

export function fundamentalAnalysis(f) {
  const signals = [];
  let sum = 0;
  let used = 0;

  if (f.epsTTM != null && f.epsTTM <= 0) {
    used++;
    sum += signal(signals, -20, 'Lợi nhuận 4 quý gần nhất âm (doanh nghiệp đang lỗ)');
  } else if (f.pe != null && f.pe > 0) {
    used++;
    const pe = f.pe.toFixed(1);
    if (f.pe < 8) sum += signal(signals, 20, `P/E ${pe}: định giá rẻ`);
    else if (f.pe < 12) sum += signal(signals, 12, `P/E ${pe}: định giá hấp dẫn`);
    else if (f.pe < 18) sum += signal(signals, 3, `P/E ${pe}: định giá hợp lý`);
    else if (f.pe < 25) sum += signal(signals, -5, `P/E ${pe}: định giá khá cao`);
    else sum += signal(signals, -15, `P/E ${pe}: định giá đắt`);
  }

  if (f.pb != null && f.pb > 0) {
    used++;
    const pb = f.pb.toFixed(2);
    if (f.pb < 1) sum += signal(signals, 10, `P/B ${pb} < 1: giá dưới giá trị sổ sách`);
    else if (f.pb < 2) sum += signal(signals, 5, `P/B ${pb}: hợp lý`);
    else if (f.pb > 3.5) sum += signal(signals, -8, `P/B ${pb}: cao so với giá trị sổ sách`);
  }

  if (f.roe != null) {
    used++;
    if (f.roe >= 0.2) sum += signal(signals, 20, `ROE ${pct(f.roe)}: hiệu quả sử dụng vốn xuất sắc`);
    else if (f.roe >= 0.15) sum += signal(signals, 12, `ROE ${pct(f.roe)}: hiệu quả tốt`);
    else if (f.roe >= 0.1) sum += signal(signals, 3, `ROE ${pct(f.roe)}: trung bình`);
    else if (f.roe >= 0) sum += signal(signals, -8, `ROE ${pct(f.roe)}: thấp`);
    else sum += signal(signals, -20, `ROE ${pct(f.roe)}: âm`);
  }

  if (f.profitGrowthTTM != null) {
    used++;
    const g = f.profitGrowthTTM;
    if (g >= 0.25) sum += signal(signals, 20, `Lợi nhuận 4 quý tăng ${pct(g)} so với cùng kỳ`);
    else if (g >= 0.1) sum += signal(signals, 10, `Lợi nhuận 4 quý tăng ${pct(g)} so với cùng kỳ`);
    else if (g >= 0) sum += signal(signals, 3, `Lợi nhuận 4 quý tăng nhẹ ${pct(g)}`);
    else if (g >= -0.15) sum += signal(signals, -8, `Lợi nhuận 4 quý giảm ${pct(-g)}`);
    else sum += signal(signals, -18, `Lợi nhuận 4 quý giảm mạnh ${pct(-g)}`);
  }

  if (f.revenueGrowthTTM != null) {
    used++;
    const g = f.revenueGrowthTTM;
    if (g >= 0.15) sum += signal(signals, 10, `Doanh thu 4 quý tăng ${pct(g)}`);
    else if (g >= 0) sum += signal(signals, 3, `Doanh thu 4 quý tăng ${pct(g)}`);
    else sum += signal(signals, -8, `Doanh thu 4 quý giảm ${pct(-g)}`);
  }

  if (f.debtToEquity != null) {
    used++;
    const d = f.debtToEquity.toFixed(2);
    if (f.debtToEquity > 2) sum += signal(signals, -12, `Nợ vay/Vốn chủ ${d}: đòn bẩy rất cao`);
    else if (f.debtToEquity > 1) sum += signal(signals, -5, `Nợ vay/Vốn chủ ${d}: đòn bẩy cao`);
    else if (f.debtToEquity < 0.5) sum += signal(signals, 5, `Nợ vay/Vốn chủ ${d}: tài chính lành mạnh`);
  }

  if (f.dividendYield != null && f.dividendYield >= 0.03) {
    sum += f.dividendYield >= 0.05
      ? signal(signals, 8, `Tỷ suất cổ tức ${pct(f.dividendYield)}: cao`)
      : signal(signals, 4, `Tỷ suất cổ tức ${pct(f.dividendYield)}`);
  }

  return { score: used ? Math.round(clamp(sum)) : null, signals, data: f };
}

export async function marketContext() {
  const { bars } = await getPriceHistory('VNINDEX', 550);
  const closes = bars.map((b) => b.close);
  const s50 = last(sma(closes, 50));
  const s20 = last(sma(closes, 20));
  const s200 = last(sma(closes, 200));
  const close = last(closes);
  const prev = closes[closes.length - 2];
  const trend = close > s50 && s20 > s50 ? 'up' : close < s50 && s20 < s50 ? 'down' : 'sideways';
  return {
    close, change: round(close - prev), changePct: round(((close - prev) / prev) * 100),
    date: last(bars).time, trend,
    ma50: round(s50), ma200: round(s200), aboveMa200: s200 != null ? close > s200 : null,
    return20d: round(pctChange(closes, 20), 1),
  };
}

export async function getMarketOverview() {
  const [market, news] = await Promise.all([marketContext(), getMarketNews()]);
  return { ...market, news: aggregateSentiment(news), items: news };
}

/**
 * Phân tích đầy đủ một mã.
 * @param {string} symbol
 * @param {{ withChart?: boolean }} opts
 */
export async function analyzeSymbol(symbol, { withChart = true } = {}) {
  symbol = String(symbol).trim().toUpperCase();
  if (!/^[A-Z0-9]{3,10}$/.test(symbol)) throw new Error('Mã chứng khoán không hợp lệ');
  const isIndex = INDEXES.has(symbol);
  const { floors } = screenCriteria();
  // Chỉ số của sàn không được theo dõi (HNX-Index, UPCoM-Index) cũng bị chặn
  if (isIndex && !floors.some((f) => INDEX_FLOOR[symbol] === f)) {
    throw new Error(`Tool chỉ theo dõi sàn ${floors.join(', ')}: không phân tích ${symbol}`);
  }

  // Dòng tiền ngành 5 phiên: chạy song song, dùng cho phần tóm tắt nhanh
  const sectorP = isIndex ? null : getSectorFlows(5).catch(() => null);
  const [priceRes, info, fund, market, indexRes, foreign, movers] = await Promise.all([
    getPriceHistory(symbol).catch((err) => err),
    isIndex ? null : getCompanyInfo(symbol).catch(() => undefined),
    isIndex ? null : getFundamentals(symbol).catch(() => null),
    marketContext().catch(() => null),
    isIndex ? null : getPriceHistory('VNINDEX').catch(() => null),
    isIndex ? null : getForeignFlow(symbol, 20).catch(() => null),
    getMarketMovers('HOSE').catch(() => null),
  ]);
  // null = API trả về rỗng (mã không tồn tại); undefined = API lỗi, vẫn thử tiếp
  if (!isIndex && info === null) throw new Error(`Không tìm thấy mã ${symbol}`);
  if (!isIndex && info?.exchange && !floors.includes(info.exchange)) {
    throw new Error(`${symbol} niêm yết trên sàn ${info.exchange}. Tool chỉ phân tích cổ phiếu sàn ${floors.join(', ')} (đổi SCREEN_FLOORS trong .env nếu muốn mở rộng).`);
  }
  if (priceRes instanceof Error) throw priceRes;

  const { bars, source } = priceRes;
  if (bars.length < 30) throw new Error(`Mã ${symbol} có quá ít dữ liệu giá (${bars.length} phiên)`);

  const newsDays = isIndex ? 7 : 30;
  let rawNews = isIndex
    ? await getMarketNews({ days: newsDays }).catch(() => [])
    : await getStockNews(symbol, { companyName: info?.name, days: newsDays }).catch(() => []);
  // AI đọc từng tin: bỏ tin không nói về mã này, chấm lại tốt/xấu, xác nhận rủi ro nghiêm trọng
  const newsFilter = isIndex ? null : await aiFilterNews(rawNews, { symbol, companyName: info?.name }).catch(() => null);
  if (newsFilter) rawNews = newsFilter.items;
  const newsItems = attachPriceReaction(rawNews, bars);
  // Dữ liệu có chuẩn không (giá cập nhật, nến tạm, nhảy giá bất thường, số liệu cơ bản cũ)
  const dataQuality = isIndex ? null : checkDataQuality(bars, {
    indexDate: indexRes?.bars?.at(-1)?.time, exchange: info?.exchange || 'HOSE', fundReportDate: fund?.reportDate || null,
  });

  const tech = technicalAnalysis(bars, isIndex ? null : market, { indexBars: indexRes?.bars, foreign });
  const ranking = isIndex ? null : await rankSymbol(symbol, bars).catch(() => null);
  // Phe mua / phe bán 10 phiên gần nhất (khối lượng, khối ngoại, tự doanh, mua/bán chủ động)
  const orderFlow = isIndex ? null : await getOrderFlow(symbol, bars, foreign).catch(() => null);
  // Dải dao động thống kê 5/10/20 phiên tới (lịch sử ~3 năm) để AI neo dự báo kịch bản
  const cone = isIndex ? null : await getPriceHistory(symbol, 1100).then((r) => coneSummary(r.bars)).catch(() => null);
  // Quét rủi ro rơi tự do và mô phỏng xác suất Monte Carlo (phương pháp Laban)
  const stockRisk = isIndex ? { isRisky: false, reasons: [], riskLevel: 'NORMAL' } : detectStockRisk(bars, symbol);
  const monteCarlo = isIndex ? null : monteCarloForecast(bars, 20, 1000, { exchange: info?.exchange, isRisky: stockRisk.isRisky });
  const fa = fund ? fundamentalAnalysis(fund) : { score: null, signals: [], data: null };
  const newsAgg = aggregateSentiment(newsItems);
  const newsSignals = [];
  if (newsAgg.count) {
    newsSignals.push({
      points: newsAgg.score,
      text: `${newsAgg.count} tin trong ${newsDays} ngày: ${newsAgg.positive} tích cực, ${newsAgg.negative} tiêu cực, ${newsAgg.neutral} trung lập`,
    });
  } else {
    newsSignals.push({ points: 0, text: `Không tìm thấy tin tức đáng chú ý trong ${newsDays} ngày` });
  }
  if (newsFilter?.checked) {
    newsSignals.push({ points: 0, text: `AI đã đọc ${newsFilter.checked} tin${newsFilter.removed.length ? `, loại ${newsFilter.removed.length} tin không nói về ${symbol}` : ''}${newsFilter.pending ? `; ${newsFilter.pending} tin chưa kịp đọc (chấm theo từ khóa)` : ''}` });
  }
  const categories = summarizeCategories(newsItems);
  // Nêu các nhóm sự kiện có tin rõ chiều (bỏ nhóm "diễn biến giá" vì chỉ mô tả lại giá)
  for (const c of categories.filter((c) => c.id !== 'price' && Math.abs(c.sentiment) >= 20)) {
    newsSignals.push({ points: 0, text: `${c.label}: ${c.count} tin, nghiêng ${c.sentiment > 0 ? 'tích cực' : 'tiêu cực'} (${c.positive} tốt / ${c.negative} xấu)` });
  }
  // Tin tích cực mà giá vẫn giảm (hoặc ngược lại) cho thấy thị trường đã/không phản ánh tin
  const reacted = newsItems.filter((i) => i.reaction && i.label !== 'trung_lap');
  const diverge = reacted.filter((i) => (i.label === 'tich_cuc' && i.reaction.pct < -1) || (i.label === 'tieu_cuc' && i.reaction.pct > 1));
  if (reacted.length >= 4 && diverge.length / reacted.length >= 0.4) {
    newsSignals.push({ points: 0, text: `${diverge.length}/${reacted.length} tin có giá phản ứng ngược chiều: thị trường đang không phản ánh theo tin` });
  }
  if (newsAgg.count) {
    tech.overview.push({
      key: 'news', label: 'Tin tức', tone: newsAgg.score > 10 ? 'up' : newsAgg.score < -10 ? 'down' : 'ref',
      verdict: newsAgg.score > 10 ? 'Tích cực' : newsAgg.score < -10 ? 'Tiêu cực' : 'Trung tính',
      detail: `${newsAgg.positive} tốt / ${newsAgg.negative} xấu / ${newsAgg.count} tin`
        + (categories.length ? ` · nổi bật: ${categories.filter((c) => c.id !== 'price').sort((a, b) => b.count - a.count).slice(0, 2).map((c) => c.label.toLowerCase()).join(', ')}` : ''),
    });
  }

  // Tổng điểm có trọng số; bỏ qua nhóm không có dữ liệu
  const parts = { technical: tech.score, fundamental: fa.score, news: newsAgg.count ? newsAgg.score : null };
  let wsum = 0, total = 0;
  for (const [k, v] of Object.entries(parts)) {
    if (v == null) continue;
    wsum += WEIGHTS[k];
    total += WEIGHTS[k] * v;
  }
  total = Math.round(wsum ? total / wsum : 0);

  const warnings = [];
  const weekAgo = Date.now() - 7 * 86_400_000;
  // Tin AI đã đọc: chỉ tính rủi ro khi AI xác nhận; tin chưa đọc: theo từ khóa như trước
  const flagged = newsItems.filter((it) => (it.publishedAt || 0) >= weekAgo
    && (it.ai ? it.ai.risk : RED_FLAGS.some((k) => it.keywords.includes(k))));
  if (flagged.length) {
    warnings.push(`Có ${flagged.length} tin rủi ro nghiêm trọng trong 7 ngày (ví dụ: "${flagged[0].title}"${flagged[0].ai ? `, AI: ${flagged[0].ai.reason}` : ''}). Cần đọc kỹ trước khi quyết định.`);
  }
  for (const q of dataQuality?.issues || []) warnings.push(`Dữ liệu: ${q.text}`);
  if (fa.data?.epsTTM != null && fa.data.epsTTM <= 0) warnings.push('Doanh nghiệp đang lỗ trong 4 quý gần nhất.');
  const ind = tech.indicators;
  if (ind.avgVolume20 && ind.avgVolume20 < 100_000 && !isIndex) {
    warnings.push(`Thanh khoản thấp (TB20 ≈ ${ind.avgVolume20.toLocaleString('vi-VN')} cp/phiên), khó mua bán khối lượng lớn.`);
  }
  if (ind.rsi14 != null && ind.rsi14 > 80) warnings.push('RSI trên 80: giá đang hưng phấn, không nên mua đuổi.');

  if (stockRisk.isRisky) {
    for (const r of stockRisk.reasons) warnings.push(`[Cảnh báo rủi ro cao] ${r}`);
  }

  // Khuyến nghị cũ theo tổng điểm: giữ để tham khảo và so sánh trong nhật ký dự đoán
  let legacyRec = RECOMMENDATIONS.find((r) => total >= r.min);
  if (flagged.length && (legacyRec.code === 'BUY' || legacyRec.code === 'ACCUMULATE')) {
    legacyRec = { ...RECOMMENDATIONS.find((r) => r.code === 'HOLD'), desc: 'Điểm số tích cực nhưng bị hạ xuống THEO DÕI do có tin rủi ro nghiêm trọng.' };
  }
  const value20 = avgTradedValue(bars);
  const marketRegime = isIndex ? null : await getMarketRegime().catch(() => null);
  if (marketRegime && marketRegime.regime === 'MARKET_CORRECTION') {
    warnings.push(`[Thị trường rủi ro] VN-Index đang điều chỉnh với ${marketRegime.distDays} ngày phân phối. Tỷ trọng cổ phiếu khuyến nghị tối đa: ${marketRegime.exposure}.`);
  } else if (marketRegime && marketRegime.regime === 'UNKNOWN') {
    warnings.push(`[Thị trường chưa rõ] ${marketRegime.desc}`);
  }

  let rec = ranking
    ? rankRecommendation(ranking, {
        flagged: flagged.length > 0,
        losing: fa.data?.epsTTM != null && fa.data.epsTTM <= 0,
        liquid: value20 >= screenCriteria().minValue,
        stockRisk,
        mc: monteCarlo,
        marketRegime,
      })
    : legacyRec;
  // Dữ liệu giá lỗi nghiêm trọng: không khuyến nghị mua dựa trên số liệu đó
  if (dataQuality?.critical && (rec.code === 'BUY' || rec.code === 'ACCUMULATE')) {
    rec = { ...RECOMMENDATIONS.find((r) => r.code === 'HOLD'), desc: `Tín hiệu tích cực nhưng dữ liệu chưa chuẩn (${dataQuality.issues.find((x) => x.level === 'critical').text}): chờ dữ liệu cập nhật.` };
  }

  // Độ tin cậy: các nhóm có cùng chiều với tổng điểm hay không
  const available = Object.values(parts).filter((v) => v != null);
  const agree = available.filter((v) => Math.sign(v) === Math.sign(total) || Math.abs(v) < 10).length;
  const confidence = available.length ? Math.round((agree / available.length) * 100) : 0;

  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const result = {
    symbol,
    isIndex,
    info: info || { symbol, name: symbol, exchange: 'INDEX' },
    updatedAt: new Date().toISOString(),
    price: {
      close: lastBar.close, open: lastBar.open, high: lastBar.high, low: lastBar.low,
      volume: lastBar.volume, date: lastBar.time, source,
      change: round(lastBar.close - prevBar.close),
      changePct: round(((lastBar.close - prevBar.close) / prevBar.close) * 100),
    },
    total,
    recommendation: { code: rec.code, label: rec.label, desc: rec.desc, confidence, basis: ranking ? 'rank' : 'legacy' },
    legacy: { total, code: legacyRec.code, label: legacyRec.label },
    value20: Math.round(value20),
    scores: parts,
    weights: WEIGHTS,
    technical: { score: tech.score, signals: tech.signals, indicators: tech.indicators },
    overview: tech.overview,
    foreign: tech.flow ? { ...tech.flow, history: foreign } : null,
    fundamental: fa,
    news: {
      ...newsAgg, signals: newsSignals, items: newsItems, categories,
      aiFilter: newsFilter ? { checked: newsFilter.checked, pending: newsFilter.pending, removed: newsFilter.removed.slice(0, 10).map((x) => ({ title: x.title, reason: x.ai.reason })) } : null,
    },
    dataQuality,
    plan: isIndex ? null : (tech.plan ? { ...tech.plan, trailing: buildDynamicTrailingPlan(bars, { entryPrice: lastBar.close, baseStop: tech.plan.stopLoss }) } : null),
    market,
    marketRegime,
    // Mua bán toàn sàn HOSE trong phiên gần nhất: độ rộng và khối ngoại
    marketFlow: movers ? {
      floor: movers.floor, date: movers.date, ...movers.breadth, foreign: movers.foreignTotal,
      topForeignBuy: movers.foreignBuy.slice(0, 5).map((s) => s.symbol),
      topForeignSell: movers.foreignSell.slice(0, 5).map((s) => s.symbol),
    } : null,
    warnings,
    ranking,
    stockRisk,
    monteCarlo,
    trend: ranking?.trend ?? (isIndex ? null : trendFeatures(bars)),
    trendPick: ranking?.trendPick ?? false,
    orderFlow,
    cone,
    recentBars: bars.slice(-60),
  };

  // Tóm tắt nhanh: kết luận, việc nên làm, lý do ngắn, mức giá, rủi ro
  if (!isIndex) {
    const flows = await sectorP;
    const k = flows?.sectors.findIndex((s) => s.stocks.some((x) => x.symbol === symbol)) ?? -1;
    result.sector = k >= 0 ? {
      name: flows.sectors[k].name, net: flows.sectors[k].net, rank: k + 1, total: flows.sectors.length, period: flows.period,
    } : null;
    // Hồ sơ doanh nghiệp: KQKD 12 quý, định giá so với lịch sử và ngành, sự kiện, cổ đông lớn, khuyến nghị CTCK
    result.company = await getCompanyProfile(symbol, {
      peers: k >= 0 ? flows.sectors[k].stocks.map((x) => x.symbol) : [],
      financial: /ngân hàng|chứng khoán|bảo hiểm|tài chính/i.test(result.sector?.name || ''),
    }).catch(() => null);
    // Nạp khi cần để tránh vòng lặp import analyze → portfolio → backtest → analyze
    const { getHolding, getOpenRisk } = await import('./portfolio.js');
    result.holding = await getHolding(symbol, lastBar.close).catch(() => null);
    result.brief = buildBrief(result, result.sector, result.holding, bars, await sizingContext(symbol, k >= 0 ? flows.sectors[k] : null, getOpenRisk));

    // Ghi dự đoán để tự chấm sau 5/10/20 phiên, kèm số liệu định lượng (điểm, dải giá, kế hoạch) để tính IC / độ phủ dải
    const L = result.brief?.levels;
    const plan = L ? { buyFrom: L.buyFrom, buyTo: L.buyTo, stop: L.stop, target: L.target, weight: L.weight } : undefined;
    const band = cone?.length ? Object.fromEntries(cone.map((c) => [c.h, [c.p05, c.p95]])) : undefined;
    const base = { symbol, date: lastBar.time, price: lastBar.close, partial: lastBar.partial };
    const list = [
      { ...base, source: 'rule', direction: RULE_DIRECTION[rec.code], label: rec.label, detail: ranking ? `Xếp hạng ${ranking.score}` : `Điểm ${total}`, score: ranking?.score ?? total, band, plan },
      ranking && { ...base, source: 'rank', direction: ranking.direction, label: ranking.label, detail: `Điểm xếp hạng ${ranking.score}`, score: ranking.score },
    ];
    if (result.trendPick) {
      list.push({ ...base, source: 'trend_pick', direction: 1, label: 'Trend Pick 8y (gần đỉnh 52w, biến động thấp)', detail: `Vol rank: ${ranking?.vol60PctRank ?? '–'}`, score: ranking?.vol60PctRank });
    }
    // Mô phỏng đã bỏ xu hướng nên chỉ ghi chiều rủi ro (không tính tín hiệu MUA của mô phỏng là dự đoán tăng)
    if (monteCarlo?.signal === 'RISK') {
      list.push({ ...base, source: 'monte_carlo', direction: -1, label: `Monte Carlo: ${monteCarlo.signal} (R/R ${monteCarlo.rr})`, detail: `P(lỗ ≥ 7%) ${Math.round(monteCarlo.probLoss7 * 100)}%`, score: monteCarlo.probLoss7 });
    }
    recordMany(list.filter(Boolean));
  }

  if (withChart) {
    const from = Math.max(0, bars.length - 300);
    const line = (arr) => arr.slice(from).map((v, i) => (v == null ? null : { time: bars[from + i].time, value: round(v, 3) })).filter(Boolean);
    result.chart = {
      bars: bars.slice(from),
      sma20: line(tech.series.sma20),
      sma50: line(tech.series.sma50),
      sma200: line(tech.series.sma200),
    };
  }
  return result;
}

/**
 * Ngữ cảnh định cỡ vị thế: vốn tài khoản (ACCOUNT_CAPITAL), rủi ro đang mở của danh mục và các mã KHÁC cùng ngành đang giữ.
 * Không đọc được danh mục thì vẫn trả vốn (bỏ heat/ngành) thay vì giả định danh mục trống.
 */
async function sizingContext(symbol, sector, getOpenRisk) {
  const capital = accountCapital();
  const open = await getOpenRisk().catch(() => null);
  if (!open) return { capital, heat: null, sector: null };
  const others = open.filter((x) => x.symbol !== symbol);
  const peers = sector ? others.filter((x) => sector.stocks.some((s) => s.symbol === x.symbol)) : [];
  return {
    capital,
    heat: portfolioHeat(others, capital),
    sector: sector ? { name: sector.name, count: peers.length, weight: capital ? peers.reduce((s, x) => s + x.value, 0) / capital : null } : null,
  };
}

/** Bản rút gọn dùng cho bảng danh mục theo dõi. */
export function summarize(a) {
  return {
    symbol: a.symbol,
    name: a.info?.name,
    exchange: a.info?.exchange,
    price: a.price,
    total: a.total,
    recommendation: a.recommendation,
    scores: a.scores,
    rsi: a.technical.indicators.rsi14,
    adx: a.technical.indicators.adx14,
    foreignNet5: a.foreign?.net5 ?? null,
    pe: a.fundamental.data?.pe ?? null,
    rankScore: a.ranking?.score ?? null,
    legacy: a.legacy ?? null,
    stockRisk: a.stockRisk?.isRisky ? a.stockRisk : null,
    monteCarlo: a.monteCarlo ? { probUp: a.monteCarlo.probUp, probGain5: a.monteCarlo.probGain5, probLoss7: a.monteCarlo.probLoss7, rr: a.monteCarlo.rr, signal: a.monteCarlo.signal } : null,
    trendPick: a.trendPick ?? false,
    newsCount: a.news.count,
    warnings: a.warnings.length,
    updatedAt: a.updatedAt,
  };
}
