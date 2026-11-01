// Bộ lọc cổ phiếu tiềm năng, quét toàn thị trường theo 3 bước:
//  1. Lọc nhanh mọi mã đạt tiêu chí sàn + thanh khoản (mặc định HOSE, ≥ 5 tỷ/phiên): chấm kỹ thuật + cơ bản + khối ngoại, nhận diện setup.
//     Bắt buộc: thanh khoản ĐỀU (TB 20 phiên ≥ ngưỡng và ≥ 16/20 phiên đạt ngưỡng), "cổ ngon" (qualityCheck)
//     và thuộc ngành đang được mua ròng hoặc top nhóm ngành hút tiền (sectorCheck).
//  2. Phân tích đầy đủ (có tin tức) nhóm dẫn đầu, loại mã có tin rủi ro hoặc bị chấm tiêu cực.
//  3. Gemini đánh giá và xếp hạng danh sách cuối trong một lần gọi.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, getFundamentals, getForeignFlow, getScreenUniverse, screenCriteria } from './data.js';
import { technicalAnalysis, fundamentalAnalysis, marketContext, analyzeSymbol } from './analyze.js';
import { aiPickStocks } from './ai.js';
import { rankSymbol } from './ranking.js';
import { recordMany } from './predictions.js';
import { getSectorFlows } from './sectors.js';
import { detectStockRisk, detectBuyWarnings } from './risk.js';
import { getMarketRegime } from './regime.js';
import { sma } from './indicators.js';

// ---------- Tiêu chí "cổ ngon" (cơ bản doanh nghiệp) và thanh khoản đều ----------
export const QUALITY_RULES = { minRoe: 0.12, minProfitGrowth: 0, maxPe: 25, maxDebtToEquity: 1.5 };
export const LIQUIDITY_RULES = { days: 20, minDays: 16 };
export const SECTOR_RULES = { period: 5, top: 5 }; // dòng tiền ngành 5 phiên: ròng > 0 hoặc thuộc top 5 ngành
const FINANCIAL = /ngân hàng|chứng khoán|bảo hiểm|tài chính/i;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Kiểm tra doanh nghiệp có "ngon" không. Thiếu dữ liệu thì không đạt (không xác minh được).
 * Nợ vay/vốn chủ không áp dụng cho ngân hàng, chứng khoán, bảo hiểm (mô hình kinh doanh dùng đòn bẩy).
 * @returns {{ pass: boolean, score: number|null, checks: {label: string, ok: boolean}[], failed: string[] }}
 */
export function qualityCheck(f, sectorName = '') {
  const R = QUALITY_RULES;
  const pc = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
  if (!f) return { pass: false, score: null, checks: [{ ok: false, label: 'Chưa có dữ liệu tài chính' }], failed: ['Chưa có dữ liệu tài chính'] };
  const checks = [];
  const add = (ok, label) => checks.push({ ok, label });
  const fin = FINANCIAL.test(sectorName);
  add(f.epsTTM != null && f.epsTTM > 0, f.epsTTM == null ? 'Chưa có EPS' : f.epsTTM > 0 ? 'Đang có lãi (EPS 4 quý dương)' : 'Đang lỗ 4 quý gần nhất');
  add(f.roe != null && f.roe >= R.minRoe, f.roe == null ? 'Chưa có ROE' : `ROE ${pc(f.roe, 1)} ${f.roe >= R.minRoe ? '≥' : '<'} ${pc(R.minRoe)}`);
  add(f.profitGrowthTTM != null && f.profitGrowthTTM >= R.minProfitGrowth,
    f.profitGrowthTTM == null ? 'Chưa có tăng trưởng lợi nhuận' : `Lợi nhuận 4 quý ${f.profitGrowthTTM >= 0 ? 'tăng' : 'giảm'} ${pc(Math.abs(f.profitGrowthTTM))}`);
  add(f.pe != null && f.pe > 0 && f.pe <= R.maxPe, f.pe == null || f.pe <= 0 ? 'Chưa có P/E' : `P/E ${f.pe.toFixed(1)} ${f.pe <= R.maxPe ? '≤' : '>'} ${R.maxPe}`);
  if (!fin) {
    add(f.debtToEquity == null || f.debtToEquity <= R.maxDebtToEquity,
      f.debtToEquity == null ? 'Nợ vay/vốn chủ: không có dữ liệu' : `Nợ vay/vốn chủ ${f.debtToEquity.toFixed(2)} ${f.debtToEquity <= R.maxDebtToEquity ? '≤' : '>'} ${R.maxDebtToEquity}`);
  }
  const failed = checks.filter((c) => !c.ok).map((c) => c.label);
  // Điểm chất lượng 0–100 để xếp hạng giữa các mã đã đạt
  const parts = [];
  if (f.roe != null) parts.push(clamp01((f.roe - R.minRoe) / (0.25 - R.minRoe)));
  if (f.profitGrowthTTM != null) parts.push(clamp01(f.profitGrowthTTM / 0.3));
  if (f.revenueGrowthTTM != null) parts.push(clamp01((f.revenueGrowthTTM + 0.05) / 0.25));
  if (f.pe != null && f.pe > 0) parts.push(clamp01((R.maxPe - f.pe) / (R.maxPe - 8)));
  if (!fin && f.debtToEquity != null) parts.push(clamp01((R.maxDebtToEquity - f.debtToEquity) / R.maxDebtToEquity));
  const score = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : null;
  return { pass: failed.length === 0, score, checks, failed };
}

/**
 * Ngành của mã có đang được mua không: dòng tiền ròng ước tính N phiên > 0 hoặc nằm trong top ngành hút tiền.
 * @param {{ name: string, rank: number, total: number, net: number }|null} s
 */
export function sectorCheck(s, { top = SECTOR_RULES.top, period = SECTOR_RULES.period } = {}) {
  if (!s) return { pass: false, label: 'Chưa xác định được ngành' };
  const bleeding = (s.rank > s.total - 3 && s.net < 0) || s.net <= -500e9;
  const inTop = s.rank <= top && !bleeding;
  const buying = s.net > 0 && !bleeding;
  const tỷ = `${s.net >= 0 ? '+' : ''}${(s.net / 1e9).toFixed(0)} tỷ`;
  return {
    pass: !bleeding && (inTop || buying),
    label: `Ngành ${s.name}: ${s.net >= 0 ? 'đang được mua ròng' : 'bị bán ròng'} ${tỷ} (${period} phiên), hạng ${s.rank}/${s.total}${inTop ? ` — top ${top} ngành` : ''}${bleeding ? ' (ngành bị rút ròng mạnh, loại)' : ''}`,
  };
}

/**
 * Bổ sung điều kiện từ BCTC quý: lợi nhuận quý gần nhất không giảm so với cùng kỳ (chặn mã "ngon" theo số liệu 4 quý
 * nhưng đang xấu đi ở quý mới nhất).
 */
export function withEarnings(q, e) {
  if (!e || e.profitYoY == null) return q;
  const ok = e.profitYoY >= 0;
  const label = `Quý ${e.latest}: lợi nhuận ${ok ? 'tăng' : 'giảm'} ${Math.round(Math.abs(e.profitYoY) * 100)}% so cùng kỳ${e.trend === 'TANG_TOC' ? ', đang tăng tốc' : ''}`;
  const checks = [...q.checks, { ok, label }];
  const failed = checks.filter((c) => !c.ok).map((c) => c.label);
  return { ...q, checks, failed, pass: failed.length === 0 };
}

/** Thanh khoản đều: TB N phiên ≥ ngưỡng và ít nhất minDays phiên có giá trị khớp lệnh ≥ ngưỡng (đồng). */
export function liquidityCheck(bars, minValue, { days = LIQUIDITY_RULES.days, minDays = LIQUIDITY_RULES.minDays } = {}) {
  const values = bars.slice(-days).map((b) => b.close * b.volume * 1000);
  const avg = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const okDays = values.filter((v) => v >= minValue).length;
  return { pass: avg >= minValue && okDays >= minDays, avg, okDays, days: values.length, last: values.at(-1) ?? 0, minDays };
}

const PICK_DIRECTION = { MUA: 1, MUA_THAM_DO: 1, CHO_DIEM_MUA: 0, LOAI: -1 };

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'screener.json');
const STAGE2_SIZE = 14;     // số mã phân tích đầy đủ
const FINAL_SIZE = 10;      // số mã gửi Gemini và hiển thị
const CONCURRENCY = 6;

const state = { status: 'idle', progress: null, error: null, result: null };
let loaded = false;

async function load() {
  if (loaded) return;
  loaded = true;
  try { state.result = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* chưa có kết quả */ }
}

/**
 * Nhận diện mẫu hình VCP (Volatility Contraction Pattern - Mark Minervini)
 * Yêu cầu:
 * - 2 đến 4 đợt co hẹp dao động (Contractions) liên tiếp trong 30-70 phiên
 * - Mỗi đợt co hẹp có biên độ dao động (%) nhỏ hơn đợt trước (ví dụ 15-25% -> 7-12% -> 2-5%)
 * - Thanh khoản 5 phiên gần nhất cạn kiệt (TB5 volume <= 0.75 TB20 volume)
 * - Giá đóng cửa hiện tại nằm ở nửa trên của vùng tích lũy (>= 0.65 từ đáy đến đỉnh của nền)
 */
export function detectVcpPattern(bars) {
  if (!bars || bars.length < 40) return { isVcp: false };
  const recent = bars.slice(-60);
  const closes = recent.map((b) => b.close);
  const highs = recent.map((b) => b.high);
  const lows = recent.map((b) => b.low);
  const vols = recent.map((b) => b.volume);

  const maxH = Math.max(...highs);
  const minL = Math.min(...lows);
  const lastClose = closes.at(-1);

  // Phải ở nửa trên của nền giá tích lũy
  if (maxH === minL || (lastClose - minL) / (maxH - minL) < 0.65) {
    return { isVcp: false };
  }

  // Khối lượng cạn kiệt 5 phiên gần nhất so với 20 phiên
  const vol5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20 = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volDryRatio = vol20 > 0 ? vol5 / vol20 : 1;
  const volDryUp = volDryRatio <= 0.75;

  // Chia 60 phiên thành 3 khoảng để đo độ co hẹp biên độ
  const len = recent.length;
  const c1Bars = recent.slice(0, Math.floor(len * 0.45));
  const c2Bars = recent.slice(Math.floor(len * 0.45), Math.floor(len * 0.8));
  const c3Bars = recent.slice(Math.floor(len * 0.8));

  const rangePct = (bList) => {
    if (!bList.length) return 0;
    const h = Math.max(...bList.map((b) => b.high));
    const l = Math.min(...bList.map((b) => b.low));
    return l > 0 ? Math.round(((h - l) / l) * 1000) / 10 : 0;
  };

  const r1 = rangePct(c1Bars);
  const r2 = rangePct(c2Bars);
  const r3 = rangePct(c3Bars);

  // Mẫu hình co hẹp: r1 > r2 > r3 và r3 < 8.5%
  const contracting = r1 > r2 && r2 > r3 && r3 <= 8.5 && r1 >= 10;
  const isVcp = contracting && volDryUp;

  return {
    isVcp,
    contractions: [r1, r2, r3],
    volDryRatio: Math.round(volDryRatio * 100) / 100,
    volDryUp,
    qualityScore: isVcp ? (volDryRatio < 0.5 ? 90 : 80) : 0,
  };
}

/**
 * Nhận diện Pocket Pivot (Gil Morales & Chris Kacher):
 * Điểm mua gom sớm trước khi bứt phá:
 * - Khối lượng phiên tăng hôm nay > khối lượng phiên giảm lớn nhất trong 10 phiên trước đó.
 * - Giá đóng cửa tăng và nằm trên hoặc chớm bứt phá MA10/MA50.
 */
export function detectPocketPivot(bars) {
  if (!bars || bars.length < 15) return { isPocketPivot: false };
  const n = bars.length;
  const last = bars[n - 1];
  const prev = bars[n - 2];
  if (last.close <= prev.close) return { isPocketPivot: false };

  const last10 = bars.slice(n - 11, n - 1);
  const downBars = last10.filter((b, idx) => {
    const prior = idx === 0 ? bars[n - 12] : last10[idx - 1];
    return prior ? b.close < prior.close : false;
  });

  const maxDownVol = downBars.length ? Math.max(...downBars.map((b) => b.volume)) : 0;
  const isHigherThanDowns = maxDownVol > 0 && last.volume > maxDownVol;

  const closes = bars.map((b) => b.close);
  const ma10 = sma(closes, 10).at(-1);
  const ma50 = sma(closes, 50).at(-1);
  const nearKeyMa = (ma10 && last.close >= ma10 * 0.99) || (ma50 && last.close >= ma50 * 0.99);

  const isPocketPivot = isHigherThanDowns && nearKeyMa;
  const volRatio = maxDownVol > 0 ? Math.round((last.volume / maxDownVol) * 100) / 100 : 1;

  return {
    isPocketPivot,
    maxDownVol,
    volRatio,
    reason: isPocketPivot
      ? `Khối lượng phiên tăng vượt cây nến giảm lớn nhất 10 phiên (${volRatio}×), chớm bứt phá MA hỗ trợ`
      : null,
  };
}

/** Nhận diện kiểu cơ hội mua từ các chỉ báo đã tính. */
export function detectSetups({ close, changePct, i, plan, faScore, flow, vcp = null, pocketPivot = null }) {
  const s = [];
  const add = (id, label, desc) => s.push({ id, label, desc });
  const upStructure = i.sma50 != null && close > i.sma50 && (i.sma200 == null || i.sma50 > i.sma200);

  if (vcp?.isVcp) {
    add('vcp', 'Mẫu hình VCP', `Độ biến động thu hẹp ${vcp.contractions.join('% → ')}%, KL cạn kiệt ${(vcp.volDryRatio * 100).toFixed(0)}% TB20`);
  }
  if (pocketPivot?.isPocketPivot) {
    add('pocket_pivot', 'Pocket Pivot', pocketPivot.reason);
  }
  if (plan && close >= plan.resistance * 0.985 && i.avgVolume20 && i.volume >= 1.5 * i.avgVolume20 && changePct > 0) {
    add('breakout', 'Bứt phá', `Giá sát/vượt đỉnh 20 phiên ${plan.resistance} với khối lượng gấp ${(i.volume / i.avgVolume20).toFixed(1)} lần TB20`);
  }
  if (i.sma20 != null && upStructure && close > i.sma20 && i.sma20 > i.sma50 && i.rsi14 >= 50 && i.rsi14 <= 72) {
    add('uptrend', 'Xu hướng tăng', `Giá > MA20 > MA50${i.sma200 != null ? ' > MA200' : ''}, RSI ${i.rsi14}`);
  }
  if (upStructure && i.sma20 != null && Math.abs(close - i.sma20) / i.sma20 < 0.025 && i.rsi14 >= 40 && i.rsi14 <= 55) {
    add('pullback', 'Điều chỉnh về hỗ trợ', `Xu hướng tăng, giá lùi về sát MA20 (${i.sma20}), RSI ${i.rsi14} đã nguội`);
  }
  if ((i.rsi14 < 38 || i.stochK < 25) && (i.rsiDivergence === 'bullish' || i.stochK > i.stochD) && faScore >= 20) {
    add('reversal', 'Hồi phục từ quá bán', `RSI ${i.rsi14}, Stochastic ${i.stochK} bắt đầu quay lên; cơ bản tốt (điểm ${faScore})`);
  }
  if (i.adx14 != null && i.adx14 < 20 && Math.abs(i.return20d ?? 99) < 5 && i.obvTrend === 'up' && faScore >= 10) {
    add('accumulation', 'Tích lũy', `Đi ngang 20 phiên (ADX ${i.adx14}) trong khi OBV tăng: dòng tiền âm thầm vào`);
  }
  if (flow && flow.ratio20 > 3 && flow.buyDays5 >= 3) {
    add('foreign', 'Khối ngoại gom', `Mua ròng ${(flow.net20 / 1e9).toFixed(0)} tỷ trong 20 phiên, ${flow.buyDays5}/5 phiên gần nhất mua`);
  }
  return s;
}

// Cổ phiếu ứng viên: sàn và ngưỡng thanh khoản theo screenCriteria() (mặc định HOSE, ≥ 5 tỷ/phiên TB 20 phiên)
const universe = () => getScreenUniverse();

async function quickScan(item, ctx) {
  const [priceRes, fund, foreign] = await Promise.all([
    getPriceHistory(item.symbol),
    getFundamentals(item.symbol).catch(() => null),
    getForeignFlow(item.symbol, 20).catch(() => null),
  ]);
  const { bars } = priceRes;
  if (bars.length < 60) return null;
  const close = bars.at(-1).close;
  const changePct = Math.round(((close - bars.at(-2).close) / bars.at(-2).close) * 10000) / 100;
  const tech = technicalAnalysis(bars, ctx.market, { indexBars: ctx.indexBars, foreign });
  const fa = fund ? fundamentalAnalysis(fund) : { score: null };
  const i = tech.indicators;
  const avgValue20 = i.avgVolume20 * close * 1000;
  if (avgValue20 < screenCriteria().minValue) return null;
  const liquidity = liquidityCheck(bars, screenCriteria().minValue);
  const sec = ctx.sectorOf?.get(item.symbol) || null;
  const quality = qualityCheck(fund, sec?.name || '');
  const sector = sec ? { ...sec, ...sectorCheck(sec) } : { ...sectorCheck(null) };

  // Nhận diện mẫu hình VCP & Pocket Pivot
  const vcp = detectVcpPattern(bars);
  const pocketPivot = detectPocketPivot(bars);

  const setups = detectSetups({ close, changePct, i, plan: tech.plan, faScore: fa.score ?? 0, flow: tech.flow, vcp, pocketPivot });
  // Quét nhanh rủi ro rơi tự do / thủng sâu MA50 (phương pháp Laban)
  const stockRisk = detectStockRisk(bars, item.symbol, avgValue20);
  const buyWarnings = stockRisk.buyWarnings || detectBuyWarnings(bars, avgValue20);
  // Tiêu chí chính: điểm xếp hạng 4 yếu tố (đã kiểm chứng). Chỉ nhóm ≥ 70 và trên MA200 thắng VN-Index ổn định,
  // nên chỉ những mã đó được đưa vào vòng phân tích sâu. Điểm kỹ thuật/cơ bản cũ chỉ để hiển thị.
  const rank = await rankSymbol(item.symbol, bars).catch(() => null);
  const quick = rank ? rank.score : null;
  return {
    symbol: item.symbol, exchange: item.exchange, close, changePct,
    quick: Math.round(quick), technical: tech.score, fundamental: fa.score, setups, avgValue20,
    rankScore: rank?.score ?? null, aboveMa200: rank?.aboveMa200 ?? null,
    stockRisk,
    buyWarnings,
    trendPick: rank?.trendPick ?? false,
    vcp,
    pocketPivot,
    liquidity, quality, sector,
    // Xếp hạng chung: nửa điểm xu hướng (xếp hạng 4 yếu tố) + nửa điểm chất lượng doanh nghiệp
    combined: quick != null && quality.score != null ? Math.round((quick + quality.score) / 2) : null,
  };
}

/**
 * Gợi ý theo ngành: với mỗi ngành đang được mua, các mã thanh khoản đều + cơ bản tốt, xếp theo điểm chung.
 * Đánh dấu mã đã đủ điều kiện (vào danh sách cuối) và mã còn chờ xu hướng (điểm xếp hạng < 70 hoặc dưới MA200).
 */
function sectorPicks(scanned, flows, finalSet, trendOk, perSector = 4) {
  const bySector = new Map();
  for (const c of scanned) {
    if (!c.sector?.pass || !c.liquidity.pass || !c.quality.pass) continue;
    if (!bySector.has(c.sector.name)) bySector.set(c.sector.name, []);
    bySector.get(c.sector.name).push(c);
  }
  return (flows?.sectors || []).map((s, k) => ({ s, rank: k + 1 }))
    .filter(({ s, rank }) => s.net > 0 || rank <= SECTOR_RULES.top)
    .map(({ s, rank }) => {
      // Mã đã chọn trước, rồi mã đủ điều kiện xu hướng, rồi theo điểm chung
      const tier = (c) => (finalSet.has(c.symbol) ? 0 : trendOk(c) ? 1 : 2);
      const list = (bySector.get(s.name) || []).sort((a, b) => tier(a) - tier(b) || (b.combined ?? 0) - (a.combined ?? 0));
      return {
        name: s.name, rank, net: s.net, foreignNet: s.foreignNet, count: s.count,
        stocks: list.slice(0, perSector).map((c) => ({
          symbol: c.symbol, close: c.close, changePct: c.changePct, rankScore: c.quick, aboveMa200: c.aboveMa200,
          quality: c.quality.score, combined: c.combined, avgValue: Math.round(c.liquidity.avg),
          status: finalSet.has(c.symbol) ? 'PICK' : trendOk(c) ? 'TREND_OK' : 'WAIT_TREND',
          waitReason: trendOk(c) ? null : c.aboveMa200 === false ? 'giá dưới MA200' : `điểm xu hướng ${c.quick ?? '?'} < 70`,
        })),
        more: Math.max(0, list.length - perSector),
      };
    });
}

async function pool(items, worker, onDone) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        const r = await worker(it);
        if (r) out.push(r);
      } catch { /* bỏ qua mã lỗi */ }
      onDone();
    }
  }));
  return out;
}

const RISK_WARNING = /tin rủi ro nghiêm trọng|đang lỗ/;

// Kế hoạch lệnh của mã AI chọn để chấm lại (vùng mua, cắt lỗ, mục tiêu, số phiên); thiếu cắt lỗ / mục tiêu thì không chấm
const pickPlan = (p) => (p.stopLoss && p.target ? {
  buyFrom: p.entryZone?.from ?? null, buyTo: p.entryZone?.to ?? null, stop: p.stopLoss, target: p.target, horizonDays: p.horizonDays ?? 20,
} : undefined);
const expectedOf = (c) => (c?.expectation ? { 5: c.expectation.h5?.meanExcess ?? null, 20: c.expectation.h20.meanExcess } : undefined);

/**
 * Ghi MỌI mã đã quét kèm cờ đạt / rớt từng lớp lọc (nguồn 'funnel', không có chiều) để sau vài tháng so sánh nhóm đạt và
 * nhóm rớt mỗi bộ lọc: bộ lọc nào thật sự giúp chọn mã tốt hơn so với chỉ dùng điểm xếp hạng.
 */
export function funnelRecords(scanned, date, trendOk, finalSet = new Set()) {
  return scanned.map((c) => ({
    source: 'funnel', symbol: c.symbol, date, direction: 0, label: 'Phễu Tiềm năng', price: c.close, score: c.quick,
    flags: {
      liquidity: c.liquidity.pass, quality: c.quality.pass, sector: c.sector.pass, trend: trendOk(c),
      risk: Boolean(c.stockRisk?.isRisky), trendPick: Boolean(c.trendPick), final: finalSet.has(c.symbol),
      setups: c.setups.map((x) => x.id),
    },
  }));
}

async function run() {
  const started = Date.now();
  const { bars: indexBars } = await getPriceHistory('VNINDEX');
  const date = indexBars.at(-1).time;
  const market = await marketContext().catch(() => null);
  const marketRegime = await getMarketRegime().catch(() => null);
  const flows = await getSectorFlows(SECTOR_RULES.period).catch(() => null);
  const sectorOf = new Map();
  (flows?.sectors || []).forEach((s, k) => {
    const info = { name: s.name, rank: k + 1, total: flows.sectors.length, net: s.net, foreignNet: s.foreignNet, ret: s.ret };
    for (const x of s.stocks) sectorOf.set(x.symbol, info);
  });
  const ctx = { indexBars, market, sectorOf };

  // Bước 1
  const uni = await universe();
  state.progress = { stage: 1, label: 'Lọc nhanh toàn thị trường', done: 0, total: uni.length };
  const scanned = await pool(uni, (it) => quickScan(it, ctx), () => state.progress.done++);

  // Bước 2
  // Bắt buộc: thanh khoản đều + cổ ngon + xu hướng (điểm xếp hạng ≥ 70, trên MA200) + KHÔNG có rủi ro rơi tự do + KHÔNG dính cảnh báo Khoan mua (SSL / Weak)
  const hasBuyWarning = (c) => Boolean(c.buyWarnings?.length);
  const trendOk = (c) => c.quick != null && c.quick >= 70 && c.aboveMa200 !== false && !c.stockRisk?.isRisky && !hasBuyWarning(c);
  const funnel = {
    scanned: scanned.length,
    liquidity: scanned.filter((c) => c.liquidity.pass).length,
    quality: scanned.filter((c) => c.liquidity.pass && c.quality.pass).length,
    sector: scanned.filter((c) => c.liquidity.pass && c.quality.pass && c.sector.pass).length,
    trend: scanned.filter((c) => c.liquidity.pass && c.quality.pass && c.sector.pass && trendOk(c)).length,
  };
  let shortlist = scanned
    .filter((c) => c.liquidity.pass && c.quality.pass && c.sector.pass && trendOk(c))
    .sort((a, b) => (b.combined + (b.trendPick ? 5 : 0)) - (a.combined + (a.trendPick ? 5 : 0)))
    .slice(0, STAGE2_SIZE);

  let isCounterTrend = false;
  let isDeepDipMode = false;
  let regimeNote = null;
  if (!shortlist.length) {
    if (marketRegime?.isDeepDip) {
      // Khi thị trường giảm sâu ≥ 15% từ đỉnh 1 năm (nghiên cứu Laban: Quality Deep Dip):
      // Kích hoạt gom hàng giá trị các mã cơ bản chất lượng cao (ROE ≥ 12%, nợ thấp) đón đầu phục hồi
      const deepDipList = scanned
        .filter((c) => c.liquidity.pass && c.quality.pass && !c.stockRisk?.isRisky && !hasBuyWarning(c))
        .sort((a, b) => (b.quality.score ?? 0) - (a.quality.score ?? 0))
        .slice(0, STAGE2_SIZE);
      if (deepDipList.length > 0) {
        shortlist = deepDipList;
        isDeepDipMode = true;
        regimeNote = `VN-Index chiết khấu sâu ${Math.abs(marketRegime.from1yHighPct).toFixed(1)}% từ đỉnh 1 năm (vùng hoảng loạn). Kích hoạt chế độ Gom hàng giá trị (Quality Deep Dip) cho các doanh nghiệp đầu ngành (ROE ≥ 12%, nợ an toàn).`;
      }
    }

    if (!shortlist.length) {
      // Khi thị trường phân phối/rút ròng toàn diện khiến phễu ngành = 0:
      // Tự động kích hoạt cơ chế chọn lọc Cổ phiếu ngược dòng / Phòng thủ (sức mạnh riêng lẻ tốt nhất)
      const counterList = scanned
        .filter((c) => c.liquidity.pass && c.quality.pass && trendOk(c))
        .sort((a, b) => (b.combined + (b.trendPick ? 5 : 0)) - (a.combined + (a.trendPick ? 5 : 0)))
        .slice(0, STAGE2_SIZE);
      if (counterList.length > 0) {
        shortlist = counterList;
        isCounterTrend = true;
        regimeNote = 'Thị trường chung đang bị rút ròng diện rộng. Hệ thống chuyển sang chế độ Cổ phiếu ngược dòng / Phòng thủ (chỉ thăm dò ≤ 15% vốn).';
      }
    }
  }
  state.progress = { stage: 2, label: 'Phân tích sâu nhóm dẫn đầu (kèm tin tức)', done: 0, total: shortlist.length };
  let marketFlow = null;
  const detailed = await pool(shortlist, async (c) => {
    const a = await analyzeSymbol(c.symbol, { withChart: false });
    marketFlow ??= a.marketFlow;
    if (a.recommendation.code === 'SELL' || a.recommendation.code === 'AVOID') return null;
    if (a.recommendation.code === 'HOLD' && (a.mathProb && !a.mathProb.pass)) return null;
    if (a.recommendation.code === 'HOLD' && (a.isOverextended || a.hasBearishDivergence || a.nearResistance || a.isForeignDumping || a.buyWarnings?.length)) return null;
    if (a.warnings.some((w) => RISK_WARNING.test(w))) return null;
    return {
      symbol: a.symbol, name: a.info.name, exchange: a.info.exchange,
      close: a.price.close, changePct: a.price.changePct, date: a.price.date,
      setups: c.setups, quick: c.quick, avgValue20: c.avgValue20,
      liquidity: c.liquidity, quality: withEarnings(qualityCheck(a.fundamental.data, c.sector?.name || ''), a.company?.earnings), sector: c.sector, combined: c.combined,
      trendPick: a.trendPick ?? c.trendPick ?? false,
      stockRisk: a.stockRisk ?? c.stockRisk ?? null,
      buyWarnings: a.buyWarnings ?? c.buyWarnings ?? [],
      mathProb: a.mathProb ? { pass: a.mathProb.pass, pWin: a.mathProb.pWin, ev: a.mathProb.expectedValuePct, kelly: a.mathProb.halfKelly, breakEven: a.mathProb.breakEvenWinRate, note: a.mathProb.summaryNote } : null,
      monteCarlo: a.monteCarlo ? { probUp: a.monteCarlo.probUp, rr: a.monteCarlo.rr, signal: a.monteCarlo.signal, peakGain: a.monteCarlo.peakGainMedian, troughDd: a.monteCarlo.troughDdMedian } : null,
      earnings: a.company?.earnings ? (({ quarters, ...rest }) => ({ ...rest, quarters: quarters.slice(-5).map(({ label, profit, profitYoY, revenueYoY }) => ({ label, profit, profitYoY, revenueYoY })) }))(a.company.earnings) : null,
      valuation: a.company?.valuation ? { verdict: a.company.valuation.verdict, pePct: a.company.valuation.pe?.percentile ?? null, peMedian: a.company.valuation.pe?.median ?? null } : null,
      upcomingEvents: (a.company?.events?.upcoming || []).slice(0, 3).map((x) => `${x.date} ${x.label}: ${x.note}`),
      total: a.total, scores: a.scores, recommendation: a.recommendation,
      indicators: a.technical.indicators, fundamentals: a.fundamental.data,
      foreign: a.foreign ? { net1: a.foreign.net1, net5: a.foreign.net5, net20: a.foreign.net20, buyDays5: a.foreign.buyDays5 } : null,
      plan: a.plan, overview: a.overview, warnings: a.warnings,
      ranking: a.ranking ? { score: a.ranking.score, label: a.ranking.label, code: a.ranking.code, position: a.ranking.position, universe: a.ranking.universe } : null,
      expectation: a.expectation ?? null,
      news: a.news.items.filter((n) => n.label !== 'trung_lap').slice(0, 4)
        .map((n) => ({ title: n.title, label: n.label, link: n.link, source: n.source, publishedAt: n.publishedAt, reaction: n.reaction })),
    };
  }, () => state.progress.done++);

  const final = detailed
    .filter((c) => c.quality.pass)
    .map((c) => ({ ...c, isCounterTrend, isDeepDipMode }))
    .sort((a, b) => ((b.combined ?? 0) + (b.trendPick ? 5 : 0)) - ((a.combined ?? 0) + (a.trendPick ? 5 : 0)))
    .slice(0, FINAL_SIZE);
  // Chỉ ghi phễu khi nến đã chốt (quét tay trong phiên thì bỏ, tránh chấm trên giá chưa chốt)
  if (!indexBars.at(-1)?.partial) recordMany(funnelRecords(scanned, date, trendOk, new Set(final.map((c) => c.symbol))));

  // Bước 3
  state.progress = { stage: 3, label: 'Gemini đánh giá và xếp hạng', done: 0, total: 1 };
  let ai = null;
  try {
    ai = await aiPickStocks(final, { marketFlow, market });
  } catch (err) {
    ai = { error: err.message };
  }
  state.progress.done = 1;
  if (ai?.picks) {
    const close = new Map(final.map((c) => [c.symbol, c]));
    recordMany(ai.picks.map((p) => ({
      source: 'screener', symbol: p.symbol, date: close.get(p.symbol)?.date || date, direction: PICK_DIRECTION[p.verdict],
      label: p.verdictLabel, price: close.get(p.symbol)?.close, detail: `Tin cậy ${p.confidence}%`, confidence: p.confidence,
      plan: pickPlan(p), expectedExcess: expectedOf(close.get(p.symbol)),
    })));
  }

  const setupCounts = {};
  for (const c of scanned) for (const s of c.setups) setupCounts[s.label] = (setupCounts[s.label] || 0) + 1;

  return {
    date, createdAt: new Date().toISOString(), durationMs: Date.now() - started,
    criteria: screenCriteria(), quality: QUALITY_RULES, liquidityRule: LIQUIDITY_RULES, sectorRule: SECTOR_RULES, funnel,
    hotSectors: (flows?.sectors || []).map((s, k) => ({ name: s.name, rank: k + 1, net: s.net })).filter((s) => s.net > 0 || s.rank <= SECTOR_RULES.top),
    sectorPicks: sectorPicks(scanned, flows, new Set(final.map((c) => c.symbol)), trendOk),
    universe: uni.length, scanned: scanned.length, shortlisted: shortlist.length,
    market, marketFlow, setupCounts, candidates: final, ai,
    isCounterTrend, isDeepDipMode, regimeNote,
  };
}

export async function getScreener() {
  await load();
  return state;
}

/** Bắt đầu quét (nếu chưa chạy). Trả về trạng thái ngay, không chờ quét xong. */
export async function startScreener() {
  await load();
  if (state.status === 'running') return state;
  state.status = 'running';
  state.error = null;
  state.progress = { stage: 0, label: 'Chuẩn bị', done: 0, total: 1 };
  run().then(async (result) => {
    state.result = result;
    state.status = 'done';
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[Tiềm năng] Quét xong ${result.scanned} mã trong ${Math.round(result.durationMs / 1000)}s, chọn ${result.candidates.length} mã`);
  }).catch((err) => {
    state.status = 'error';
    state.error = err.message;
    console.error('[Tiềm năng] Lỗi:', err.message);
  });
  return state;
}

/** Chỉ chạy lại bước Gemini trên danh sách đã lọc (khi lần trước Gemini lỗi hoặc muốn đánh giá lại). */
export async function rerunScreenerAi() {
  await load();
  if (state.status === 'running') return state;
  const r = state.result;
  if (!r?.candidates?.length) throw new Error('Chưa có danh sách ứng viên, hãy quét thị trường trước');
  state.status = 'running';
  state.error = null;
  state.progress = { stage: 3, label: 'Gemini đánh giá và xếp hạng', done: 0, total: 1 };
  aiPickStocks(r.candidates, { marketFlow: r.marketFlow, market: r.market })
    .catch((err) => ({ error: err.message }))
    .then(async (ai) => {
      r.ai = ai;
      state.status = 'done';
      const byS = new Map(r.candidates.map((c) => [c.symbol, c]));
      recordMany((ai?.picks || []).map((p) => ({
      source: 'screener', symbol: p.symbol, date: byS.get(p.symbol)?.date || r.date, direction: PICK_DIRECTION[p.verdict],
      label: p.verdictLabel, price: byS.get(p.symbol)?.close, detail: `Tin cậy ${p.confidence}%`, confidence: p.confidence,
      plan: pickPlan(p), expectedExcess: expectedOf(byS.get(p.symbol)),
    })));
      await writeFile(FILE, JSON.stringify(r, null, 2), 'utf8');
    });
  return state;
}

/** Tự quét mỗi ngày giao dịch sau 15:10 (giờ VN) nếu chưa có kết quả cho phiên đó. */
export function startScreenerSchedule() {
  const tick = async () => {
    await load();
    if (state.status === 'running') return;
    const vn = new Date(Date.now() + 7 * 3600_000);
    const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    if (vn.getUTCDay() === 0 || vn.getUTCDay() === 6 || minutes < 15 * 60 + 10) return;
    const { bars } = await getPriceHistory('VNINDEX').catch(() => ({ bars: [] }));
    const latest = bars.at(-1)?.time;
    if (latest && state.result?.date !== latest) startScreener();
  };
  tick();
  return setInterval(tick, 5 * 60_000);
}
