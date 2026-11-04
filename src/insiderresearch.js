// Kiểm định tín hiệu giao dịch nội bộ, 8 năm, rổ HOSE theo thời điểm: `npm run research-quality -- insider 8`
//  1. Sự kiện: lãi hơn rổ 5 / 20 phiên sau thông báo đăng ký MUA và đăng ký BÁN (mua mở cửa phiên sau ngày công bố).
//  2. Xếp hạng: IC 20 phiên của tín hiệu riêng và khi thêm vào 4 yếu tố.
//  3. Danh mục theo đúng cấu hình tool tự đầu tư (giữ 30% tiền mặt, mua rải dần 2 mã/phiên, vốn 5 triệu lô lẻ) và vốn
//     100 triệu lô 100, có / không có tín hiệu, 5 lịch.
// Quy tắc đặt trước: CHẤP NHẬN khi phần 3 ở cấu hình tool đạt upgradeVerdict (Sharpe TB hơn ở cả hai nửa, hơn ở ≥ 4/5 lịch,
// sụt TB không tệ hơn quá 1 điểm) VÀ IC tăng có t ≥ 2. Phần 1 để hiểu tín hiệu, không dùng để quyết định.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avgTradedValue } from './data.js';
import { LOT } from './backtest.js';
import { FACTORS } from './ranking.js';
import { buildSamples } from './research.js';
import { compareIc } from './quality.js';
import { ROLLING_RULES, simulateRolling, loadRollingData } from './rolling.js';
import { evalSeries, upgradeVerdict, ODD_LOT_COST } from './riskresearch.js';
import { loadInsider, insiderReader, INSIDER_FACTOR } from './insider.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'insider_research.json');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const tstat = (a) => {
  if (a.length < 3) return null;
  const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  return sd ? m / (sd / Math.sqrt(a.length)) : null;
};
const pc = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(d)}%`);
const fx = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));

/**
 * Lãi hơn rổ sau sự kiện (hàm thuần): mua mở cửa phiên đầu tiên SAU ngày công bố, bán đóng cửa h phiên sau;
 * rổ = trung bình các mã đủ thanh khoản cùng kỳ. Chỉ tính mã thuộc rổ và đủ thanh khoản tại ngày công bố.
 */
export function eventStudy({ cal, data, members, minValue, start }, events, horizons = [5, 20]) {
  const calAt = new Map(cal.map((b, k) => [b.time, k]));
  const fromDate = cal[start].time;
  const basketMemo = new Map();
  const basket = (t, h) => {
    const key = `${t}|${h}`;
    if (basketMemo.has(key)) return basketMemo.get(key);
    const d0 = cal[t].time, d1 = cal[t + h]?.time;
    const inUni = members(d0);
    const r = [];
    if (d1) for (const s of inUni) {
      const x = data[s]; if (!x) continue;
      const i = x.at.get(d0), j = x.at.get(d1);
      if (i == null || j == null || !(x.bars[i].open > 0) || avgTradedValue(x.bars, 20, i - 1) < minValue) continue;
      r.push(x.bars[j].close / x.bars[i].open - 1);
    }
    const v = r.length >= 30 ? mean(r) : null;
    basketMemo.set(key, v);
    return v;
  };
  const out = { buy: {}, sell: {} };
  for (const side of ['buy', 'sell']) for (const h of horizons) out[side][h] = [];
  for (const [s, evs] of Object.entries(events)) {
    const x = data[s]; if (!x) continue;
    for (const e of evs) {
      if (e.published < fromDate) continue;
      const side = e.buy > e.sell ? 'buy' : e.sell > e.buy ? 'sell' : null;
      if (!side) continue;
      // phiên đầu tiên sau ngày công bố
      let t = calAt.get(e.published);
      t = t != null ? t + 1 : cal.findIndex((b) => b.time > e.published);
      if (t < 1 || t >= cal.length) continue;
      const d0 = cal[t].time, i = x.at.get(d0);
      if (i == null || !members(d0).has(s) || avgTradedValue(x.bars, 20, i - 1) < minValue || !(x.bars[i].open > 0)) continue;
      for (const h of horizons) {
        const j = x.at.get(cal[t + h]?.time), b = basket(t, h);
        if (j == null || b == null) continue;
        out[side][h].push({ date: d0, ex: x.bars[j].close / x.bars[i].open - 1 - b });
      }
    }
  }
  const summary = (arr) => {
    const v = arr.map((x) => x.ex), half = Math.floor(arr.length / 2);
    const sorted = [...arr].sort((a, b) => a.date.localeCompare(b.date));
    return { n: v.length, mean: mean(v), t: tstat(v), win: v.length ? v.filter((x) => x > 0).length / v.length : null,
      first: mean(sorted.slice(0, half).map((x) => x.ex)), second: mean(sorted.slice(half).map((x) => x.ex)) };
  };
  return Object.fromEntries(Object.entries(out).map(([side, byH]) => [side, Object.fromEntries(Object.entries(byH).map(([h, a]) => [h, summary(a)]))]));
}

export function formatInsiderReport(r) {
  const ev = (side, h) => {
    const x = r.events[side][h];
    return `${side === 'buy' ? 'Đăng ký MUA' : 'Đăng ký BÁN'} · ${h} phiên: ${x.n} lần · hơn rổ TB ${pc(x.mean)} (t ${fx(x.t)}) · thắng rổ ${pc(x.win, 0)} · nửa đầu ${pc(x.first)} / nửa sau ${pc(x.second)}`;
  };
  const L = [`Tín hiệu giao dịch nội bộ ${r.from} → ${r.to} · ${r.symbolsWithData} mã có dữ liệu, ${r.eventCount} thông báo đăng ký`, '',
    '1. Sau thông báo (mua mở cửa phiên sau ngày công bố, so với rổ):', `   ${ev('buy', 5)}`, `   ${ev('buy', 20)}`, `   ${ev('sell', 5)}`, `   ${ev('sell', 20)}`, '',
    `2. Xếp hạng 20 phiên: IC riêng ${fx(r.ic.alone.mean, 3)} (t ${fx(r.ic.alone.t)}) · thêm vào 4 yếu tố: chênh ${fx(r.ic.diff.mean, 3)} (t ${fx(r.ic.diff.t)}; nửa đầu ${fx(r.ic.diff.first, 3)} / nửa sau ${fx(r.ic.diff.second, 3)})`, '',
    '3. Danh mục (cấu hình tool, 5 lịch):'];
  for (const [cap, rows] of Object.entries(r.portfolio)) {
    L.push(`   Vốn ${Number(cap) / 1e6} triệu:`);
    for (const v of rows) L.push(`     ${v.label.padEnd(28)} năm ${pc(v.avg.annual, 1)} · Sharpe ${fx(v.avg.sharpe)} (${fx(v.avg.first)}/${fx(v.avg.second)}) · sụt TB ${pc(v.avg.maxDD, 1)} · 5 lịch ${v.runs.map((m) => fx(m.sharpe)).join(' ')}${v.verdict ? ` · hơn ở ${v.verdict.wins}/5 → ${v.verdict.ok ? 'đạt' : 'không đạt'}` : ''}`);
  }
  L.push('', `→ ${r.adopt ? 'CHẤP NHẬN: đưa tín hiệu nội bộ vào xếp hạng của tool' : 'KHÔNG CHẤP NHẬN: giữ xếp hạng hiện tại (tín hiệu vẫn có thể hiển thị để tham khảo)'}`);
  return L.join('\n');
}

export async function runInsiderResearch({ years = 8, log = console.log } = {}) {
  const d = await loadRollingData({ years, step: ROLLING_RULES.step });
  const syms = Object.keys(d.data);
  const events = await loadInsider(syms, { log });
  const withData = syms.filter((s) => events[s]?.length);
  log(`${syms.length} mã · ${withData.length} mã có dữ liệu nội bộ`);
  for (const s of syms) {
    const x = d.data[s], ir = insiderReader(x.bars, events[s] || []), base = x.read;
    x.read = (i) => { const f = base(i); return f ? { ...f, ins: ir(i) } : null; };
    x.panel = x.read;
  }

  log('1. Nghiên cứu sự kiện…');
  const evRes = eventStudy(d, events);

  log('2. IC xếp hạng…');
  const samples = buildSamples(d.cal, d.data, { start: d.start, minValue: d.minValue, members: d.members, horizons: [20] });
  const ic = compareIc(samples, FACTORS, [...FACTORS, INSIDER_FACTOR], 20);
  const alone = compareIc(samples, FACTORS, [INSIDER_FACTOR], 20).b;

  log('3. Danh mục…');
  const live = { maxExposure: 0.7, step: 1, maxNew: 2 };
  const portfolio = {};
  for (const [cap, lot, odd] of [[5e6, 1, ODD_LOT_COST], [1e8, LOT, 0]]) {
    const rows = [];
    for (const [label, factors] of [['Xếp hạng hiện tại', FACTORS], ['+ tín hiệu nội bộ', [...FACTORS, INSIDER_FACTOR]]]) {
      log(`   vốn ${cap / 1e6} triệu · ${label}…`);
      const runs = [0, 1, 2, 3, 4].map((k) => evalSeries(simulateRolling(d.cal, d.data, { ...ROLLING_RULES, ...d, ...live, factors, lot, oddLot: odd, initialCash: cap, start: d.start + k }).equity.map((e) => e.value), cap));
      const m = (f) => mean(runs.map(f));
      rows.push({ label, runs: runs.map((x) => ({ sharpe: x.sharpe, annual: x.annual, maxDD: x.maxDD })),
        avg: { annual: m((x) => x.annual), sharpe: m((x) => x.sharpe), first: m((x) => x.first.sharpe), second: m((x) => x.second.sharpe), maxDD: m((x) => x.maxDD) } });
    }
    rows[1].verdict = upgradeVerdict(rows[1], rows[0]);
    portfolio[cap] = rows;
  }
  const adopt = portfolio[5e6][1].verdict.ok && ic.diff.t >= 2;
  const rep = {
    from: d.cal[d.start].time, to: d.cal.at(-1).time, symbolsWithData: withData.length,
    eventCount: withData.reduce((a, s) => a + events[s].length, 0), events: evRes, ic: { ...ic, alone }, portfolio, adopt,
    rule: 'Danh mục cấu hình tool đạt (Sharpe hơn ở cả hai nửa, ≥ 4/5 lịch, sụt không tệ hơn quá 1 điểm) và IC tăng t ≥ 2',
    builtAt: new Date().toISOString(),
  };
  await writeFile(FILE, JSON.stringify(rep), 'utf8');
  return rep;
}
