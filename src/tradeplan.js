// Kế hoạch giao dịch cụ thể cho một mã: bậc thang giá (hỗ trợ / kháng cự / cắt lỗ) và các bước
// mua – bán chia lần cho 2 trường hợp: chưa có cổ phiếu và đang nắm giữ.
// Mức giá lấy từ đỉnh/đáy thực tế (swing) ~6 tháng, đáy/đỉnh 20 phiên, MA20/50/200 và ATR; làm tròn theo bước giá HOSE.

import { atr as atrSeries, sma } from './indicators.js';

const EPS = 1e-9;
/** Bước giá HOSE (nghìn đồng): < 10 → 0,01; < 50 → 0,05; còn lại 0,1. */
export function tick(price) {
  return price < 10 ? 0.01 : price < 50 ? 0.05 : 0.1;
}
const down = (p) => Math.round(Math.floor(p / tick(p) + EPS) * tick(p) * 100) / 100;
const up = (p) => Math.round(Math.ceil(p / tick(p) - EPS) * tick(p) * 100) / 100;

/** Đáy (đỉnh) cục bộ: thấp (cao) nhất trong cửa sổ ±w phiên. */
function swings(bars, w, lows) {
  const out = [];
  for (let i = w; i < bars.length - w; i++) {
    const v = lows ? bars[i].low : bars[i].high;
    let ok = true;
    for (let k = i - w; k <= i + w && ok; k++) if (k !== i && (lows ? bars[k].low < v : bars[k].high > v)) ok = false;
    if (ok) out.push(v);
  }
  return out;
}

/**
 * Các mức giá then chốt.
 * @returns {{ r2, r1, close, s1, s2, stop, atr }}
 */
export function priceLevels(bars, { atr, ma20, ma50, ma200, minStopAtr = 0 }) {
  const close = bars.at(-1).close;
  const a = atr || close * 0.02;
  const recent = bars.slice(-120);
  const last20 = bars.slice(-20), last60 = bars.slice(-60);

  const supCand = [
    ...swings(recent, 3, true), Math.min(...last20.map((b) => b.low)), ma20, ma50, ma200,
  ].filter((v) => v != null && v < close * 0.995 && v > close * 0.8).sort((x, y) => y - x);
  let s1 = supCand[0] ?? close - a;
  let s2 = supCand.find((v) => v < s1 * 0.985) ?? s1 - a;
  // Hỗ trợ 2 quá xa (hơn 2,5 ATR dưới giá) thì không dùng: cắt lỗ sẽ quá rộng
  if (s2 < close - 2.5 * a) s2 = null;

  // Cắt lỗ dưới hỗ trợ thấp nhất nửa ATR (tối đa 1 ATR dưới hỗ trợ 1), không để rủi ro quá 10%
  let stop = Math.max(s2 != null ? s2 - 0.5 * a : s1 - a, close * 0.9);
  // Khoảng cách tối thiểu (tự hiệu chỉnh khi cắt lỗ bị quét quá thường xuyên rồi giá hồi lại)
  if (minStopAtr > 0) stop = Math.max(Math.min(stop, close - minStopAtr * a), close * 0.9);
  if (s2 != null && stop >= s2) s2 = null;
  if (stop >= s1) s1 = Math.max(stop + a * 0.5, close - a * 0.5);

  const resCand = [
    ...swings(recent, 3, false), Math.max(...last20.map((b) => b.high)), Math.max(...last60.map((b) => b.high)), ma50, ma200,
  ].filter((v) => v != null && v > close * 1.01 && v < close * 1.4).sort((x, y) => x - y);
  const r1 = resCand[0] ?? close + 2 * a;
  const r2 = resCand.find((v) => v > r1 * 1.03) ?? Math.max(r1 + 2 * a, r1 * 1.05);

  const chanStop = chandelierExit(bars, 22, 2.5);

  return {
    r2: up(r2), r1: up(r1), close,
    s1: down(s1), s2: s2 != null ? down(s2) : null, stop: down(stop), atr: a,
    chandelierStop: chanStop != null ? down(chanStop) : null,
  };
}

/** Chỉ báo đầu vào của priceLevels cho mọi phiên (tính một lần cho cả chuỗi). */
export function levelInputs(bars) {
  const c = bars.map((b) => b.close);
  return { atr: atrSeries(bars, 14), ma20: sma(c, 20), ma50: sma(c, 50), ma200: sma(c, 200) };
}

/** Bậc thang giá tại phiên i, chỉ dùng dữ liệu đến phiên i (kết quả giống priceLevels trên chuỗi cắt tại i). */
export function levelsAt(bars, i, inp, minStopAtr = 0) {
  return priceLevels(bars.slice(Math.max(0, i - 130), i + 1), {
    atr: inp.atr[i], ma20: inp.ma20[i], ma50: inp.ma50[i], ma200: inp.ma200[i], minStopAtr,
  });
}

// Người đang giữ: lãi ≥ 6% thì cắt lỗ lên hòa vốn (+0,5% bù phí), lãi ≥ 10% thì theo Chandelier
export const HOLD_STOP = { breakeven: 0.06, chandelier: 0.1 };

/**
 * Một bước của cắt lỗ cho người đang giữ: CHỈ NÂNG, KHÔNG HẠ. Lấy mức cao nhất của cắt lỗ hôm trước, cắt lỗ theo bậc thang
 * hôm nay, hòa vốn (khi đã từng lãi ≥ 6%) và Chandelier (khi đã từng lãi ≥ 10%). Vì không bao giờ hạ nên hòa vốn đã kích
 * hoạt thì giữ nguyên kể cả khi lãi giảm lại.
 */
export function ratchetStop(prev, L, close, avgCost, R = HOLD_STOP) {
  const pnl = avgCost ? close / avgCost - 1 : 0;
  const cands = [prev, L.stop];
  if (pnl >= R.breakeven) cands.push(down(avgCost * 1.005));
  if (pnl >= R.chandelier && L.chandelierStop != null) cands.push(L.chandelierStop);
  return Math.max(...cands.filter((v) => v != null && Number.isFinite(v)));
}

/**
 * Cắt lỗ hiện tại của vị thế mở từ `openedAt` với giá vốn `avgCost`: bắt đầu từ bậc thang của phiên trước ngày mua
 * (mức lúc ra quyết định), sau đó chỉ nâng lên hòa vốn / Chandelier (`trail: 'anchor'`, mặc định). `trail: 'levels'`
 * nâng thêm theo bậc thang mỗi phiên: backtest quy trình (livebacktest.js, 3 năm) cho kết quả kém hơn vì cắt lỗ quá sát.
 * Trước đây cắt lỗ tính lại từ giá hôm nay nên giá giảm thì cắt lỗ cũng giảm theo, gần như không bao giờ bị thủng.
 */
export function holderStop(bars, { openedAt, avgCost }, { minStopAtr = 0, trail = 'anchor' } = {}) {
  if (!bars?.length || !avgCost) return null;
  let i0 = openedAt ? bars.findIndex((b) => b.time >= openedAt) : bars.length - 1;
  if (i0 < 0) i0 = bars.length - 1;
  const inp = levelInputs(bars);
  const first = Math.max(0, i0 - 1);
  let stop = null;
  for (let i = first; i < bars.length; i++) {
    const L = levelsAt(bars, i, inp, minStopAtr);
    stop = ratchetStop(stop, i === first || trail === 'levels' ? L : { stop: null, chandelierStop: L.chandelierStop }, bars[i].close, avgCost);
  }
  return stop;
}

/**
 * Tính mức Chandelier Trailing Exit (Chuck LeBeau):
 * Đỉnh cao nhất N phiên - mult * ATR(N).
 * Giúp bảo toàn tối đa lợi nhuận khi cổ phiếu đang vào pha tăng mạnh (trend-following).
 */
export function chandelierExit(bars, period = 22, mult = 2.5) {
  if (!bars || bars.length < period) return null;
  const slice = bars.slice(-period);
  const hh = Math.max(...slice.map((b) => b.high));
  // ATR đơn giản trên slice
  let sumTr = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close)
    );
    sumTr += tr;
  }
  const a = sumTr / (slice.length - 1 || 1);
  return Math.max(0, hh - mult * a);
}

/**
 * Kế hoạch cho người đang giữ theo HOLD_RULE (luật đo tốt nhất trong bộ đo evaluation.js, 4 năm): KHÔNG chốt lời theo
 * mốc cố định, KHÔNG dời cắt lỗ về hòa vốn, KHÔNG cắt lỗ đuổi — so với luật này, cả ba đều làm lãi mỗi lệnh giảm.
 * Chỉ có một ngưỡng cảnh báo xa (−wideStop giá vốn, xét theo giá ĐÓNG CỬA) và mốc xem lại sau `sessions` phiên.
 * @param {{ entryPrice: number, currentPrice?: number, heldSessions?: number }} o
 */
export function holdPlan({ entryPrice, currentPrice = null, heldSessions = null } = {}, R = HOLD_RULE) {
  if (!entryPrice) return null;
  const cur = currentPrice ?? entryPrice;
  const warnStop = down(entryPrice * (1 - R.wideStop));
  return {
    entryPrice,
    currentPrice: cur,
    pnlPct: Math.round(((cur - entryPrice) / entryPrice) * 1000) / 10,
    warnStop,
    belowWarn: cur < warnStop,
    reviewAfter: R.sessions,
    reviewDue: heldSessions != null && heldSessions >= R.sessions,
    label: `Cảnh báo khi đóng cửa dưới ${fmt(warnStop)} (−${Math.round(R.wideStop * 100)}% giá vốn), giữ ${R.sessions} phiên rồi xem lại; không chốt lời theo mốc cố định`,
  };
}

/** Chia số cổ phiếu theo tỷ lệ; ≥ 300 cp thì làm tròn lô 100, phần dư dồn vào bước cuối. */
export function splitShares(qty, portions) {
  const lot = qty >= 300 ? 100 : 1;
  const out = [];
  let left = qty;
  portions.forEach((p, k) => {
    const n = k === portions.length - 1 ? left : Math.min(left, Math.floor((qty * p) / lot) * lot);
    out.push(n);
    left -= n;
  });
  return out;
}

const fmt = (v) => (v == null ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: 2 }));

/**
 * Quy tắc mua / giữ đã kiểm chứng (danh mục cuốn chiếu rolling.js, theo cách vận hành của Laban; backtest rổ theo thời
 * điểm 3–4 năm ngang danh mục mẫu và hơn hẳn quy trình cũ chia lệnh + cắt lỗ sát + chặn theo regime):
 *  - mua MỘT lần bằng lệnh LO ở giá đóng cửa gần nhất cho phiên tới (Laban: khớp ~89% số phiên, không tốn hơn ATO);
 *    không khớp thì xét lại phiên sau, không đuổi giá; một suất mỗi mã (mua thăm dò: nửa suất);
 *  - KHÔNG cắt lỗ sát (cắt 5–8% làm giảm lãi trên HOSE): ngưỡng cảnh báo xa HOLD_RULE.wideStop dưới giá vốn;
 *  - giữ HOLD_RULE.sessions phiên rồi xem lại: còn trong nhóm mua thì giữ tiếp, không thì bán; ⛔ thì cân nhắc bán sớm.
 */
export const HOLD_RULE = { sessions: 40, wideStop: 0.15 };

/**
 * Các bước mua – bán.
 * @param {string} code BUY | ACCUMULATE | HOLD | AVOID | SELL
 * @param {object} L kết quả priceLevels (L.stop = ngưỡng cảnh báo xa cho người mua mới)
 * @param {{ weight?: number, score?: number, aboveMa200?: boolean, ma200?: number, marketWait?: string, avoid?: boolean,
 *   holdStop?: number, heldSessions?: number,
 *   holding?: { qty: number, avgCost: number, pnlPct?: number, sellable?: number, pending?: number } }} ctx
 * Mỗi bước: { side: 'buy'|'sell'|'stop'|'wait', zone?: [from, to], price?, portion?, portionOfHolding?, condition, shares? }
 */
export function tradeSteps(code, L, ctx = {}) {
  const W = ctx.weight ?? 0.1;
  const N = HOLD_RULE.sessions;

  // ----- Chưa có cổ phiếu -----
  const fresh = [];
  if (code === 'BUY' || code === 'ACCUMULATE') {
    const half = code === 'ACCUMULATE';
    fresh.push({ side: 'buy', price: L.close, portion: half ? W / 2 : W,
      condition: `Lệnh LO giá ${fmt(L.close)} (đóng cửa gần nhất) cho phiên tới${half ? ', nửa suất (mua thăm dò)' : ''}; không khớp thì xét lại phiên sau, không đuổi giá` });
    fresh.push({ side: 'wait', condition: 'Lưu ý kẹt hàng T+2: Cổ phiếu chưa về trong T+0 và T+1 (khóa vị thế). Tuyệt đối không bình quân giá xuống khi giá giảm trong thời gian chờ.' });
    fresh.push({ side: 'stop', price: L.stop, condition: `Cảnh báo nếu đóng cửa dưới ${fmt(L.stop)} (−${Math.round(HOLD_RULE.wideStop * 100)}% giá mua): xem lại lý do nắm giữ khi hàng về (chiều T+2 hoặc mở cửa T+3)` });
    fresh.push({ side: 'wait', condition: `Giữ khoảng ${N} phiên rồi xem lại: còn trong nhóm mua thì giữ tiếp, không thì bán. Không chốt lời sớm theo mốc %, không dời cắt lỗ sát khi đang lãi` });
  } else {
    const miss = [];
    if (ctx.avoid) miss.push('ra khỏi nhóm ⛔ (10% thấp nhất)');
    else {
      if (ctx.score != null && ctx.score < 70) miss.push(`điểm xếp hạng ≥ 70 (hiện ${ctx.score}) hoặc vào nhóm xu hướng chuẩn`);
      if (ctx.aboveMa200 === false && ctx.ma200) miss.push(`giá đóng cửa trên MA200 ${fmt(up(ctx.ma200))}`);
    }
    // Điều kiện còn thiếu: từ tín hiệu định lượng, hoặc từ yếu tố thị trường AI đánh giá xấu
    if (ctx.marketWait) miss.push(ctx.marketWait);
    fresh.push({ side: 'wait', condition: code === 'SELL' ? 'Không mua mã này' : `Chưa mua. Chỉ xem xét khi đạt: ${miss.join(' và ') || 'tín hiệu rõ hơn'}` });
  }

  // ----- Đang nắm giữ -----
  const hold = [];
  const h = ctx.holding;
  const hs = ctx.holdStop ?? L.stop;
  const held = ctx.heldSessions;
  const due = held != null && held >= N;
  const heldTxt = held != null ? ` (đã giữ ${held}/${N} phiên)` : '';
  if (code === 'BUY' || code === 'ACCUMULATE') {
    hold.push({ side: 'wait', condition: `Giữ: vẫn trong nhóm mua${heldTxt}${due ? ', đã đủ hạn nên giữ tiếp thêm một kỳ' : ''}. Không mua thêm quá một suất` });
  } else if (code === 'HOLD') {
    hold.push(due
      ? { side: 'sell', price: null, portionOfHolding: 1, condition: `Đã giữ đủ ${N} phiên và không còn trong nhóm mua: bán ở phiên tới` }
      : { side: 'wait', condition: `Giữ đến đủ ${N} phiên${heldTxt} rồi xem lại; không mua thêm` });
  } else if (code === 'AVOID') {
    hold.push(ctx.avoid || due
      ? { side: 'sell', price: null, portionOfHolding: 1, condition: ctx.avoid ? '⛔ Thuộc 10% thấp nhất: cân nhắc bán ở phiên tới (nhóm này kém rổ ~1,3%/20 phiên)' : `Đã giữ đủ ${N} phiên và không còn trong nhóm mua: bán ở phiên tới` }
      : { side: 'wait', condition: `Không mua thêm. Giữ đến đủ ${N} phiên${heldTxt} rồi bán nếu vẫn chưa vào nhóm mua` });
  } else {
    hold.push({ side: 'sell', price: null, portionOfHolding: 1, condition: 'Rủi ro rơi tự do: bán ở phiên tới' });
  }
  if (code !== 'SELL') hold.push({ side: 'stop', price: hs, portionOfHolding: 1, condition: `Cảnh báo nếu đóng cửa dưới ${fmt(hs)} (−${Math.round(HOLD_RULE.wideStop * 100)}% giá vốn): xem lại lý do nắm giữ` });

  // Cá nhân hóa theo vị thế thật: số cổ phiếu, cảnh báo đã thủng ngưỡng, cổ phiếu chưa về
  if (h?.qty) {
    for (const s of hold) if (s.portionOfHolding) s.shares = h.qty;
    if (L.close < hs) hold.unshift({ side: 'stop', price: L.close, shares: h.qty, condition: `Giá đã dưới ngưỡng cảnh báo ${fmt(hs)}: xem lại lý do nắm giữ, không bình quân giá xuống` });
    if (h.pending) hold.push({ side: 'wait', condition: `${h.pending.toLocaleString('vi-VN')} cp chưa về (T+2): hôm nay chỉ bán được tối đa ${(h.sellable ?? 0).toLocaleString('vi-VN')} cp` });
  }
  return { fresh, hold };
}
