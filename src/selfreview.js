// Tự đối chiếu và tự cải thiện: mỗi ngày giao dịch sau 15:30 so các gợi ý trước đây với giá thực tế, rồi chỉnh
// một số thông số trong tuning.js KHI có đủ bằng chứng.
//
// Rào chắn chống "học theo nhiễu":
//  - chỉ dùng lệnh đã đủ phiên (đã chạm cắt lỗ / chốt lời hoặc đủ 20 phiên), cần ≥ MIN_SAMPLE lệnh;
//  - mỗi bằng chứng quy về MỘT GIÁ TRỊ MỖI PHIÊN rồi kiểm định bằng t Newey-West (verify.js) vì các lệnh cùng phiên /
//    phiên liền nhau không độc lập. Thay đổi làm TĂNG rủi ro hoặc rời mặc định (nới cắt lỗ, tắt AI loại mã, bỏ thận
//    trọng, đổi dải giá) cần |t| ≥ 2 và ≥ minDates phiên; thay đổi QUAY VỀ phía thận trọng (bật thận trọng, bật lại
//    AI loại mã) chỉ cần ước lượng điểm;
//  - mỗi lần chỉnh một bước nhỏ, kẹp trong giới hạn BOUNDS; mỗi thông số tối đa 1 lần / COOLDOWN phiên; mỗi lần chỉnh
//    là một phiên bản mô hình mới (tuning.js ghi băm thông số trước / sau);
//  - không tự đổi chiến lược xếp hạng gốc (đã kiểm chứng 4 năm; ~40 biến thể thử nghiệm đều không vững hơn).
// Mọi thay đổi được ghi nhật ký (data/tuning.json) và báo qua Telegram.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { evaluatePredictions } from './predictions.js';
import { testSeries } from './verify.js';
import { getTuning, setParam, tuningLog } from './tuning.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TRADES = join(DIR, 'trades.json');
const REVIEWS = join(DIR, 'reviews.json');
export const RULES = { minSample: 30, minDates: 20, t: 2, window: 60, cooldown: 20, hold: 20, stopFloor: 0.15 };

const readJson = (f, d) => readFile(f, 'utf8').then(JSON.parse).catch(() => d);
async function writeJson(f, v) {
  await mkdir(DIR, { recursive: true });
  await writeFile(f, JSON.stringify(v), 'utf8');
}
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const share = (a, f) => (a.length ? a.filter(f).length / a.length : null);
const r = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ---------- Ghi gợi ý đã gửi ----------
/**
 * Lưu các mã đã gợi ý mua (status 'pick') và mã hệ thống muốn mua nhưng AI loại (status 'rejected').
 * Mỗi mã / phiên giữ bản mới nhất (bản tin đóng cửa ghi đè bản mở cửa vì giá đã chốt).
 * @param {{ symbol, date, entry, stop, target, buyFrom, buyTo, code, status }[]} list
 */
export async function recordTrades(list) {
  const store = await readJson(TRADES, { items: [] });
  for (const t of list) {
    if (!t.symbol || !t.date || !t.entry) continue;
    const k = store.items.findIndex((x) => x.symbol === t.symbol && x.date === t.date);
    const item = { ...t, at: new Date().toISOString() };
    if (k >= 0) store.items[k] = item;
    else store.items.push(item);
  }
  if (store.items.length > 5000) store.items.splice(0, store.items.length - 5000);
  await writeJson(TRADES, store);
}

// ---------- Chấm ----------
/**
 * Mô phỏng một lệnh mua ở giá `entry` phiên `date`, cùng luật với khuyến nghị: ĐÓNG CỬA dưới cắt lỗ thì bán giá mở cửa
 * phiên sau (hết dữ liệu thì giá đóng cửa đó); giá cao nhất chạm chốt lời thì bán ở mức chốt lời (lệnh giới hạn, mở cửa
 * vượt thì giá mở cửa); hoặc đóng cửa phiên thứ `hold`. Cùng phiên chạm chốt lời và đóng cửa dưới cắt lỗ thì tính cắt lỗ
 * (thận trọng). Kèm lợi suất 10 / 20 phiên giữ nguyên (để biết cắt lỗ có bị "quét" rồi giá hồi không).
 */
export function scoreTrade(t, bars, indexBars = [], hold = RULES.hold) {
  const i = bars.findIndex((b) => b.time === t.date);
  if (i < 0) return null;
  const at = (h) => (i + h < bars.length ? bars[i + h].close / t.entry - 1 : null);
  const j0 = indexBars.findIndex((b) => b.time === t.date);
  const idx = (h) => (j0 >= 0 && j0 + h < indexBars.length ? indexBars[j0 + h].close / indexBars[j0].close - 1 : null);
  let outcome = null, exit = null, days = null;
  for (let j = i + 1; j <= Math.min(i + hold, bars.length - 1); j++) {
    const b = bars[j];
    if (t.stop && b.close < t.stop) { outcome = 'stop'; exit = bars[j + 1]?.open ?? b.close; days = j - i; break; }
    if (t.target && b.high >= t.target) { outcome = 'target'; exit = Math.max(b.open, t.target); days = j - i; break; }
  }
  if (!outcome && i + hold < bars.length) { outcome = 'time'; exit = bars[i + hold].close; days = hold; }
  const ret10 = at(10), ret20 = at(20);
  return {
    matured: outcome != null, outcome, days, ret: exit != null ? exit / t.entry - 1 : null,
    ret10, excess10: ret10 != null && idx(10) != null ? ret10 - idx(10) : null, ret20,
  };
}

/** Thống kê một nhóm lệnh đã chấm. */
export function tradeStats(list) {
  const done = list.filter((x) => x.s?.matured);
  const stops = done.filter((x) => x.s.outcome === 'stop');
  const shaken = stops.filter((x) => x.s.ret20 != null);
  return {
    n: done.length,
    winRate: r(share(done, (x) => x.s.ret > 0), 3),
    avgRet: r(avg(done.map((x) => x.s.ret))),
    stopRate: r(share(done, (x) => x.s.outcome === 'stop'), 3),
    stop5Rate: r(share(done, (x) => x.s.outcome === 'stop' && x.s.days <= 5), 3),
    targetRate: r(share(done, (x) => x.s.outcome === 'target'), 3),
    shakeN: shaken.length,
    shakeAvgRet20: r(avg(shaken.map((x) => x.s.ret20))),
  };
}

function excessStats(list) {
  const done = list.filter((x) => x.s?.excess10 != null);
  return { n: done.length, avgRet10: r(avg(done.map((x) => x.s.ret10))), avgExcess10: r(avg(done.map((x) => x.s.excess10))) };
}

/** Tỷ lệ giá thật nằm trong dải 5–95% của các dự báo AI đã lưu, ở mốc 5 phiên. */
async function bandCoverage(barsOf) {
  const store = await readJson(join(DIR, 'forecasts.json'), {});
  const hits = [];
  for (const [sym, byDate] of Object.entries(store)) {
    const list = Object.values(byDate).filter((f) => f.band?.p5);
    if (!list.length) continue;
    const bars = await barsOf(sym);
    if (!bars) continue;
    for (const f of list) {
      const i = bars.findIndex((b) => b.time === f.date);
      if (i < 0 || i + 5 >= bars.length) continue;
      const v = bars[i + 5].close, [lo, hi] = f.band.p5;
      hits.push({ date: f.date, hit: v >= lo && v <= hi });
    }
  }
  return { n: hits.length, coverage90: r(share(hits, (x) => x.hit), 3), hits };
}

// Trung bình theo phiên của f(x) (bỏ null), theo thứ tự ngày
function perDate(list, f) {
  const m = new Map();
  for (const x of list) {
    const v = f(x);
    if (v == null || !Number.isFinite(v)) continue;
    if (!m.has(x.date)) m.set(x.date, []);
    m.get(x.date).push(v);
  }
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, value: avg(v) }));
}

/**
 * Kiểm định cho từng quyết định chỉnh, mỗi bằng chứng là chuỗi một giá trị mỗi phiên (hàm thuần).
 *  shake: lợi suất 20 phiên của lệnh bị cắt lỗ trong 5 phiên (> 0 = cắt lỗ bị quét rồi giá hồi);
 *  stopLow: tỷ lệ chạm cắt lỗ − stopFloor (< 0 = cắt lỗ hiếm khi bị chạm);
 *  veto: lãi hơn VN-Index 10 phiên của mã AI loại − mã AI chọn (> 0 = AI loại sai);
 *  picks: lãi hơn VN-Index 10 phiên của mã gợi ý; band: dải 5–95% chứa giá thật − 90%.
 * @param {object[]} scored lệnh đã chấm ({ date, status, s })
 * @param {{ date: string, hit: boolean }[]} bandHits
 */
export function gateTests(scored, bandHits = [], rules = RULES) {
  const R = { minDates: rules.minDates, t: rules.t };
  const T = (series, lags) => testSeries(series.map((x) => x.value), lags, null, R);
  const picks = scored.filter((x) => x.status === 'pick');
  const matured = picks.filter((x) => x.s?.matured);
  const pick10 = perDate(picks, (x) => x.s?.excess10);
  const rej10 = new Map(perDate(scored.filter((x) => x.status === 'rejected'), (x) => x.s?.excess10).map((x) => [x.date, x.value]));
  return {
    shake: T(perDate(matured.filter((x) => x.s.outcome === 'stop' && x.s.days <= 5), (x) => x.s.ret20), rules.hold - 1),
    stopLow: T(perDate(matured, (x) => (x.s.outcome === 'stop' ? 1 : 0) - rules.stopFloor), rules.hold - 1),
    veto: T(pick10.filter((x) => rej10.has(x.date)).map((x) => ({ value: rej10.get(x.date) - x.value })), 9),
    picks: T(pick10, 9),
    band: T(perDate(bandHits, (x) => (x.hit ? 1 : 0) - 0.9), 4),
  };
}

// ---------- Quyết định chỉnh ----------
/**
 * Các thay đổi đề xuất từ số liệu và kiểm định (hàm thuần, dễ kiểm thử).
 * @param {{ picks, picks10, rejected10, band }} st thống kê mô tả
 * @param {ReturnType<typeof gateTests>} tests kiểm định theo phiên
 * @returns {{ name, value, reason, evidence }[]}
 */
export function proposeChanges({ picks, picks10, rejected10, band }, tests, t, rules = RULES) {
  const out = [];
  const ok = (x, sign) => x?.verdict === (sign > 0 ? 'supported' : 'rejected'); // |t| ≥ 2, đủ phiên, đúng chiều
  const ev = (x) => ({ n: x?.n, mean: x?.mean, t: x?.t });
  const bandEv = (x) => ({ band: { n: band.n, coverage90: band.coverage90 }, test: ev(x) });
  if (picks.n >= rules.minSample && picks.stop5Rate > 0.45 && ok(tests.shake, 1)) {
    out.push({ name: 'minStopAtr', value: t.minStopAtr + 0.25, evidence: { picks, test: ev(tests.shake) },
      reason: `${Math.round(picks.stop5Rate * 100)}% lệnh chạm cắt lỗ trong 5 phiên nhưng sau 20 phiên giá các mã đó lại ${(tests.shake.mean * 100).toFixed(1)}% (t ${tests.shake.t}, ${tests.shake.n} phiên): cắt lỗ quá sát, nới thêm 0,25 ATR` });
  } else if (t.minStopAtr > 0 && ok(tests.stopLow, -1)) {
    out.push({ name: 'minStopAtr', value: t.minStopAtr - 0.25, evidence: { picks, test: ev(tests.stopLow) },
      reason: `Chỉ ${Math.round(picks.stopRate * 100)}% lệnh chạm cắt lỗ (t ${tests.stopLow.t}, ${tests.stopLow.n} phiên): thu hẹp lại 0,25 ATR` });
  }
  if (ok(tests.band, -1)) {
    out.push({ name: 'widen', value: t.widen * 1.04, evidence: bandEv(tests.band),
      reason: `Dải 5–95% chỉ chứa giá thật ${Math.round((tests.band.mean + 0.9) * 100)}% (chuẩn 90%, t ${tests.band.t}): nới dải 4%` });
  } else if (ok(tests.band, 1)) {
    out.push({ name: 'widen', value: t.widen / 1.04, evidence: bandEv(tests.band),
      reason: `Dải 5–95% chứa giá thật ${Math.round((tests.band.mean + 0.9) * 100)}% (chuẩn 90%, t ${tests.band.t}): dải quá rộng, thu hẹp 4%` });
  }
  if (t.aiVeto && ok(tests.veto, 1)) {
    out.push({ name: 'aiVeto', value: false, evidence: { picks10, rejected10, test: ev(tests.veto) },
      reason: `Mã AI loại lại tốt hơn mã AI chọn ${(tests.veto.mean * 100).toFixed(1)}%/10 phiên (t ${tests.veto.t}, ${tests.veto.n} phiên): vẫn cho AI phân tích nhưng không loại mã, chỉ ghi chú` });
  } else if (!t.aiVeto && picks10.n >= rules.minSample && rejected10.n >= rules.minSample && rejected10.avgExcess10 - picks10.avgExcess10 < -0.01) {
    // Quay về mặc định thận trọng: chỉ cần ước lượng điểm
    out.push({ name: 'aiVeto', value: true, evidence: { picks10, rejected10 },
      reason: `Mã AI chọn tốt hơn mã AI loại ${((picks10.avgExcess10 - rejected10.avgExcess10) * 100).toFixed(1)}%/10 phiên: bật lại quyền loại mã của AI` });
  }
  if (!t.caution && picks10.n >= rules.minSample && picks10.avgExcess10 < -0.01) {
    out.push({ name: 'caution', value: true, evidence: picks10,
      reason: `Gợi ý mua gần đây thua VN-Index ${(-picks10.avgExcess10 * 100).toFixed(1)}%/10 phiên: chỉ gợi ý 3 mã, kèm cảnh báo` });
  } else if (t.caution && ok(tests.picks, 1)) {
    out.push({ name: 'caution', value: false, evidence: { picks10, test: ev(tests.picks) },
      reason: `Gợi ý mua vượt VN-Index +${(tests.picks.mean * 100).toFixed(1)}%/10 phiên có ý nghĩa (t ${tests.picks.t}, ${tests.picks.n} phiên): bỏ chế độ thận trọng` });
  }
  return out;
}

/** Số phiên giao dịch kể từ lần chỉnh gần nhất của thông số. */
function sessionsSince(name, sessions) {
  const last = tuningLog().filter((x) => x.name === name && x.date).at(-1);
  if (!last) return Infinity;
  return sessions.filter((d) => d > last.date).length;
}

// ---------- Chạy ----------
let running = null;
/** Tự đánh giá cho phiên mới nhất; `apply` = áp dụng thay đổi (mặc định có). */
export function runSelfReview({ apply = true } = {}) {
  running ??= (async () => {
    const { bars: idx } = await getPriceHistory('VNINDEX');
    const date = idx.at(-1).time, sessions = idx.map((b) => b.time);
    const cache = new Map();
    const barsOf = async (s) => {
      if (!cache.has(s)) cache.set(s, (await getPriceHistory(s).catch(() => null))?.bars || null);
      return cache.get(s);
    };

    const items = (await readJson(TRADES, { items: [] })).items.sort((a, b) => b.date.localeCompare(a.date));
    const scored = [];
    for (const t of items) {
      const bars = await barsOf(t.symbol);
      scored.push({ ...t, s: bars ? scoreTrade(t, bars, idx) : null });
    }
    const recent = (status, f) => scored.filter((x) => x.status === status && f(x)).slice(0, RULES.window);
    const picks = tradeStats(recent('pick', (x) => x.s?.matured));
    const picks10 = excessStats(recent('pick', (x) => x.s?.excess10 != null));
    const rejected10 = excessStats(recent('rejected', (x) => x.s?.excess10 != null));
    const band = await bandCoverage(barsOf);
    const pred = await evaluatePredictions().catch(() => null);
    const accuracy = (pred?.summary || []).map((s) => ({ source: s.source, label: s.label, ...s.horizons.find((h) => h.h === 10) }))
      .filter((s) => s.evaluated > 0);

    const t = getTuning();
    const tests = gateTests(scored, band.hits);
    const proposed = proposeChanges({ picks, picks10, rejected10, band }, tests, t);
    const changes = [];
    for (const p of proposed) {
      const wait = RULES.cooldown - sessionsSince(p.name, sessions);
      if (wait > 0) { changes.push({ ...p, skipped: `vừa chỉnh, chờ thêm ${wait} phiên` }); continue; }
      const done = apply ? await setParam(p.name, p.value, p.reason, p.evidence, date) : null;
      if (done) changes.push({ ...p, from: done.from, value: done.to });
    }

    const review = {
      date, at: new Date().toISOString(), trades: { total: items.length, pending: scored.filter((x) => x.status === 'pick' && !x.s?.matured).length },
      picks, picks10, rejected10, band: { n: band.n, coverage90: band.coverage90 }, accuracy, changes, tuning: { ...getTuning() },
      tests: Object.fromEntries(Object.entries(tests).map(([k, x]) => [k, { n: x.n, mean: x.mean, t: x.t, verdict: x.verdict }])),
    };
    // Chạy thử (apply = false) không lưu: bản lưu ngày hôm nay sẽ làm lịch tự đánh giá bỏ qua lần chạy thật
    if (apply) {
      const all = await readJson(REVIEWS, []);
      all.push(review);
      await writeJson(REVIEWS, all.slice(-250));
    }
    return review;
  })().finally(() => (running = null));
  return running;
}

export async function lastReview() {
  return (await readJson(REVIEWS, [])).at(-1) || null;
}

// ---------- Bản tin ----------
const pc = (v, d = 0) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: d })}%`);
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const NAMES = { minStopAtr: 'Cắt lỗ tối thiểu (ATR)', widen: 'Độ rộng dải giá', aiVeto: 'AI được loại mã', caution: 'Chế độ thận trọng' };
const val = (v) => (v === true ? 'bật' : v === false ? 'tắt' : String(v).replace('.', ','));

/** Tin Telegram ngắn tóm tắt lần tự đánh giá. */
export function formatReview(rv) {
  const d = `${rv.date.slice(8, 10)}/${rv.date.slice(5, 7)}`;
  const L = [`🔍 <b>TỰ ĐÁNH GIÁ ${d}</b>`];
  const p = rv.picks;
  if (p.n) L.push(`Gợi ý mua (${p.n} lệnh đã xong): thắng ${pct(p.winRate)} · TB ${pc(p.avgRet, 1)}/lệnh · chạm cắt lỗ ${pct(p.stopRate)} · chạm chốt lời ${pct(p.targetRate)}`);
  else L.push(`Gợi ý mua: chưa lệnh nào đủ 20 phiên (đang theo dõi ${rv.trades.pending})`);
  if (rv.picks10.n) L.push(`Sau 10 phiên so với VN-Index: AI chọn ${pc(rv.picks10.avgExcess10, 1)} (${rv.picks10.n})${rv.rejected10.n ? ` · AI loại ${pc(rv.rejected10.avgExcess10, 1)} (${rv.rejected10.n})` : ''}`);
  const acc = rv.accuracy.filter((a) => ['rank_all', 'final', 'ai'].includes(a.source));
  if (acc.length) L.push(`Đúng so VN-Index sau 10 phiên: ${acc.map((a) => `${a.source === 'rank_all' ? 'xếp hạng' : a.source === 'final' ? 'quyết định cuối' : 'AI'} ${pct(a.beatIndexRate ?? a.hitRate)}${a.beatBasketRate != null ? ` (rổ ${pct(a.beatBasketRate)})` : ''} (${a.evaluated})`).join(' · ')}`);
  if (rv.band.n) L.push(`Dải giá 5 phiên chứa giá thật ${pct(rv.band.coverage90)} (chuẩn 90%, ${rv.band.n} lần)`);
  const made = rv.changes.filter((c) => !c.skipped);
  if (made.length) for (const c of made) L.push(`🔧 ${NAMES[c.name]}: ${val(c.from)} → <b>${val(c.value)}</b>. ${c.reason}`);
  else {
    const few = Object.values(rv.tests || {}).every((x) => x.verdict === 'insufficient');
    L.push(few ? `Chưa tự chỉnh: mỗi bằng chứng cần ≥ ${RULES.minDates} phiên và |t| ≥ ${RULES.t} (lệnh đã xong: ${p.n}).`
      : 'Không chỉnh: chưa có bằng chứng nào đủ ý nghĩa thống kê (|t| ≥ 2).');
  }
  return L.join('\n');
}

/**
 * Mỗi 30 phút: phiên hôm nay đã đóng cửa (sau 15:30) mà chưa tự đánh giá thì chạy. Gửi Telegram khi có thay đổi
 * hoặc vào thứ Sáu (tổng kết tuần).
 */
export function startSelfReview(notify = null) {
  const tick = async () => {
    try {
      const vn = new Date(Date.now() + 7 * 3600_000);
      const today = vn.toISOString().slice(0, 10);
      if (vn.getUTCHours() * 60 + vn.getUTCMinutes() < 15 * 60 + 30) return;
      const { bars } = await getPriceHistory('VNINDEX');
      if (bars.at(-1)?.time !== today || (await lastReview())?.date === today) return;
      const rv = await runSelfReview();
      console.log(`[Tự đánh giá] ${today}: ${rv.picks.n} lệnh đã xong, ${rv.changes.filter((c) => !c.skipped).length} thay đổi`);
      if (notify && (rv.changes.some((c) => !c.skipped) || vn.getUTCDay() === 5)) await notify(formatReview(rv));
    } catch (err) {
      console.error('[Tự đánh giá] Lỗi:', err.message);
    }
  };
  setTimeout(tick, 90_000);
  return setInterval(tick, 30 * 60_000);
}
