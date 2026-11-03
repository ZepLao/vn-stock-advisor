// Bảng chấm điểm tuần: tool có thắng thị trường thật không (tài khoản giấy) và khuyến nghị đúng / sai bao nhiêu.
// Dữ liệu: lịch sử tài sản + sổ lệnh của tool tự đầu tư (autotrade.js) và các khuyến nghị đã tự chấm (predictions.js).
import { getAutoTrade } from './autotrade.js';
import { scoredPredictions } from './predictions.js';

const DAY = 86400_000;

// Nguồn khuyến nghị đưa vào bảng (mua = kỳ vọng hơn rổ, tránh = kỳ vọng kém rổ)
export const SCORE_SOURCES = [
  ['final', 'Quyết định cuối (hệ thống + AI)'],
  ['rank_top', 'Top 8 bảng xếp hạng'],
  ['ai', 'Gemini'],
  ['committee', 'Hội đồng đầu tư'],
];
export const SCORE_H = 5;

/** Thứ 2 → thứ 6 của tuần chứa `date` (YYYY-MM-DD, theo lịch). */
export function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const mon = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { from: iso(mon), to: iso(new Date(mon.getTime() + 4 * DAY)) };
}

/**
 * Chuỗi hiệu suất đã loại trừ nạp / rút tiền (hàm thuần): mỗi phiên lãi = (NAV − NAV trước − tiền nạp thêm) / NAV trước.
 * @param {{ date, nav, funded }[]} equity
 * @returns {{ date, perf }[]} perf bắt đầu từ 1
 */
export function perfSeries(equity) {
  const out = [];
  let perf = 1;
  equity.forEach((e, k) => {
    if (k) {
      const p = equity[k - 1];
      const flow = (e.funded ?? 0) - (p.funded ?? 0);
      if (p.nav > 0) perf *= 1 + (e.nav - p.nav - flow) / p.nav;
    }
    out.push({ date: e.date, perf });
  });
  return out;
}

const maxDrawdown = (vals) => {
  let peak = -Infinity, dd = 0;
  for (const v of vals) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  return dd;
};

/**
 * Bảng chấm điểm của tuần chứa `asOf` (hàm thuần).
 * @param {{ equity: {date,nav,funded,index}[], orders: object[], scored: object[], index: {time,close}[], asOf: string }} o
 */
export function buildScorecard({ equity = [], orders = [], scored = [], index = [], asOf }) {
  const week = weekOf(asOf);
  const sessions = index.filter((b) => b.time >= week.from && b.time <= week.to).map((b) => b.time);

  // 1. Tool tự đầu tư: tuần này và từ đầu, so với VN-Index cùng kỳ
  let tool = null;
  if (equity.length) {
    const perf = perfSeries(equity);
    const before = perf.filter((p) => p.date < week.from).at(-1) || perf[0];
    const end = perf.filter((p) => p.date <= week.to).at(-1);
    const eqAt = (d) => equity.find((e) => e.date === d);
    const weekRet = end && before ? end.perf / before.perf - 1 : null;
    const idxWeek = end && before && eqAt(before.date)?.index && eqAt(end.date)?.index ? eqAt(end.date).index / eqAt(before.date).index - 1 : null;
    const first = equity[0], last = equity.at(-1);
    const fills = orders.filter((o) => o.date >= week.from && o.date <= week.to);
    const sells = fills.filter((o) => o.side === 'SELL' && o.pnl != null);
    // Cả tuần không nắm cổ phiếu nào: hơn / kém VN-Index chỉ vì đứng ngoài, không phải nhờ chọn mã
    const inWeek = equity.filter((e) => e.date >= week.from && e.date <= week.to);
    const cashOnly = inWeek.length > 0 && inWeek.every((e) => e.cash != null && e.cash >= e.nav * 0.99);
    tool = {
      nav: last.nav, funded: last.funded, sessions: equity.length, cashOnly,
      week: { ret: weekRet, index: idxWeek, vs: weekRet != null && idxWeek != null ? weekRet - idxWeek : null, from: before?.date, to: end?.date },
      total: { ret: perf.at(-1).perf - 1, index: first.index && last.index ? last.index / first.index - 1 : null },
      maxDrawdown: maxDrawdown(perf.map((p) => p.perf)),
      trades: { buys: fills.filter((o) => o.side === 'BUY').length, sells: sells.length, wins: sells.filter((o) => o.pnl > 0).length, pnl: sells.reduce((a, o) => a + o.pnl, 0) },
    };
    tool.total.vs = tool.total.index != null ? tool.total.ret - tool.total.index : null;
  }

  // 2. Khuyến nghị có kết quả 5 phiên kết thúc trong tuần này
  const pos = new Map(index.map((b, k) => [b.time, k]));
  const endOf = (d) => (pos.has(d) ? index[pos.get(d) + SCORE_H]?.time ?? null : null);
  const calls = SCORE_SOURCES.map(([source, label]) => {
    const mine = scored.filter((x) => x.source === source && x.direction && x.result?.[SCORE_H]?.beatBasket != null)
      .filter((x) => { const e = endOf(x.date); return e && e >= week.from && e <= week.to; });
    const side = (dir) => {
      const a = mine.filter((x) => x.direction === dir);
      return {
        n: a.length,
        right: a.filter((x) => x.result[SCORE_H].beatBasket).length,
        avgExcess: a.length ? a.reduce((s, x) => s + (x.result[SCORE_H].excessBasket ?? 0), 0) / a.length : null,
        worst: dir > 0 ? [...new Set(a.filter((x) => !x.result[SCORE_H].beatBasket).sort((p, q) => p.result[SCORE_H].excessBasket - q.result[SCORE_H].excessBasket).map((x) => x.symbol))].slice(0, 3) : [],
      };
    };
    return { source, label, buy: side(1), avoid: side(-1) };
  }).filter((c) => c.buy.n || c.avoid.n);

  // 3. Một dòng kết luận
  let verdict;
  if (!tool || tool.week.vs == null) verdict = 'Chưa đủ dữ liệu tài khoản tự đầu tư cho tuần này.';
  else {
    const v = tool.week.vs * 100;
    verdict = (tool.cashOnly
      ? `Tuần này tool đứng ngoài (100% tiền mặt) nên ${v >= 0 ? `tránh được mức giảm ${Math.abs(tool.week.index * 100).toFixed(1).replace('.', ',')}% của VN-Index` : `lỡ mức tăng ${(tool.week.index * 100).toFixed(1).replace('.', ',')}% của VN-Index`}`
      : `Tuần này tool ${v >= 0 ? 'hơn' : 'kém'} VN-Index ${Math.abs(v).toFixed(1).replace('.', ',')} điểm %`)
      + (tool.sessions < 120 ? ` · mới chạy ${tool.sessions} phiên, cần 120–250 phiên mới đánh giá được` : '');
  }
  return { week, sessions, asOf, verdict, tool, calls, horizon: SCORE_H };
}

/** Bảng chấm điểm tuần của phiên mới nhất. */
export async function getScorecard() {
  const [at, sp] = await Promise.all([getAutoTrade().catch(() => null), scoredPredictions()]);
  const asOf = sp.index.at(-1)?.time;
  return {
    ...buildScorecard({ equity: at?.opened ? at.equity : [], orders: at?.opened ? at.orders : [], scored: sp.scored, index: sp.index, asOf }),
    updatedAt: new Date().toISOString(),
  };
}

const hesc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pp = (v, d = 1) => {
  if (v == null || !Number.isFinite(v)) return '–';
  const x = Math.abs(v * 100).toFixed(d);
  return `${Number(x) === 0 ? '' : v > 0 ? '+' : '−'}${x.replace('.', ',')}%`;
};
const ratio = (s) => (s.n ? `${s.right}/${s.n} đúng (${Math.round((s.right / s.n) * 100)}%)` : '–');

/** Các dòng bảng chấm điểm cho bản tin Telegram (HTML, hàm thuần). */
export function formatScorecard(sc) {
  if (!sc) return [];
  const L = ['🏆 <b>BẢNG CHẤM ĐIỂM TUẦN</b>', hesc(sc.verdict)];
  const t = sc.tool;
  if (t) {
    L.push(`🤖 Tool tự đầu tư: tuần ${pp(t.week.ret)} · VN-Index ${pp(t.week.index)} · từ đầu ${pp(t.total.ret)} (VN-Index ${pp(t.total.index)}) · sụt lớn nhất ${pp(t.maxDrawdown)}`);
    if (t.trades.buys || t.trades.sells) L.push(`   Lệnh trong tuần: ${t.trades.buys} mua · ${t.trades.sells} bán (${t.trades.wins} lãi)`);
  }
  if (sc.calls.length) {
    L.push(`🎯 Khuyến nghị đủ ${sc.horizon} phiên trong tuần (đúng = mua hơn rổ / tránh kém rổ):`);
    for (const c of sc.calls) {
      L.push(`   ${hesc(c.label)}: mua ${ratio(c.buy)}${c.buy.n ? ` TB ${pp(c.buy.avgExcess)}` : ''} · tránh ${ratio(c.avoid)}`);
    }
  }
  return L;
}
