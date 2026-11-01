// Chẩn đoán dự đoán mỗi ngày (sau 15:45, khi database đã có giá chốt phiên): dùng dữ liệu đã thu thập để biết tool
// đoán đúng/sai ở đâu, lưu bảng `diagnostics` và đưa ra đề xuất cải thiện kèm số liệu.
//  1. Độ chính xác từng nguồn dự đoán (so với VN-Index và rổ đồng tỷ trọng) ở 5/10/20 phiên.
//  2. Vùng mua của gợi ý có khớp được không trong 3 phiên sau (vùng quá chặt = gợi ý vô dụng).
//  3. Giờ nào trong phiên giá thường thấp hơn giá đóng cửa (dữ liệu chụp trong phiên, src/intraday.js).
//  4. Nhãn tin của AI lọc tin có báo trước được phản ứng giá phiên sau không.
//  5. Dải giá / giá kỳ vọng / kịch bản AI (forecast_scores), độ tự tin của AI và hội đồng (ai_confidence_scores),
//     mua/bán chủ động (orderflow_scores), từng yếu tố xếp hạng (factor_ic), triển vọng tuần (outlook_scores).
// Đề xuất chỉ đưa ra khi đủ mẫu; việc tự chỉnh thông số vẫn do selfreview.js (có rào chắn) đảm nhiệm.
import { dbConfig, query, syncAll } from './db.js';
import { getPriceHistory } from './data.js';

export const DIAG_RULES = {
  minSource: 100, minFill: 20, minHour: 2000, minNews: 50, hourEdge: 0.003,
  minForecast: 50, minConf: 30, minFlow: 100, flowEdge: 0.005, minIcDays: 20, icT: 2, minOutlook: 8,
};
const n4 = (v) => (v == null ? null : Math.round(Number(v) * 10000) / 10000);

const SQL = {
  accuracy: `SELECT source, horizon, evaluated, beat_index_rate, buy_avg_excess, sell_avg_excess,
      beat_basket_rate, buy_avg_excess_ew, sell_avg_excess_ew
    FROM prediction_accuracy WHERE evaluated > 0 ORDER BY source, horizon`,
  fill: `WITH t AS (SELECT symbol, date, buy_to, entry FROM trades WHERE status = 'pick' AND buy_to IS NOT NULL),
    x AS (
      SELECT t.symbol, t.date, bool_or(b.low <= t.buy_to) AS filled, count(*) AS n
      FROM t JOIN LATERAL (SELECT low FROM daily_bars b WHERE b.symbol = t.symbol AND b.date > t.date ORDER BY b.date LIMIT 3) b ON true
      GROUP BY t.symbol, t.date)
    SELECT count(*) AS n, avg(filled::int) AS fill_rate FROM x WHERE n = 3`,
  hours: `SELECT extract(hour FROM si.ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour, count(*) AS n,
      avg(d.close / si.price - 1) AS to_close
    FROM stock_intraday si JOIN daily_bars d ON d.symbol = si.symbol AND d.date = si.date AND d.volume > 0
    WHERE si.date >= current_date - 90 AND si.price > 0
    GROUP BY 1 ORDER BY 1`,
  news: `WITH n AS (
      SELECT symbol, label,
        CASE WHEN extract(hour FROM published_at AT TIME ZONE 'Asia/Ho_Chi_Minh') >= 15
          THEN (published_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1
          ELSE (published_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END AS d0
      FROM news_labels WHERE relevant AND published_at IS NOT NULL),
    s AS (
      SELECT n.label, b.symbol, b.date FROM n
      JOIN LATERAL (SELECT symbol, date FROM daily_bars WHERE symbol = n.symbol AND date >= n.d0 ORDER BY date LIMIT 1) b ON true),
    r AS (
      SELECT s.label,
        (SELECT c.close FROM daily_bars c WHERE c.symbol = s.symbol AND c.date = s.date)
          / (SELECT p.close FROM daily_bars p WHERE p.symbol = s.symbol AND p.date < s.date ORDER BY p.date DESC LIMIT 1) - 1
        - ((SELECT c.close FROM daily_bars c WHERE c.symbol = 'VNINDEX' AND c.date = s.date)
          / (SELECT p.close FROM daily_bars p WHERE p.symbol = 'VNINDEX' AND p.date < s.date ORDER BY p.date DESC LIMIT 1) - 1) AS excess
      FROM s)
    SELECT label, count(excess) AS n, avg(excess) AS avg_excess FROM r GROUP BY label`,
  forecast: `SELECT h, count(*) AS n, avg(in_band::int) AS coverage, avg(err_ai) AS err_ai, avg(err_naive) AS err_naive,
      avg((dir_ai = dir_actual)::int) FILTER (WHERE dir_ai <> 0 AND dir_actual <> 0) AS dir_hit,
      avg((nearest_scenario = top_scenario)::int) AS top_hit
    FROM forecast_scores GROUP BY h ORDER BY h`,
  confidence: `SELECT who, conf_band, count(*) AS n, avg((sign(excess_ew) = direction)::int) AS beat, avg(excess_ew * direction) AS edge
    FROM ai_confidence_scores WHERE h = 10 AND direction <> 0 AND excess_ew IS NOT NULL GROUP BY who, conf_band ORDER BY who, conf_band`,
  flow: `SELECT buy_tercile AS tercile, count(*) AS n, avg(excess_ew) AS avg_excess
    FROM orderflow_scores WHERE h = 5 GROUP BY buy_tercile ORDER BY buy_tercile`,
  factors: `SELECT factor, count(*) AS days, avg(ic) AS ic, stddev_samp(ic) AS sd FROM factor_ic GROUP BY factor ORDER BY avg(ic) DESC`,
  outlook: `SELECT count(*) AS n, avg(in_range::int) AS hit FROM outlook_scores WHERE week_close IS NOT NULL`,
};

const pc = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
// Thống kê t của IC trung bình: lớn hơn ~2 mới coi là khác 0 thật
export const icT = (f) => (f.sd > 0 && f.days > 1 ? f.ic / (f.sd / Math.sqrt(f.days)) : null);

/** Đề xuất từ số liệu chẩn đoán (hàm thuần, dễ kiểm thử). */
export function suggest({ accuracy = [], fill = {}, hours = [], news = [], forecast = [], confidence = [], flow = [], factors = [], outlook = {} }, R = DIAG_RULES) {
  const out = [];
  // Kết luận chỉ khi VN-Index và rổ đồng tỷ trọng cùng chiều: VN-Index có thể bị vài mã vốn hóa lớn kéo lệch
  for (const a of accuracy.filter((x) => x.horizon === 10 && x.evaluated >= R.minSource && x.beat_index_rate != null)) {
    const rates = [a.beat_index_rate, a.beat_basket_rate].filter((v) => v != null);
    const both = `so VN-Index ${Math.round(a.beat_index_rate * 100)}%${a.beat_basket_rate != null ? `, so rổ ${Math.round(a.beat_basket_rate * 100)}%` : ''}`;
    if (Math.max(...rates) < 0.45) out.push({ area: 'source', text: `Nguồn "${a.source}" đúng ${both} sau 10 phiên (${a.evaluated} dự đoán): xem lại hoặc giảm trọng số nguồn này.` });
    else if (Math.min(...rates) > 0.55) out.push({ area: 'source', text: `Nguồn "${a.source}" đúng ${both} sau 10 phiên (${a.evaluated} dự đoán): đang có lợi thế.` });
  }
  if (fill.n >= R.minFill) {
    if (fill.fill_rate < 0.4) out.push({ area: 'zone', text: `Chỉ ${Math.round(fill.fill_rate * 100)}% gợi ý khớp được vùng mua trong 3 phiên (${fill.n} lệnh): vùng mua quá chặt, nên nới lên gần giá hiện tại.` });
    else if (fill.fill_rate > 0.9) out.push({ area: 'zone', text: `${Math.round(fill.fill_rate * 100)}% gợi ý khớp vùng mua (${fill.n} lệnh): vùng mua dễ khớp, có thể đặt thấp hơn để mua giá tốt hơn.` });
  }
  const hs = hours.filter((h) => h.n >= R.minHour / 5);
  if (hs.reduce((s, h) => s + h.n, 0) >= R.minHour && hs.length >= 3) {
    const best = hs.reduce((a, b) => (b.to_close > a.to_close ? b : a));
    const worst = hs.reduce((a, b) => (b.to_close < a.to_close ? b : a));
    if (best.to_close - worst.to_close >= R.hourEdge) {
      out.push({ area: 'timing', text: `Giá lúc ${best.hour}h thường thấp hơn giá đóng cửa ${(best.to_close * 100).toFixed(2)}%, lúc ${worst.hour}h thì ${(worst.to_close * 100).toFixed(2)}%: đặt mua vào khoảng ${best.hour}h có lợi hơn.` });
    }
  }
  const pos = news.find((x) => x.label === 'TICH_CUC'), neg = news.find((x) => x.label === 'TIEU_CUC');
  if (pos?.n >= R.minNews && neg?.n >= R.minNews) {
    const gap = pos.avg_excess - neg.avg_excess;
    out.push({ area: 'news', text: gap > 0.002
      ? `Tin AI chấm tích cực: phiên sau hơn VN-Index ${(pos.avg_excess * 100).toFixed(2)}%, tin tiêu cực ${(neg.avg_excess * 100).toFixed(2)}%: nhãn tin của AI có giá trị, có thể tăng trọng số tin tức.`
      : `Nhãn tin của AI chưa phân biệt được phản ứng giá (tích cực ${(pos.avg_excess * 100).toFixed(2)}% vs tiêu cực ${(neg.avg_excess * 100).toFixed(2)}%): giữ trọng số tin tức thấp.` });
  }
  // Giá kỳ vọng của AI sau 5 phiên: phải sát giá thật hơn giả định "giá đứng yên" mới đáng dùng làm mục tiêu
  const f5 = forecast.find((x) => x.h === 5);
  if (f5?.n >= R.minForecast && f5.err_ai != null) {
    if (f5.err_ai > f5.err_naive) out.push({ area: 'forecast', text: `Giá kỳ vọng 5 phiên của AI lệch giá thật ${pc(f5.err_ai, 2)}, còn kém giả định "giá đứng yên" (${pc(f5.err_naive, 2)}, ${f5.n} lần): không dùng giá kỳ vọng AI làm mục tiêu, chỉ tham khảo kịch bản.` });
    else if (f5.dir_hit != null && f5.dir_hit < 0.45) out.push({ area: 'forecast', text: `Hướng giá kỳ vọng 5 phiên của AI chỉ đúng ${pc(f5.dir_hit, 0)} (${f5.n} lần): xem lại cách AI chọn kịch bản cơ sở.` });
    if (f5.top_hit != null && f5.top_hit < 0.3) out.push({ area: 'forecast', text: `Kịch bản AI cho xác suất cao nhất chỉ gần giá thật nhất ${pc(f5.top_hit, 0)} số lần (ngẫu nhiên ≈ 33%): xác suất kịch bản của AI chưa đáng tin.` });
  }
  // Độ tự tin của AI / hội đồng: mức "cao" phải đúng hơn mức "vừa"
  for (const who of ['ai', 'committee']) {
    const hi = confidence.find((x) => x.who === who && x.conf_band.startsWith('cao'));
    const mid = confidence.find((x) => x.who === who && x.conf_band.startsWith('vừa'));
    if (!(hi?.n >= R.minConf && mid?.n >= R.minConf)) continue;
    const name = who === 'ai' ? 'Gemini' : 'Hội đồng';
    if (hi.beat <= mid.beat) out.push({ area: 'confidence', text: `${name} tự tin cao đúng so rổ ${pc(hi.beat, 0)} (${hi.n}), không hơn tự tin vừa ${pc(mid.beat, 0)} (${mid.n}): độ tự tin chưa có giá trị, không dùng để tăng tỷ trọng.` });
    else if (hi.beat - mid.beat >= 0.1) out.push({ area: 'confidence', text: `${name} tự tin cao đúng so rổ ${pc(hi.beat, 0)} (${hi.n}) so với tự tin vừa ${pc(mid.beat, 0)} (${mid.n}): có thể ưu tiên mã AI tự tin cao.` });
  }
  // Mua chủ động: nhóm phe mua áp đảo nhất (tercile 3) so với yếu nhất (tercile 1), lãi hơn rổ 5 phiên sau
  const t1 = flow.find((x) => x.tercile === 1), t3 = flow.find((x) => x.tercile === 3);
  if (t1?.n >= R.minFlow && t3?.n >= R.minFlow) {
    const gap = t3.avg_excess - t1.avg_excess;
    if (Math.abs(gap) >= R.flowEdge) out.push({ area: 'flow', text: gap > 0
      ? `Mã phe mua chủ động áp đảo hơn rổ ${pc(t3.avg_excess, 2)} sau 5 phiên, mã phe bán áp đảo ${pc(t1.avg_excess, 2)} (${t3.n + t1.n} lần): mua/bán chủ động có giá trị, nên đưa vào điểm xếp hạng.`
      : `Mã phe mua chủ động áp đảo lại kém rổ ${pc(t3.avg_excess, 2)} so với phe bán áp đảo ${pc(t1.avg_excess, 2)} (${t3.n + t1.n} lần): đừng coi mua chủ động là tín hiệu mua.` });
  }
  // Yếu tố xếp hạng: IC trung bình khác 0 có ý nghĩa thống kê
  for (const f of factors.filter((x) => x.days >= R.minIcDays)) {
    const t = icT(f);
    if (t == null) continue;
    if (t >= R.icT) out.push({ area: 'factor', text: `Yếu tố ${f.factor}: IC 10 phiên trung bình ${f.ic.toFixed(3)} (t = ${t.toFixed(1)}, ${f.days} phiên) — đang dự báo đúng chiều.` });
    else if (t <= -R.icT) out.push({ area: 'factor', text: `Yếu tố ${f.factor}: IC 10 phiên trung bình ${f.ic.toFixed(3)} (t = ${t.toFixed(1)}, ${f.days} phiên) — đang dự báo NGƯỢC chiều, xem lại trọng số.` });
  }
  if (outlook.n >= R.minOutlook && outlook.hit < 0.6) out.push({ area: 'outlook', text: `VN-Index cuối tuần chỉ nằm trong khoảng AI dự báo ${pc(outlook.hit, 0)} số tuần (${outlook.n} tuần): khoảng triển vọng tuần quá hẹp.` });
  return out;
}

/** Chạy chẩn đoán cho phiên mới nhất, lưu bảng diagnostics. */
export async function runDiagnosis() {
  if (!dbConfig().enabled) throw new Error('Database đang tắt');
  await syncAll(); // bảo đảm giá chốt phiên và dữ liệu mới nhất đã vào database
  const { bars } = await getPriceHistory('VNINDEX');
  const date = bars.at(-1).time;
  const rows = async (sql) => (await query(sql)).rows;
  const [accuracy, fillRows, hours, news, forecast, confidence, flow, factors, outlook] = await Promise.all(
    [SQL.accuracy, SQL.fill, SQL.hours, SQL.news, SQL.forecast, SQL.confidence, SQL.flow, SQL.factors, SQL.outlook].map(rows));
  const data = {
    accuracy: accuracy.map((a) => ({ ...a, evaluated: Number(a.evaluated), beat_index_rate: n4(a.beat_index_rate), buy_avg_excess: n4(a.buy_avg_excess), sell_avg_excess: n4(a.sell_avg_excess),
      beat_basket_rate: n4(a.beat_basket_rate), buy_avg_excess_ew: n4(a.buy_avg_excess_ew), sell_avg_excess_ew: n4(a.sell_avg_excess_ew) })),
    fill: { n: Number(fillRows[0]?.n || 0), fill_rate: n4(fillRows[0]?.fill_rate) },
    hours: hours.map((h) => ({ hour: h.hour, n: Number(h.n), to_close: n4(h.to_close) })),
    news: news.map((x) => ({ label: x.label, n: Number(x.n), avg_excess: n4(x.avg_excess) })),
    forecast: forecast.map((x) => ({ h: x.h, n: Number(x.n), coverage: n4(x.coverage), err_ai: n4(x.err_ai), err_naive: n4(x.err_naive), dir_hit: n4(x.dir_hit), top_hit: n4(x.top_hit) })),
    confidence: confidence.map((x) => ({ who: x.who, conf_band: x.conf_band, n: Number(x.n), beat: n4(x.beat), edge: n4(x.edge) })),
    flow: flow.map((x) => ({ tercile: Number(x.tercile), n: Number(x.n), avg_excess: n4(x.avg_excess) })),
    factors: factors.map((x) => ({ factor: x.factor, days: Number(x.days), ic: n4(x.ic), sd: n4(x.sd) })),
    outlook: { n: Number(outlook[0]?.n || 0), hit: n4(outlook[0]?.hit) },
  };
  const result = { date, at: new Date().toISOString(), ...data, suggestions: suggest(data) };
  await query('INSERT INTO diagnostics (date, at, raw) VALUES ($1, $2, $3) ON CONFLICT (date) DO UPDATE SET at = EXCLUDED.at, raw = EXCLUDED.raw',
    [date, result.at, JSON.stringify(result)]);
  return result;
}

export async function lastDiagnosis() {
  if (!dbConfig().enabled) return null;
  return (await query('SELECT raw FROM diagnostics ORDER BY date DESC LIMIT 1')).rows[0]?.raw || null;
}

/** Tin Telegram ngắn. */
export function formatDiagnosis(d) {
  const L = [`🩺 <b>CHẨN ĐOÁN DỰ ĐOÁN ${d.date.slice(8, 10)}/${d.date.slice(5, 7)}</b>`];
  const src = d.accuracy.filter((a) => a.horizon === 10 && a.beat_index_rate != null);
  if (src.length) L.push('', 'Đúng sau 10 phiên (so VN-Index / so rổ đồng tỷ trọng):', ...src.map((a) =>
    `• ${a.source}: ${Math.round(a.beat_index_rate * 100)}%${a.beat_basket_rate != null ? ` / ${Math.round(a.beat_basket_rate * 100)}%` : ''} (${a.evaluated})`));
  else L.push('', 'Chưa có dự đoán nào đủ 10 phiên để chấm.');
  if (d.fill.n) L.push('', `Vùng mua khớp trong 3 phiên: ${Math.round(d.fill.fill_rate * 100)}% (${d.fill.n} lệnh)`);
  const f5 = d.forecast?.find((x) => x.h === 5);
  if (f5?.n) L.push(`Dải giá 5 phiên chứa giá thật: ${pc(f5.coverage, 0)} · AI lệch ${pc(f5.err_ai, 1)} vs giá đứng yên ${pc(f5.err_naive, 1)} (${f5.n} lần)`);
  const conf = (d.confidence || []).filter((x) => x.who === 'ai');
  if (conf.length) L.push(`Gemini theo độ tự tin, đúng so rổ 10 phiên: ${conf.map((x) => `${x.conf_band} ${pc(x.beat, 0)} (${x.n})`).join(' · ')}`);
  const top = (d.factors || []).filter((x) => x.days >= 5);
  if (top.length) L.push(`IC yếu tố 10 phiên (${top[0].days} phiên): ${top.slice(0, 3).map((x) => `${x.factor} ${x.ic.toFixed(2)}`).join(', ')} … ${top.at(-1).factor} ${top.at(-1).ic.toFixed(2)}`);
  if (d.outlook?.n) L.push(`Triển vọng tuần: VN-Index nằm trong khoảng AI dự báo ${pc(d.outlook.hit, 0)} (${d.outlook.n} tuần)`);
  const snaps = d.hours.reduce((s, h) => s + h.n, 0);
  L.push(`Dữ liệu trong phiên đã thu: ${snaps.toLocaleString('vi-VN')} điểm giá`);
  L.push('', d.suggestions.length ? '<b>Đề xuất</b>' : '<i>Chưa đủ mẫu để đề xuất thay đổi.</i>', ...d.suggestions.map((s) => `• ${s.text}`));
  return L.join('\n');
}

/** Mỗi ngày giao dịch sau 15:45 chạy một lần; gửi Telegram khi có đề xuất mới hoặc vào thứ 6. */
export function startDiagnose(notify = null) {
  if (!dbConfig().enabled) return null;
  const areas = (d) => (d?.suggestions || []).map((s) => s.area).sort().join(',');
  const tick = async () => {
    try {
      const vn = new Date(Date.now() + 7 * 3600_000);
      const today = vn.toISOString().slice(0, 10);
      if (vn.getUTCHours() * 60 + vn.getUTCMinutes() < 15 * 60 + 45) return;
      const { bars } = await getPriceHistory('VNINDEX');
      const prev = await lastDiagnosis();
      if (bars.at(-1)?.time !== today || prev?.date === today) return;
      const d = await runDiagnosis();
      console.log(`[Chẩn đoán] ${today}: ${d.suggestions.length} đề xuất`);
      // Chỉ báo khi xuất hiện loại đề xuất mới so với hôm trước (tổng kết tuần nằm trong bản tin tổng kết tuần của telegram.js)
      if (notify && d.suggestions.length && areas(d) !== areas(prev)) await notify(formatDiagnosis(d));
    } catch (err) {
      console.error('[Chẩn đoán] Lỗi:', err.message);
    }
  };
  setTimeout(tick, 120_000);
  return setInterval(tick, 30 * 60_000);
}
