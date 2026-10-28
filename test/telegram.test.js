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

test('Dòng mã đang giữ: thoát ký tự < cho HTML của Telegram, giữ đến 40 phiên, cảnh báo −15%, ⛔ cân nhắc bán', () => {
  const a = (close, pnlPct, held = 12) => ({ symbol: 'VTP', price: { close }, holding: { avgCost: 46.8, pnlPct }, brief: { code: 'HOLD', levels: { stop: 42.6, holdStop: 39.75, heldSessions: held, holdSessions: 40 } } });
  assert.equal(holdingLine(a(47.35, 0.008)), '▸ <b>VTP</b>  <b>47,35</b> (lãi <b>+0,8%</b>)\n  👉 🟡 Giữ đến đủ 40 phiên (12/40 phiên) · cảnh báo &lt; 39,75');
  assert.match(holdingLine(a(47.35, 0.008, 41)), /Bán<\/b> \(đủ 40 phiên, không còn trong nhóm mua\)/);
  assert.match(holdingLine(a(39, -0.17)), /Dưới ngưỡng −15%<\/b> \(39,75\)/);
  assert.match(holdingLine(a(47.35, 0.008), 'BUY'), /Giữ \(vẫn trong nhóm mua\)/);
  // Quyết định cuối sau AI được ưu tiên hơn khuyến nghị hệ thống; ⛔ thì cân nhắc bán
  assert.match(holdingLine({ ...a(47.35, 0.008), ranking: { avoid: true } }, 'AVOID'), /⛔ Cân nhắc bán/);
  assert.match(holdingLine(a(47.35, 0.008), 'HOLD', { noAi: true }), /\(chưa qua AI\)/);
});

test('Dòng mã mua: 2 dòng gọn, ngành + thăm dò, lệnh LO giá đóng cửa, giữ ~40 phiên, cảnh báo −15%', () => {
  const a = (close) => ({ symbol: 'DHC', price: { close }, sector: { name: 'Sản xuất giấy' }, brief: { levels: { buyFrom: 38.8, buyTo: 38.8, stop: 32.95, holdSessions: 40 } } });
  assert.equal(buyLine(a(38.8), { code: 'ACCUMULATE' }), [
    '▸ <b>DHC</b>  <b>38,8</b> · <i>Sản xuất giấy · thăm dò</i>',
    '  🎯 LO <b>38,8</b> (giá đóng cửa)',
    '  ⏳ Giữ ~40 phiên · ⚠️ Cảnh báo &lt; 32,95 (−15%)',
  ].join('\n'));
  assert.match(buyLine(a(40), { code: 'BUY' }), /Chờ về LO <b>38,8<\/b>/);
  assert.equal(zoneState(38.8, a(0).brief.levels), 'buy');
  assert.equal(zoneState(32, a(0).brief.levels), 'broken');
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
