import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdingAdvice, formatHoldingAdvice } from '../src/telegram.js';

// Mã đang giữ mẫu: VPB như dữ liệu thật ngày 2/11 (lỗ 9%, có cảnh báo suy yếu, khối ngoại bán)
const mk = (o = {}) => ({
  symbol: 'VPB', price: { close: 21.55 },
  holding: { qty: 100, avgCost: 23.71, pnlPct: -0.092, pending: 0, ...o.holding },
  brief: { code: o.code ?? 'HOLD', levels: { holdStop: 20.15, heldSessions: 6, holdSessions: 40 } },
  ranking: { score: 74, aboveMa200: true, avoid: false, ...o.ranking },
  stockRisk: { isRisky: false, reasons: [] },
  buyWarnings: o.buyWarnings ?? [{ name: '📉 Suy yếu', text: 'giảm 8,7% trong 5 phiên và dưới MA20' }],
  foreign: { net5: o.net5 ?? -12e9 },
  technical: { indicators: { atr14: 0.65 } },
});

test('holdingAdvice: lấy đúng quyết định bán / xem lại từ planOrders', () => {
  assert.equal(holdingAdvice(mk(), { sell: '⛔ 10% thấp nhất' }).action, 'BÁN');
  const r = holdingAdvice(mk(), { review: true });
  assert.equal(r.action, 'XEM LẠI');
  assert.match(r.why, /không bình quân giá xuống/);
});

test('holdingAdvice: đang lỗ, thị trường yếu, có cảnh báo → GIỮ, không mua thêm, nêu đủ rủi ro', () => {
  const r = holdingAdvice(mk(), { breadth: 0.2, nav: 4_800_000, sector: { name: 'Ngân hàng', net: -2.79e12 } });
  assert.equal(r.action, 'GIỮ');
  assert.match(r.why, /thị trường yếu \(20% mã trên MA50\)/);
  assert.match(r.why, /chưa lãi ≥ 3%/);
  assert.ok(r.risks.some((x) => /cách ngưỡng thoát 20,15 còn 6,9%/.test(x)), r.risks.join(' | '));
  assert.ok(r.risks.some((x) => /khối ngoại bán ròng 5 phiên −?-?12/.test(x) || /khối ngoại bán ròng/.test(x)));
  assert.ok(r.risks.some((x) => /ngành Ngân hàng bị rút ròng/.test(x)));
  assert.ok(r.risks.some((x) => /tập trung: chiếm 45% tài sản/.test(x)));
  assert.ok(r.risks.some((x) => /Suy yếu/.test(x)));
});

test('holdingAdvice: MUA THÊM chỉ khi trong nhóm mua, lãi ≥ 3%, thị trường đủ rộng, chưa đủ suất, không cảnh báo', () => {
  const good = mk({ code: 'BUY', holding: { qty: 20, pnlPct: 0.06 }, buyWarnings: [], net5: 5e9 });
  const r = holdingAdvice(good, { breadth: 0.6, nav: 50_000_000 });
  assert.equal(r.action, 'MUA THÊM');
  assert.equal(holdingAdvice(good, { breadth: 0.4, nav: 50_000_000 }).action, 'GIỮ', 'thị trường yếu thì không mua thêm');
  assert.equal(holdingAdvice(good, { breadth: 0.6, nav: 2_000_000 }).action, 'GIỮ', 'đã quá một suất thì không mua thêm');
});

test('formatHoldingAdvice: mỗi mã có dòng việc cần làm và dòng rủi ro', () => {
  const lines = formatHoldingAdvice([holdingAdvice(mk(), { breadth: 0.2, nav: 4_800_000 })]);
  assert.match(lines[0], /<b>VPB<\/b> 21,55 · 100 cp vốn 23,71 · lỗ <b>−9,2%<\/b> · 6\/40 phiên/);
  assert.match(lines[1], /🟡 <b>GIỮ<\/b>/);
  assert.match(lines[2], /^ {2}Rủi ro: /);
});
