// Kiểm chứng dự đoán theo các giả thuyết chọn trước (pre-registration), trên sổ dự đoán chỉ ghi thêm (predictions.js).
// Giả thuyết CHÍNH (chỉ các giả thuyết này được dùng để kết luận; các nguồn khác trong bảng độ chính xác là khám phá):
//  H1  IC 5 phiên của điểm xếp hạng (toàn rổ) > 0: tương quan thứ hạng giữa điểm và lãi hơn rổ, tính mỗi phiên.
//  H2  Nhóm NÊN MUA theo xếp hạng (≥ 70, trên MA200) hơn rổ chia đều sau 20 phiên.
//  H3  Dải giá 5–95% chứa giá thật ~90% số lần (không quá hẹp, không quá rộng).
//  H4  Quyết định cuối (có AI) tốt hơn khuyến nghị chỉ theo luật trên cùng mã / phiên.
//  H5  (thêm 10/2026, đăng ký trước khi có dữ liệu tương lai) Mô hình v2 — nhóm biến động thấp, chọn từ nghiên cứu
//      research.js — sắp thứ tự tốt hơn v1: IC 5 phiên của v2 − v1 trên cùng phiên > 0. IC cao hơn KHÔNG đủ để thay bộ
//      xếp hạng mua (backtest: top 8 theo v2 kém xa v1); H5 "ủng hộ" chỉ cho phép dùng v2 làm bộ lọc tránh mã biến động cao.
// Mỗi giả thuyết quy về một chuỗi theo phiên (mỗi phiên một giá trị) rồi kiểm định trung bình bằng sai số chuẩn
// Newey-West (độ trễ h − 1) vì các cửa sổ h phiên chồng nhau. |t| ≥ 2 mới kết luận; dưới VERIFY_RULES.minDates phiên
// thì báo "chưa đủ dữ liệu" dù t lớn.
import { cached } from './http.js';
import { scoredPredictions, scorePlan, HORIZONS } from './predictions.js';
import { getPriceHistory } from './data.js';
import { newsEvents, scoreNewsEvent, NEWS_HORIZONS } from './newsevents.js';

export const VERIFY_RULES = {
  minDates: 20,     // số phiên tối thiểu trước khi được kết luận
  t: 2,             // ngưỡng |t|
  minCross: 20,     // số mã tối thiểu mỗi phiên để tính IC
  bandTarget: 0.9,  // độ phủ mong muốn của dải 5–95%
  // Hiệu ứng giả định (để ước tính còn bao lâu nếu hiệu ứng thật cỡ này)
  prior: { H1: 0.04, H2: 0.008, H3: 0.03, H4: 0.005, H5: 0.02 },
};

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const out = new Array(a.length);
  for (let k = 0; k < idx.length;) {
    let e = k;
    while (e + 1 < idx.length && idx[e + 1][0] === idx[k][0]) e++;
    for (let m = k; m <= e; m++) out[idx[m][1]] = (k + e) / 2 + 1; // hạng trung bình khi bằng nhau
    k = e + 1;
  }
  return out;
}

/** Tương quan thứ hạng Spearman; null nếu ít hơn 3 cặp hoặc một bên không đổi. */
export function spearman(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const rx = ranks(x), ry = ranks(y);
  const mx = mean(rx), my = mean(ry);
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < rx.length; i++) { c += (rx[i] - mx) * (ry[i] - my); vx += (rx[i] - mx) ** 2; vy += (ry[i] - my) ** 2; }
  return vx && vy ? c / Math.sqrt(vx * vy) : null;
}

/** Trung bình, sai số chuẩn Newey-West (trọng số Bartlett, `lags` độ trễ) và t của một chuỗi theo thời gian. */
export function neweyWest(series, lags = 0) {
  const n = series.length;
  if (n < 3) return { n, mean: mean(series), se: null, t: null };
  const m = mean(series);
  const e = series.map((v) => v - m);
  const L = Math.min(lags, n - 1);
  let v = e.reduce((s, x) => s + x * x, 0) / n;
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += e[i] * e[i - l];
    v += 2 * (1 - l / (L + 1)) * (g / n);
  }
  const se = Math.sqrt(Math.max(v, 0) / n);
  return { n, mean: m, se, t: se ? m / se : null };
}

/**
 * Kết luận một chuỗi theo phiên so với 0: 'insufficient' | 'supported' | 'rejected' (ngược chiều) | 'inconclusive',
 * kèm số phiên cần để |t| = 2 nếu hiệu ứng thật bằng mức đang đo (needDates) hoặc bằng mức giả định (needDatesPrior).
 */
export function testSeries(series, lags, prior, R = VERIFY_RULES) {
  const s = neweyWest(series, lags);
  let verdict = 'inconclusive';
  if (s.n < R.minDates || s.t == null) verdict = 'insufficient';
  else if (s.t >= R.t) verdict = 'supported';
  else if (s.t <= -R.t) verdict = 'rejected';
  const sigma = s.se != null ? s.se * Math.sqrt(s.n) : null; // độ lệch hiệu dụng của một phiên
  const need = (eff) => (sigma && eff ? Math.ceil((R.t * sigma / Math.abs(eff)) ** 2) : null);
  return {
    n: s.n, mean: r4(s.mean), se: r4(s.se), t: s.t == null ? null : Math.round(s.t * 100) / 100, verdict,
    needDates: need(s.mean), needDatesPrior: need(prior),
  };
}

// Bản ghi cũ (legacy) chưa có trường số: lấy từ phần mô tả
export function scoreOf(it) {
  if (it.score != null) return it.score;
  const m = /(?:Xếp hạng|Điểm xếp hạng|Điểm cũ|Điểm)\s+(-?\d+(?:\.\d+)?)/.exec(it.detail || '');
  return m ? Number(m[1]) : null;
}
export function confidenceOf(it) {
  if (it.confidence != null) return it.confidence;
  const m = /Tin cậy\s+(\d+)%/.exec(it.detail || '');
  return m ? Number(m[1]) : null;
}

const byDate = (items) => {
  const m = new Map();
  for (const x of items) { if (!m.has(x.date)) m.set(x.date, []); m.get(x.date).push(x); }
  return [...m].sort((a, b) => a[0].localeCompare(b[0]));
};

/** IC theo phiên của một nguồn ở mốc h: Spearman giữa điểm và lãi hơn rổ, các phiên có ≥ minCross mã. */
export function dailyIc(items, h, R = VERIFY_RULES) {
  const ok = items.filter((x) => scoreOf(x) != null && x.result?.[h]?.excessBasket != null);
  return byDate(ok).map(([date, xs]) => (xs.length >= R.minCross
    ? { date, n: xs.length, ic: spearman(xs.map(scoreOf), xs.map((x) => x.result[h].excessBasket)) }
    : null)).filter((x) => x?.ic != null);
}

/** Trung bình theo phiên của f(x) (bỏ giá trị null). */
function dailyMean(items, f) {
  return byDate(items).map(([date, xs]) => {
    const v = xs.map(f).filter((y) => y != null && Number.isFinite(y));
    return v.length ? { date, n: v.length, value: mean(v) } : null;
  }).filter(Boolean);
}

/**
 * Toàn bộ kết quả kiểm chứng từ các bản ghi đã chấm (hàm thuần).
 * @param {object[]} scored bản ghi được chấm kèm result (predictions.scoredPredictions)
 */
export function verifyFromScored(scored, R = VERIFY_RULES) {
  const src = (s) => scored.filter((x) => x.source === s);
  const rankAll = src('rank_all');
  const hyp = [];

  // H1: IC điểm xếp hạng
  const ic = Object.fromEntries(HORIZONS.map((h) => {
    const d = dailyIc(rankAll, h, R);
    return [h, { ...testSeries(d.map((x) => x.ic), h - 1, R.prior.H1, R), avgCross: Math.round(mean(d.map((x) => x.n)) || 0), recent: d.slice(-60).map((x) => ({ date: x.date, ic: r4(x.ic) })) }];
  }));
  hyp.push({ id: 'H1', title: 'Điểm xếp hạng sắp đúng thứ tự lãi hơn rổ (IC 5 phiên > 0)', metric: 'IC trung bình', h: 5, ...ic[5], recent: undefined });

  // H2: nhóm NÊN MUA hơn rổ sau 20 phiên
  const buys = rankAll.filter((x) => x.direction > 0);
  const h2 = dailyMean(buys, (x) => x.result?.[20]?.excessBasket);
  hyp.push({ id: 'H2', title: 'Nhóm NÊN MUA theo xếp hạng hơn rổ chia đều sau 20 phiên', metric: 'Lãi hơn rổ TB', h: 20, ...testSeries(h2.map((x) => x.value), 19, R.prior.H2, R), avgCross: Math.round(mean(h2.map((x) => x.n)) || 0) });

  // H3: độ phủ dải 5–95% (mọi nguồn có dải), mốc 5 phiên; kiểm định độ phủ − 90%
  const banded = scored.filter((x) => Array.isArray(x.band?.[5]) && x.result?.[5]?.exit != null && !x.result[5].delisted);
  const h3 = dailyMean(banded, (x) => { const [lo, hi] = x.band[5]; return (x.result[5].exit >= lo && x.result[5].exit <= hi ? 1 : 0) - R.bandTarget; });
  const h3t = testSeries(h3.map((x) => x.value), 4, R.prior.H3, R);
  // Hai chiều: lệch có ý nghĩa (quá hẹp / quá rộng) là bác bỏ; không lệch là phù hợp
  const h3v = h3t.verdict === 'insufficient' ? 'insufficient' : Math.abs(h3t.t ?? 0) >= R.t ? 'rejected' : 'supported';
  hyp.push({ id: 'H3', title: 'Dải giá 5–95% chứa giá thật khoảng 90% số lần (mốc 5 phiên)', metric: 'Độ phủ − 90%', h: 5, ...h3t, verdict: h3v,
    coverage: h3t.mean == null ? null : r4(h3t.mean + R.bandTarget), samples: banded.length,
    note: h3v === 'rejected' ? (h3t.mean < 0 ? 'dải quá hẹp' : 'dải quá rộng') : null });

  // H4: quyết định cuối so với luật trên cùng mã / phiên, mốc 10 phiên (lãi hơn rổ theo chiều khuyến nghị)
  const rule = new Map(src('rule').map((x) => [`${x.symbol}|${x.date}`, x]));
  const pairs = src('final').map((f) => ({ f, r: rule.get(`${f.symbol}|${f.date}`) }))
    .filter(({ f, r }) => r && f.result?.[10]?.excessBasket != null && (f.direction || r.direction))
    .map(({ f, r }) => ({ date: f.date, diff: (f.direction - r.direction) * f.result[10].excessBasket }));
  const h4 = dailyMean(pairs, (x) => x.diff);
  hyp.push({ id: 'H4', title: 'Quyết định cuối (có AI) tốt hơn khuyến nghị theo luật trên cùng mã', metric: 'Chênh lãi hơn rổ TB', h: 10,
    ...testSeries(h4.map((x) => x.value), 9, R.prior.H4, R), pairs: pairs.length, disagree: pairs.filter((x) => x.diff !== 0).length });

  // H5: v2 so với v1, chênh IC trên cùng phiên
  const ic1 = new Map(dailyIc(rankAll, 5, R).map((x) => [x.date, x.ic]));
  const ic2 = dailyIc(src('rank_v2'), 5, R);
  const diff = ic2.filter((x) => ic1.has(x.date)).map((x) => x.ic - ic1.get(x.date));
  const h5 = testSeries(diff, 4, R.prior.H5, R);
  hyp.push({ id: 'H5', title: 'Mô hình v2 (biến động thấp) sắp thứ tự tốt hơn v1 (chênh IC 5 phiên)', metric: 'IC v2 − IC v1', h: 5, ...h5,
    icV2: r4(mean(ic2.map((x) => x.ic))), note: h5.verdict === 'supported' ? 'có thể dùng v2 làm bộ lọc tránh mã biến động cao (không thay bộ xếp hạng mua)' : null });

  // Độ tự tin AI: tỷ lệ đúng so rổ theo nhóm độ tự tin (mốc 10 phiên)
  const calib = ['ai', 'committee', 'final'].map((s) => {
    const xs = src(s).filter((x) => x.direction && x.result?.[10]?.beatBasket != null && confidenceOf(x) != null);
    const band = (c) => (c >= 75 ? 'cao (≥75)' : c >= 60 ? 'vừa (60–74)' : 'thấp (<60)');
    const groups = ['thấp (<60)', 'vừa (60–74)', 'cao (≥75)'].map((g) => {
      const g1 = xs.filter((x) => band(confidenceOf(x)) === g);
      return { group: g, n: g1.length, hitRate: g1.length ? r4(g1.filter((x) => x.result[10].beatBasket).length / g1.length) : null };
    });
    return { source: s, n: xs.length, groups };
  });

  const versions = {};
  for (const x of scored) versions[x.version || 'legacy'] = (versions[x.version || 'legacy'] || 0) + 1;
  return { rules: R, hypotheses: hyp, ic, calibration: calib, versions };
}

/** Kiểm chứng trên dữ liệu thật (cache 10 phút, xóa khi có dự đoán mới). */
// ---------- Phần khám phá: không dùng để kết luận như 4 giả thuyết chính, nhưng cùng cách kiểm định ----------

/**
 * Con số % dự báo có sát không: so dự báo với thực tế (cùng cách tính lãi: mua mở cửa phiên sau).
 * - expected (kịch bản AI): lãi dự báo so với lãi thật sau h phiên;
 * - expectedExcess (bảng kỳ vọng thống kê): lãi hơn rổ dự báo so với lãi hơn rổ thật.
 * slope = hệ số hồi quy thực tế theo dự báo: 1 là chuẩn, < 1 là dự báo phóng đại (thực tế chỉ được một phần), ≤ 0 là vô ích.
 * mae so với maeNaive (luôn dự báo 0%): nhỏ hơn mới có ích.
 */
export function pctCalibration(scored) {
  const rows = [];
  const fit = (pairs) => {
    if (pairs.length < 3) return { n: pairs.length };
    const mp = mean(pairs.map((p) => p[0])), ma = mean(pairs.map((p) => p[1]));
    let c = 0, v = 0;
    for (const [p, a] of pairs) { c += (p - mp) * (a - ma); v += (p - mp) ** 2; }
    return {
      n: pairs.length, meanPred: r4(mp), meanActual: r4(ma),
      mae: r4(mean(pairs.map(([p, a]) => Math.abs(a - p)))), maeNaive: r4(mean(pairs.map(([, a]) => Math.abs(a)))),
      slope: v ? r4(c / v) : null,
      signHit: r4(pairs.filter(([p, a]) => p !== 0 && Math.sign(p) === Math.sign(a)).length / Math.max(1, pairs.filter(([p]) => p !== 0).length)),
    };
  };
  for (const [kind, field, actual] of [['Kịch bản AI (lãi)', 'expected', 'ret'], ['Bảng kỳ vọng (hơn rổ)', 'expectedExcess', 'excessBasket']]) {
    const bySource = new Map();
    for (const x of scored) if (x[field]) { if (!bySource.has(x.source)) bySource.set(x.source, []); bySource.get(x.source).push(x); }
    for (const [source, xs] of bySource) {
      for (const h of HORIZONS) {
        const pairs = xs.map((x) => [x[field][h], x.result?.[h]?.[actual]]).filter(([p, a]) => Number.isFinite(p) && Number.isFinite(a));
        if (pairs.length || xs.some((x) => Number.isFinite(x[field][h]))) rows.push({ kind, source, h, ...fit(pairs), recorded: xs.filter((x) => Number.isFinite(x[field][h])).length });
      }
    }
  }
  return rows;
}

/** Kế hoạch lệnh (vùng mua, cắt lỗ, mục tiêu, số phiên) đi đến đâu: khớp không, chạm mục tiêu hay cắt lỗ, lãi thật so với mục tiêu hứa. */
export function planOutcomes(scored, bars) {
  const out = [];
  const bySource = new Map();
  for (const x of scored) if (x.plan?.target && x.plan?.stop && x.direction > 0) { if (!bySource.has(x.source)) bySource.set(x.source, []); bySource.get(x.source).push(x); }
  for (const [source, xs] of bySource) {
    const res = xs.map((x) => (bars[x.symbol] ? scorePlan(x, bars[x.symbol]) : null)).filter(Boolean);
    const filled = res.filter((r) => r.outcome !== 'no_fill');
    const cnt = (k) => filled.filter((r) => r.outcome === k).length;
    out.push({
      source, recorded: xs.length, done: res.length, noFill: res.length - filled.length, filled: filled.length,
      target: cnt('target'), stop: cnt('stop'), time: cnt('time'),
      targetRate: filled.length ? r4(cnt('target') / filled.length) : null,
      avgRet: r4(mean(filled.map((r) => r.ret))), avgTargetPct: r4(mean(filled.map((r) => r.targetPct))),
      avgStopPct: r4(mean(filled.map((r) => r.stopPct))), avgDays: r4(mean(filled.map((r) => r.days))),
    });
  }
  return out;
}

/** Từng bộ lọc của phễu Tiềm năng: nhóm ĐẠT hơn nhóm RỚT bao nhiêu (lãi hơn rổ, mỗi phiên một giá trị, t Newey-West). */
export function filterTests(scored, R = VERIFY_RULES) {
  const funnel = scored.filter((x) => x.source === 'funnel' && x.flags);
  if (!funnel.length) return [];
  const setupIds = [...new Set(funnel.flatMap((x) => x.flags.setups || []))];
  const flags = [
    ['liquidity', 'Thanh khoản đều'], ['quality', 'Cơ bản tốt (BCTC)'], ['sector', 'Ngành được mua ròng 5 phiên'],
    ['trend', 'Xu hướng (≥ 70, trên MA200, không rủi ro)'], ['risk', 'Bị cờ rủi ro rơi tự do'], ['trendPick', 'Trend Pick'],
    ['final', 'Vào danh sách cuối'], ...setupIds.map((id) => [`setup:${id}`, `Setup ${id}`]),
  ];
  const has = (x, k) => (k.startsWith('setup:') ? (x.flags.setups || []).includes(k.slice(6)) : Boolean(x.flags[k]));
  const out = [];
  for (const [k, label] of flags) {
    for (const h of [5, 20]) {
      const daily = byDate(funnel.filter((x) => x.result?.[h]?.excessBasket != null)).map(([, xs]) => {
        const a = xs.filter((x) => has(x, k)).map((x) => x.result[h].excessBasket), b = xs.filter((x) => !has(x, k)).map((x) => x.result[h].excessBasket);
        return a.length && b.length ? mean(a) - mean(b) : null;
      }).filter((v) => v != null);
      const passed = funnel.filter((x) => has(x, k)).length;
      out.push({ key: k, label, h, passed, failed: funnel.length - passed, ...testSeries(daily, h - 1, null, R) });
    }
  }
  return out;
}

/** Tác động của tin: lãi bất thường sau tin theo nhãn (tốt / xấu / trung lập, AI xác nhận rủi ro) và nhóm sự kiện. */
export function newsImpact(events, scoreOf, R = VERIFY_RULES) {
  const scoredEv = events.map((e) => ({ ...e, r: scoreOf(e) })).filter((e) => e.r);
  const groups = [
    ['tich_cuc', 'Tin tích cực', (e) => e.label === 'tich_cuc'], ['tieu_cuc', 'Tin tiêu cực', (e) => e.label === 'tieu_cuc'],
    ['trung_lap', 'Tin trung lập', (e) => e.label === 'trung_lap'], ['ai_risk', 'AI xác nhận rủi ro nghiêm trọng', (e) => e.aiRisk === true],
    ...[...new Set(scoredEv.flatMap((e) => e.categories || []))].map((c) => [`cat:${c}`, `Nhóm: ${c}`, (e) => (e.categories || []).includes(c)]),
  ];
  const out = [];
  for (const [key, label, f] of groups) {
    const xs = scoredEv.filter(f);
    if (!xs.length) continue;
    const row = { key, label, events: xs.length, gap: r4(mean(xs.map((e) => e.r.gap).filter(Number.isFinite))) };
    for (const h of NEWS_HORIZONS) {
      const daily = [...xs.reduce((m, e) => {
        const v = e.r[h]?.abnormal;
        if (Number.isFinite(v)) { if (!m.has(e.r.session)) m.set(e.r.session, []); m.get(e.r.session).push(v); }
        return m;
      }, new Map()).values()].map((v) => mean(v));
      row[h] = testSeries(daily, h - 1, null, R);
    }
    out.push(row);
  }
  return out;
}

/** Kiểm chứng trên dữ liệu thật (cache 10 phút, xóa khi có dự đoán mới). */
export function getVerification() {
  return cached('verify', 10 * 60_000, async () => {
    const { scored, bars, index, basket } = await scoredPredictions();
    const events = await newsEvents().catch(() => []);
    // Giá các mã chỉ có trong sổ tin (chưa có trong sổ dự đoán)
    const evBars = { ...bars };
    for (const s of [...new Set(events.map((e) => e.symbol))].filter((s) => !(s in evBars))) {
      evBars[s] = (await getPriceHistory(s).catch(() => null))?.bars || null;
    }
    return {
      updatedAt: new Date().toISOString(), ...verifyFromScored(scored),
      explore: {
        pct: pctCalibration(scored),
        plans: planOutcomes(scored, bars),
        filters: filterTests(scored),
        news: newsImpact(events, (e) => (evBars[e.symbol] ? scoreNewsEvent(e, evBars[e.symbol], index, basket) : null)),
        newsEvents: events.length,
      },
    };
  });
}
