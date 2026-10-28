// Kỳ vọng thống kê theo nhóm điểm xếp hạng: trong ~4 năm (rổ theo thời điểm, gồm mã sau này hủy niêm yết), các mã có điểm
// xếp hạng và vị trí so với MA200 như mã đang xem thì sau 5 / 20 phiên lãi hơn rổ chia đều bao nhiêu (trung bình, trung vị,
// p10–p90) và bao nhiêu % số lần thắng rổ. Đây là con số "tăng bao nhiêu %" có căn cứ; AI chỉ được giải thích, không tự đặt.
//
// Nhóm điểm cố định từ trước (EXPECT_BINS), không dò để số đẹp. Cách tính giống phần chấm dự đoán: mua giá mở cửa phiên sau
// ngày có điểm, bán giá đóng cửa phiên thứ h. Lấy mẫu mỗi EXPECT_STEP phiên; t Newey-West theo ngày để biết khác 0 thật không.
// Bảng dựng từ dữ liệu quá khứ đến hôm nay nên chỉ dùng cho dự báo TỪ NAY (không dùng để chấm lại quá khứ).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, getScreenUniverse, screenCriteria, avgTradedValue, DELIST_HAIRCUT, DELIST_GAP } from './data.js';
import { FACTORS, factorReader, buildRef, compositeScore, poolMap, pointInTimeUniverse } from './ranking.js';
import { testSeries } from './verify.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'expectancy.json');
export const EXPECT_BINS = [[0, 30], [30, 50], [50, 70], [70, 85], [85, 101]];
export const EXPECT_HORIZONS = [5, 20];
export const EXPECT_STEP = 5;
export const EXPECT_YEARS = 4;

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const quantile = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : null);

/** Khóa nhóm: khoảng điểm + trên/dưới MA200. */
export function bucketOf(score, aboveMa200) {
  if (score == null || !Number.isFinite(score)) return null;
  const b = EXPECT_BINS.find(([lo, hi]) => score >= lo && score < hi) || EXPECT_BINS.at(-1);
  return `${b[0]}-${Math.min(b[1], 100)}|${aboveMa200 === false ? 'duoi' : 'tren'}`;
}

// Giá thoát tại phiên `end` của lịch; mã ngừng giao dịch hẳn trước đó: giá cuối trừ haircut; còn lại null
function exitAt(d, end, endT, calAt) {
  const i = d.at.get(end);
  if (i != null) return d.bars[i].close;
  const last = d.bars.at(-1);
  const lastT = calAt.get(last.time);
  return last.time < end && lastT != null && endT - lastT >= DELIST_GAP ? last.close * (1 - DELIST_HAIRCUT) : null;
}

/**
 * Dựng bảng kỳ vọng (hàm thuần).
 * @param {object[]} cal lịch phiên (VN-Index)
 * @param {Record<string, { bars, at: Map, read: Function }>} data
 * @param {{ start: number, minValue: number, members?: (date: string) => Set<string>|null, step?: number }} o
 */
export function buildExpectancy(cal, data, { start, minValue, members = null, step = EXPECT_STEP }) {
  const calAt = new Map(cal.map((b, k) => [b.time, k]));
  const acc = {}; // bucket → h → { ex: [], ret: [], byDate: Map }
  const syms = Object.keys(data);
  let samples = 0;
  for (let t = start; t < cal.length - 1; t += step) {
    const date = cal[t].time, next = cal[t + 1].time;
    const inUni = members ? members(date) : null;
    const snap = [];
    for (const s of syms) {
      if (members && !inUni?.has(s)) continue;
      const d = data[s], i = d.at.get(date);
      if (i == null || avgTradedValue(d.bars, 20, i) < minValue) continue;
      const f = d.read(i);
      if (!f) continue;
      const j = d.at.get(next);
      const entry = j != null && d.bars[j].open > 0 ? d.bars[j].open : d.bars[i].close;
      snap.push({ s, f, entry });
    }
    if (snap.length < 20) continue;
    const ref = buildRef(snap.map((x) => x.f), FACTORS);
    for (const h of EXPECT_HORIZONS) {
      if (t + h >= cal.length) continue;
      const end = cal[t + h].time;
      const rows = snap.map((x) => {
        const exit = exitAt(data[x.s], end, t + h, calAt);
        return exit == null ? null : { ...x, ret: exit / x.entry - 1 };
      }).filter(Boolean);
      if (rows.length < 20) continue;
      const basket = rows.reduce((a, r) => a + r.ret, 0) / rows.length;
      for (const r of rows) {
        const key = bucketOf(compositeScore(r.f, ref, FACTORS)?.score, r.f.aboveMa200);
        if (!key) continue;
        const a = ((acc[key] ??= {})[h] ??= { ex: [], ret: [], byDate: new Map() });
        a.ex.push(r.ret - basket);
        a.ret.push(r.ret);
        if (!a.byDate.has(date)) a.byDate.set(date, []);
        a.byDate.get(date).push(r.ret - basket);
      }
    }
    samples++;
  }
  const buckets = {};
  for (const [key, byH] of Object.entries(acc)) {
    buckets[key] = {};
    for (const [h, a] of Object.entries(byH)) {
      const s = [...a.ex].sort((x, y) => x - y);
      const daily = [...a.byDate.values()].map((v) => v.reduce((x, y) => x + y, 0) / v.length);
      const test = testSeries(daily, Math.max(0, Math.ceil(Number(h) / step) - 1), null, { minDates: 20, t: 2 });
      buckets[key][h] = {
        n: s.length, dates: a.byDate.size,
        meanExcess: round(s.reduce((x, y) => x + y, 0) / s.length), medianExcess: round(quantile(s, 0.5)),
        p10: round(quantile(s, 0.1)), p90: round(quantile(s, 0.9)),
        pBeat: round(s.filter((x) => x > 0).length / s.length, 3),
        meanReturn: round(a.ret.reduce((x, y) => x + y, 0) / a.ret.length),
        t: test.t, significant: test.verdict === 'supported' || test.verdict === 'rejected',
      };
    }
  }
  return { from: cal[start]?.time, to: cal.at(-1)?.time, samples, step, buckets };
}

let table = null;    // bảng đang dùng
let building = null; // đang dựng

async function build() {
  const cal = (await getPriceHistory('VNINDEX', Math.round((EXPECT_YEARS + 1.3) * 365))).bars;
  const days = Math.round((EXPECT_YEARS + 1.3) * 365);
  const start = Math.max(260, cal.length - Math.round(EXPECT_YEARS * 252));
  const snapDates = [];
  for (let t = start; t < cal.length; t += EXPECT_STEP) snapDates.push(cal[t].time);
  const pit = await pointInTimeUniverse(snapDates);
  const syms = pit.byDate.size ? [...new Set([...pit.byDate.values()].flat().map((u) => u.symbol))] : (await getScreenUniverse()).map((u) => u.symbol);
  const members = pit.byDate.size ? (date) => new Set((pit.byDate.get(date) || []).map((u) => u.symbol)) : null;
  const all = await poolMap(syms, (s) => getPriceHistory(s, days));
  const data = {};
  syms.forEach((s, k) => {
    const bars = all[k]?.bars;
    if (bars?.length) data[s] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars) };
  });
  const out = { ...buildExpectancy(cal, data, { start, minValue: screenCriteria().minValue, members }), survivorshipBias: !pit.byDate.size, builtAt: new Date().toISOString() };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(out), 'utf8');
  return out;
}

/**
 * Bảng kỳ vọng hiện tại. Đọc file nếu đã dựng cho phiên mới nhất; cũ hơn thì dựng lại ở nền và tạm dùng bảng cũ.
 * @param {{ wait?: boolean }} o wait = chờ dựng xong (lần đầu chưa có bảng)
 */
export async function getExpectancy({ wait = false } = {}) {
  table ??= await readFile(FILE, 'utf8').then(JSON.parse).catch(() => null);
  const latest = (await getPriceHistory('VNINDEX').catch(() => null))?.bars.at(-1)?.time;
  if (!table || (latest && table.to < latest)) {
    building ??= build().then((t) => (table = t)).catch((err) => console.error('[Kỳ vọng] Lỗi dựng bảng:', err.message)).finally(() => (building = null));
    if (wait) await building; // không chờ: lần đầu trả null, các lần sau dùng bảng cũ đến khi dựng xong
  }
  return table;
}

/** Kỳ vọng cho một mã theo điểm xếp hạng (null nếu bảng chưa sẵn sàng hoặc nhóm quá ít mẫu). */
export async function expectationFor(score, aboveMa200) {
  const t = await getExpectancy();
  const key = bucketOf(score, aboveMa200);
  const b = key && t?.buckets?.[key];
  if (!b || !b[20] || b[20].dates < 20) return null;
  const [lo, hi] = key.split('|')[0].split('-');
  return { bucket: { from: Number(lo), to: Number(hi), aboveMa200: aboveMa200 !== false }, period: { from: t.from, to: t.to }, h5: b[5] ?? null, h20: b[20] };
}
