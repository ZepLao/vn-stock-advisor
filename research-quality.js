// Kiểm định "cổ ngon" trên BCTC theo thời điểm: `npm run research-quality` (cần đã chạy `npm run db-backfill`)
// Thử thêm ROE vào điểm xếp hạng: `npm run research-quality -- roe`
import './src/env.js';
import { runQualityResearch, formatQualityReport, runRoeTest, formatRoeReport } from './src/quality.js';

try {
  const roe = process.argv.includes('roe');
  const years = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;
  if (roe) {
    console.log(`Thử thêm ROE vào điểm xếp hạng, ${years} năm…`);
    console.log(formatRoeReport(await runRoeTest({ years })));
    process.exit(0);
  }
  console.log(`Kiểm định cổ ngon ${years} năm (tải giá và gắn nhãn, có thể mất vài phút)…`);
  const rep = await runQualityResearch({ years });
  console.log(formatQualityReport(rep));
  if (rep.survivorshipBias) console.log('\n⚠ Không lấy được rổ theo thời điểm: kết quả có thể đẹp hơn thực tế.');
  process.exit(0);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
