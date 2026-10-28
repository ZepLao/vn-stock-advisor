import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateRolling } from '../src/rolling.js';
import { factorReader } from '../src/ranking.js';

const day = (i) => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10);
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

// 12 mã tăng đều (ứng viên) chia 2 ngành, 12 mã đi xuống biến động mạnh (không là ứng viên)
function fixture({ crashAt = null } = {}) {
  const N = 420, r = rng(3);
  const cal = Array.from({ length: N }, (_, i) => ({ time: day(i), open: 1000, close: 1000 }));
  const data = {};
  for (let k = 0; k < 24; k++) {
    const up = k < 12;
    let c = 20;
    const bars = Array.from({ length: N }, (_, i) => {
      c *= up ? 1.002 + (r() - 0.5) * 0.004 : 0.999 + (r() - 0.5) * 0.04;
      if (up && crashAt != null && i >= crashAt && i < crashAt + 5) c *= 0.93; // giảm ~30% trong 5 phiên
      return { time: day(i), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1e6 };
    });
    data[`S${k}`] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars), ex: 'HOSE' };
  }
  return { cal, data, sectorOf: (s) => (Number(s.slice(1)) % 2 ? 'A' : 'B') };
}

test('simulateRolling: tối đa N mã, mỗi ngành tối đa K, chỉ mua ứng viên', () => {
  const { cal, data, sectorOf } = fixture();
  const sim = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf, slots: 6, perSector: 2 });
  assert.ok(sim.positions.length <= 4); // 2 ngành × 2 mã
  const bySec = {};
  for (const s of sim.positions) bySec[sectorOf(s)] = (bySec[sectorOf(s)] || 0) + 1;
  assert.ok(Object.values(bySec).every((n) => n <= 2));
  assert.ok(sim.positions.every((s) => Number(s.slice(1)) < 12), 'chỉ giữ mã tăng đều (ứng viên)');
});

test('simulateRolling: mã vẫn là ứng viên khi đến hạn thì giữ tiếp, không bán rồi mua lại', () => {
  const { cal, data, sectorOf } = fixture();
  const sim = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf, hold: 40 });
  assert.ok(sim.stats.kept > 0);
  assert.equal(sim.trades.filter((t) => t.reason === 'hold_end').length, 0);
});

test('simulateRolling: không cắt lỗ theo mặc định; bật stopPct thì cắt khi lỗ vượt ngưỡng', () => {
  const { cal, data, sectorOf } = fixture({ crashAt: 300 });
  const base = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf });
  assert.equal(base.trades.filter((t) => t.reason === 'stop').length, 0);
  const stopped = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf, stopPct: 0.15 });
  assert.ok(stopped.trades.some((t) => t.reason === 'stop'), 'giảm ~30% phải bị cắt lỗ 15%');
});
