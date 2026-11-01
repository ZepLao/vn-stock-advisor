// Nạp bù lịch sử dài vào database: `npm run db-backfill` (mặc định 8 năm), `npm run db-backfill -- 10` (10 năm)
import './src/env.js';
import { backfillHistory } from './src/backfill.js';

try {
  const years = Number(process.argv[2]) || 8;
  console.log(`Nạp bù ${years} năm lịch sử (lần đầu có thể mất 10–30 phút)…`);
  const r = await backfillHistory({ years });
  console.log(`Xong: ${r.snapshots} dòng rổ theo thời điểm · ${r.symbols} mã · ${r.bars} nến ngày · ${r.quarters} quý BCTC · ${r.foreign} phiên khối ngoại`);
  if (r.errors.length) console.log(`${r.errors.length} lỗi (mã ngừng giao dịch / nguồn không có dữ liệu), ví dụ:\n  ${r.errors.slice(0, 10).join('\n  ')}`);
  process.exit(0);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
