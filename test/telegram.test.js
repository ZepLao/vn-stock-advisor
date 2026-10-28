import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReport, splitMessage, zoneState, holdingLine, buyLine, marketLine } from '../src/telegram.js';

const IND = ' '.repeat(5);

// Giờ VN = UTC + 7
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);

test('Lịch gửi: sau ATO và sau đóng cửa, mỗi loại một lần/ngày, bỏ qua ngày không giao dịch', () => {
  const d = '2026-10-21';
  assert.equal(dueReport(at(d, '09:10'), d), null); // chưa hết ATO
  assert.equal(dueReport(at(d, '09:25'), d), 'open');
  assert.equal(dueReport(at(d, '09:25'), d, { open: d }), null); // đã gửi
  assert.equal(dueReport(at(d, '13:00'), d), null); // quá giờ bản tin mở cửa
  assert.equal(dueReport(at(d, '15:05'), d), null);
  assert.equal(dueReport(at(d, '15:12'), d, { open: d }), 'close');
  assert.equal(dueReport(at(d, '20:00'), d, { close: d }), null);
  assert.equal(dueReport(at(d, '09:25'), '2026-10-20'), null); // ngày lễ: VN-Index không có nến hôm nay
});

test('Tách tin dài theo dòng, mỗi phần không quá giới hạn', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Dòng ${i} ${'x'.repeat(30)}`).join('\n');
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000);
  assert.equal(parts.join('\n'), text);
});

test('Dòng mã đang giữ: thoát ký tự < cho HTML của Telegram, nâng cắt lỗ khi lãi ≥ 10%', () => {
  const a = (close, pnlPct) => ({ symbol: 'VTP', price: { close }, holding: { avgCost: 46.8, pnlPct }, brief: { code: 'HOLD', levels: { stop: 42.6, target: 52 } } });
  assert.equal(holdingLine(a(47.35, 0.008)), '▸ <b>VTP</b>  <b>47,35</b> (lãi <b>+0,8%</b>)\n  👉 🟢 Giữ · cắt &lt; 42,6');
  assert.match(holdingLine(a(51.5, 0.1)), /cắt &lt; 46,8/);
  assert.match(holdingLine(a(42, -0.1)), /BÁN<\/b> \(thủng 42,6\)/);
  // Quyết định cuối sau AI được ưu tiên hơn khuyến nghị hệ thống
  assert.match(holdingLine(a(47.35, 0.008), 'AVOID'), /Giảm khi hồi · cắt &lt; 42,6/);
  assert.match(holdingLine(a(47.35, 0.008), 'HOLD', { noAi: true }), /\(chưa qua AI\)/);
});

test('Dòng mã mua: 2 dòng gọn, ngành + thăm dò, vùng mua / chờ giá, % tới chốt và cắt', () => {
  const a = (close) => ({ symbol: 'DHC', price: { close }, sector: { name: 'Sản xuất giấy' }, brief: { levels: { buyFrom: 38.25, buyTo: 38.8, stop: 35.75, target: 42 } } });
  assert.equal(buyLine(a(38.8), { code: 'ACCUMULATE' }), [
    '▸ <b>DHC</b>  <b>38,8</b> · <i>Sản xuất giấy · thăm dò</i>',
    '  🎯 Mua <b>38,25–38,8</b>',
    '  🚀 Chốt 42 (+8%) · 🛡️ Cắt 35,75 (−8%)',
  ].join('\n'));
  assert.match(buyLine(a(40), { code: 'BUY' }), /Chờ về <b>38,25–38,8<\/b>/);
  assert.equal(zoneState(38.5, a(0).brief.levels), 'buy');
  assert.equal(zoneState(35, a(0).brief.levels), 'broken');
});

test('VN-Index: nói rõ là xu hướng trung hạn', () => {
  assert.equal(marketLine({ close: 1738.67, changePct: 2.76, trend: 'down', aboveMa200: true }),
    '📊 VN-Index <b>1.739</b> ▲2,76% · xu hướng trung hạn còn yếu → mua từng phần');
});

test('Trạng thái so với vùng mua', () => {
  const L = { buyFrom: 37, buyTo: 38, stop: 35 };
  assert.equal(zoneState(37.5, L), 'buy');
  assert.equal(zoneState(39, L), 'wait');
  assert.equal(zoneState(36, L), 'unstable');
  assert.equal(zoneState(34.9, L), 'broken');
});
