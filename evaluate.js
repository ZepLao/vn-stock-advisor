// Chạy bộ đo 3 rào trên dữ liệu 4 năm và in kết quả: `npm run evaluate` (lưu data/evaluation.json)
import './src/env.js';
import { runEvaluation, formatReport } from './src/evaluation.js';

try {
  const years = Number(process.argv[2]) || 4;
  console.log(`Đang tải dữ liệu ${years} năm và gắn nhãn… (lần đầu có thể mất vài phút)`);
  const rep = await runEvaluation({ years });
  console.log(formatReport(rep));
  if (rep.survivorshipBias) console.log('\n⚠ Không lấy được rổ theo thời điểm: kết quả có thể đẹp hơn thực tế (thiên lệch sống sót).');
  process.exit(0);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
