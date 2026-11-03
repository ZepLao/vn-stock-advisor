import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earningsReader, reversalReader, sectorMomentum } from '../src/factorlab.js';

const day = (k) => new Date(Date.UTC(2024, 0, 1) + k * 86400_000).toISOString().slice(0, 10);
const bars = Array.from({ length: 400 }, (_, k) => ({ time: day(k), close: 10 + k * 0.01 }));
const at = (date) => bars.findIndex((b) => b.time === date);

test('earningsReader: chỉ dùng quý đã công bố, chỉ trong 60 ngày sau công bố, so với cùng kỳ năm trước', () => {
  const q = [
    { fiscal: '2023-03-31', available: '2023-05-15', profit: 100 },
    { fiscal: '2024-03-31', available: '2024-05-15', profit: 150 },
  ];
  const read = earningsReader(bars, q);
  assert.equal(read(at('2024-05-14')), null); // quý 1/2024 chưa công bố; quý cũ đã quá 60 ngày
  assert.equal(read(at('2024-05-15')), 0.5); // ngày công bố
  assert.equal(read(at('2024-07-14')), 0.5); // 60 ngày sau
  assert.equal(read(at('2024-07-15')), null); // quá 60 ngày
});

test('earningsReader: cùng kỳ lỗ hoặc thiếu thì không tính', () => {
  const read = earningsReader(bars, [
    { fiscal: '2023-03-31', available: '2023-05-15', profit: -20 },
    { fiscal: '2024-03-31', available: '2024-05-15', profit: 50 },
  ]);
  assert.equal(read(at('2024-05-20')), null);
  assert.equal(earningsReader(bars, [{ fiscal: '2024-03-31', available: '2024-05-15', profit: 50 }])(at('2024-05-20')), null);
});

test('reversalReader: lãi 5 phiên, chỉ dùng dữ liệu đến phiên i', () => {
  const b = [10, 10, 10, 10, 10, 9, 20].map((close, k) => ({ time: day(k), close }));
  const r = reversalReader(b);
  assert.equal(r(4), null);
  assert.ok(Math.abs(r(5) - -0.1) < 1e-12);
  assert.equal(r(5), reversalReader(b.slice(0, 6))(5)); // phiên 6 tăng vọt không ảnh hưởng phiên 5
});

test('sectorMomentum: trung bình ngành, bỏ tháng gần nhất, ngành ít hơn 3 mã thì không tính', () => {
  const mk = (rate) => {
    const bs = Array.from({ length: 200 }, (_, k) => ({ time: day(k), close: 10 * (1 + rate) ** k }));
    return { bars: bs, at: new Map(bs.map((x, k) => [x.time, k])) };
  };
  const data = { A: mk(0.01), B: mk(0.01), C: mk(0.01), D: mk(0.02), E: mk(0.02) };
  const sec = { A: 'X', B: 'X', C: 'X', D: 'Y', E: 'Y' };
  const f = sectorMomentum(data, (s) => sec[s]);
  const d = day(150);
  assert.ok(Math.abs(f('A', d) - (1.01 ** 105 - 1)) < 1e-9); // từ phiên 150−126 đến 150−21
  assert.equal(f('D', d), null); // ngành Y chỉ có 2 mã
  assert.equal(f('A', day(100)), null); // chưa đủ 126 phiên
});
