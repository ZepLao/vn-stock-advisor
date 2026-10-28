import test from 'node:test';
import assert from 'node:assert/strict';
import { factorPanel, compositeOf, evaluateScore, adoptVerdict, runResearch } from '../src/research.js';

const day = (i) => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10);
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

test('factorPanel: chỉ dùng dữ liệu đến phiên i (đổi tương lai không đổi giá trị quá khứ)', () => {
  const r = rng(1);
  let c = 20;
  const bars = Array.from({ length: 320 }, (_, i) => { c *= 1 + (r() - 0.5) * 0.03; return { time: day(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 }; });
  const f = factorPanel(bars)(280);
  const changed = bars.map((b, i) => (i > 280 ? { ...b, close: b.close * 3, high: b.high * 3, volume: 1 } : b));
  assert.deepEqual(factorPanel(changed)(280), f);
  assert.ok(Math.abs(f.rev1m - (bars[280].close / bars[260].close - 1)) < 1e-12);
  assert.ok(f.maxret >= 0 && f.ivol > 0 && f.attention > 0);
  assert.equal(factorPanel(bars)(100), null);
});

// Mẫu giả: 60 mốc × 40 mã; yếu tố "sig" báo trước lãi hơn rổ, "noise" không; "flip" đổi chiều giữa hai nửa
function samples() {
  const r = rng(7);
  return Array.from({ length: 60 }, (_, d) => ({
    date: day(d * 5),
    rows: Array.from({ length: 40 }, (_, k) => {
      const sig = r(), noise = r(), flip = r();
      const ex = 0.04 * (sig - 0.5) + 0.04 * (flip - 0.5) * (d < 30 ? 1 : -1) + (r() - 0.5) * 0.06;
      return { s: `S${k}`, f: { sig, noise, flip, mom: sig, high: sig, atr: 1 - sig, adx: noise }, ex: { 5: ex, 20: ex } };
    }),
  }));
}

test('evaluateScore / adoptVerdict: nhận yếu tố thật, loại nhiễu và yếu tố đổi chiều giữa hai nửa', () => {
  const s = samples();
  const sig = evaluateScore(s, (rows) => rows.map((x) => x.f.sig), 5);
  assert.equal(adoptVerdict(sig), 'adopt');
  assert.ok(sig.all.spread > 0.01);
  assert.notEqual(adoptVerdict(evaluateScore(s, (rows) => rows.map((x) => x.f.noise), 5)), 'adopt');
  assert.equal(adoptVerdict(evaluateScore(s, (rows) => rows.map((x) => x.f.flip), 5)), 'unstable');
  assert.equal(adoptVerdict(evaluateScore(s, (rows) => rows.map((x) => -x.f.sig), 5)), 'adopt_reversed');
});

test('compositeOf: trung bình phân vị theo chiều; thiếu yếu tố vẫn tính khi đủ 2', () => {
  const rows = [{ f: { a: 1, b: 10 } }, { f: { a: 2, b: 5 } }, { f: { a: 3, b: null } }];
  const sc = compositeOf(rows, [{ key: 'a', sign: 1 }, { key: 'b', sign: -1 }]);
  assert.ok(sc[1] > sc[0]); // a cao hơn và b thấp hơn
  assert.equal(sc[2], null); // chỉ có 1 yếu tố
});

test('runResearch: tổ hợp "robust" chỉ gồm yếu tố đạt quy tắc', () => {
  const out = runResearch(samples());
  const robust = out.variants.find((v) => v.key === 'robust');
  assert.ok(robust.keys.includes('+sig') === false); // "sig" không nằm trong danh sách ứng viên đăng ký trước
  const mom = out.factors.find((f) => f.key === 'mom');
  assert.equal(mom[20].verdict, 'adopt');
  assert.ok(robust.keys.includes('+mom') && robust.keys.includes('−atr'));
  assert.ok(!robust.keys.some((k) => k.endsWith('adx')));
});
