// Nghiên cứu yếu tố dự báo trên dữ liệu theo thời điểm (rổ tại từng mốc, gồm mã sau này hủy niêm yết), để nâng cấp điểm
// xếp hạng có căn cứ thay vì thêm chỉ báo theo cảm tính.
//
// ĐĂNG KÝ TRƯỚC (không thêm / bớt sau khi xem kết quả):
//  - Danh sách ứng viên CANDIDATES (4 yếu tố đang dùng + 8 yếu tố mới, đều tính được theo thời điểm) và chiều kỳ vọng.
//  - Thước đo: IC = tương quan thứ hạng Spearman giữa yếu tố và lãi hơn rổ h phiên (mua mở cửa phiên sau), mỗi mốc
//    (cách EXPECT_STEP phiên) một giá trị, t Newey-West. Kèm chênh lệch nhóm 20% cao nhất − 20% thấp nhất.
//  - Quy tắc chấp nhận một yếu tố (ADOPT_RULE): |t| ≥ 2 trên toàn giai đoạn VÀ IC cùng dấu ở cả hai nửa thời gian.
//  - Tổ hợp thử (VARIANTS) cố định trước; chọn tổ hợp theo IC ở CẢ HAI NỬA, không theo số đẹp nhất một lần.
import { avgTradedValue, DELIST_HAIRCUT, DELIST_GAP } from './data.js';
import { spearman, testSeries } from './verify.js';
import { earningsReader } from './ranking.js';
import { getQuarterly } from './company.js';
import { poolMap } from './ranking.js';
import { loadPanel, EXPECT_STEP } from './expectancy.js';
import { factorPanel } from './factors.js';

export { factorPanel };

export const ADOPT_RULE = { t: 2 };
export const RESEARCH_HORIZONS = [5, 20];

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

/**
 * Ứng viên: key, nhãn, chiều kỳ vọng (sign: +1 giá trị cao tốt, −1 giá trị thấp tốt, 0 = chưa có giả thuyết), nhóm.
 * Giá trị đọc từ panel(i) chỉ dùng dữ liệu đến phiên i.
 */
export const CANDIDATES = [
  { key: 'mom', label: 'Động lượng 12 tháng bỏ tháng gần nhất', sign: 1, current: true },
  { key: 'high', label: 'Gần đỉnh 52 tuần', sign: 1, current: true },
  { key: 'atr', label: 'Biến động thấp (ATR%)', sign: -1, current: true },
  { key: 'adx', label: 'Xu hướng rõ (ADX)', sign: 1, current: true },
  { key: 'rev1m', label: 'Đảo chiều 1 tháng (lãi 20 phiên)', sign: -1 },
  { key: 'mom6', label: 'Động lượng 6 tháng bỏ tháng gần nhất', sign: 1 },
  { key: 'ivol', label: 'Biến động 60 phiên (độ lệch chuẩn lãi ngày)', sign: -1 },
  { key: 'maxret', label: 'Lãi ngày lớn nhất 20 phiên ("vé số")', sign: -1 },
  { key: 'amihud', label: 'Kém thanh khoản (Amihud 20 phiên)', sign: 1 },
  { key: 'attention', label: 'Độ chú ý: giá trị GD 5 phiên / 60 phiên', sign: 0 },
  { key: 'ma200', label: 'Khoảng cách tới MA200', sign: 1 },
  { key: 'eg', label: 'Tăng trưởng LN quý gần nhất đã công bố (trễ 45 ngày)', sign: 1 },
];

/**
 * Bảng mẫu theo mốc: tại mỗi mốc (cách `step` phiên), mọi mã thuộc rổ + đạt thanh khoản, giá trị yếu tố và lãi hơn rổ h phiên.
 * @returns {{ date: string, rows: { s: string, f: object, ex: Record<number, number> }[] }[]}
 */
export function buildSamples(cal, data, { start, step = EXPECT_STEP, minValue, members = null, horizons = RESEARCH_HORIZONS }) {
  const calAt = new Map(cal.map((b, k) => [b.time, k]));
  const exitAt = (d, end, endT) => {
    const i = d.at.get(end);
    if (i != null) return d.bars[i].close;
    const last = d.bars.at(-1), lastT = calAt.get(last.time);
    return last.time < end && lastT != null && endT - lastT >= DELIST_GAP ? last.close * (1 - DELIST_HAIRCUT) : null;
  };
  const out = [];
  for (let t = start; t < cal.length - 1; t += step) {
    const date = cal[t].time, next = cal[t + 1].time;
    const inUni = members ? members(date) : null;
    const rows = [];
    for (const [s, d] of Object.entries(data)) {
      if (members && !inUni?.has(s)) continue;
      const i = d.at.get(date);
      if (i == null || avgTradedValue(d.bars, 20, i) < minValue) continue;
      const f = d.panel(i);
      if (!f) continue;
      const j = d.at.get(next);
      rows.push({ s, f, entry: j != null && d.bars[j].open > 0 ? d.bars[j].open : d.bars[i].close, d });
    }
    if (rows.length < 30) continue;
    const ex = {};
    for (const h of horizons) {
      if (t + h >= cal.length) continue;
      const end = cal[t + h].time;
      const rets = rows.map((x) => { const e = exitAt(x.d, end, t + h); return e == null ? null : e / x.entry - 1; });
      const ok = rets.filter((v) => v != null);
      if (ok.length < 30) continue;
      const basket = mean(ok);
      ex[h] = rets.map((v) => (v == null ? null : v - basket));
    }
    out.push({ date, rows: rows.map((x, k) => ({ s: x.s, f: x.f, ex: Object.fromEntries(Object.entries(ex).map(([h, arr]) => [h, arr[k]])) })) });
  }
  return out;
}

// Phân vị trong mảng đã sắp xếp (bằng nhau tính một nửa) — giống compositeScore của ranking.js
function pct(sorted, v) {
  let lo = 0, eq = 0;
  for (const x of sorted) { if (x < v) lo++; else if (x === v) eq++; }
  return (lo + eq / 2) / sorted.length;
}

/** Điểm tổ hợp: trung bình phân vị (theo chiều) của các yếu tố trong mỗi mốc; cần ≥ 2 yếu tố có giá trị. */
export function compositeOf(rows, factors) {
  const ref = Object.fromEntries(factors.map(({ key }) => [key, rows.map((x) => x.f[key]).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b)]));
  return rows.map((x) => {
    const parts = factors.filter(({ key }) => x.f[key] != null && Number.isFinite(x.f[key]) && ref[key].length)
      .map(({ key, sign }) => (sign >= 0 ? pct(ref[key], x.f[key]) : 1 - pct(ref[key], x.f[key])));
    return parts.length >= Math.min(2, factors.length) ? mean(parts) : null;
  });
}

/**
 * IC theo mốc của một hàm điểm (giá trị cao = kỳ vọng tốt) và chênh nhóm 20% cao − 20% thấp, toàn giai đoạn và hai nửa.
 * @param {(rows) => (number|null)[]} scoreFn
 */
export function evaluateScore(samples, scoreFn, h, step = EXPECT_STEP) {
  const lags = Math.max(0, Math.ceil(h / step) - 1);
  const daily = [];
  for (const { date, rows } of samples) {
    const sc = scoreFn(rows);
    const pairs = rows.map((x, k) => [sc[k], x.ex[h]]).filter(([a, b]) => a != null && Number.isFinite(a) && b != null);
    if (pairs.length < 30) continue;
    const ic = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
    const q = Math.floor(sorted.length / 5);
    const spread = mean(sorted.slice(-q).map((p) => p[1])) - mean(sorted.slice(0, q).map((p) => p[1]));
    if (ic != null) daily.push({ date, ic, spread });
  }
  const R = { minDates: 20, t: ADOPT_RULE.t };
  const half = Math.floor(daily.length / 2);
  const part = (xs) => ({ ...testSeries(xs.map((x) => x.ic), lags, null, R), spread: r4(mean(xs.map((x) => x.spread))), from: xs[0]?.date, to: xs.at(-1)?.date });
  return { all: part(daily), first: part(daily.slice(0, half)), second: part(daily.slice(half)) };
}

/** Kết luận theo quy tắc đăng ký trước. */
export function adoptVerdict(ev) {
  const { all, first, second } = ev;
  if (all.t == null || first.mean == null || second.mean == null) return 'insufficient';
  const consistent = Math.sign(first.mean) === Math.sign(second.mean) && Math.sign(first.mean) === Math.sign(all.mean);
  if (Math.abs(all.t) >= ADOPT_RULE.t && consistent) return all.mean > 0 ? 'adopt' : 'adopt_reversed';
  return consistent ? 'weak' : 'unstable';
}

/** Các tổ hợp thử, cố định trước. `robust` = các yếu tố đạt quy tắc ở mốc 20 phiên (chiều theo dữ liệu). */
export const VARIANTS = [
  { key: 'current', label: '4 yếu tố hiện tại', keys: ['mom', 'high', 'atr', 'adx'] },
  { key: 'current_rev', label: 'Hiện tại + đảo chiều 1 tháng', keys: ['mom', 'high', 'atr', 'adx', 'rev1m'] },
  { key: 'current_eg', label: 'Hiện tại + tăng trưởng LN quý', keys: ['mom', 'high', 'atr', 'adx', 'eg'] },
  { key: 'no_adx', label: 'Hiện tại bỏ ADX', keys: ['mom', 'high', 'atr'] },
  { key: 'robust', label: 'Chỉ các yếu tố đạt quy tắc (20 phiên)', keys: null },
];

/** Chạy toàn bộ nghiên cứu trên bảng mẫu (hàm thuần). */
export function runResearch(samples, step = EXPECT_STEP) {
  const byKey = Object.fromEntries(CANDIDATES.map((c) => [c.key, c]));
  const factors = CANDIDATES.map((c) => {
    const res = {};
    for (const h of RESEARCH_HORIZONS) {
      // IC theo giá trị thô (chiều dữ liệu); "đúng kỳ vọng" so với chiều đăng ký trước
      const ev = evaluateScore(samples, (rows) => rows.map((x) => x.f[c.key]), h, step);
      res[h] = { ...ev, verdict: adoptVerdict(ev), asExpected: c.sign === 0 || ev.all.mean == null ? null : Math.sign(ev.all.mean) === c.sign };
    }
    const cover = mean(samples.map(({ rows }) => rows.filter((x) => x.f[c.key] != null).length / rows.length));
    return { ...c, coverage: r4(cover), ...res };
  });
  const robustKeys = factors.filter((f) => f[20].verdict === 'adopt' || f[20].verdict === 'adopt_reversed');
  const variants = VARIANTS.map((v) => {
    const fs = v.keys ? v.keys.map((k) => byKey[k]) : robustKeys.map((f) => ({ key: f.key, sign: Math.sign(f[20].all.mean) }));
    if (!fs.length) return { ...v, keys: [], note: 'không có yếu tố nào đạt quy tắc' };
    const res = Object.fromEntries(RESEARCH_HORIZONS.map((h) => [h, evaluateScore(samples, (rows) => compositeOf(rows, fs), h, step)]));
    return { ...v, keys: fs.map((f) => `${f.sign < 0 ? '−' : '+'}${f.key}`), ...res };
  });
  return { factors, variants, samples: samples.length, from: samples[0]?.date, to: samples.at(-1)?.date };
}

/** Chạy trên dữ liệu thật (tải dữ liệu theo thời điểm 4 năm + BCTC quý của mọi mã). */
export async function runFactorResearch({ years = 4 } = {}) {
  const panel = await loadPanel({ years });
  const syms = Object.keys(panel.data);
  const quarterly = await poolMap(syms, (s) => getQuarterly(s), 6);
  syms.forEach((s, k) => { panel.data[s].panel = factorPanel(panel.data[s].bars, quarterly[k] ? earningsReader(quarterly[k]) : null); });
  const samples = buildSamples(panel.cal, panel.data, panel);
  return { survivorshipBias: panel.survivorshipBias, symbols: syms.length, ...runResearch(samples, panel.step) };
}
