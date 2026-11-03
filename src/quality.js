// Kiểm định "cổ ngon" trên BCTC theo thời điểm (bảng quarterly_financials, nạp bằng `npm run db-backfill`).
//
// ĐĂNG KÝ TRƯỚC (không chỉnh sau khi xem kết quả):
//  - Chỉ dùng quý đã đến ngày available_date (cuối quý + 45 ngày) tại mỗi mốc: không nhìn trước BCTC chưa công bố.
//  - "Cổ ngon" kiểm định được = 4/6 điều kiện của QUALITY_RULES + withEarnings đang chạy (screener.js):
//      có lãi 4 quý (LN TTM > 0), ROE TTM ≥ 12%, LN TTM không giảm so 4 quý trước, LN quý gần nhất không giảm so cùng kỳ.
//    P/E ≤ 25 và nợ vay/vốn chủ ≤ 1,5 KHÔNG tái tạo được (thiếu số cổ phiếu và nợ vay theo quý) → không kiểm định.
//  - Câu hỏi chính: trong cùng mốc, mã đạt cổ ngon có lãi hơn mã không đạt không? Đo bằng chênh lãi % theo mốc
//    (luật nắm giữ đang chạy LIVE) và chênh R (thoát cố định BASE), t Newey-West, cả hai nửa thời gian.
//    Kết luận "có ích" khi t ≥ 2 và chênh dương ở cả hai nửa — xét trong rổ lõi (điểm ≥ 70, trên MA200), vì tool chỉ
//    áp dụng cổ ngon cho mã đã qua lõi; trên toàn rổ báo cáo để tham khảo.
//  - Các chỉ số liên tục (ROE, tăng trưởng, tăng tốc, chất lượng lợi nhuận, đòn bẩy…) đo bằng IC 20 phiên như research.js.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';
import { loadPanel, EXPECT_STEP } from './expectancy.js';
import { buildSamples, evaluateScore, adoptVerdict, compositeOf } from './research.js';
import { collectTrades, summarize, EXITS } from './evaluation.js';
import { testSeries, spearman } from './verify.js';
import { FACTORS, ROE_FACTOR, PORTFOLIO_RULE, simulateRankPortfolio } from './ranking.js';
import { calcMetrics } from './backtest.js';
import { QUALITY_RULES } from './screener.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'quality_research.json');
const DAY = 86400_000;
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const num = (v) => (v == null ? null : Number(v));

/** Các quý liên tiếp (cách nhau ~3 tháng) — chuỗi có lỗ hổng thì không tính TTM. */
function consecutive(qs) {
  for (let k = 1; k < qs.length; k++) {
    const gap = (Date.parse(qs[k].fiscal) - Date.parse(qs[k - 1].fiscal)) / DAY;
    if (gap < 80 || gap > 100) return false;
  }
  return true;
}

/**
 * Hàm đọc chỉ số BCTC tại một ngày, chỉ dùng quý đã công bố (available ≤ ngày) — hàm thuần.
 * @param {{ fiscal: string, available: string, bank?: boolean, revenue, grossProfit, profit, cfo, equity, assets }[]} quarters
 * @returns {(date: string) => null | object}
 */
export function qualityReader(quarters, R = QUALITY_RULES) {
  const q = [...(quarters || [])].sort((a, b) => a.fiscal.localeCompare(b.fiscal));
  return (date) => {
    let n = 0;
    while (n < q.length && q[n].available <= date) n++;
    if (n < 4) return null;
    const last4 = q.slice(n - 4, n);
    if (!consecutive(last4) || last4.some((x) => x.profit == null)) return null;
    const cur = last4.at(-1);
    const profitTTM = sum(last4.map((x) => x.profit));
    const eq = [cur.equity, n >= 5 ? q[n - 5].equity : null].filter((v) => v != null && v > 0);
    const roe = eq.length ? profitTTM / mean(eq) : null;
    const prev4 = n >= 8 ? q.slice(n - 8, n - 4) : null;
    const prevOk = prev4 && consecutive(q.slice(n - 8, n)) && prev4.every((x) => x.profit != null);
    const prevTTM = prevOk ? sum(prev4.map((x) => x.profit)) : null;
    const yearAgo = n >= 5 && consecutive(q.slice(n - 5, n)) ? q[n - 5] : null;
    const twoAgo = n >= 6 && consecutive(q.slice(n - 6, n)) ? { cur: q[n - 2], ago: q[n - 6] } : null;
    const yoy = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);
    const eg = yoy(cur.profit, yearAgo?.profit);
    const egPrev = twoAgo ? yoy(twoAgo.cur.profit, twoAgo.ago.profit) : null;
    const revTTM = last4.every((x) => x.revenue != null) ? sum(last4.map((x) => x.revenue)) : null;
    const revPrev = prevOk && prev4.every((x) => x.revenue != null) ? sum(prev4.map((x) => x.revenue)) : null;
    const cfoTTM = last4.every((x) => x.cfo != null) ? sum(last4.map((x) => x.cfo)) : null;

    const profitable = profitTTM > 0;
    const roeOk = roe != null && roe >= R.minRoe;
    const ttmUp = prevTTM != null ? profitTTM >= prevTTM : null;
    const qUp = yearAgo?.profit != null ? cur.profit >= yearAgo.profit : null;
    return {
      profitTTM, roe: r4(roe),
      profitGrowth: r4(yoy(profitTTM, prevTTM)), revenueGrowth: r4(yoy(revTTM, revPrev)),
      eg: r4(eg), accel: eg != null && egPrev != null ? r4(eg - egPrev) : null,
      cfoRatio: profitTTM > 0 && cfoTTM != null && !cur.bank ? r4(cfoTTM / profitTTM) : null,
      leverage: !cur.bank && cur.equity > 0 && cur.assets != null ? r4((cur.assets - cur.equity) / cur.equity) : null,
      bank: !!cur.bank,
      checks: { profitable, roeOk, ttmUp, qUp },
      // Thiếu dữ liệu điều kiện nào thì không đạt (giống qualityCheck: không xác minh được là không đạt)
      pass: profitable && roeOk && ttmUp === true && qUp === true,
    };
  };
}

/** Dữ liệu quý từ database, nhóm theo mã. */
export async function loadQuarters() {
  const rows = (await query(`SELECT symbol, to_char(fiscal_date, 'YYYY-MM-DD') f, to_char(available_date, 'YYYY-MM-DD') a,
    bank, revenue, gross_profit, profit, cfo, equity, assets FROM quarterly_financials ORDER BY symbol, fiscal_date`)).rows;
  const by = {};
  for (const r of rows) {
    (by[r.symbol] ??= []).push({ fiscal: r.f, available: r.a, bank: r.bank, revenue: num(r.revenue), grossProfit: num(r.gross_profit),
      profit: num(r.profit), cfo: num(r.cfo), equity: num(r.equity), assets: num(r.assets) });
  }
  return by;
}

/**
 * Chênh lệch theo mốc giữa hai nhóm lệnh (cùng mốc mới so): trung bình nhóm A − trung bình nhóm B, t Newey-West.
 * @param {(t) => number} val giá trị của một lệnh (lãi % hoặc R của một kiểu thoát)
 */
export function groupSpread(tradesA, tradesB, val, mid, lags) {
  const by = (tr) => {
    const m = new Map();
    for (const x of tr) (m.get(x.date) ?? m.set(x.date, []).get(x.date)).push(val(x));
    return m;
  };
  const A = by(tradesA), B = by(tradesB);
  const dates = [...A.keys()].filter((d) => B.has(d)).sort();
  const diff = (ds) => ds.map((d) => mean(A.get(d)) - mean(B.get(d)));
  const all = testSeries(diff(dates), lags, null, { minDates: 20, t: 2 });
  const first = mean(diff(dates.filter((d) => d < mid))), second = mean(diff(dates.filter((d) => d >= mid)));
  let verdict = 'unproven';
  if (all.verdict === 'insufficient') verdict = 'insufficient';
  else if (all.t >= 2 && first > 0 && second > 0) verdict = 'helps';
  else if (all.t <= -2) verdict = 'hurts';
  return { dates: dates.length, diff: all.mean, t: all.t, first: r4(first), second: r4(second), verdict };
}

export const QUALITY_FACTORS = [
  { key: 'roe', label: 'ROE 4 quý', sign: 1 },
  { key: 'profitGrowth', label: 'Tăng trưởng LN 4 quý', sign: 1 },
  { key: 'revenueGrowth', label: 'Tăng trưởng doanh thu 4 quý', sign: 1 },
  { key: 'eg', label: 'LN quý gần nhất so cùng kỳ', sign: 1 },
  { key: 'accel', label: 'Tăng tốc LN quý', sign: 1 },
  { key: 'cfoRatio', label: 'Dòng tiền KD / LN (chất lượng LN)', sign: 1 },
  { key: 'leverage', label: 'Đòn bẩy (nợ phải trả / vốn chủ)', sign: -1 },
];

/** Báo cáo (hàm thuần) từ các lệnh đã gắn cờ quality và bảng mẫu IC. */
export function buildQualityReport(trades, samples, step = EXPECT_STEP) {
  const dates = [...new Set(trades.map((x) => x.date))].sort();
  const mid = dates[Math.floor(dates.length / 2)];
  const live = EXITS.find((x) => x.key === 'LIVE'), base = EXITS[0];
  const core = (x) => x.rules.includes('CORE');
  const groups = {
    ALL_Q: trades.filter((x) => x.quality === true), ALL_NOQ: trades.filter((x) => x.quality === false),
    CORE_Q: trades.filter((x) => core(x) && x.quality === true), CORE_NOQ: trades.filter((x) => core(x) && x.quality === false),
  };
  const sumBy = (tr, X) => summarize(tr.map((x) => ({ date: x.date, ...x.exits[X.key] })), step, X.maxDays);
  const lagsOf = (X) => Math.max(0, Math.ceil(X.maxDays / step) - 1);
  const spread = (a, b) => ({
    live: groupSpread(groups[a], groups[b], (x) => x.exits.LIVE.ret, mid, lagsOf(live)),
    base: groupSpread(groups[a], groups[b], (x) => x.exits.BASE.r, mid, lagsOf(base)),
  });
  // Từng điều kiện riêng lẻ trong rổ lõi: đạt vs không đạt (luật nắm giữ)
  const components = Object.fromEntries(['profitable', 'roeOk', 'ttmUp', 'qUp'].map((k) => {
    const a = trades.filter((x) => core(x) && x.checks?.[k] === true), b = trades.filter((x) => core(x) && x.checks?.[k] === false);
    return [k, { n: [a.length, b.length], live: groupSpread(a, b, (x) => x.exits.LIVE.ret, mid, lagsOf(live)) }];
  }));
  const ic = QUALITY_FACTORS.map((f) => {
    const ev = evaluateScore(samples, (rows) => rows.map((x) => (x.f[f.key] == null ? null : f.sign * x.f[f.key])), 20, step);
    return { ...f, ic: ev.all.mean, t: ev.all.t, first: ev.first.mean, second: ev.second.mean, spread: ev.all.spread, verdict: adoptVerdict(ev) };
  });
  const withData = trades.filter((x) => x.quality != null).length;
  return {
    from: dates[0], to: dates.at(-1), split: mid, trades: trades.length, coverage: r4(withData / (trades.length || 1)),
    groups: Object.fromEntries(Object.entries(groups).map(([k, tr]) => [k, { live: sumBy(tr, live), base: sumBy(tr, base) }])),
    spread: { all: spread('ALL_Q', 'ALL_NOQ'), core: spread('CORE_Q', 'CORE_NOQ') },
    components, ic,
  };
}

const pc = (v, d = 1) => (v == null ? '–' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 2) => (v == null ? '–' : v.toFixed(d));
const V = { helps: 'CÓ ÍCH', hurts: 'CÓ HẠI', unproven: 'chưa chứng minh', insufficient: 'chưa đủ mẫu', adopt: 'CÓ ÍCH', reject: 'ngược chiều', inconclusive: 'chưa chứng minh' };

export function formatQualityReport(r) {
  const g = (k) => r.groups[k];
  const line = (name, k) => `  ${name.padEnd(30)} ${String(g(k).live.n || 0).padStart(6)} lệnh · giữ theo luật: thắng ${pc(g(k).live.winRate)}, lãi TB ${pc(g(k).live.avgRet, 2)} · thoát cố định: R TB ${fx(g(k).base.avgR)}`;
  const sp = (s) => `chênh ${s.live.diff >= 0 ? '+' : ''}${pc(s.live.diff, 2)}/lệnh (t ${fx(s.live.t)}, nửa đầu ${pc(s.live.first, 2)} / nửa sau ${pc(s.live.second, 2)}): ${V[s.live.verdict]} · thoát cố định ${s.base.diff >= 0 ? '+' : ''}${fx(s.base.diff)}R (t ${fx(s.base.t)}): ${V[s.base.verdict]}`;
  const out = [
    `Kiểm định cổ ngon ${r.from} → ${r.to} · ${r.trades} tín hiệu, ${pc(r.coverage, 0)} có đủ BCTC · tách nửa tại ${r.split}`,
    'Cổ ngon = có lãi 4 quý + ROE ≥ 12% + LN 4 quý không giảm + LN quý gần nhất không giảm (BCTC dùng sau cuối quý 45 ngày)',
    '',
    line('Toàn rổ · cổ ngon', 'ALL_Q'), line('Toàn rổ · không đạt', 'ALL_NOQ'),
    `  → ${sp(r.spread.all)}`,
    '',
    line('Lõi (điểm ≥70, trên MA200) · cổ ngon', 'CORE_Q'), line('Lõi · không đạt', 'CORE_NOQ'),
    `  → ${sp(r.spread.core)}`,
    '',
    'Từng điều kiện trong rổ lõi (đạt − không đạt, giữ theo luật):',
    ...Object.entries(r.components).map(([k, c]) => `  ${{ profitable: 'Có lãi 4 quý', roeOk: 'ROE ≥ 12%', ttmUp: 'LN 4 quý không giảm', qUp: 'LN quý không giảm' }[k].padEnd(22)} ${c.n[0]}/${c.n[1]} lệnh · ${c.live.diff >= 0 ? '+' : ''}${pc(c.live.diff, 2)} (t ${fx(c.live.t)}, ${pc(c.live.first, 2)} / ${pc(c.live.second, 2)}): ${V[c.live.verdict]}`),
    '',
    'Chỉ số liên tục — IC với lãi hơn rổ 20 phiên (toàn rổ):',
    ...r.ic.map((f) => `  ${f.label.padEnd(36)} IC ${fx(f.ic, 3)} (t ${fx(f.t)}; nửa đầu ${fx(f.first, 3)} / nửa sau ${fx(f.second, 3)}) · nhóm 20% tốt − 20% kém ${pc(f.spread, 2)}: ${V[f.verdict] || f.verdict}`),
  ];
  return out.join('\n');
}

// ---------- Thử thêm ROE vào điểm xếp hạng ----------
// ĐĂNG KÝ TRƯỚC: hai phiên bản V1 = FACTORS (4 yếu tố đang dùng), V1_ROE = FACTORS + ROE 4 quý (trọng số bằng nhau, không dò).
// Chấp nhận khi CẢ HAI: (a) IC 20 phiên của điểm V1_ROE hơn V1 theo từng mốc, t ≥ 2 và chênh dương ở cả hai nửa;
// (b) danh mục top 8 (tái cơ cấu 20 phiên, lọc MA200, luật PORTFOLIO_RULE) theo V1_ROE lãi hơn V1 mỗi kỳ, dương ở cả hai nửa.

/**
 * So IC theo từng mốc của hai bộ yếu tố trên cùng bảng mẫu (hàm thuần).
 * @returns {{ a, b, diff }} a/b: IC trung bình từng bộ; diff: chênh b − a với t Newey-West và hai nửa
 */
export function compareIc(samples, factorsA, factorsB, h = 20, step = EXPECT_STEP) {
  const rows = [];
  for (const { date, rows: rs } of samples) {
    const sa = compositeOf(rs, factorsA), sb = compositeOf(rs, factorsB);
    const ok = rs.map((x, k) => [sa[k], sb[k], x.ex[h]]).filter(([p, q, y]) => p != null && q != null && y != null);
    if (ok.length < 30) continue;
    const ia = spearman(ok.map((x) => x[0]), ok.map((x) => x[2])), ib = spearman(ok.map((x) => x[1]), ok.map((x) => x[2]));
    if (ia != null && ib != null) rows.push({ date, ia, ib });
  }
  const lags = Math.max(0, Math.ceil(h / step) - 1);
  const half = Math.floor(rows.length / 2);
  const R = { minDates: 20, t: 2 };
  const diff = testSeries(rows.map((x) => x.ib - x.ia), lags, null, R);
  return {
    a: testSeries(rows.map((x) => x.ia), lags, null, R), b: testSeries(rows.map((x) => x.ib), lags, null, R),
    diff: { ...diff, first: r4(mean(rows.slice(0, half).map((x) => x.ib - x.ia))), second: r4(mean(rows.slice(half).map((x) => x.ib - x.ia))) },
  };
}

/** Chênh lãi từng kỳ của hai danh mục chạy trên cùng lịch tái cơ cấu (hàm thuần). */
export function comparePeriods(periodsA, periodsB) {
  const byFrom = new Map(periodsA.filter((p) => !p.open).map((p) => [p.from, p]));
  const pairs = periodsB.filter((p) => !p.open && byFrom.has(p.from)).map((p) => ({ from: p.from, d: p.ret - byFrom.get(p.from).ret }));
  const half = Math.floor(pairs.length / 2);
  const t = testSeries(pairs.map((x) => x.d), 0, null, { minDates: 10, t: 2 });
  return { periods: pairs.length, diff: t.mean, t: t.t, first: r4(mean(pairs.slice(0, half).map((x) => x.d))), second: r4(mean(pairs.slice(half).map((x) => x.d))),
    wins: pairs.filter((x) => x.d > 0).length };
}

export function roeVerdict(ic, pf) {
  if (ic.diff.verdict === 'insufficient' || !pf.periods) return 'insufficient';
  const icOk = ic.diff.t >= 2 && ic.diff.first > 0 && ic.diff.second > 0;
  const pfOk = pf.first > 0 && pf.second > 0;
  return icOk && pfOk ? 'adopt' : 'reject';
}

export function formatRoeReport(r) {
  const m = (x) => `tổng ${pc(x.totalReturn)} · năm ${pc(x.annualReturn)} · sụt tối đa ${pc(x.maxDrawdown)} · Sharpe ${fx(x.sharpe)}`;
  return [
    `Thử thêm ROE vào điểm xếp hạng ${r.from} → ${r.to}`,
    '',
    `IC 20 phiên: 4 yếu tố ${fx(r.ic.a.mean, 3)} (t ${fx(r.ic.a.t)}) · 4 yếu tố + ROE ${fx(r.ic.b.mean, 3)} (t ${fx(r.ic.b.t)})`,
    `  chênh ${r.ic.diff.mean >= 0 ? '+' : ''}${fx(r.ic.diff.mean, 3)} (t ${fx(r.ic.diff.t)}; nửa đầu ${fx(r.ic.diff.first, 3)} / nửa sau ${fx(r.ic.diff.second, 3)})`,
    '',
    `Danh mục top 8 (tái cơ cấu 20 phiên, lọc MA200, tính phí thuế, T+2):`,
    `  4 yếu tố:        ${m(r.portfolio.v1)}`,
    `  4 yếu tố + ROE:  ${m(r.portfolio.roe)}`,
    `  VN-Index:        tổng ${pc(r.portfolio.index)}`,
    `  Từng kỳ (+ROE − cũ): ${r.periods.diff >= 0 ? '+' : ''}${pc(r.periods.diff, 2)}/kỳ (t ${fx(r.periods.t)}; nửa đầu ${pc(r.periods.first, 2)} / nửa sau ${pc(r.periods.second, 2)}) · hơn ở ${r.periods.wins}/${r.periods.periods} kỳ`,
    '',
    `Kết luận theo quy tắc đặt trước: ${r.verdict === 'adopt' ? 'CHẤP NHẬN — đưa ROE vào điểm xếp hạng' : r.verdict === 'reject' ? 'KHÔNG CHẤP NHẬN — giữ điểm 4 yếu tố' : 'chưa đủ mẫu'}`,
  ].join('\n');
}

/** Chạy so sánh trên dữ liệu thật, lưu data/roe_research.json. */
export async function runRoeTest({ years = 7, log = console.log } = {}) {
  const quarters = await loadQuarters();
  const panel = await loadPanel({ years });
  log(`Giá: ${Object.keys(panel.data).length} mã, BCTC: ${Object.keys(quarters).length} mã`);
  for (const [s, d] of Object.entries(panel.data)) {
    const q = qualityReader(quarters[s] || []);
    const base = d.read;
    d.ex = 'HOSE';
    d.read = (i) => { const f = base(i); return f ? { ...f, roe: q(d.bars[i].time)?.roe ?? null } : null; };
    d.panel = d.read;
  }
  const V1 = FACTORS, V2 = [...FACTORS, ROE_FACTOR];
  const samples = buildSamples(panel.cal, panel.data, { start: panel.start, minValue: panel.minValue, members: panel.members, horizons: [20] });
  const ic = compareIc(samples, V1, V2, 20, panel.step);
  const sim = (factors) => simulateRankPortfolio(panel.cal, panel.data, {
    start: panel.start, top: PORTFOLIO_RULE.top, rebalance: PORTFOLIO_RULE.rebalance, buffer: PORTFOLIO_RULE.buffer,
    trendFilter: true, regime: 'none', factors, earnings: false, minValue: panel.minValue, initialCash: 1e8, members: panel.members,
  });
  const a = sim(V1), b = sim(V2);
  const metrics = (s) => calcMetrics(s.equity.map((e) => e.value), s.trades, 1e8);
  const periods = comparePeriods(a.periods, b.periods);
  const rep = {
    from: a.equity[0]?.time, to: a.equity.at(-1)?.time, ic,
    portfolio: { v1: metrics(a), roe: metrics(b), index: a.equity.at(-1).index / a.equity[0].index - 1 },
    periods, verdict: roeVerdict(ic, periods), builtAt: new Date().toISOString(),
  };
  await writeFile(join(dirname(FILE), 'roe_research.json'), JSON.stringify(rep), 'utf8');
  return rep;
}

/** Chạy toàn bộ trên dữ liệu thật và lưu data/quality_research.json. */
export async function runQualityResearch({ years = 7, log = console.log } = {}) {
  const quarters = await loadQuarters();
  log(`BCTC quý: ${Object.keys(quarters).length} mã`);
  const panel = await loadPanel({ years });
  log(`Giá: ${Object.keys(panel.data).length} mã, ${panel.cal.length} phiên`);
  for (const [s, d] of Object.entries(panel.data)) {
    const read = qualityReader(quarters[s] || []);
    d.quality = read;
    d.panel = (i) => (i < d.bars.length ? read(d.bars[i].time) : null);
  }
  const collected = collectTrades(panel.cal, panel.data, panel);
  const samples = buildSamples(panel.cal, panel.data, { start: panel.start, minValue: panel.minValue, members: panel.members, horizons: [20] });
  const rep = { ...buildQualityReport(collected.trades, samples, panel.step), survivorshipBias: panel.survivorshipBias, builtAt: new Date().toISOString() };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(rep), 'utf8');
  return rep;
}

// ---------- Khối ngoại: mua/bán ròng 20 phiên chia giá trị giao dịch 20 phiên ----------
export const FOREIGN_FACTOR = { key: 'fnet', label: 'Khối ngoại mua ròng 20 phiên', sign: 1 };
export const FOREIGN_WINDOW = 20;

/** Khối ngoại theo ngày từ DB: { symbol: Map(date → net_val đồng) }. */
export async function loadForeign() {
  const r = await query(`SELECT symbol, to_char(date, 'YYYY-MM-DD') d, net_val FROM foreign_daily`);
  const out = {};
  for (const x of r.rows) (out[x.symbol] ??= new Map()).set(x.d, num(x.net_val));
  return out;
}

/**
 * Đọc yếu tố khối ngoại tại phiên i (hàm thuần): tổng mua ròng N phiên / tổng giá trị khớp N phiên.
 * Chỉ dùng số liệu đến hết phiên i; thiếu quá nửa số phiên thì trả null.
 */
export function foreignReader(bars, net, N = FOREIGN_WINDOW) {
  return (i) => {
    if (i < N - 1) return null;
    let n = 0, v = 0, seen = 0;
    for (let k = i - N + 1; k <= i; k++) {
      const b = bars[k];
      v += b.close * 1000 * b.volume;
      const x = net.get(b.time);
      if (x != null) { n += x; seen++; }
    }
    return seen >= N / 2 && v > 0 ? n / v : null;
  };
}

export function formatForeignReport(r) {
  const m = (x) => `tổng ${pc(x.totalReturn)} · năm ${pc(x.annualReturn)} · sụt tối đa ${pc(x.maxDrawdown)} · Sharpe ${fx(x.sharpe)}`;
  return [
    `Kiểm định khối ngoại ${r.from} → ${r.to}`,
    '',
    `IC 20 phiên riêng khối ngoại: ${fx(r.alone.mean, 3)} (t ${fx(r.alone.t)})`,
    `IC 20 phiên: 4 yếu tố ${fx(r.ic.a.mean, 3)} (t ${fx(r.ic.a.t)}) · 4 yếu tố + khối ngoại ${fx(r.ic.b.mean, 3)} (t ${fx(r.ic.b.t)})`,
    `  chênh ${r.ic.diff.mean >= 0 ? '+' : ''}${fx(r.ic.diff.mean, 3)} (t ${fx(r.ic.diff.t)}; nửa đầu ${fx(r.ic.diff.first, 3)} / nửa sau ${fx(r.ic.diff.second, 3)})`,
    '',
    `Danh mục top 8 (tái cơ cấu 20 phiên, lọc MA200, tính phí thuế, T+2):`,
    `  4 yếu tố:              ${m(r.portfolio.v1)}`,
    `  4 yếu tố + khối ngoại: ${m(r.portfolio.foreign)}`,
    `  VN-Index:              tổng ${pc(r.portfolio.index)}`,
    `  Từng kỳ (mới − cũ): ${r.periods.diff >= 0 ? '+' : ''}${pc(r.periods.diff, 2)}/kỳ (t ${fx(r.periods.t)}; nửa đầu ${pc(r.periods.first, 2)} / nửa sau ${pc(r.periods.second, 2)}) · hơn ở ${r.periods.wins}/${r.periods.periods} kỳ`,
    '',
    `Kết luận theo quy tắc đặt trước: ${r.verdict === 'adopt' ? 'CHẤP NHẬN — đưa khối ngoại vào điểm xếp hạng' : r.verdict === 'reject' ? 'KHÔNG CHẤP NHẬN — giữ điểm 4 yếu tố' : 'chưa đủ mẫu'}`,
  ].join('\n');
}

/** Cùng quy tắc với ROE (roeVerdict): IC tăng t ≥ 2 ở cả hai nửa và danh mục hơn ở cả hai nửa. Lưu data/foreign_research.json. */
export async function runForeignTest({ years = 8, log = console.log } = {}) {
  const foreign = await loadForeign();
  const panel = await loadPanel({ years });
  log(`Giá: ${Object.keys(panel.data).length} mã, khối ngoại: ${Object.keys(foreign).length} mã`);
  for (const [s, d] of Object.entries(panel.data)) {
    const f = foreignReader(d.bars, foreign[s] || new Map());
    const base = d.read;
    d.ex = 'HOSE'; // thiếu dòng này mô phỏng danh mục ra NaN (biên độ trần/sàn không xác định)
    d.read = (i) => { const x = base(i); return x ? { ...x, fnet: f(i) } : null; };
    d.panel = d.read;
  }
  const V1 = FACTORS, V2 = [...FACTORS, FOREIGN_FACTOR];
  const samples = buildSamples(panel.cal, panel.data, { start: panel.start, minValue: panel.minValue, members: panel.members, horizons: [20] });
  const ic = compareIc(samples, V1, V2, 20, panel.step);
  const alone = compareIc(samples, V1, [FOREIGN_FACTOR], 20, panel.step).b;
  const sim = (factors) => simulateRankPortfolio(panel.cal, panel.data, {
    start: panel.start, top: PORTFOLIO_RULE.top, rebalance: PORTFOLIO_RULE.rebalance, buffer: PORTFOLIO_RULE.buffer,
    trendFilter: true, regime: 'none', factors, earnings: false, minValue: panel.minValue, initialCash: 1e8, members: panel.members,
  });
  const a = sim(V1), b = sim(V2);
  const metrics = (s) => calcMetrics(s.equity.map((e) => e.value), s.trades, 1e8);
  const periods = comparePeriods(a.periods, b.periods);
  const rep = {
    from: a.equity[0]?.time, to: a.equity.at(-1)?.time, ic, alone,
    portfolio: { v1: metrics(a), foreign: metrics(b), index: a.equity.at(-1).index / a.equity[0].index - 1 },
    periods, verdict: roeVerdict(ic, periods), builtAt: new Date().toISOString(),
  };
  await writeFile(join(dirname(FILE), 'foreign_research.json'), JSON.stringify(rep), 'utf8');
  return rep;
}
