import test from 'node:test';
import assert from 'node:assert/strict';
import { spearman, neweyWest, testSeries, dailyIc, scoreOf, confidenceOf, verifyFromScored } from '../src/verify.js';

const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
// Bộ sinh số có seed để test lặp lại được
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}

test('spearman: đơn điệu = 1, ngược = −1, có giá trị bằng nhau vẫn đúng', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.ok(Math.abs(spearman([1, 1, 2, 3], [1, 2, 3, 4]) - 0.9487) < 1e-3);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
});

test('neweyWest: chuỗi tương quan dương làm sai số chuẩn lớn hơn cách tính độc lập', () => {
  const r = rng(1);
  let x = 0;
  const s = Array.from({ length: 400 }, () => (x = 0.8 * x + (r() - 0.5)));
  const iid = neweyWest(s, 0), nw = neweyWest(s, 10);
  assert.ok(nw.se > iid.se * 1.5, `NW ${nw.se} phải lớn hơn rõ so với ${iid.se}`);
  assert.equal(neweyWest([1, 2], 1).se, null);
});

test('testSeries: chưa đủ phiên, ủng hộ, bác bỏ, chưa kết luận; ước tính số phiên cần', () => {
  const r = rng(2);
  const noise = (m, n) => Array.from({ length: n }, () => m + (r() - 0.5) * 0.2);
  assert.equal(testSeries(noise(0.1, 10), 0, 0.04).verdict, 'insufficient');
  assert.equal(testSeries(noise(0.05, 200), 0, 0.04).verdict, 'supported');
  assert.equal(testSeries(noise(-0.05, 200), 0, 0.04).verdict, 'rejected');
  const flat = testSeries(noise(0, 40), 0, 0.01);
  assert.equal(flat.verdict, 'inconclusive');
  // σ ≈ 0,2/√12 ≈ 0,058 → cần ≈ (2 × 0,058 / 0,01)² ≈ 133 phiên
  assert.ok(flat.needDatesPrior > 90 && flat.needDatesPrior < 190, `${flat.needDatesPrior}`);
});

test('scoreOf / confidenceOf đọc được bản ghi cũ chỉ có mô tả', () => {
  assert.equal(scoreOf({ detail: 'Xếp hạng 82' }), 82);
  assert.equal(scoreOf({ detail: 'Điểm cũ -15' }), -15);
  assert.equal(scoreOf({ score: 70, detail: 'Xếp hạng 82' }), 70);
  assert.equal(confidenceOf({ detail: 'Tin cậy 72%' }), 72);
  assert.equal(confidenceOf({ detail: 'x' }), null);
});

// Rổ giả lập 40 phiên × 30 mã: lãi hơn rổ = 0,001 × điểm + nhiễu → IC dương
function fixture(edge = 0.001) {
  const r = rng(3);
  const scored = [];
  for (let d = 0; d < 40; d++) {
    for (let k = 0; k < 30; k++) {
      const score = Math.round(r() * 100);
      const ex = edge * (score - 50) + (r() - 0.5) * 0.08;
      const res = Object.fromEntries([5, 10, 20].map((h) => [h, { excessBasket: ex, beatBasket: ex > 0, exit: 10 * (1 + ex), ret: ex }]));
      scored.push({ source: 'rank_all', symbol: `S${k}`, date: day(d), score, direction: score >= 70 ? 1 : 0, result: res, band: { 5: [9, 11] } });
    }
  }
  return scored;
}

test('dailyIc / verifyFromScored: phát hiện IC dương, nhóm mua hơn rổ, dải quá rộng', () => {
  const scored = fixture();
  const ic = dailyIc(scored.filter((x) => x.source === 'rank_all'), 5);
  assert.equal(ic.length, 40);
  assert.ok(ic.every((x) => x.ic > 0.2));
  const v = verifyFromScored(scored);
  const H = Object.fromEntries(v.hypotheses.map((h) => [h.id, h]));
  assert.equal(H.H1.verdict, 'supported');
  assert.equal(H.H2.verdict, 'supported');
  assert.equal(H.H3.verdict, 'rejected'); // dải 9–11 chứa ~100% giá (lãi ±~10%) → quá rộng
  assert.equal(H.H3.note, 'dải quá rộng');
  assert.equal(H.H4.verdict, 'insufficient'); // chưa có cặp quyết định cuối / luật
  assert.equal(v.versions.legacy, scored.length);
  // Không có lợi thế: IC không được báo là ủng hộ
  const none = verifyFromScored(fixture(0));
  assert.notEqual(none.hypotheses[0].verdict, 'supported');
});

test('H5: mô hình v2 sắp thứ tự tốt hơn v1 trên cùng phiên thì ủng hộ; như nhau thì không', () => {
  const r = rng(11);
  const scored = [];
  for (let d = 0; d < 40; d++) {
    for (let k = 0; k < 30; k++) {
      const v2 = r() * 100, noise = r() * 100;
      const ex = 0.0008 * (v2 - 50) + (r() - 0.5) * 0.08;
      const res = { 5: { excessBasket: ex }, 10: { excessBasket: ex }, 20: { excessBasket: ex } };
      scored.push({ source: 'rank_all', symbol: `S${k}`, date: day(d), score: Math.round(noise), direction: 0, result: res });
      scored.push({ source: 'rank_v2', symbol: `S${k}`, date: day(d), score: Math.round(v2), direction: 0, result: res });
    }
  }
  const h5 = verifyFromScored(scored).hypotheses.find((h) => h.id === 'H5');
  assert.equal(h5.verdict, 'supported');
  assert.ok(h5.icV2 > 0.1);
  const same = scored.map((x) => (x.source === 'rank_v2' ? { ...x, score: scored.find((y) => y.source === 'rank_all' && y.symbol === x.symbol && y.date === x.date).score } : x));
  assert.notEqual(verifyFromScored(same).hypotheses.find((h) => h.id === 'H5').verdict, 'supported');
});

test('H6: điểm +ROE sắp thứ tự tốt hơn điểm 4 yếu tố (IC 20 phiên) thì ủng hộ; như nhau thì không', () => {
  const r = rng(17);
  const scored = [];
  for (let d = 0; d < 60; d++) {
    for (let k = 0; k < 30; k++) {
      const roe = r() * 100, noise = r() * 100;
      const ex = 0.0008 * (roe - 50) + (r() - 0.5) * 0.08;
      const res = { 5: { excessBasket: ex }, 10: { excessBasket: ex }, 20: { excessBasket: ex } };
      scored.push({ source: 'rank_all', symbol: `S${k}`, date: day(d), score: Math.round(noise), direction: 0, result: res });
      scored.push({ source: 'rank_roe', symbol: `S${k}`, date: day(d), score: Math.round(roe), direction: 0, result: res });
    }
  }
  const h6 = verifyFromScored(scored).hypotheses.find((h) => h.id === 'H6');
  assert.equal(h6.h, 20);
  assert.equal(h6.verdict, 'supported');
  assert.ok(h6.icRoe > 0.1);
  const same = scored.map((x) => (x.source === 'rank_roe' ? { ...x, score: scored.find((y) => y.source === 'rank_all' && y.symbol === x.symbol && y.date === x.date).score } : x));
  assert.notEqual(verifyFromScored(same).hypotheses.find((h) => h.id === 'H6').verdict, 'supported');
});
