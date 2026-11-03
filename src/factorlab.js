// Kiểm định yếu tố mới theo cùng quy tắc đặt trước với ROE: `npm run research-quality -- new3`
//   1. Lợi nhuận quý tăng đột biến (PEAD): LN quý vừa công bố so với cùng kỳ, chỉ trong 60 ngày sau ngày công bố
//   2. Động lượng ngành: lãi 6 tháng (bỏ tháng gần nhất) trung bình của các mã cùng ngành ICB cấp 3
//   3. Đảo chiều ngắn hạn: lãi 5 phiên gần nhất, càng giảm mạnh càng tốt (dấu âm)
// Mỗi yếu tố: IC riêng, IC khi thêm vào 4 yếu tố, và danh mục top 8 có / không có yếu tố đó.
// Chấp nhận khi IC tăng có t ≥ 2 và dương ở cả hai nửa, và danh mục hơn ở cả hai nửa (roeVerdict).
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPanel } from './expectancy.js';
import { buildSamples } from './research.js';
import { FACTORS, PORTFOLIO_RULE, simulateRankPortfolio } from './ranking.js';
import { calcMetrics } from './backtest.js';
import { compareIc, comparePeriods, roeVerdict, loadQuarters, loadForeign, foreignReader, FOREIGN_FACTOR } from './quality.js';
import { getIndustryMap } from './sectors.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'factor_research.json');
const DAY = 86400_000;

export const NEW_FACTORS = [
  { key: 'eps', label: 'LN quý tăng đột biến (60 ngày sau công bố)', sign: 1 },
  { key: 'secmom', label: 'Động lượng ngành 6 tháng', sign: 1 },
  { key: 'rev5', label: 'Đảo chiều 5 phiên', sign: -1 },
];
export const EPS_FRESH_DAYS = 60;

/**
 * LN quý mới nhất đã công bố tại phiên i so với cùng kỳ năm trước (hàm thuần).
 * Chỉ có giá trị trong `fresh` ngày sau ngày công bố; cùng kỳ phải có lãi để tỷ lệ có nghĩa.
 */
export function earningsReader(bars, quarters, fresh = EPS_FRESH_DAYS) {
  const q = [...(quarters || [])].filter((x) => x.profit != null).sort((a, b) => a.fiscal.localeCompare(b.fiscal));
  return (i) => {
    const date = bars[i]?.time;
    if (!date) return null;
    let n = 0;
    while (n < q.length && q[n].available <= date) n++;
    if (!n) return null;
    const cur = q[n - 1];
    if ((Date.parse(date) - Date.parse(cur.available)) / DAY > fresh) return null;
    const ago = q.slice(0, n - 1).findLast((x) => {
      const gap = (Date.parse(cur.fiscal) - Date.parse(x.fiscal)) / DAY;
      return gap >= 350 && gap <= 380;
    });
    return ago && ago.profit > 0 ? cur.profit / ago.profit - 1 : null;
  };
}

/** Lãi n phiên gần nhất tại phiên i (hàm thuần). */
export function reversalReader(bars, n = 5) {
  return (i) => (i >= n && bars[i - n].close > 0 ? bars[i].close / bars[i - n].close - 1 : null);
}

/**
 * Động lượng ngành theo ngày (hàm thuần): trung bình lãi từ phiên i−long đến i−skip của các mã cùng ngành có dữ liệu tại ngày đó.
 * Ngành ít hơn `minMembers` mã thì bỏ (một hai mã không đại diện được ngành).
 * @returns {(symbol: string, date: string) => number|null}
 */
export function sectorMomentum(data, sectorOf, { long = 126, skip = 21, minMembers = 3 } = {}) {
  const byDate = new Map();
  const tableAt = (date) => {
    if (byDate.has(date)) return byDate.get(date);
    const acc = new Map();
    for (const [s, d] of Object.entries(data)) {
      const sec = sectorOf(s), i = d.at.get(date);
      if (!sec || i == null || i < long) continue;
      const a = d.bars[i - long].close, b = d.bars[i - skip].close;
      if (!(a > 0 && b > 0)) continue;
      const x = acc.get(sec) || { sum: 0, n: 0 };
      x.sum += b / a - 1; x.n++;
      acc.set(sec, x);
    }
    const out = new Map([...acc].filter(([, x]) => x.n >= minMembers).map(([k, x]) => [k, x.sum / x.n]));
    byDate.set(date, out);
    return out;
  };
  return (symbol, date) => {
    const sec = sectorOf(symbol);
    return sec ? tableAt(date).get(sec) ?? null : null;
  };
}

const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const pc = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));

export function formatFactorReport(r) {
  const m = (x) => `tổng ${pc(x.totalReturn)} · năm ${pc(x.annualReturn)} · sụt tối đa ${pc(x.maxDrawdown)} · Sharpe ${fx(x.sharpe)}`;
  const V = { adopt: 'CHẤP NHẬN', reject: 'KHÔNG CHẤP NHẬN', insufficient: 'chưa đủ mẫu' };
  const L = [`Kiểm định yếu tố mới ${r.from} → ${r.to} (rổ HOSE theo thời điểm, GTGD ≥ 5 tỷ)`, '',
    `Mốc so sánh — 4 yếu tố: IC 20 phiên ${fx(r.base.ic, 3)} · danh mục top 8: ${m(r.base.portfolio)} · VN-Index ${pc(r.index)}`];
  for (const f of r.factors) {
    L.push('', `■ ${f.label}`,
      `  IC riêng: ${fx(f.alone.mean, 3)} (t ${fx(f.alone.t)}) · độ phủ ${pc(f.coverage, 0)} số mã`,
      `  Thêm vào 4 yếu tố: IC ${fx(f.ic.b.mean, 3)}, chênh ${f.ic.diff.mean >= 0 ? '+' : ''}${fx(f.ic.diff.mean, 3)} (t ${fx(f.ic.diff.t)}; nửa đầu ${fx(f.ic.diff.first, 3)} / nửa sau ${fx(f.ic.diff.second, 3)})`,
      `  Danh mục: ${m(f.portfolio)}`,
      `  Từng kỳ (mới − cũ): ${f.periods.diff >= 0 ? '+' : ''}${pc(f.periods.diff, 2)}/kỳ (t ${fx(f.periods.t)}; nửa đầu ${pc(f.periods.first, 2)} / nửa sau ${pc(f.periods.second, 2)}) · hơn ở ${f.periods.wins}/${f.periods.periods} kỳ`,
      `  → ${V[f.verdict]}`);
  }
  return L.join('\n');
}

/** Chạy trên dữ liệu thật (một lần nạp dữ liệu cho mọi yếu tố), lưu data/factor_research.json. */
export async function runFactorLab({ years = 8, log = console.log, withForeign = true } = {}) {
  const [quarters, industry, foreign] = await Promise.all([
    loadQuarters(), getIndustryMap(), withForeign ? loadForeign() : null,
  ]);
  const panel = await loadPanel({ years });
  log(`Giá: ${Object.keys(panel.data).length} mã · BCTC: ${Object.keys(quarters).length} mã · phân ngành: ${industry.size} mã`);
  const sectorOf = (s) => industry.get(s)?.code ?? null;
  const secMom = sectorMomentum(panel.data, sectorOf);
  for (const [s, d] of Object.entries(panel.data)) {
    const eps = earningsReader(d.bars, quarters[s]), rev = reversalReader(d.bars);
    const fnet = foreign ? foreignReader(d.bars, foreign[s] || new Map()) : null;
    const base = d.read;
    d.ex = 'HOSE'; // biên độ trần/sàn của sàn HOSE cho mô phỏng danh mục
    d.read = (i) => {
      const f = base(i);
      return f ? { ...f, eps: eps(i), secmom: secMom(s, d.bars[i].time), rev5: rev(i), fnet: fnet ? fnet(i) : null } : null;
    };
    d.panel = d.read;
  }
  const samples = buildSamples(panel.cal, panel.data, { start: panel.start, minValue: panel.minValue, members: panel.members, horizons: [20] });
  log(`${samples.length} mốc lấy mẫu`);
  const sim = (factors) => simulateRankPortfolio(panel.cal, panel.data, {
    start: panel.start, top: PORTFOLIO_RULE.top, rebalance: PORTFOLIO_RULE.rebalance, buffer: PORTFOLIO_RULE.buffer,
    trendFilter: true, regime: 'none', factors, earnings: false, minValue: panel.minValue, initialCash: 1e8, members: panel.members,
  });
  const metrics = (x) => calcMetrics(x.equity.map((e) => e.value), x.trades, 1e8);
  const base = sim(FACTORS);
  const tested = [...NEW_FACTORS, ...(foreign ? [FOREIGN_FACTOR] : [])];
  const factors = [];
  for (const F of tested) {
    log(`Đang kiểm định: ${F.label}…`);
    const ic = compareIc(samples, FACTORS, [...FACTORS, F], 20, panel.step);
    const alone = compareIc(samples, FACTORS, [F], 20, panel.step).b;
    let have = 0, all = 0;
    for (const { rows } of samples) for (const x of rows) { all++; if (x.f[F.key] != null && Number.isFinite(x.f[F.key])) have++; }
    const b = sim([...FACTORS, F]);
    const periods = comparePeriods(base.periods, b.periods);
    factors.push({ ...F, alone, ic, coverage: all ? have / all : 0, portfolio: metrics(b), periods, verdict: roeVerdict(ic, periods) });
  }
  const rep = {
    from: base.equity[0]?.time, to: base.equity.at(-1)?.time,
    base: { ic: factors[0]?.ic.a.mean ?? null, portfolio: metrics(base) },
    index: base.equity.at(-1).index / base.equity[0].index - 1,
    factors: factors.map((f) => ({ ...f, alone: { mean: r4(f.alone.mean), t: f.alone.t }, coverage: r4(f.coverage) })),
    rule: 'IC tăng t ≥ 2, dương ở cả hai nửa; danh mục hơn ở cả hai nửa',
    survivorshipBias: panel.survivorshipBias, builtAt: new Date().toISOString(),
  };
  await writeFile(FILE, JSON.stringify(rep), 'utf8');
  return rep;
}
