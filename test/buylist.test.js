import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBuyList } from '../src/buylist.js';

const R = { slots: 4, perSector: 2, maxExposure: 0.7, minBreadth: 0.5 };
const row = (symbol, score, sector, extra = {}) => ({ symbol, score, sector, close: 20, aboveMa200: true, avoid: false, ...extra });
const rows = [
  row('A', 95, 'Ngân hàng'), row('B', 90, 'Ngân hàng'), row('C', 88, 'Ngân hàng'), row('D', 85, 'Thép'),
  row('E', 80, 'Thép', { aboveMa200: false }), row('F', 60, 'Bán lẻ', { trendPick: true }), row('G', 99, 'Bán lẻ', { avoid: true }), row('H', 50, 'Dầu khí'),
];

test('buildBuyList: đúng luật tool — điểm ≥ 70 trên MA200 hoặc xu hướng chuẩn, bỏ ⛔, mỗi ngành tối đa, số mã tối đa', () => {
  const r = buildBuyList({ rows, breadth: 0.6, nav: 10_000_000 }, R);
  assert.deepEqual(r.picks.map((p) => p.symbol), ['A', 'B', 'D', 'F']); // C quá 2 mã ngân hàng, E dưới MA200, G ⛔, H điểm thấp
  assert.equal(r.gated, false);
  assert.equal(r.picks[0].budget, 1_750_000); // 10 triệu × 70% / 4 mã
  assert.equal(r.picks[0].shares, Math.floor(1_750_000 / (20 * 1000 * 1.0015)));
});

test('buildBuyList: thị trường yếu thì báo chưa mua mới', () => {
  const r = buildBuyList({ rows, breadth: 0.3, nav: null }, R);
  assert.equal(r.gated, true);
  assert.match(r.action, /Chưa mua mới/);
  assert.equal(r.picks[0].budget, null);
});
