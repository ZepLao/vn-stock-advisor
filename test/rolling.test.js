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

test('simulateRolling: thoát hết khi thị trường sập (crashBreadth), mặc định thì không', async () => {
  const { cal, data, sectorOf } = fixture({ crashAt: 300 });
  const base = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf });
  assert.equal(base.trades.filter((t) => t.reason === 'crash').length, 0);
  const crash = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf, crashBreadth: 0.25 });
  assert.ok(crash.stats.crashes >= 1);
  assert.ok(crash.trades.some((t) => t.reason === 'crash'), 'mã tăng đều gãy MA50 hàng loạt phải bị bán');
});

test('simulateRolling: lô 100 với vốn nhỏ không mua được, cho phép lô lẻ thì mua được', () => {
  const { cal, data, sectorOf } = fixture();
  const lot100 = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e4 * 1000, sectorOf, slots: 10 }); // 10 triệu, mỗi suất 1 triệu < 100 cp × ~25 nghìn
  const odd = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e4 * 1000, sectorOf, slots: 10, lot: 1, oddLot: 0.003 });
  assert.equal(lot100.positions.length, 0);
  assert.ok(odd.positions.length > 0);
});

test('exposureFor / oddLotCost: nấc tỷ trọng và chi phí phần lô lẻ', async () => {
  const { exposureFor, oddLotCost } = await import('../src/rolling.js');
  const R = { minBreadth: 0.5 };
  assert.equal(exposureFor(0.49, R), 0);
  assert.equal(exposureFor(0.5, R), 1);
  assert.equal(exposureFor(0.35, { ...R, gradedLo: 0.3, gradedFrac: 0.5 }), 0.5);
  assert.equal(exposureFor(0.2, { ...R, gradedLo: 0.3, gradedFrac: 0.5 }), 0);
  assert.equal(exposureFor(0.1, { minBreadth: null }), 1);
  assert.equal(oddLotCost(250, 0.003), 0.003 * (50 / 250));
  assert.equal(oddLotCost(200, 0.003), 0);
});

test('riskVerdict / holdEtf: quy tắc đặt trước và lõi ETF mua một lần', async () => {
  const { riskVerdict, holdEtf } = await import('../src/riskresearch.js');
  const m = (s1, s2, dd) => ({ first: { sharpe: s1 }, second: { sharpe: s2 }, maxDD: dd });
  assert.equal(riskVerdict(m(1.1, 1.2, -0.2), m(1, 1, -0.25)), true);
  assert.equal(riskVerdict(m(1.1, 0.9, -0.2), m(1, 1, -0.25)), false); // một nửa kém hơn
  assert.equal(riskVerdict(m(1.1, 1.2, -0.3), m(1, 1, -0.25)), false); // sụt sâu hơn
  const cal = [{ time: 'a' }, { time: 'b' }, { time: 'c' }];
  const etf = [{ time: 'b', open: 10, close: 11 }, { time: 'c', open: 11, close: 12 }];
  const v = holdEtf(cal, 0, etf, 5_000_000);
  assert.equal(v[0], 5_000_000); // chưa có giá ETF
  // phiên b: mua 400 ccq (lô 100) ở 10 nghìn
  assert.equal(v[2] - v[1], 400 * 1000);
});

test('simulateTranched: 1 phần = mô phỏng thường; 5 phần lệch ngày, cộng đúng tài sản', async () => {
  const { simulateTranched } = await import('../src/rolling.js');
  const { cal, data, sectorOf } = fixture();
  const o = { start: 260, minValue: 0, initialCash: 1e9, sectorOf };
  const one = simulateTranched(cal, data, o, 1);
  const plain = simulateRolling(cal, data, o);
  assert.deepEqual(one.equity.map((e) => e.value), plain.equity.map((e) => e.value));
  const five = simulateTranched(cal, data, o, 5);
  assert.equal(five.equity.length, cal.length - 260);
  assert.equal(five.equity[0].value, 1e9); // phiên đầu chưa phần nào mua
  const last = five.parts.reduce((a, p) => a + p.equity.at(-1).value, 0);
  assert.ok(Math.abs(five.equity.at(-1).value - last) < 1e-3);
  assert.equal(five.parts[3].equity[0].time, cal[263].time); // phần 4 bắt đầu lệch 3 phiên
});

test('robustVerdict: phải hơn B trên bản chia 5 phần VÀ hơn ở ≥ 4/5 lịch đơn', async () => {
  const { robustVerdict } = await import('../src/riskresearch.js');
  const m = (s) => ({ sharpe: s });
  const tr = (s1, s2, dd) => ({ first: { sharpe: s1 }, second: { sharpe: s2 }, maxDD: dd });
  const B = { singles: [m(1), m(1), m(1), m(1), m(1)], tranched: tr(1, 1, -0.25) };
  assert.equal(robustVerdict({ singles: [m(2), m(2), m(2), m(2), m(0)], tranched: tr(1.2, 1.1, -0.2) }, B).ok, true);
  assert.equal(robustVerdict({ singles: [m(2), m(2), m(2), m(0), m(0)], tranched: tr(1.2, 1.1, -0.2) }, B).ok, false); // chỉ 3/5 lịch
  assert.equal(robustVerdict({ singles: [m(2), m(2), m(2), m(2), m(2)], tranched: tr(1.2, 0.9, -0.2) }, B).ok, false); // nửa sau kém
});

test('simulateRolling: maxExposure giữ tiền mặt dự phòng, mặc định đầu tư hết', () => {
  const { cal, data, sectorOf } = fixture();
  const o = { start: 260, minValue: 0, initialCash: 1e9, sectorOf };
  const full = simulateRolling(cal, data, o);
  const kept = simulateRolling(cal, data, { ...o, maxExposure: 0.7 });
  const cashShare = (sim) => Math.min(...sim.equity.slice(20).map((e) => e.cash / e.value));
  // dữ liệu mẫu chỉ có 6 suất (2 ngành × 3 mã): đầu tư hết = 60%, giữ dự phòng = 6 × 7% = 42%
  assert.ok(cashShare(kept) > cashShare(full) + 0.12, 'mỗi suất nhỏ lại 30%');
  assert.equal(kept.positions.length, full.positions.length, 'vẫn chia đủ số mã');
});

test('simulateRolling: maxNew mua rải dần, mỗi lần tối đa N mã, không trùng mã', () => {
  const { cal, data, sectorOf } = fixture();
  const sim = simulateRolling(cal, data, { start: 260, minValue: 0, initialCash: 1e9, sectorOf, step: 1, maxNew: 2 });
  const byEntry = {};
  for (const t of sim.trades) byEntry[t.entryTime] = (byEntry[t.entryTime] || 0) + 1;
  const open = sim.positions.length;
  assert.ok(open > 0);
  assert.ok(Object.values(byEntry).every((n) => n <= 2), 'mỗi phiên mua tối đa 2 mã');
  assert.equal(new Set(sim.positions).size, sim.positions.length);
});

test('simulateRolling: volScale giảm tỷ trọng khi VN-Index biến động mạnh', () => {
  const { cal, data, sectorOf } = fixture();
  // VN-Index êm đến phiên 330 rồi dao động rất mạnh
  const wild = cal.map((b, i) => ({ ...b, close: i < 330 ? 1000 + i * 0.5 : 1000 * (1 + (i % 2 ? 0.04 : -0.04)) }));
  const o = { start: 260, minValue: 0, initialCash: 1e9, sectorOf };
  const calm = simulateRolling(wild, data, o);
  const scaled = simulateRolling(wild, data, { ...o, volScale: true });
  const late = (sim) => sim.equity.slice(-40).reduce((a, e) => a + (1 - e.cash / e.value), 0) / 40;
  assert.ok(late(scaled) < late(calm) - 0.1, `tỷ trọng cổ phiếu cuối kỳ ${late(scaled).toFixed(2)} phải thấp hơn ${late(calm).toFixed(2)}`);
});

test('rollingCandidates: dùng bộ yếu tố truyền vào', async () => {
  const { rollingCandidates } = await import('../src/rolling.js');
  const rows = Array.from({ length: 40 }, (_, k) => ({ s: `X${k}`, vol: 0.02, f: { mom: k, high: 0, atr: 0.02, adx: 20, aboveMa200: true, ey: 40 - k, bp: 40 - k } }));
  const a = rollingCandidates(rows).cands.map((c) => c.s);
  const b = rollingCandidates(rows, [{ key: 'ey', sign: 1 }, { key: 'bp', sign: 1 }]).cands.map((c) => c.s);
  assert.ok(a.slice(0, 3).includes('X39') && !a.slice(0, 3).includes('X0'), 'động lượng cao nhất đứng đầu');
  assert.ok(b.slice(0, 3).includes('X0') && !b.slice(0, 3).includes('X39'), 'rẻ nhất theo E/P đứng đầu');
});

test('valueReader: chỉ dùng P/E, P/B từ 45 ngày trước, quy về giá hiện tại; lỗ thì bỏ', async () => {
  const { valueReader } = await import('../src/riskresearch.js');
  const bars = Array.from({ length: 120 }, (_, k) => ({ time: day(k), close: k < 60 ? 10 : 20 }));
  const pe = [{ date: day(0), value: 10 }, { date: day(80), value: 5 }]; // P/E đổi ở ngày 80: chưa được dùng trước ngày 125
  const pb = [{ date: day(0), value: 2 }];
  const r = valueReader(bars, pe, pb);
  assert.equal(r(30).ey, null); // trước ngày 45 chưa có số liệu đủ trễ
  assert.ok(Math.abs(r(50).ey - 0.1) < 1e-12); // E/P = 1/10, giá không đổi
  assert.ok(Math.abs(r(100).ey - 0.05) < 1e-12); // vẫn dùng P/E ngày 0 (= 1/10) nhưng giá đã gấp đôi
  assert.ok(Math.abs(r(100).bp - 0.25) < 1e-12);
  assert.equal(valueReader(bars, [{ date: day(0), value: -3 }], pb)(100).ey, null);
});
