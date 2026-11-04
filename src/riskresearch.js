// Nâng cấp lõi danh mục cuốn chiếu, kiểm định 8 năm trên rổ HOSE theo thời điểm: `npm run research-quality -- risk 8`
//
// Phần 1 — giảm sụt vốn (so với luật đang chạy B: độ rộng < 50% thì không mua mới, xét mỗi 5 phiên):
//   A không có luật độ rộng · C xét độ rộng hằng ngày · D giảm tỷ trọng theo nấc (< 30%: 0, 30–50%: nửa vốn)
//   E thoát hết khi độ rộng < 25% · F gộp C + D + E
//   Quy tắc đặt trước (như lần chấp nhận luật độ rộng): CHẤP NHẬN khi Sharpe cao hơn B ở CẢ HAI nửa giai đoạn
//   và sụt tối đa không tệ hơn B. Nhiều phương án đạt thì chọn sụt tối đa nhỏ nhất.
//
// Phần 2 — chia danh mục theo số vốn (vốn 5, 20, 50, 100 triệu): 3 / 5 / 10 mã, lô 100 hoặc cho phép lô lẻ
//   (chi phí thêm ODD_LOT_COST mỗi chiều cho phần lô lẻ), lõi ETF E1VFVN30 50% / 70% + vệ tinh 3 mã, và 100% ETF.
//   Quy tắc chọn đặt trước: mỗi mức vốn chọn cấu hình Sharpe cao nhất trong các cấu hình mua được thật
//   (tỷ trọng cổ phiếu trung bình khi được phép mua ≥ 60%: lô 100 với vốn nhỏ thường không mua nổi mã nào).
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { DEFAULTS, calcMetrics, LOT } from './backtest.js';
import { ROLLING_RULES, simulateRolling, loadRollingData } from './rolling.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'risk_research.json');
export const ODD_LOT_COST = 0.003; // lô lẻ khớp ở bảng riêng, thanh khoản mỏng: ước chừng kém 0,3% mỗi chiều
export const ETF = 'E1VFVN30';

export const RISK_VARIANTS = [
  ['A', 'Không có luật độ rộng', { minBreadth: null }],
  ['B', 'Luật đang chạy: < 50% mã khỏe thì không mua mới, xét mỗi 5 phiên', {}],
  ['C', 'Xét độ rộng hằng ngày, đủ 50% là mua ngay', { gateDaily: true }],
  ['D', 'Giảm theo nấc: < 30% không mua, 30–50% nửa vốn', { gradedLo: 0.3, gradedFrac: 0.5 }],
  ['E', 'Thoát hết khi < 25% mã khỏe, chờ ≥ 50% mới mua lại', { crashBreadth: 0.25 }],
  ['F', 'Gộp C + D + E', { gateDaily: true, gradedLo: 0.3, gradedFrac: 0.5, crashBreadth: 0.25 }],
];

/** Chỉ số của một chuỗi tài sản, cả giai đoạn và hai nửa (hàm thuần). */
export function evalSeries(values, initial) {
  const half = Math.floor(values.length / 2);
  const m = (v, base) => {
    const x = calcMetrics(v, [], base);
    return { total: x.totalReturn, annual: x.annualReturn, sharpe: x.sharpe, maxDD: x.maxDrawdown, vol: x.volatility };
  };
  return { ...m(values, initial), first: m(values.slice(0, half), initial), second: m(values.slice(half), values[half - 1]) };
}

/** Quy tắc phần 1 (hàm thuần): Sharpe hơn ở cả hai nửa và sụt tối đa không tệ hơn. */
export function riskVerdict(v, base) {
  return v.first.sharpe > base.first.sharpe && v.second.sharpe > base.second.sharpe && v.maxDD >= base.maxDD - 1e-9;
}

/**
 * Lõi ETF mua một lần ở giá mở cửa phiên đầu rồi giữ (hàm thuần), lô 100, có phí mua; định giá theo giá đóng cửa.
 * @returns {number[]} giá trị theo từng phiên của cal từ start
 */
export function holdEtf(cal, start, etfBars, cash, lot = LOT) {
  const at = new Map(etfBars.map((b) => [b.time, b]));
  let shares = 0, last = null;
  const out = [];
  for (let t = start; t < cal.length; t++) {
    const b = at.get(cal[t].time);
    if (b) last = b.close;
    if (!shares && b?.open > 0) {
      shares = Math.floor(cash / (b.open * 1000 * (1 + DEFAULTS.brokerage)) / lot) * lot;
      cash -= shares * b.open * 1000 * (1 + DEFAULTS.brokerage);
    }
    out.push(cash + shares * (last ?? 0) * 1000);
  }
  return out;
}

const pc = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
const line = (m) => `năm ${pc(m.annual)} · Sharpe ${fx(m.sharpe)} (nửa đầu ${fx(m.first.sharpe)} / nửa sau ${fx(m.second.sharpe)}) · sụt ${pc(m.maxDD)}`;

export function formatRiskReport(r) {
  const L = [`Nâng cấp lõi danh mục ${r.from} → ${r.to} · VN-Index ${pc(r.index)} · ETF ${ETF} giữ nguyên: ${line(r.etf)}`, '',
    'PHẦN 1 — Giảm sụt vốn (vốn 100 triệu, 10 mã, lô 100)'];
  for (const v of r.part1) L.push(`  ${v.id} ${v.label}`, `     ${line(v.m)} · tỷ trọng CP TB ${pc(v.exposure, 0)}${v.id === 'B' ? '' : ` → ${v.ok ? 'ĐẠT' : 'không đạt'}`}`);
  L.push(`  → ${r.pick ? `Áp dụng ${r.pick}` : 'Giữ luật đang chạy (B)'}`, '', 'PHẦN 2 — Chia danh mục theo số vốn (luật thị trường đang chạy)');
  for (const g of r.part2) {
    L.push(`  Vốn ${g.capital / 1e6} triệu:`);
    for (const c of g.rows) L.push(`     ${c.id === g.pick ? '★' : ' '} ${c.label.padEnd(30)} ${line(c.m)} · tỷ trọng CP TB ${pc(c.exposure, 0)}${c.feasible ? '' : ' · (không mua được đủ)'}`);
  }
  return L.join('\n');
}

/** Chạy toàn bộ trên dữ liệu thật, lưu data/risk_research.json. */
export async function runRiskResearch({ years = 8, log = console.log } = {}) {
  const d = await loadRollingData({ years, step: ROLLING_RULES.step });
  const etfBars = (await getPriceHistory(ETF, Math.round((years + 1.3) * 365))).bars;
  log(`${Object.keys(d.data).length} mã · ${d.cal.length - d.start} phiên · ETF ${etfBars.length} phiên`);
  const run = (R, cash) => {
    const sim = simulateRolling(d.cal, d.data, { ...ROLLING_RULES, ...d, ...R, initialCash: cash });
    const values = sim.equity.map((e) => e.value);
    return { values, sim };
  };
  // Tỷ trọng cổ phiếu trung bình = 1 − tiền mặt / tài sản
  const exposureOf = (sim) => sim.equity.reduce((a, e) => a + (e.value > 0 ? 1 - e.cash / e.value : 0), 0) / sim.equity.length;

  // Phần 1
  const part1 = [];
  for (const [id, label, R] of RISK_VARIANTS) {
    log(`Phần 1 · ${id} ${label}…`);
    const { values, sim } = run(R, 1e8);
    part1.push({ id, label, R, m: evalSeries(values, 1e8), stats: sim.stats, exposure: exposureOf(sim) });
  }
  const base = part1.find((x) => x.id === 'B');
  for (const v of part1) v.ok = v.id !== 'B' && v.id !== 'A' && riskVerdict(v.m, base.m);
  const passed = part1.filter((v) => v.ok).sort((a, b) => b.m.maxDD - a.m.maxDD);
  const pick = passed[0]?.id ?? null;

  // Phần 2
  const etfValues = (cash) => holdEtf(d.cal, d.start, etfBars, cash);
  const part2 = [];
  for (const capital of [5e6, 20e6, 50e6, 1e8]) {
    log(`Phần 2 · vốn ${capital / 1e6} triệu…`);
    const rows = [];
    for (const slots of [3, 5, 10]) for (const [lot, odd, tag] of [[LOT, 0, 'lô 100'], [1, ODD_LOT_COST, 'cho phép lô lẻ']]) {
      const { values, sim } = run({ slots, lot, oddLot: odd }, capital);
      rows.push({ id: `${slots}-${lot}`, label: `${slots} mã, ${tag}`, m: evalSeries(values, capital), exposure: exposureOf(sim) });
    }
    for (const core of [0.5, 0.7]) {
      const sat = run({ slots: 3, lot: 1, oddLot: ODD_LOT_COST }, capital * (1 - core));
      const etf = etfValues(capital * core);
      const values = sat.values.map((v, k) => v + etf[k]);
      const satExp = exposureOf(sat.sim);
      rows.push({ id: `etf${core}`, label: `${core * 100}% ETF + 3 mã (lô lẻ)`, m: evalSeries(values, capital), exposure: satExp == null ? null : core + (1 - core) * satExp });
    }
    rows.push({ id: 'etf1', label: '100% ETF', m: evalSeries(etfValues(capital), capital), exposure: 1 });
    for (const r of rows) r.feasible = r.exposure == null || r.exposure >= 0.6 * (base.exposure ?? 1);
    const ok = rows.filter((r) => r.feasible).sort((a, b) => b.m.sharpe - a.m.sharpe);
    part2.push({ capital, rows, pick: ok[0]?.id ?? null });
  }

  const rep = {
    from: d.cal[d.start].time, to: d.cal.at(-1).time, index: d.cal.at(-1).close / d.cal[d.start].close - 1,
    etf: evalSeries(etfValues(1e8), 1e8), part1, pick, part2,
    rules: { part1: 'Sharpe hơn B ở cả hai nửa và sụt tối đa không tệ hơn B', part2: 'Sharpe cao nhất trong cấu hình mua được thật', oddLotCost: ODD_LOT_COST },
    builtAt: new Date().toISOString(),
  };
  await writeFile(FILE, JSON.stringify(rep), 'utf8');
  return rep;
}

// ---------- Kiểm định chống may rủi lịch quyết định: `npm run research-quality -- robust 8` ----------
// Mỗi phương án chạy 5 lần với ngày bắt đầu lệch 0–4 phiên, và chạy bản chia vốn 5 phần lệch ngày (simulateTranched).
// Quy tắc đặt trước:
//   (1) Chia 5 phần được áp dụng nếu với luật đang chạy (B): Sharpe bản chia ≥ trung bình Sharpe 5 lần chạy đơn
//       và sụt tối đa bản chia không tệ hơn trung bình sụt 5 lần chạy đơn (đổi may rủi lấy mức trung bình, không mất gì).
//   (2) Phương án C–F thay được B nếu, trên bản chia 5 phần: Sharpe cao hơn B ở cả hai nửa và sụt tối đa không tệ hơn,
//       VÀ trong 5 lần chạy đơn có ít nhất 4 lần Sharpe cao hơn B cùng lịch.
export function robustVerdict(v, base) {
  const wins = v.singles.filter((m, k) => m.sharpe > base.singles[k].sharpe).length;
  return { wins, ok: riskVerdict(v.tranched, base.tranched) && wins >= 4 };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export function formatRobustReport(r) {
  const L = [`Kiểm định chống may rủi lịch quyết định ${r.from} → ${r.to} (vốn 100 triệu, 10 mã, lô 100)`, ''];
  for (const v of r.variants) {
    L.push(`${v.id} ${v.label}`,
      `   5 lịch đơn: năm ${v.singles.map((m) => pc(m.annual)).join(' ')} · Sharpe ${v.singles.map((m) => fx(m.sharpe)).join(' ')} · sụt ${v.singles.map((m) => pc(m.maxDD)).join(' ')}`,
      `   TB 5 lịch: năm ${pc(v.avg.annual)} · Sharpe ${fx(v.avg.sharpe)} · sụt ${pc(v.avg.maxDD)}`,
      `   Chia 5 phần: ${line(v.tranched)}${v.id === 'B' || v.id === 'A' ? '' : ` · hơn B ở ${v.verdict.wins}/5 lịch → ${v.verdict.ok ? 'ĐẠT' : 'không đạt'}`}`);
  }
  L.push('', `Chia 5 phần lệch ngày cho luật đang chạy: ${r.tranche.ok ? 'ÁP DỤNG' : 'không áp dụng'} (Sharpe ${fx(r.tranche.sharpe)} so với TB ${fx(r.tranche.avgSharpe)}; sụt ${pc(r.tranche.maxDD)} so với TB ${pc(r.tranche.avgDD)})`,
    `Phương án thay luật thị trường: ${r.pick ? r.pick : 'không có, giữ B'}`, '', 'Theo số vốn (luật B, chia 5 phần):');
  for (const c of r.capital) L.push(`   ${String(c.capital / 1e6).padStart(3)} triệu · ${c.label.padEnd(16)} ${line(c.m)} · tỷ trọng CP TB ${pc(c.exposure, 0)}`);
  return L.join('\n');
}

export async function runRobustResearch({ years = 8, log = console.log } = {}) {
  const { simulateTranched } = await import('./rolling.js');
  const d = await loadRollingData({ years, step: ROLLING_RULES.step });
  log(`${Object.keys(d.data).length} mã · ${d.cal.length - d.start} phiên`);
  const base = { ...ROLLING_RULES, ...d };
  const exposureOf = (sim) => mean(sim.equity.map((e) => (e.value > 0 ? 1 - e.cash / e.value : 0)));
  const variants = [];
  for (const [id, label, R] of RISK_VARIANTS) {
    log(`${id} ${label}…`);
    const singles = [0, 1, 2, 3, 4].map((k) => {
      const sim = simulateRolling(d.cal, d.data, { ...base, ...R, start: d.start + k, initialCash: 1e8 });
      return evalSeries(sim.equity.map((e) => e.value), 1e8);
    });
    const tr = simulateTranched(d.cal, d.data, { ...base, ...R, initialCash: 1e8 });
    variants.push({ id, label, R, singles, tranched: evalSeries(tr.equity.map((e) => e.value), 1e8), exposure: exposureOf(tr),
      avg: { annual: mean(singles.map((m) => m.annual)), sharpe: mean(singles.map((m) => m.sharpe)), maxDD: mean(singles.map((m) => m.maxDD)) } });
  }
  const B = variants.find((v) => v.id === 'B');
  for (const v of variants) v.verdict = robustVerdict(v, B);
  const pick = variants.filter((v) => !['A', 'B'].includes(v.id) && v.verdict.ok).sort((a, b) => b.tranched.maxDD - a.tranched.maxDD)[0]?.id ?? null;
  const tranche = { sharpe: B.tranched.sharpe, avgSharpe: B.avg.sharpe, maxDD: B.tranched.maxDD, avgDD: B.avg.maxDD };
  tranche.ok = tranche.sharpe >= tranche.avgSharpe && tranche.maxDD >= tranche.avgDD;

  const capital = [];
  for (const [cap, lot, odd, label] of [[5e6, 1, ODD_LOT_COST, 'lô lẻ'], [20e6, 1, ODD_LOT_COST, 'lô lẻ'], [20e6, LOT, 0, 'lô 100'], [50e6, LOT, 0, 'lô 100'], [1e8, LOT, 0, 'lô 100']]) {
    log(`Vốn ${cap / 1e6} triệu, ${label}…`);
    const tr = simulateTranched(d.cal, d.data, { ...base, lot, oddLot: odd, initialCash: cap });
    capital.push({ capital: cap, label, m: evalSeries(tr.equity.map((e) => e.value), cap), exposure: exposureOf(tr) });
  }
  const rep = { from: d.cal[d.start].time, to: d.cal.at(-1).time, variants, pick, tranche, capital, builtAt: new Date().toISOString() };
  await writeFile(join(dirname(FILE), 'robust_research.json'), JSON.stringify(rep), 'utf8');
  return rep;
}

// ---------- Ba nâng cấp: `npm run research-quality -- upgrade 8` ----------
// So với cấu hình tool đang chạy (giữ 30% tiền mặt): (1) tỷ trọng theo biến động VN-Index, (2) thêm yếu tố định giá E/P và
// B/P vào xếp hạng, (3) mua rải dần mỗi phiên tối đa 2 mã (tổng vẫn 10 mã, không trùng).
// Quy tắc đặt trước: CHẤP NHẬN khi, tính trên 5 lịch quyết định, Sharpe trung bình cao hơn ở cả hai nửa giai đoạn,
// Sharpe cao hơn ở ít nhất 4/5 lịch, và sụt tối đa trung bình không tệ hơn quá 1 điểm %.
export const VALUE_FACTORS = [{ key: 'ey', label: 'Lợi nhuận / giá (E/P)', sign: 1 }, { key: 'bp', label: 'Giá trị sổ sách / giá (B/P)', sign: 1 }];
export const VALUE_LAG_DAYS = 45; // P/E, P/B của ngày D có thể dùng BCTC chưa công bố: lấy số liệu 45 ngày trước rồi chia giá hiện tại

/**
 * Đọc E/P và B/P tại phiên i theo thời điểm (hàm thuần): mẫu số lấy từ P/E, P/B của ít nhất `lag` ngày trước (khi BCTC chắc chắn
 * đã công bố), quy về giá hiện tại. P/E ≤ 0 (lỗ) hoặc thiếu thì null.
 * @param {{ date: string, value: number }[]} pe @param {{ date: string, value: number }[]} pb  (thứ tự bất kỳ)
 */
export function valueReader(bars, pe, pb, lag = VALUE_LAG_DAYS) {
  const asc = (a) => [...(a || [])].sort((x, y) => x.date.localeCompare(y.date));
  const P = asc(pe), B = asc(pb);
  const lastBefore = (arr, d) => { let lo = 0, hi = arr.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].date <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k < 0 ? null : arr[k]; };
  const priceAt = (d) => { let k = bars.length - 1; while (k >= 0 && bars[k].time > d) k--; return k >= 0 ? bars[k].close : null; };
  return (i) => {
    const b = bars[i];
    if (!b) return { ey: null, bp: null };
    const cut = new Date(Date.parse(b.time) - lag * 86400_000).toISOString().slice(0, 10);
    const p = lastBefore(P, cut), q = lastBefore(B, cut);
    const px = (x) => (x ? priceAt(x.date) : null);
    const ep = p && p.value > 0 && px(p) ? (1 / p.value) * (px(p) / b.close) : null;
    const bv = q && q.value > 0 && px(q) ? (1 / q.value) * (px(q) / b.close) : null;
    return { ey: ep, bp: bv };
  };
}

async function loadValuation(symbols, log) {
  const file = join(dirname(FILE), 'valuation_hist.json');
  const { readFile } = await import('node:fs/promises');
  const { fetchJson } = await import('./http.js');
  const { poolMap } = await import('./ranking.js');
  let cache = {};
  try { cache = JSON.parse(await readFile(file, 'utf8')); } catch { /* chưa có */ }
  const need = symbols.filter((s) => !cache[s]);
  log(`P/E, P/B lịch sử: có sẵn ${symbols.length - need.length} mã, tải thêm ${need.length} mã…`);
  const FINFO = 'https://api-finfo.vndirect.com.vn/v4';
  const get = (s, code) => fetchJson(`${FINFO}/ratios?q=code:${s}~itemCode:${code}&sort=reportDate:desc&size=3000&fields=reportDate,value`)
    .then((r) => (r.data || []).filter((x) => Number.isFinite(x.value)).map((x) => ({ date: x.reportDate, value: x.value }))).catch(() => []);
  const got = await poolMap(need, async (s) => ({ pe: await get(s, 51006), pb: await get(s, 51012) }), 6);
  need.forEach((s, k) => { cache[s] = got[k]; });
  await writeFile(file, JSON.stringify(cache), 'utf8');
  return cache;
}

export function upgradeVerdict(v, base) {
  const wins = v.runs.filter((m, k) => m.sharpe > base.runs[k].sharpe).length;
  const ok = v.avg.first > base.avg.first && v.avg.second > base.avg.second && wins >= 4 && v.avg.maxDD >= base.avg.maxDD - 0.01;
  return { wins, ok };
}

export function formatUpgradeReport(r) {
  const L = [`Ba nâng cấp ${r.from} → ${r.to} · so với cấu hình đang chạy (giữ 30% tiền mặt) · trung bình 5 lịch quyết định`, `Độ phủ E/P: ${pc(r.coverage, 0)} số mã-phiên`, ''];
  for (const [cap, rows] of Object.entries(r.byCapital)) {
    L.push(`=== Vốn ${Number(cap) / 1e6} triệu ===`);
    for (const v of rows) L.push(`${v.id} ${v.label.padEnd(44)} năm ${pc(v.avg.annual)} · Sharpe ${fx(v.avg.sharpe)} (${fx(v.avg.first)}/${fx(v.avg.second)}) · sụt TB ${pc(v.avg.maxDD)} · 5 lịch Sharpe ${v.runs.map((m) => fx(m.sharpe)).join(' ')}${v.verdict ? ` · hơn ở ${v.verdict.wins}/5 → ${v.verdict.ok ? 'ĐẠT' : 'không đạt'}` : ''}`);
    L.push('');
  }
  return L.join('\n');
}

export async function runUpgradeResearch({ years = 8, log = console.log } = {}) {
  const { FACTORS } = await import('./ranking.js');
  const d = await loadRollingData({ years, step: ROLLING_RULES.step });
  const val = await loadValuation(Object.keys(d.data), log);
  let have = 0, all = 0;
  for (const [s, x] of Object.entries(d.data)) {
    const vr = valueReader(x.bars, val[s]?.pe, val[s]?.pb), base = x.read;
    x.read = (i) => { const f = base(i); return f ? { ...f, ...vr(i) } : null; };
    for (let i = d.data[s].bars.length - 1; i >= Math.max(0, d.data[s].bars.length - 2000); i -= 50) { all++; if (vr(i).ey != null) have++; }
  }
  const live = { maxExposure: 0.7 };
  const variants = [
    ['B', 'Đang chạy: giữ 30% tiền mặt', live],
    ['V1', 'Tỷ trọng theo biến động VN-Index', { ...live, volScale: true }],
    ['V2', 'Thêm định giá E/P, B/P vào xếp hạng', { ...live, factors: [...FACTORS, ...VALUE_FACTORS] }],
    ['V3', 'Mua rải dần: mỗi phiên tối đa 2 mã, tổng 10 mã', { ...live, step: 1, maxNew: 2 }],
  ];
  const byCapital = {};
  for (const [cap, lot, odd] of [[1e8, LOT, 0], [5e6, 1, ODD_LOT_COST]]) {
    const rows = [];
    for (const [id, label, R] of variants) {
      log(`Vốn ${cap / 1e6} triệu · ${id} ${label}…`);
      const runs = [0, 1, 2, 3, 4].map((k) => {
        const sim = simulateRolling(d.cal, d.data, { ...ROLLING_RULES, ...d, ...R, lot, oddLot: odd, initialCash: cap, start: d.start + k });
        return evalSeries(sim.equity.map((e) => e.value), cap);
      });
      const m = (f) => mean(runs.map(f));
      rows.push({ id, label, R: { ...R, factors: R.factors?.map((x) => x.key) }, runs: runs.map((x) => ({ sharpe: x.sharpe, annual: x.annual, maxDD: x.maxDD })),
        avg: { annual: m((x) => x.annual), sharpe: m((x) => x.sharpe), first: m((x) => x.first.sharpe), second: m((x) => x.second.sharpe), maxDD: m((x) => x.maxDD) } });
    }
    const B = rows[0];
    for (const v of rows.slice(1)) v.verdict = upgradeVerdict(v, B);
    byCapital[cap] = rows;
  }
  const rep = { from: d.cal[d.start].time, to: d.cal.at(-1).time, coverage: all ? have / all : 0, byCapital, builtAt: new Date().toISOString() };
  await writeFile(join(dirname(FILE), 'upgrade_research.json'), JSON.stringify(rep), 'utf8');
  return rep;
}
