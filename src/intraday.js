// TẮT mặc định (database chỉ lưu cuối ngày, xem db.js); bật lại bằng INTRADAY=1.
// Thu thập dữ liệu TRONG PHIÊN vào database: mỗi INTRADAY_MINUTES phút (mặc định 15) trong giờ giao dịch
// (9:15–11:30, 13:00–14:45; bỏ ATO/ATC và nghỉ trưa) chụp VN-Index, độ rộng, khối ngoại toàn sàn và giá + điểm
// xếp hạng của toàn bộ rổ. Dùng để chẩn đoán: gợi ý buổi sáng diễn biến thế nào trong ngày, vùng mua có được khớp
// không, giờ nào trong phiên giá tốt hơn (src/diagnose.js). Chỉ ghi khi database bật.
import { getMarketMovers, getPriceHistory } from './data.js';
import { getRankBoard } from './ranking.js';
import { uncache } from './http.js';
import { dbConfig, upsert } from './db.js';

export const INTRADAY_MINUTES = Number(process.env.INTRADAY_MINUTES) || 15;

/** Có nằm trong khung thu thập không (giờ VN, thứ 2–6). */
export function intradayWindow(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const day = vn.getUTCDay(), m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  if (day < 1 || day > 5) return false;
  return (m >= 9 * 60 + 15 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 14 * 60 + 45);
}

let busy = false;

/** Một lần chụp. Trả về số dòng đã ghi. */
export async function captureIntraday({ force = false } = {}) {
  if (busy || !dbConfig().enabled) return 0;
  if (!force && !intradayWindow()) return 0;
  busy = true;
  try {
    uncache('rank-board'); // tính lại bằng giá trong phiên (radar cũng làm vậy; giá cache 2 phút nên không dội nguồn)
    const [board, movers, idxRes] = await Promise.all([
      getRankBoard(), getMarketMovers('HOSE').catch(() => null), getPriceHistory('VNINDEX').catch(() => null),
    ]);
    const ts = new Date().toISOString();
    const [prev, last] = (idxRes?.bars || []).slice(-2);
    const chg = prev && last ? Math.round((last.close / prev.close - 1) * 10000) / 100 : null;
    const b = movers?.breadth || {};
    let n = await upsert('market_intraday', ['ts', 'date', 'vnindex', 'change_pct', 'advancers', 'decliners', 'unchanged', 'value', 'foreign_net'],
      [[ts, last?.time ?? board.date, last?.close ?? null, chg, b.advancers ?? null, b.decliners ?? null, b.unchanged ?? null, b.totalValue ?? null, movers?.foreignTotal?.netVal ?? null]], ['ts']);
    n += await upsert('stock_intraday', ['ts', 'date', 'symbol', 'price', 'change_pct', 'rank_score', 'above_ma200'],
      board.rows.map((r) => [ts, r.date, r.symbol, r.close, r.changePct, r.score, r.aboveMa200]), ['ts', 'symbol']);
    return n;
  } finally {
    busy = false;
  }
}

export function startIntraday() {
  if (process.env.INTRADAY !== '1' || !dbConfig().enabled) return null;
  const run = () => captureIntraday()
    .then((n) => n && console.log(`[Trong phiên] Đã lưu ảnh chụp ${n} dòng`))
    .catch((err) => console.error('[Trong phiên] Lỗi:', err.message));
  return setInterval(run, INTRADAY_MINUTES * 60_000);
}
