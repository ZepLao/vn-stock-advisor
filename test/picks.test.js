import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectorMap, sectorTier, orderBySector, junkCheck, rewardCheck, sectorLeaders } from '../src/picks.js';

test('Lời kỳ vọng tối thiểu 4% tới mức chốt', () => {
  assert.equal(rewardCheck(48, { target: 48.7 }).ok, false); // +1,5%: không bù nổi phí, thuế, trượt giá
  assert.equal(rewardCheck(38.8, { target: 42 }).ok, true);
  assert.equal(rewardCheck(38.8, null).ok, true); // không có kế hoạch: không chặn ở bước này
});

test('Mã đầu ngành: ngành mua ròng, đủ lớn, mã điểm cao nhất trước', () => {
  const rows = [{ symbol: 'MSB', score: 88, aboveMa200: true }, { symbol: 'VPB', score: 75, aboveMa200: true }, { symbol: 'HPG', score: 56 }, { symbol: 'DXG', score: 90 }];
  const lead = sectorLeaders(flows, rows);
  assert.deepEqual(lead.map((s) => s.name), ['Ngân hàng', 'Thép & Kim loại', 'A', 'B']); // bỏ BĐS (bán ròng), ngành nhỏ
  assert.deepEqual(lead[0].leaders.map((l) => l.symbol), ['MSB', 'VPB']);
});

const flows = {
  sectors: [
    { name: 'Ngân hàng', net: 900e9, count: 15, stocks: [{ symbol: 'MSB' }, { symbol: 'VPB' }] },
    { name: 'Thép & Kim loại', net: 300e9, count: 6, stocks: [{ symbol: 'HPG' }] },
    { name: 'A', net: 10e9, count: 4, stocks: [] }, { name: 'B', net: 5e9, count: 4, stocks: [] }, { name: 'C', net: 1e9, count: 4, stocks: [] },
    { name: 'Điện', net: 2e9, count: 5, stocks: [{ symbol: 'NT2' }] }, // hạng 6, vẫn mua ròng
    { name: 'Bất động sản', net: -500e9, count: 20, stocks: [{ symbol: 'DXG' }] },
    { name: 'Nhỏ', net: 50e9, count: 2, stocks: [{ symbol: 'XYZ' }] },
  ],
};

test('Hạng ngành: top 5 > đang mua ròng > bán ròng > ngành nhỏ / không rõ', () => {
  const m = sectorMap(flows);
  assert.equal(sectorTier(m.get('MSB')), 0);
  assert.equal(sectorTier(m.get('NT2')), 1);
  assert.equal(sectorTier(m.get('DXG')), 2);
  assert.equal(sectorTier(m.get('XYZ')), 3);
  assert.equal(sectorTier(undefined), 3);
});

test('Sắp ứng viên: ngành mạnh trước, cùng hạng thì điểm cao trước', () => {
  const m = sectorMap(flows);
  const rows = [
    { symbol: 'DXG', score: 95 }, { symbol: 'NT2', score: 90 }, { symbol: 'HPG', score: 72 },
    { symbol: 'MSB', score: 80 }, { symbol: 'ZZZ', score: 99 },
  ];
  assert.deepEqual(orderBySector(rows, m).map((r) => r.symbol), ['MSB', 'HPG', 'NT2', 'DXG', 'ZZZ']);
});

const good = { epsTTM: 2000, roe: 0.18, debtToEquity: 0.8 };
const bars = Array.from({ length: 20 }, (_, i) => ({ close: 30, high: 30 + (i % 4) / 2, low: 29, volume: 1_000_000 })); // 30 tỷ/phiên
const stock = (f, extra = {}) => ({ fundamental: { data: f }, price: { close: 30 }, sector: { name: 'Thép' }, recentBars: bars, ...extra });

test('Mã rác: lỗ, ROE thấp, nợ cao, penny kém, thiếu số liệu, thanh khoản không đều', () => {
  assert.equal(junkCheck(stock(good)).junk, false);
  assert.match(junkCheck(stock({ ...good, epsTTM: -100 })).reasons[0], /lỗ/);
  assert.equal(junkCheck(stock({ ...good, roe: 0.03 })).junk, true);
  assert.equal(junkCheck(stock({ ...good, debtToEquity: 4 })).junk, true);
  assert.equal(junkCheck(stock({ ...good, debtToEquity: 8 }, { sector: { name: 'Ngân hàng' } })).junk, false); // đòn bẩy là mô hình kinh doanh
  assert.equal(junkCheck(stock({ ...good, roe: 0.08 }, { price: { close: 7 } })).junk, true); // penny ROE thấp
  assert.equal(junkCheck(stock(good, { price: { close: 7 } })).junk, false); // penny nhưng hiệu quả tốt
  assert.equal(junkCheck(stock(null)).junk, true);
  const thin = bars.map((b, i) => (i % 3 ? b : { close: 30, volume: 50_000 })); // 7/20 phiên chỉ 1,5 tỷ
  assert.equal(junkCheck(stock(good, { recentBars: thin })).junk, true);
  const pinned = bars.map((b) => ({ ...b, close: 48, high: 48.1, low: 47.8 })); // NAF 10/2026: biên độ 0,6%/20 phiên
  assert.match(junkCheck(stock(good, { recentBars: pinned })).reasons[0], /bị ghim/);
  const dumped = stock(good, { technical: { flow: { ratio20: -18, net5: -25e9 } } });
  assert.equal(junkCheck(dumped).junk, true);
  assert.match(junkCheck(dumped).reasons[0], /khối ngoại xả ròng mạnh/);
  const falling = stock(good, { stockRisk: { isRisky: true, reasons: ['Rơi tự do 5 phiên (-14%)'] } });
  assert.equal(junkCheck(falling).junk, true);
  assert.match(junkCheck(falling).reasons[0], /rủi ro cao/);
});
