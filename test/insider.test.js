import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInsiderRow, insiderReader } from '../src/insider.js';

test('parseInsiderRow: ngày công bố theo giờ Việt Nam, bỏ dòng không có khối lượng đăng ký', () => {
  // 2026-10-12 17:00 UTC = 2026-10-13 0:00 giờ Việt Nam
  const r = parseInsiderRow({ PublishedDate: `/Date(${Date.UTC(2026, 9, 12, 17)})/`, PlanBuyVolume: 1000, PlanSellVolume: 0, TransactionMan: 'A' });
  assert.equal(r.published, '2026-10-13');
  assert.equal(r.buy, 1000);
  assert.equal(parseInsiderRow({ PublishedDate: `/Date(${Date.UTC(2026, 0, 1)})/`, PlanBuyVolume: 0, PlanSellVolume: 0 }), null);
  assert.equal(parseInsiderRow({ PublishedDate: null, PlanBuyVolume: 5 }), null);
});

test('insiderReader: chỉ dùng thông báo công bố trước phiên, trong 60 ngày, chia khối lượng TB 20 phiên', () => {
  const day = (k) => new Date(Date.UTC(2025, 0, 1) + k * 86400_000).toISOString().slice(0, 10);
  const bars = Array.from({ length: 200 }, (_, k) => ({ time: day(k), close: 10, volume: 1000 }));
  const ev = [
    { published: day(50), buy: 5000, sell: 0 },
    { published: day(60), buy: 0, sell: 2000 },
  ];
  const r = insiderReader(bars, ev);
  assert.equal(r(50), 0); // công bố đúng ngày 50: chưa dùng
  assert.equal(r(51), 5); // 5000 / 1000
  assert.equal(r(61), 3); // 5000 − 2000
  assert.equal(r(111), -2); // thông báo ngày 50 đã quá 60 ngày
  assert.equal(r(200), null);
  assert.equal(r(10), null); // chưa đủ 20 phiên
});
