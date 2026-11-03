import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityReader, groupSpread, compareIc, comparePeriods, roeVerdict } from '../src/quality.js';

// 8 quý liên tiếp 2023–2024, công bố sau cuối quý 45 ngày
const ends = ['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31', '2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31'];
const avail = ['2023-05-15', '2023-08-14', '2023-11-14', '2024-02-14', '2024-05-15', '2024-08-14', '2024-11-14', '2025-02-14'];
const mk = (profits, extra = {}) => ends.map((fiscal, k) => ({
  fiscal, available: avail[k], profit: profits[k], revenue: 1000, cfo: profits[k] * 1.2, equity: 1000, assets: 2500, ...extra,
}));

test('qualityReader: chỉ dùng quý đã công bố — trước 15/5/2024 chưa thấy quý 1/2024', () => {
  const read = qualityReader(mk([30, 30, 30, 30, 40, 40, 40, 40]));
  assert.equal(read('2024-02-13'), null, 'mới công bố 3 quý: chưa đủ 4 quý');
  const a = read('2024-05-14');
  assert.equal(a.profitTTM, 120, 'chỉ 4 quý của 2023');
  assert.equal(a.eg, null, 'chưa có quý cùng kỳ năm trước');
  const b = read('2024-05-15');
  assert.equal(b.profitTTM, 130);
  assert.equal(b.eg, 40 / 30 - 1 > 0 ? Math.round((40 / 30 - 1) * 1e4) / 1e4 : null);
});

test('qualityReader: cổ ngon khi có lãi, ROE ≥ 12%, LN 4 quý và LN quý không giảm', () => {
  const read = qualityReader(mk([30, 30, 30, 30, 40, 40, 40, 40]));
  const g = read('2025-03-01');
  assert.equal(g.profitTTM, 160);
  assert.equal(g.roe, 0.16);
  assert.equal(g.profitGrowth, 160 / 120 - 1 > 0 ? Math.round((160 / 120 - 1) * 1e4) / 1e4 : null);
  assert.equal(g.leverage, 1.5);
  assert.equal(g.cfoRatio, 1.2);
  assert.equal(g.pass, true);

  const lowRoe = qualityReader(mk([20, 20, 20, 20, 25, 25, 25, 25]))('2025-03-01');
  assert.equal(lowRoe.checks.roeOk, false, 'ROE 10% < 12%');
  assert.equal(lowRoe.pass, false);

  const dropQ = qualityReader(mk([30, 30, 30, 50, 40, 40, 40, 45]))('2025-03-01');
  assert.equal(dropQ.checks.qUp, false, 'quý 4/2024 45 < quý 4/2023 50');
  assert.equal(dropQ.pass, false);
});

test('qualityReader: thiếu quý giữa chuỗi thì không tính, thiếu năm trước thì không đạt (không xác minh được)', () => {
  const gap = mk([30, 30, 30, 30, 40, 40, 40, 40]).filter((_, k) => k !== 5);
  assert.equal(qualityReader(gap)('2024-12-01'), null, '4 quý gần nhất không liên tiếp');
  const short = qualityReader(mk([30, 30, 30, 30, 40, 40, 40, 40]).slice(4))('2025-03-01');
  assert.equal(short.checks.ttmUp, null);
  assert.equal(short.pass, false);
});

test('qualityReader: ngân hàng không tính đòn bẩy và chất lượng dòng tiền', () => {
  const g = qualityReader(mk([30, 30, 30, 30, 40, 40, 40, 40], { bank: true }))('2025-03-01');
  assert.equal(g.leverage, null);
  assert.equal(g.cfoRatio, null);
  assert.equal(g.bank, true);
});

test('groupSpread: nhóm A lãi hơn B ổn định ở mọi mốc là có ích', () => {
  const A = [], B = [];
  for (let d = 0; d < 40; d++) {
    const date = `2024-${String(1 + Math.floor(d / 4)).padStart(2, '0')}-${String(1 + (d % 4) * 7).padStart(2, '0')}`;
    A.push({ date, v: 0.03 + (d % 3) * 0.005 });
    B.push({ date, v: 0.01 });
  }
  const s = groupSpread(A, B, (x) => x.v, '2024-06-01', 0);
  assert.equal(s.verdict, 'helps');
  assert.ok(s.diff > 0.02);
  assert.equal(groupSpread(B, A, (x) => x.v, '2024-06-01', 0).verdict, 'hurts');
});

test('compareIc: thêm yếu tố có tác dụng thật làm IC tăng ổn định', () => {
  // 40 mốc × 40 mã: lãi = 0,5×a + 0,5×roe (+ nhiễu theo mã); bộ A chỉ có a, b (b vô nghĩa), bộ B có thêm roe
  const samples = [];
  for (let d = 0; d < 40; d++) {
    const rows = [];
    for (let k = 0; k < 40; k++) {
      const a = ((k * 7 + d) % 40) / 40, b = ((k * 13 + d * 3) % 40) / 40, roe = ((k * 11 + d * 5) % 40) / 40;
      rows.push({ f: { a, b, roe }, ex: { 20: 0.5 * a + 0.5 * roe + ((k * 17) % 5) / 100 } });
    }
    samples.push({ date: `2024-${String(1 + Math.floor(d / 4)).padStart(2, '0')}-${String(1 + (d % 4) * 7).padStart(2, '0')}`, rows });
  }
  const A = [{ key: 'a', sign: 1 }, { key: 'b', sign: 1 }], B = [...A, { key: 'roe', sign: 1 }];
  const r = compareIc(samples, A, B, 20, 20);
  assert.ok(r.b.mean > r.a.mean);
  assert.ok(r.diff.t >= 2 && r.diff.first > 0 && r.diff.second > 0);
});

test('comparePeriods + roeVerdict: cần IC tốt hơn VÀ danh mục lãi hơn ở cả hai nửa', () => {
  const pa = Array.from({ length: 20 }, (_, k) => ({ from: `p${String(k).padStart(2, '0')}`, ret: 0.01 }));
  const pb = pa.map((p, k) => ({ ...p, ret: 0.015 + (k % 3) * 0.001 }));
  pb.push({ from: 'open', ret: 0.5, open: true });
  const c = comparePeriods(pa, pb);
  assert.equal(c.periods, 20, 'bỏ kỳ đang mở');
  assert.equal(c.wins, 20);
  const icGood = { diff: { verdict: 'supported', t: 3, first: 0.01, second: 0.01 } };
  assert.equal(roeVerdict(icGood, c), 'adopt');
  assert.equal(roeVerdict({ diff: { ...icGood.diff, second: -0.01 } }, c), 'reject', 'IC tụt ở nửa sau');
  assert.equal(roeVerdict(icGood, comparePeriods(pb, pa)), 'reject', 'danh mục kém hơn');
});

test('foreignReader: mua ròng 20 phiên / giá trị khớp 20 phiên, chỉ dùng dữ liệu đến phiên i', async () => {
  const { foreignReader } = await import('../src/quality.js');
  const bars = Array.from({ length: 25 }, (_, k) => ({ time: `2024-01-${String(k + 1).padStart(2, '0')}`, close: 10, volume: 1000 }));
  const net = new Map(bars.map((b, k) => [b.time, k === 24 ? 1e9 : 100_000]));
  const read = foreignReader(bars, net);
  assert.equal(read(18), null); // chưa đủ 20 phiên
  assert.equal(read(19), (20 * 100_000) / (20 * 10_000_000)); // 1%
  assert.equal(read(23), 0.01); // phiên 24 bán/mua đột biến chưa được nhìn thấy
  assert.equal(read(19), foreignReader(bars, new Map([...net].slice(0, 20)))(19));
  assert.equal(foreignReader(bars, new Map([[bars[19].time, 1]]))(19), null); // thiếu quá nửa số phiên
});
