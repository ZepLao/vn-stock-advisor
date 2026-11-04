// Kiểm định "cổ ngon" trên BCTC theo thời điểm: `npm run research-quality` (cần đã chạy `npm run db-backfill`)
// Thử thêm ROE vào điểm xếp hạng: `npm run research-quality -- roe`
// Kiểm định khối ngoại: `npm run research-quality -- foreign 8`
// Kiểm định 3 yếu tố mới (LN quý đột biến, động lượng ngành, đảo chiều 5 phiên) + khối ngoại: `npm run research-quality -- new3 8`
import './src/env.js';
import { runFactorLab, formatFactorReport } from './src/factorlab.js';
import { runRiskResearch, formatRiskReport, runRobustResearch, formatRobustReport } from './src/riskresearch.js';
import { runQualityResearch, formatQualityReport, runRoeTest, formatRoeReport, runForeignTest, formatForeignReport } from './src/quality.js';

try {
  const roe = process.argv.includes('roe');
  const years = Number(process.argv.find((a) => /^\d+$/.test(a))) || 7;
  if (process.argv.includes('robust')) {
    console.log(`Kiểm định chống may rủi lịch quyết định, ${years} năm…`);
    console.log(formatRobustReport(await runRobustResearch({ years })));
    process.exit(0);
  }
  if (process.argv.includes('risk')) {
    console.log(`Nâng cấp lõi danh mục, ${years} năm…`);
    console.log(formatRiskReport(await runRiskResearch({ years })));
    process.exit(0);
  }
  if (process.argv.includes('new3')) {
    console.log(`Kiểm định yếu tố mới, ${years} năm…`);
    console.log(formatFactorReport(await runFactorLab({ years })));
    process.exit(0);
  }
  if (process.argv.includes('foreign')) {
    console.log(`Kiểm định khối ngoại, ${years} năm…`);
    console.log(formatForeignReport(await runForeignTest({ years })));
    process.exit(0);
  }
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
