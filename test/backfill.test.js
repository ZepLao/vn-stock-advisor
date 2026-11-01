import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthStarts, quarterRows } from '../src/backfill.js';

test('monthStarts: phiên đầu tiên mỗi tháng, bỏ ngày trước mốc bắt đầu', () => {
  const cal = ['2024-01-30', '2024-01-31', '2024-02-01', '2024-02-02', '2024-03-04', '2024-03-05'].map((time) => ({ time }));
  assert.deepEqual(monthStarts(cal, '2024-01-01'), ['2024-01-30', '2024-02-01', '2024-03-04']);
  assert.deepEqual(monthStarts(cal, '2024-02-02'), ['2024-02-02', '2024-03-04']);
});

test('quarterRows: ngày được dùng = cuối quý + 45 ngày, bỏ quý thiếu ngày', () => {
  const rows = quarterRows('FPT', [
    { date: '2024-03-31', revenue: 100, grossProfit: 40, profit: 20, cfo: 15, equity: 500, assets: 900, bank: false },
    { date: '2024-12-31', revenue: 120, profit: 25, bank: true, netInterest: 50, provision: 5 },
    { date: null, revenue: 1 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].slice(0, 7), ['FPT', '2024-03-31', '2024-05-15', false, 100, 40, 20]);
  assert.equal(rows[1][2], '2025-02-14', 'qua năm mới vẫn cộng đúng 45 ngày');
  assert.equal(rows[1][3], true);
  assert.equal(rows[1][10], 50);
});
