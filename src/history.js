// Ảnh chụp dữ liệu cuối ngày cho toàn bộ rổ cổ phiếu (mặc định HOSE ≥ 5 tỷ/phiên), lưu ở data/history/YYYY-MM-DD.json.
// Mục đích:
//  1. Tích lũy dữ liệu lịch sử mà nguồn công khai không cung cấp (khối ngoại, chỉ số tài chính theo thời điểm)
//     để sau vài tháng kiểm chứng được phần cơ bản/khối ngoại có dự báo được giá hay không.
//  2. Ghi dự đoán cho MỌI mã trong rổ (không chỉ mã người dùng mở) theo cả điểm xếp hạng lẫn điểm cũ,
//     để nhật ký dự đoán so sánh hai cách chấm một cách công bằng, không lệch mẫu.
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, getFundamentals, getForeignFlow } from './data.js';
import { technicalAnalysis, fundamentalAnalysis, marketContext, rankRecommendation, RECOMMENDATIONS } from './analyze.js';
import { getRankBoard, MODELS, buildRef, compositeScore, rankLabel } from './ranking.js';
import { recordMany } from './predictions.js';
import { uncache } from './http.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'history');
const DIRECTION = { BUY: 1, ACCUMULATE: 1, HOLD: 0, AVOID: -1, SELL: -1 };
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

async function poolMap(items, fn, n = 6) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (k < items.length) {
      const i = k++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

/** Chụp dữ liệu phiên gần nhất của toàn bộ rổ và ghi dự đoán. Trả về ảnh chụp. */
export async function takeSnapshot() {
  // Bảng xếp hạng được cache 30 phút: tính lại để không chụp bảng dựng từ nến trong phiên
  uncache('rank-board');
  const [board, indexRes, market] = await Promise.all([
    getRankBoard(), getPriceHistory('VNINDEX'), marketContext().catch(() => null),
  ]);
  const date = board.date;
  const rows = await poolMap(board.rows, async (r) => {
    const [priceRes, fund, foreign] = await Promise.all([
      getPriceHistory(r.symbol),
      getFundamentals(r.symbol).catch(() => null),
      getForeignFlow(r.symbol, 20).catch(() => null),
    ]);
    const bars = priceRes.bars;
    if (bars.at(-1)?.partial) return null; // nến chưa chốt: không chụp, không ghi dự đoán
    const v2f = MODELS.v2.reader(bars)(bars.length - 1); // yếu tố của mô hình thử nghiệm v2
    const tech = technicalAnalysis(bars, market, { indexBars: indexRes.bars, foreign });
    const fa = fund ? fundamentalAnalysis(fund) : { score: null };
    // Điểm cũ không có phần tin tức (quá tốn kém để lấy tin cho toàn bộ rổ mỗi ngày)
    const legacyTotal = fa.score == null ? tech.score : Math.round((0.4 * tech.score + 0.35 * fa.score) / 0.75);
    const legacy = RECOMMENDATIONS.find((x) => legacyTotal >= x.min);
    const losing = fund?.epsTTM != null && fund.epsTTM <= 0;
    const rankRec = rankRecommendation({ ...r, position: 0, universe: board.universe }, { losing });
    return {
      symbol: r.symbol, close: r.close, value20: r.value20,
      rank: r.score, aboveMa200: r.aboveMa200, parts: r.parts, factors: r.factors, rankRec: rankRec.code,
      tech: tech.score, fund: fa.score, legacyTotal, legacyRec: legacy.code,
      foreign: tech.flow ? { net1: tech.flow.net1, net5: tech.flow.net5, net20: tech.flow.net20, ratio20: tech.flow.ratio20 } : null,
      fundamentals: fund ? {
        pe: round(fund.pe), pb: round(fund.pb), roe: round(fund.roe, 4), epsTTM: fund.epsTTM,
        profitGrowthTTM: round(fund.profitGrowthTTM, 4), revenueGrowthTTM: round(fund.revenueGrowthTTM, 4),
        debtToEquity: round(fund.debtToEquity), dividendYield: round(fund.dividendYield, 4), reportDate: fund.reportDate,
      } : null,
    };
  });
  // Mô hình thử nghiệm v2 (biến động thấp): điểm phân vị trong cùng rổ, chạy song song để kiểm chứng tương lai (H5)
  const kept = rows.filter(Boolean);
  const ref2 = buildRef(kept.map((x) => x.v2f), MODELS.v2.factors);
  for (const x of kept) {
    const cs = compositeScore(x.v2f, ref2, MODELS.v2.factors);
    x.rankV2 = cs?.score ?? null;
    x.v2 = x.v2f ? { atr: round(x.v2f.atr, 4), ivol: round(x.v2f.ivol, 4), maxret: round(x.v2f.maxret, 4) } : null;
    delete x.v2f;
  }
  // Mô hình thử nghiệm 4 yếu tố + ROE (ROE 4 quý mới nhất của VNDirect), chạy song song để kiểm chứng tương lai (H6)
  const roeIn = kept.map((x) => (x.factors ? { ...x.factors, roe: x.fundamentals?.roe ?? null } : null));
  const refRoe = buildRef(roeIn, MODELS.roe.factors);
  kept.forEach((x, k) => { x.rankRoe = compositeScore(roeIn[k], refRoe, MODELS.roe.factors)?.score ?? null; });
  const snap = { date, createdAt: new Date().toISOString(), market, universe: board.universe, criteria: board.criteria, rows: kept };
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${date}.json`), JSON.stringify(snap), 'utf8');

  await recordMany(snap.rows.flatMap((x) => [
    x.rankRoe != null && { source: 'rank_roe', symbol: x.symbol, date, direction: rankLabel(x.rankRoe, x.aboveMa200).direction, label: `+ROE: ${rankLabel(x.rankRoe, x.aboveMa200).label}`, price: x.close, detail: `Xếp hạng +ROE ${x.rankRoe}`, score: x.rankRoe },
    x.rankV2 != null && { source: 'rank_v2', symbol: x.symbol, date, direction: rankLabel(x.rankV2, x.aboveMa200).direction, label: `v2: ${rankLabel(x.rankV2, x.aboveMa200).label}`, price: x.close, detail: `Xếp hạng v2 ${x.rankV2}`, score: x.rankV2 },
    { source: 'rank_all', symbol: x.symbol, date, direction: DIRECTION[x.rankRec], label: RECOMMENDATIONS.find((r) => r.code === x.rankRec).label, price: x.close, detail: `Xếp hạng ${x.rank}`, score: x.rank },
    { source: 'legacy_all', symbol: x.symbol, date, direction: DIRECTION[x.legacyRec], label: RECOMMENDATIONS.find((r) => r.code === x.legacyRec).label, price: x.close, detail: `Điểm cũ ${x.legacyTotal}`, score: x.legacyTotal },
  ].filter(Boolean)));
  console.log(`[Lịch sử] Đã lưu ảnh chụp ${date}: ${snap.rows.length} mã`);
  return snap;
}

export async function listSnapshots() {
  try {
    return (await readdir(DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  } catch {
    return [];
  }
}

let running = null;

/** Mỗi 10 phút: nếu phiên gần nhất đã đóng cửa (sau 15:10 giờ VN) và chưa có ảnh chụp thì chụp. */
export function startHistorySchedule() {
  const tick = async () => {
    if (running) return;
    const { bars } = await getPriceHistory('VNINDEX').catch(() => ({ bars: [] }));
    const latest = bars.at(-1)?.time;
    if (!latest) return;
    const vn = new Date(Date.now() + 7 * 3600_000);
    const today = vn.toISOString().slice(0, 10);
    const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    if (latest === today && minutes < 15 * 60 + 10) return; // phiên hôm nay chưa đóng cửa
    if ((await listSnapshots()).includes(latest)) return;
    running = takeSnapshot().catch((err) => console.error('[Lịch sử] Lỗi:', err.message)).finally(() => (running = null));
  };
  setTimeout(tick, 20_000); // đợi bảng xếp hạng khởi động xong
  return setInterval(tick, 10 * 60_000);
}
