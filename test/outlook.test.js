import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWeek, outlookDue, sanitizeOutlook, formatOutlook, outlookLine } from '../src/outlook.js';

const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);

test('Tuần dự báo: trong tuần là tuần hiện tại, từ chiều thứ 6 là tuần sau', () => {
  assert.deepEqual(nextWeek(at('2026-10-21', '20:00')), { monday: '2026-10-19', friday: '2026-10-23' }); // thứ 4
  assert.deepEqual(nextWeek(at('2026-10-26', '08:20')), { monday: '2026-10-26', friday: '2026-10-30' }); // thứ 2
  assert.deepEqual(nextWeek(at('2026-10-23', '16:00')), { monday: '2026-10-26', friday: '2026-10-30' }); // thứ 6 sau đóng cửa
  assert.deepEqual(nextWeek(at('2026-10-25', '10:00')), { monday: '2026-10-26', friday: '2026-10-30' }); // chủ nhật
});

const g = {
  cone: [{ h: 5, p05: 1655, p25: 1706, p50: 1742, p75: 1774, p95: 1826 }],
  sectors: [
    { name: 'Ngân hàng', symbols: ['MSB', 'VPB', 'OCB'], leaders: [{ symbol: 'MSB' }, { symbol: 'OCB' }], net5: 4.9e12 },
    { name: 'Chứng khoán & Dịch vụ tài chính', symbols: ['SSI', 'HCM'], leaders: [{ symbol: 'HCM' }], net5: 7.3e12 },
    { name: 'Bất động sản', symbols: ['VIC', 'VHM'], leaders: [{ symbol: 'VIC' }], net5: 2e12 },
  ],
};

test('Kiểm tra đầu ra AI: ngành/mã có thật, vùng giá trong dải thống kê', () => {
  const o = sanitizeOutlook({
    trend: 'TANG_NHE', confidence: 140, low: 1500, high: 1790, summary: 's', drivers: ['a'], risks: ['b'],
    hotSectors: [
      { name: 'ngân hàng', view: 'BUNG_NO', reason: 'r', symbols: ['MSB', 'FPT', 'vpb'] }, // FPT không thuộc ngành
      { name: 'Chứng khoán', view: 'TICH_CUC', reason: 'r', symbols: [] }, // tên rút gọn, không có mã → lấy mã dẫn đầu
      { name: 'Hàng không vũ trụ', view: 'BUNG_NO', reason: 'r', symbols: ['XYZ'] }, // ngành không có trong dữ liệu
    ],
    weakSectors: [{ name: 'Bất động sản', reason: 'w' }, { name: 'Ngân hàng', reason: 'trùng ngành triển vọng' }],
    news: [{ theme: 't', impact: 'TICH_CUC' }, { theme: 'x', impact: 'SAI' }], strategy: 'st',
  }, g);
  assert.equal(o.confidence, 100);
  assert.equal(o.low, 1655); // kẹp vào p05
  assert.equal(o.high, 1790);
  assert.deepEqual(o.hotSectors.map((h) => [h.name, h.symbols]), [['Ngân hàng', ['MSB', 'VPB']], ['Chứng khoán & Dịch vụ tài chính', ['HCM']]]);
  assert.deepEqual(o.weakSectors.map((w) => w.name), ['Bất động sản']);
  assert.equal(o.news.length, 1);
  assert.equal(sanitizeOutlook({ trend: 'LEN_MANH' }, g).trend, 'DI_NGANG'); // nhãn lạ → đi ngang
});

test('Tin Telegram triển vọng tuần và dòng tóm tắt', () => {
  const x = { week: { monday: '2026-10-26', friday: '2026-10-30' }, close: 1738.67, result: sanitizeOutlook({
    trend: 'TANG_NHE', confidence: 60, low: 1700, high: 1780, summary: 'Hồi phục <thận trọng>', drivers: ['Tiền vào ngân hàng'], risks: ['Khối ngoại bán'],
    hotSectors: [{ name: 'Ngân hàng', view: 'BUNG_NO', reason: 'Tiền vào mạnh', symbols: ['MSB'] }], weakSectors: [], news: [{ theme: 'Lãi suất giảm', impact: 'TICH_CUC' }], strategy: 'Giải ngân 50%',
  }, g) };
  const t = formatOutlook(x);
  assert.match(t, /TRIỂN VỌNG TUẦN 26\/10 – 30\/10/);
  assert.match(t, /TĂNG NHẸ<\/b> \(tin cậy 60%\)/);
  assert.match(t, /Hồi phục &lt;thận trọng&gt;/);
  assert.match(t, /1\. Ngân hàng<\/b> — có thể bùng nổ 🔥/);
  assert.equal(outlookLine(x), '🧭 Tuần (AI): tăng nhẹ · 1.700–1.780 · ngành: Ngân hàng');
});

test('outlookDue: gửi sau phiên chiều thứ 6 (từ 15:45), bù thứ 7 / chủ nhật; không gửi sáng thứ 2 hay trong tuần', () => {
  const next = { monday: '2026-11-09', friday: '2026-11-13' };
  assert.equal(outlookDue(at('2026-11-06', '15:30')), null, 'thứ 6 trước 15:45');
  assert.deepEqual(outlookDue(at('2026-11-06', '15:45')), next);
  assert.deepEqual(outlookDue(at('2026-11-07', '09:00')), next, 'bù thứ 7');
  assert.deepEqual(outlookDue(at('2026-11-08', '21:00')), next, 'bù chủ nhật');
  assert.equal(outlookDue(at('2026-11-09', '08:20')), null, 'sáng thứ 2 không gửi');
  assert.equal(outlookDue(at('2026-11-04', '15:50')), null, 'giữa tuần không gửi');
});
