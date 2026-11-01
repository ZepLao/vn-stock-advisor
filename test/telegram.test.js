import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReport, splitMessage, zoneState, holdingLine, buyLine, marketLine, planOrders, formatCloseReport, formatMorning, formatWeekly } from '../src/telegram.js';

const IND = ' '.repeat(5);

// Giờ VN = UTC + 7
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);

test('Lịch gửi: lệnh 15:10 mỗi phiên, nhắc lệnh 8:30 khi có lệnh, tổng kết thứ 6, bỏ qua ngày không giao dịch', () => {
  const d = '2026-10-21'; // thứ 4
  const plan = { buys: [{ symbol: 'MSB' }], sells: [] };
  assert.equal(dueReport(at(d, '09:25'), d), null); // không còn bản tin mở cửa sau ATO
  assert.equal(dueReport(at(d, '15:05'), d), null);
  assert.equal(dueReport(at(d, '15:12'), d), 'close');
  assert.equal(dueReport(at(d, '20:00'), d, { close: d }), null);
  assert.equal(dueReport(at(d, '15:12'), '2026-10-20'), null); // ngày lễ: VN-Index không có nến hôm nay
  // Nhắc lệnh trước ATO: chỉ khi bản tin hôm trước có lệnh, mỗi sáng một lần
  assert.equal(dueReport(at('2026-10-22', '08:40'), d, { plan, planDate: d }), 'morning');
  assert.equal(dueReport(at('2026-10-22', '08:40'), d, { plan: { buys: [], sells: [] }, planDate: d }), null);
  assert.equal(dueReport(at('2026-10-22', '08:40'), d, { plan, planDate: d, morning: '2026-10-22' }), null);
  assert.equal(dueReport(at('2026-10-22', '09:05'), d, { plan, planDate: d }), null); // đã qua ATO
  // Thứ 6: tổng kết tuần sau bản tin chiều
  const f = '2026-10-23';
  assert.equal(dueReport(at(f, '15:45'), f, { close: f }), 'weekly');
  assert.equal(dueReport(at(f, '15:45'), f), 'close'); // bản tin chiều trước
  assert.equal(dueReport(at(f, '15:45'), f, { close: f, weekly: f }), null);
  assert.equal(dueReport(at('2026-10-24', '08:40'), f, { plan, planDate: f }), null); // thứ 7
});

const mk = (symbol, { code = 'HOLD', avoid = false, held = 10, close = 20, avgCost = 20, holdStop = 17, score = 80, trendPick = false, qty = 1000 } = {}) => ({
  symbol, price: { close }, ranking: { score, avoid, trendPick },
  holding: qty ? { qty, sellable: qty, avgCost, pnlPct: close / avgCost - 1 } : null,
  brief: { code, levels: { buyTo: close, stop: Math.round(close * 0.85 * 100) / 100, holdStop, heldSessions: held } },
});

test('Lập lệnh: bán ⛔ / đủ 40 phiên rời nhóm mua / rủi ro; xem lại dưới −15%; mua theo suất trống và tối đa 3 mã/ngành', () => {
  const held = [
    { a: mk('AAA', { avoid: true }), sector: 'Thép' },
    { a: mk('BBB', { held: 41 }), sector: 'Thép' },
    { a: mk('CCC', { code: 'BUY', held: 45 }), sector: 'Thép' }, // đủ hạn nhưng vẫn trong nhóm mua: giữ tiếp
    { a: mk('DDD', { close: 16, avgCost: 20 }), sector: 'Ngân hàng' }, // dưới −15%
    { a: mk('EEE', { code: 'SELL' }), sector: 'Thép' },
  ];
  const candidates = ['F1', 'F2', 'F3', 'F4'].map((s) => ({ a: { ...mk(s, { code: 'BUY', qty: 0 }), holding: null }, sector: 'Thép' }))
    .concat([{ a: { ...mk('G1', { code: 'ACCUMULATE', qty: 0, close: 25 }), holding: null }, sector: 'Ngân hàng' }]);
  const p = planOrders({ held, candidates, capital: 1e9, buyCount: 5 });
  assert.deepEqual(p.sells.map((x) => x.symbol), ['AAA', 'BBB', 'EEE']);
  assert.deepEqual(p.review.map((x) => x.symbol), ['DDD']);
  assert.deepEqual(p.keep.map((x) => x.symbol), ['CCC']);
  assert.equal(p.freeSlots, 8);
  // Thép đã có CCC: thêm tối đa 2 mã Thép; mua thăm dò = nửa suất
  assert.deepEqual(p.buys.map((x) => x.symbol), ['F1', 'F2', 'G1']);
  assert.equal(p.buys[0].shares, 5000); // 100 tr / (20 nghìn × 1000)
  assert.equal(p.buys[2].shares, 2000); // nửa suất: 50 tr / 25 nghìn
  const text = formatCloseReport({ date: '2026-10-28', market: { close: 1766, changePct: 0.27, trend: 'down' }, regime: { regime: 'MARKET_CORRECTION' }, plan: p,
    summary: { unrealizedPct: 3.2, dayChange: 1.1e6 }, expectation: { h20: { meanExcess: 0.0107, p10: -0.085, p90: 0.115 } } });
  assert.match(text, /LỆNH CHO PHIÊN TỚI · sau phiên 28\/10/);
  assert.match(text, /chỉ tham khảo, quy tắc không đổi/);
  assert.match(text, /▸ <b>AAA<\/b> LO 20 · <b>1\.000<\/b> cp · ⛔ 10% thấp nhất/);
  assert.match(text, /▸ <b>F1<\/b> LO <b>20<\/b> · <b>5\.000<\/b> cp ≈ 100 tr/);
  assert.match(text, /XEM LẠI.*\n▸ <b>DDD<\/b>/);
  assert.match(text, /DANH MỤC<\/b> 5\/10 mã/);
  assert.match(text, /hơn rổ TB <b>\+1,1%<\/b>\/20 phiên/);
  assert.ok(!/AI chưa/.test(text));
  // Đủ 10 mã: không mua thêm
  const full = planOrders({ held: Array.from({ length: 10 }, (_, k) => ({ a: mk(`H${k}`, { code: 'BUY' }), sector: `S${k}` })), candidates, capital: 1e9 });
  assert.equal(full.buys.length, 0);
  assert.match(formatCloseReport({ date: '2026-10-28', market: null, regime: null, plan: full }), /Danh mục đã đủ 10 mã/);
});

test('Nhắc lệnh sáng và tổng kết tuần', () => {
  assert.equal(formatMorning({ buys: [], sells: [] }, '2026-10-28'), null);
  const m = formatMorning({ buys: [{ symbol: 'MSB', price: 16, shares: 6200 }], sells: [{ symbol: 'NVL', qty: 1000 }] }, '2026-10-28');
  assert.match(m, /Bán: <b>NVL<\/b> 1\.000 cp/);
  assert.match(m, /Mua LO: <b>MSB<\/b> 16 × 6\.200/);
  const w = formatWeekly({ date: '2026-10-30', summary: { marketValue: 5e8, unrealizedPct: 2.5, realized: 3e6 },
    holdings: [{ sector: 'Thép' }, { sector: 'Thép' }, { sector: 'Thép' }, { sector: 'Thép' }],
    hypotheses: [{ id: 'H1', title: 'IC > 0', verdict: 'insufficient', n: 9, t: -1.36 }], tuning: [{ name: 'widen', from: 1.12, to: 1.16, reason: 'dải hẹp' }] });
  assert.match(w, /Danh mục 4\/10 mã · giá trị 500 tr/);
  assert.match(w, /Vượt 3 mã\/ngành: Thép \(4\)/);
  assert.match(w, /H1 IC &gt; 0: chưa đủ dữ liệu · 9 phiên · t −1,36|H1 IC &gt; 0: chưa đủ dữ liệu · 9 phiên · t -1,36/);
  assert.match(w, /widen: 1\.12 → <b>1\.16<\/b>/);
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
    '📊 VN-Index <b>1.739</b> ▲2,76% · xu hướng trung hạn còn yếu');
});

test('Trạng thái so với vùng mua', () => {
  const L = { buyFrom: 37, buyTo: 38, stop: 35 };
  assert.equal(zoneState(37.5, L), 'buy');
  assert.equal(zoneState(39, L), 'wait');
  assert.equal(zoneState(36, L), 'unstable');
  assert.equal(zoneState(34.9, L), 'broken');
});
