// Nạp bù lịch sử dài vào database để nghiên cứu / kiểm định (bộ đo, yếu tố "cổ ngon", khối ngoại…):
//  - rổ cổ phiếu tại mỗi đầu tháng (gồm mã sau này hủy niêm yết) → universe_snapshots
//  - giá ngày của mọi mã từng có trong rổ → daily_bars
//  - BCTC theo quý (kèm ngày được phép dùng = cuối quý + 45 ngày) → quarterly_financials
//  - khối ngoại theo ngày → foreign_daily
// Chạy lại an toàn (ghi đè theo khóa chính). Mỗi mã lỗi riêng không chặn mã khác.
import { getPriceHistory, getForeignFlow, getUniverseAt, getScreenUniverse } from './data.js';
import { getQuarterly } from './company.js';
import { EARN_LAG_DAYS, poolMap } from './ranking.js';
import { upsert, dbConfig } from './db.js';

const DAY = 86400_000;
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

/** Phiên đầu tiên của mỗi tháng trong lịch phiên (hàm thuần). */
export function monthStarts(cal, from) {
  const out = [];
  let month = null;
  for (const b of cal) {
    if (b.time < from) continue;
    const m = b.time.slice(0, 7);
    if (m !== month) { out.push(b.time); month = m; }
  }
  return out;
}

/** Dòng quarterly_financials từ kết quả getQuarterly (hàm thuần). */
export function quarterRows(symbol, quarters, lagDays = EARN_LAG_DAYS) {
  return (quarters || []).filter((q) => /^\d{4}-\d{2}-\d{2}$/.test(q.date)).map((q) => [
    symbol, q.date, addDays(q.date, lagDays), q.bank ?? false,
    q.revenue, q.grossProfit, q.profit, q.cfo, q.equity, q.assets, q.netInterest, q.provision,
  ]);
}

/**
 * @param {{ years?: number, log?: (msg: string) => void }} o years = số năm lịch sử (giá nạp thêm ~1,5 năm trước đó để đủ MA200)
 */
export async function backfillHistory({ years = 8, log = console.log } = {}) {
  if (!dbConfig().enabled) throw new Error('Chưa cấu hình database (DB_PASSWORD hoặc DATABASE_URL trong .env)');
  const priceDays = Math.round((years + 1.5) * 365);
  const out = { snapshots: 0, symbols: 0, bars: 0, quarters: 0, foreign: 0, errors: [] };

  // 1. Rổ theo thời điểm
  const cal = (await getPriceHistory('VNINDEX', priceDays)).bars.filter((b) => !b.partial);
  const from = addDays(cal.at(-1).time, -Math.round(years * 365));
  const dates = monthStarts(cal, from);
  log(`Rổ theo thời điểm: ${dates.length} mốc (${dates[0]} → ${dates.at(-1)})`);
  const snaps = await poolMap(dates, (d) => getUniverseAt(d).catch(() => []), 4);
  const rows = dates.flatMap((d, k) => (snaps[k] || []).map((u) => [d, u.symbol, u.exchange]));
  out.snapshots = await upsert('universe_snapshots', ['date', 'symbol', 'exchange'], rows, ['date', 'symbol']);

  // 2. Danh sách mã: mọi mã từng có trong rổ + rổ hiện tại
  const current = await getScreenUniverse().catch(() => []);
  const symbols = [...new Set([...rows.map((r) => r[1]), ...current.map((u) => u.symbol)])].sort();
  out.symbols = symbols.length;
  log(`${symbols.length} mã cần nạp giá, BCTC quý và khối ngoại`);

  // VNINDEX trước: là lịch phiên của mọi phép tính
  out.bars += await upsert('daily_bars', ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'],
    cal.map((b) => ['VNINDEX', b.time, b.open, b.high, b.low, b.close, b.volume]), ['symbol', 'date']);

  // 3. Từng mã
  let done = 0;
  await poolMap(symbols, async (s) => {
    const part = async (name, fn) => {
      try { return await fn(); } catch (err) { out.errors.push(`${s} ${name}: ${err.message}`); return 0; }
    };
    const nBars = await part('giá', async () => {
      const { bars } = await getPriceHistory(s, priceDays);
      return upsert('daily_bars', ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'],
        bars.filter((b) => !b.partial).map((b) => [s, b.time, b.open, b.high, b.low, b.close, b.volume]), ['symbol', 'date']);
    });
    const nQuarters = await part('BCTC', async () => upsert('quarterly_financials',
      ['symbol', 'fiscal_date', 'available_date', 'bank', 'revenue', 'gross_profit', 'profit', 'cfo', 'equity', 'assets', 'net_interest', 'provision'],
      quarterRows(s, await getQuarterly(s)), ['symbol', 'fiscal_date']));
    const nForeign = await part('khối ngoại', async () => {
      const f = await getForeignFlow(s, Math.round(years * 252));
      return upsert('foreign_daily', ['symbol', 'date', 'buy_val', 'sell_val', 'net_val', 'net_vol'],
        f.filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x.date || '')).map((x) => [s, x.date.slice(0, 10), x.buyVal, x.sellVal, x.netVal, x.netVol]), ['symbol', 'date']);
    });
    // Cộng sau khi chờ xong: `x += await …` đọc x trước khi chờ nên đếm thiếu khi chạy song song
    out.bars += nBars; out.quarters += nQuarters; out.foreign += nForeign;
    if (++done % 25 === 0 || done === symbols.length) log(`  ${done}/${symbols.length} mã · ${out.bars} nến · ${out.quarters} quý · ${out.foreign} phiên khối ngoại`);
  }, 4);
  return out;
}
