import test from 'node:test';
import assert from 'node:assert/strict';
import { positionSize, tailLoss, portfolioHeat } from '../src/sizing.js';
import { sessionProgress, markPartial, projectedVolume } from '../src/data.js';
import { evaluateMarketRegime } from '../src/regime.js';
import { sanitizePriority } from '../src/prioritize.js';

const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
// Chuỗi giá có một số phiên giảm sâu để đuôi trái dày
const fatBars = Array.from({ length: 260 }, (_, i) => {
  const c = 20 * (1 + 0.01 * Math.sin(i)) * (i % 25 === 0 ? 0.93 : 1);
  return { time: day(i), open: c, high: c, low: c, close: c, volume: 1e6 };
});

test('positionSize: có đuôi dày thì mua ít hơn so với chỉ dùng khoảng cách cắt lỗ', () => {
  const plain = positionSize(20, 19);
  const tail = positionSize(20, 19, { bars: fatBars });
  assert.equal(plain.weight, 0.2);
  assert.ok(tail.effectiveLoss > 0.05);
  assert.ok(tail.weight < plain.weight);
  assert.equal(tail.binding, 'risk');
  const t = tailLoss(fatBars);
  assert.ok(t.cvar1 > 0 && t.cvar3 >= t.cvar1 * 0.5);
});

test('positionSize: thanh khoản, heat và ngành chặn tỷ trọng khi biết vốn', () => {
  // Vốn 10 tỷ, mã khớp TB 5 tỷ/phiên: ≤ 10% × 5 tỷ = 0,5 tỷ = 5% vốn
  const liq = positionSize(20, 19, { value20: 5e9, capital: 1e10 });
  assert.equal(liq.binding, 'liquidity');
  assert.equal(liq.weight, 0.05);
  // Danh mục đã mở rủi ro 5,5%/6%: còn 0,5% / 5% = 10%
  const heat = positionSize(20, 19, { capital: 1e9, heat: 0.055 });
  assert.equal(heat.binding, 'heat');
  assert.equal(heat.weight, 0.1);
  // Đã giữ 2 mã cùng ngành: không mở thêm
  const sec = positionSize(20, 19, { capital: 1e9, sector: { name: 'Thép', weight: 0.1, count: 2 } });
  assert.equal(sec.weight, 0);
  assert.equal(sec.binding, 'sectorCount');
  // Không biết vốn: bỏ qua thanh khoản/heat, vẫn áp giới hạn số mã ngành
  assert.equal(positionSize(20, 19, { value20: 5e9, heat: 0.06 }).weight, 0.2);
});

test('portfolioHeat: vị thế không có / đã thủng cắt lỗ tính như mất 7%', () => {
  const h = portfolioHeat([
    { value: 1e8, close: 20, stop: 19 }, // 5%
    { value: 1e8, close: 20, stop: null }, // 7%
    { value: 1e8, close: 18, stop: 19 }, // đã thủng → 7%
  ], 1e9);
  assert.ok(Math.abs(h - 0.019) < 1e-9);
  assert.equal(portfolioHeat([], null), null);
});

test('markPartial / projectedVolume: nến hôm nay chưa chốt được đánh dấu và ước tính khối lượng cả phiên', () => {
  // 10:15 giờ VN = 03:15 UTC: đã qua 75/255 phút giao dịch
  const now = new Date('2026-10-28T03:15:00Z');
  const s = sessionProgress(now);
  assert.equal(s.date, '2026-10-28');
  assert.ok(Math.abs(s.progress - 75 / 255) < 1e-9);
  assert.equal(s.closed, false);
  const bars = markPartial([{ time: '2026-10-27', volume: 1000 }, { time: '2026-10-28', volume: 300 }], now);
  assert.equal(bars[1].partial, true);
  assert.ok(Math.abs(projectedVolume(bars[1]) - 300 / (75 / 255)) < 1e-6);
  assert.equal(projectedVolume(bars[0]), 1000);
  // Sau 15:00 nến đã chốt
  const after = markPartial([{ time: '2026-10-28', volume: 300 }], new Date('2026-10-28T08:05:00Z'));
  assert.equal(after[0].partial, undefined);
});

test('evaluateMarketRegime: không đếm nến trong phiên là ngày phân phối', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ time: day(i), close: 1000 + i * 5, volume: 50000 }));
  const withDist = [...bars, { time: day(60), close: 1290, volume: 60000 }]; // giảm 0,3% kèm khối lượng cao hơn
  assert.equal(evaluateMarketRegime(withDist).distDays, 1);
  const partial = [...bars, { time: day(60), close: 1290, volume: 60000, partial: true, progress: 0.5 }];
  assert.equal(evaluateMarketRegime(partial).distDays, 0);
});

test('sanitizePriority: tối đa 3 mã một ngành, mã trần tỷ trọng 0 chuyển ĐỂ SAU', () => {
  const f = (symbol, sector, maxWeightPct = 10) => ({ symbol, sector, maxWeightPct, zone: 'trong vùng mua', final: 'NÊN MUA', rankScore: 80, riskReward: 2 });
  const facts = [f('HPG', 'Thép'), f('HSG', 'Thép'), f('POM', 'Thép'), f('NKG', 'Thép'), f('FPT', 'Công nghệ', 0)];
  const out = sanitizePriority({ items: facts.map((x) => ({ symbol: x.symbol, tier: 'NEN_MUA', weightPct: 8, reason: 'x' })) }, facts);
  const by = Object.fromEntries(out.items.map((x) => [x.symbol, x]));
  assert.equal(by.NKG.tier, 'CHUA_MUA');
  assert.equal(by.NKG.weightPct, 0);
  assert.notEqual(by.HPG.tier, 'CHUA_MUA');
  assert.equal(by.FPT.tier, 'CHUA_MUA');
});
