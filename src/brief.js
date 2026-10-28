// Tóm tắt nhanh cho một mã: kết luận, việc nên làm, 4-5 lý do ngắn có số liệu, mức giá và rủi ro.
// Dựng hoàn toàn từ dữ liệu đã tính (không cần AI) để đọc lướt là hiểu.
import { priceLevels, tradeSteps, holderStop } from './tradeplan.js';
import { getTuning } from './tuning.js';
import { positionSize } from './sizing.js';

export { positionSize };

const pct = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d })}%`);
const ty = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: Math.abs(v) >= 1e11 ? 0 : 1 })} tỷ`);
const num = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d }));

const ACTIONS = {
  BUY: (l) => (l.blocked ? `Tín hiệu mua nhưng không mở vị thế mới: ${l.blocked}.` : `Có thể mua, tối đa ${l.size} vốn; cắt lỗ nếu đóng cửa dưới ${l.stop}.`),
  ACCUMULATE: (l) => (l.blocked ? `Tín hiệu mua thăm dò nhưng không mở vị thế mới: ${l.blocked}.` : `Chỉ mua thăm dò, tối đa ${l.half} vốn; cắt lỗ dưới ${l.stop}.`),
  HOLD: (l) => `Chưa mua mới. Đang có thì giữ, bán nếu đóng cửa dưới ${l.stop}.`,
  AVOID: (l) => `Không mua mới. Đang có thì cân nhắc giảm, nhất là khi thủng ${l.stop}.`,
  SELL: () => 'Không mua. Đang có nên hạ tỷ trọng.',
};

/**
 * Hướng dẫn hành động cho 2 trường hợp: chưa có cổ phiếu / đang nắm giữ.
 * Mỗi trường hợp là danh sách bước ngắn, có mức giá cụ thể. Nếu biết vị thế thật của người dùng
 * (từ Danh mục) thì phần "đang nắm giữ" nói theo đúng số lượng, giá vốn và lãi/lỗ của họ.
 * @param {string} code mã khuyến nghị BUY | ACCUMULATE | HOLD | AVOID | SELL
 * @param {object} c bối cảnh: close, stop, buyFrom, buyTo, target, resistance, weight, rsi, aboveMa200, ma200, score, holding
 */
export function playbook(code, c) {
  const n = (v, d = 2) => num(v, d);
  const w = c.weight != null ? Math.round(c.weight * 100) : 10;
  const hot = (c.rsi ?? 0) > 70;
  const missing = [];
  if (c.score != null && c.score < 70) missing.push(`điểm xếp hạng lên ≥ 70 (hiện ${c.score})`);
  if (c.aboveMa200 === false && c.ma200) missing.push(`giá vượt lên trên MA200 ${n(c.ma200)} (hiện ${n(c.close)})`);
  const waitFor = missing.length ? `Chờ ${missing.join(' và ')}` : 'Chờ tín hiệu rõ hơn';

  let newBuyer, holder;
  switch (code) {
    case 'BUY':
      newBuyer = [
        hot ? `Không mua đuổi (RSI ${n(c.rsi, 0)} đang nóng): đặt mua khi giá lùi về ${n(c.buyFrom)}–${n((c.buyFrom + c.buyTo) / 2)}`
          : `Mua trong vùng ${n(c.buyFrom)}–${n(c.buyTo)}, chia 2 lần: 1/2 ngay, 1/2 khi giá vượt ${n(c.resistance)} kèm khối lượng lớn`,
        `Tổng tỷ trọng tối đa ${w}% vốn`,
        `Đặt cắt lỗ ${n(c.stop)}; chốt lời 1/3 ở ${n(c.target)}`,
      ];
      holder = [
        'Tiếp tục nắm giữ',
        `Có thể mua thêm nếu tỷ trọng còn dưới ${w}% vốn${hot ? ', nhưng đợi giá chỉnh' : ''}`,
        `Chốt lời 1/3 ở ${n(c.target)}; bán nếu đóng cửa dưới ${n(c.stop)}`,
      ];
      break;
    case 'ACCUMULATE':
      newBuyer = [`Chỉ mua thăm dò, tối đa ${Math.max(5, Math.round(w / 2))}% vốn trong vùng ${n(c.buyFrom)}–${n(c.buyTo)}`, `Cắt lỗ ${n(c.stop)}`];
      holder = ['Giữ, chưa mua thêm', `Bán nếu đóng cửa dưới ${n(c.stop)}`];
      break;
    case 'HOLD':
      newBuyer = ['Chưa mua', `${waitFor} thì mới xem xét mua`];
      holder = ['Giữ, không mua thêm', `Bán nếu đóng cửa dưới ${n(c.stop)}`, `Chốt lời một phần ở ${n(c.target)}`];
      break;
    case 'AVOID':
      newBuyer = ['Không mua', `${waitFor} thì mới xem xét lại`];
      holder = [`Giảm tỷ trọng khi giá hồi lên gần ${n(c.resistance)}`, `Bán hết nếu đóng cửa dưới ${n(c.stop)}`, 'Không mua bình quân giá xuống'];
      break;
    default: // SELL
      newBuyer = ['Tránh mã này'];
      holder = ['Hạ tỷ trọng sớm, không chờ hồi', 'Không mua bình quân giá xuống'];
  }

  // Cá nhân hóa theo vị thế thật trong Danh mục
  const h = c.holding;
  let position = null;
  if (h) {
    position = `Bạn đang có ${h.qty.toLocaleString('vi-VN')} cp, giá vốn ${n(h.avgCost)}, ${h.pnlPct != null ? `${h.pnlPct >= 0 ? 'lãi' : 'lỗ'} ${pct(Math.abs(h.pnlPct), 1).replace('+', '')}` : ''}`
      + `${h.pending ? ` · bán được ngay ${h.sellable.toLocaleString('vi-VN')} cp, ${h.pending.toLocaleString('vi-VN')} cp đang chờ về (T+2)` : ''}`;
    if (c.stop && c.close < c.stop) holder.unshift(`Giá đã thủng cắt lỗ ${n(c.stop)}: nên bán theo kỷ luật`);
    else if (c.target && c.close >= c.target) holder.unshift(`Đã chạm mục tiêu ${n(c.target)}: chốt lời 1/3–1/2`);
    else if (h.pnlPct != null && h.pnlPct >= 0.1 && c.stop) holder.push(`Đang lãi ${pct(h.pnlPct, 0).replace('+', '')}: nâng cắt lỗ lên tối thiểu ${n(Math.max(c.stop, h.avgCost))} để bảo toàn lãi`);
    else if (h.pnlPct != null && h.pnlPct <= -0.07 && code !== 'BUY') holder.unshift(`Đang lỗ ${pct(Math.abs(h.pnlPct), 0).replace('+', '')} và mã không còn mạnh: cân nhắc cắt lỗ, không gồng thêm`);
    // Mục tiêu thấp hơn giá vốn thì bán ở đó là cắt lỗ, không phải chốt lời
    if (c.target && c.target < h.avgCost) {
      for (let k = 0; k < holder.length; k++) {
        holder[k] = holder[k]
          .replace(/Chốt lời 1\/3 ở ([\d.,]+); /, 'Giảm 1/3 khi giá hồi về $1 (vẫn dưới giá vốn); ')
          .replace(/Chốt lời một phần ở ([\d.,]+)/, `Giảm tỷ trọng khi giá hồi về $1 (vẫn dưới giá vốn ${n(h.avgCost)})`);
      }
    }
    if (h.pending && h.sellable === 0) holder.push('Cổ phiếu chưa về tài khoản: chưa bán được trước T+2');
  }
  return { newBuyer, holder, position };
}

/**
 * @param {object} a kết quả analyzeSymbol (không phải chỉ số)
 * @param {{ name: string, net: number, rank: number, total: number, period: number }|null} sector dòng tiền ngành
 * @param {object|null} holding vị thế đang nắm giữ (từ Danh mục)
 * @param {{ capital?: number|null, heat?: number|null, sector?: object|null }|null} risk ngữ cảnh định cỡ vị thế (sizing.js)
 */
export function buildBrief(a, sector = null, holding = null, bars = null, risk = null) {
  const r = a.ranking;
  const i = a.technical.indicators;
  const f = a.fundamental.data || {};
  const close = a.price.close;
  const reasons = [];
  const add = (tone, text) => reasons.push({ tone, text });

  // 1. Sức mạnh so với rổ và xu hướng dài hạn (tín hiệu chính đã kiểm chứng)
  if (r) {
    const beat = Math.round((1 - (r.position - 1) / Math.max(r.universe - 1, 1)) * 100);
    const mom = r.factors?.mom != null ? ` · 12 tháng ${pct(r.factors.mom)}, cách đỉnh 52 tuần ${pct(r.factors.high)}` : '';
    add(r.score >= 70 ? 'up' : r.score < 30 ? 'down' : 'ref', `Mạnh hơn ${beat}% cổ phiếu HOSE thanh khoản cao${mom}`);
    add(r.aboveMa200 === false ? 'down' : 'up', r.aboveMa200 === false
      ? `Giá ${num(close)} dưới MA200 (${num(i.sma200)}): xu hướng dài hạn chưa tốt`
      : `Giá trên MA200 (${num(i.sma200)}): xu hướng dài hạn tăng`);
  }

  // 2. Cơ bản: lỗ/lãi, định giá, tăng trưởng (gộp 1 dòng)
  if (f.epsTTM != null && f.epsTTM <= 0) add('down', 'Doanh nghiệp đang lỗ 4 quý gần nhất');
  else if (f.pe != null || f.roe != null) {
    const good = (f.roe ?? 0) >= 0.15 && (f.profitGrowthTTM ?? 0) >= 0;
    const bad = (f.profitGrowthTTM ?? 0) < -0.15 || (f.pe ?? 0) > 25;
    add(good && !bad ? 'up' : bad ? 'down' : 'ref',
      `P/E ${num(f.pe)} · ROE ${pct(f.roe)} · LN 4 quý ${pct(f.profitGrowthTTM)}`);
  }

  // 3. Dòng tiền: khối ngoại của mã và dòng tiền của ngành
  const fl = a.foreign;
  if (fl?.net20 != null && Math.abs(fl.ratio20 ?? 0) >= 1) {
    add(fl.net20 > 0 ? 'up' : 'down', `Khối ngoại ${fl.net20 > 0 ? 'mua' : 'bán'} ròng ${ty(Math.abs(fl.net20)).replace('+', '')}/20 phiên`);
  }
  if (sector) {
    const hot = sector.rank <= 3 && sector.net > 0, cold = sector.rank > sector.total - 3 && sector.net < 0;
    add(sector.net > 0 ? 'up' : 'down', `Ngành ${sector.name} ${sector.net > 0 ? 'được mua' : 'bị bán'} ròng ${ty(Math.abs(sector.net)).replace('+', '')}/${sector.period} phiên${hot ? ' (top hút tiền)' : cold ? ' (bị bán mạnh nhất)' : ''}`);
  }

  // 4. Tin tức đáng chú ý
  const flagged = a.warnings.find((w) => /tin rủi ro nghiêm trọng/.test(w));
  if (flagged) add('down', 'Có tin rủi ro nghiêm trọng trong 7 ngày');
  else if (a.news.count >= 3 && Math.abs(a.news.score) >= 20) {
    add(a.news.score > 0 ? 'up' : 'down', `Tin tức nghiêng ${a.news.score > 0 ? 'tích cực' : 'tiêu cực'} (${a.news.positive} tốt / ${a.news.negative} xấu)`);
  }

  // Bậc thang giá từ đỉnh/đáy thực tế + MA + ATR; nếu không có chuỗi giá thì dùng kế hoạch ATR đơn giản
  const p = a.plan;
  const L = bars?.length >= 60
    ? priceLevels(bars, { atr: i.atr14, ma20: i.sma20, ma50: i.sma50, ma200: i.sma200, minStopAtr: getTuning().minStopAtr })
    : p ? { r2: p.target, r1: p.resistance, close, s1: p.support, s2: null, stop: p.stopLoss, atr: i.atr14 || close * 0.02 } : null;
  const size = L ? positionSize(close, L.stop, { bars, value20: a.value20, ...(risk || {}) }) : null;
  const holdStop = holding?.avgCost && bars?.length >= 60 ? holderStop(bars, holding, { minStopAtr: getTuning().minStopAtr }) : null;
  const steps = L ? tradeSteps(a.recommendation.code, L, {
    weight: size?.weight ?? 0.1, rsi: i.rsi14, avgVol20: i.avgVolume20, ma200: i.sma200,
    score: r?.score, aboveMa200: r?.aboveMa200, holding, holdStop,
  }) : null;
  const firstBuy = steps?.fresh.find((x) => x.side === 'buy' && x.zone);
  const levels = L ? {
    ...L, buyFrom: firstBuy?.zone[0] ?? L.s1, buyTo: firstBuy?.zone[1] ?? close,
    // Kháng cự 1 sát giá (dưới 1 ATR) thì lấy kháng cự 2 làm mục tiêu tính lời/lỗ
    ...(() => {
      const tgt = L.r1 - close >= L.atr ? L.r1 : L.r2;
      return {
        target: tgt, targetLabel: tgt === L.r1 ? 'mục tiêu 1' : 'mục tiêu 2',
        stopPct: (L.stop - close) / close, targetPct: (tgt - close) / close,
        riskReward: close > L.stop ? Math.round(((tgt - close) / (close - L.stop)) * 10) / 10 : null,
      };
    })(),
    weight: size?.weight ?? null,
    holdStop,
    sizing: size ? { effectiveLoss: size.effectiveLoss, tail: size.tail, binding: size.binding, limits: size.limits, capitalKnown: risk?.capital > 0 } : null,
  } : null;
  const fmtLv = {
    size: size ? `${Math.round(size.weight * 100)}%` : '10%', half: size ? `${Math.max(1, Math.round(size.weight * 50))}%` : '5%',
    stop: L ? num(L.stop, 2) : 'mức hỗ trợ gần nhất',
    blocked: size?.weight === 0 ? size.limits.find((x) => x.key === size.binding)?.text : null,
  };
  const action = (ACTIONS[a.recommendation.code] || ACTIONS.HOLD)(fmtLv);
  const plays = levels ? playbook(a.recommendation.code, {
    close, stop: L.stop, buyFrom: levels.buyFrom, buyTo: levels.buyTo, target: L.r1, resistance: L.r1, weight: size?.weight ?? null,
    rsi: i.rsi14, aboveMa200: r?.aboveMa200, ma200: i.sma200, score: r?.score, holding,
  }) : null;

  // Rủi ro: ngắn gọn, bỏ cảnh báo đã nêu ở trên
  const risks = a.warnings
    .filter((w) => !/tin rủi ro nghiêm trọng|đang lỗ/.test(w))
    .map((w) => w.split(/[:.]/)[0].trim())
    .slice(0, 2);
  if (r?.score >= 70 && r.aboveMa200 !== false && (i.rsi14 ?? 0) > 70) risks.push(`RSI ${num(i.rsi14, 0)}: đang nóng, nên chờ nhịp chỉnh để mua`);

  const tone = { BUY: 'up', ACCUMULATE: 'up', HOLD: 'ref', AVOID: 'down', SELL: 'down' }[a.recommendation.code] || 'ref';
  return {
    verdict: a.recommendation.label, code: a.recommendation.code, tone,
    headline: r ? `Xếp hạng ${r.score}/100 · hạng ${r.position}/${r.universe}` : `Điểm ${a.total}`,
    action,
    reasons: reasons.slice(0, 6),
    levels,
    risks,
    plays,
    steps,
    holding,
  };
}

/** Câu hành động chính cho một mức khuyến nghị (dùng lại khi AI thẩm định đổi mức). */
export function actionFor(code, levels) {
  const bind = levels?.weight === 0 ? levels.sizing?.limits?.find((x) => x.key === levels.sizing.binding) : null;
  const fmtLv = {
    blocked: bind?.text ?? null,
    size: levels?.weight != null ? `${Math.round(levels.weight * 100)}%` : '10%',
    half: levels?.weight != null ? `${Math.max(1, Math.round(levels.weight * 50))}%` : '5%',
    stop: levels ? num(levels.stop, 2) : 'mức hỗ trợ gần nhất',
  };
  return (ACTIONS[code] || ACTIONS.HOLD)(fmtLv);
}
