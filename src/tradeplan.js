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
 * Kế hoạch chốt lời đa tầng & Chặn lãi động (Trailing Stop & Profit Lock)
 */
export function buildDynamicTrailingPlan(bars, { entryPrice, currentPrice = null, pnlPct = null, baseStop = null } = {}) {
  const cur = currentPrice ?? bars.at(-1)?.close ?? entryPrice;
  const pnl = pnlPct ?? (entryPrice ? (cur - entryPrice) / entryPrice : 0);
  const chan = chandelierExit(bars, 22, 2.5);
  const cStop = chan ? down(chan) : null;

  // Dời Stop Loss về hòa vốn khi lãi ≥ 6%
  const breakevenStop = pnl >= 0.06 && entryPrice ? down(entryPrice * 1.005) : null;

  // Điểm chặn lãi hiệu lực cao nhất
  const effectiveStop = Math.max(
    baseStop ?? 0,
    breakevenStop ?? 0,
    (pnl >= 0.1 && cStop) ? cStop : 0
  );

  return {
    entryPrice,
    currentPrice: cur,
    pnlPct: Math.round(pnl * 1000) / 10,
    breakevenStop,
    chandelierStop: cStop,
    effectiveStop: effectiveStop > 0 ? down(effectiveStop) : null,
    isBreakevenActive: breakevenStop != null,
    isChandelierActive: pnl >= 0.1 && cStop != null,
    stages: {
      tp1: entryPrice ? up(entryPrice * 1.07) : null, // Chốt 1/3 vị thế, dời stop hòa vốn
      tp2: entryPrice ? up(entryPrice * 1.15) : null, // Chốt 1/3 vị thế tiếp theo
      tp3Trailing: cStop, // Gồng 1/3 còn lại theo Chandelier
    },
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
 * Các bước mua – bán.
 * @param {string} code BUY | ACCUMULATE | HOLD | AVOID | SELL
 * @param {object} L kết quả priceLevels
 * @param {{ weight?: number, rsi?: number, avgVol20?: number, ma200?: number, score?: number, aboveMa200?: boolean,
 *   holding?: { qty: number, avgCost: number, pnlPct?: number, sellable?: number, pending?: number } }} ctx
 * Mỗi bước: { step, side: 'buy'|'sell'|'stop'|'wait', zone: [from, to] | null, price, portion, condition, shares? }
 */
export function tradeSteps(code, L, ctx = {}) {
  const W = ctx.weight ?? 0.1;
  const hot = (ctx.rsi ?? 0) > 70;
  const volTrigger = ctx.avgVol20 ? Math.round(ctx.avgVol20 * 1.5 / 1000) * 1000 : null;
  const breakout = `đóng cửa trên ${fmt(L.r1)}${volTrigger ? ` với khối lượng > ${volTrigger.toLocaleString('vi-VN')} cp (1,5× TB20)` : ' kèm khối lượng lớn'}`;
  // RSI nóng: chờ giá lùi về hỗ trợ — cận trên luôn thấp hơn giá hiện tại ít nhất 0,3 ATR
  const hotTop = down(Math.min(L.s1 + 0.3 * L.atr, L.close - 0.3 * L.atr));
  const zone1 = hot
    ? [Math.min(L.s1, hotTop), hotTop]
    : [down(Math.max(L.s1, L.close - 0.5 * L.atr)), L.close];
  const zone2 = L.s2 != null ? [L.s2, up(Math.min(L.s1, L.s2 + 0.3 * L.atr))] : null;

  // ----- Chưa có cổ phiếu -----
  const fresh = [];
  if (code === 'BUY' || code === 'ACCUMULATE') {
    const total = code === 'BUY' ? W : W / 2;
    const parts = code === 'BUY' ? (zone2 ? [0.4, 0.3, 0.3] : [0.5, 0.5]) : (zone2 ? [0.5, 0.5] : [1]);
    let k = 0;
    fresh.push({ side: 'buy', zone: zone1, portion: total * parts[k++],
      condition: hot ? `RSI ${Math.round(ctx.rsi)} đang nóng: không mua đuổi, đặt lệnh chờ giá lùi về vùng hỗ trợ` : 'Mua quanh giá hiện tại / hỗ trợ gần' });
    if (zone2) fresh.push({ side: 'buy', zone: zone2, portion: total * parts[k++], condition: `Khi giá điều chỉnh về hỗ trợ 2 mà chưa thủng ${fmt(L.stop)}` });
    if (code === 'BUY') fresh.push({ side: 'buy', price: up(L.r1 + tick(L.r1)), portion: total * parts[k++], condition: `Khi ${breakout} (xác nhận bứt phá)` });
    fresh.push({ side: 'stop', price: L.stop, condition: `Bán toàn bộ nếu đóng cửa dưới ${fmt(L.stop)}` });
  } else {
    const miss = [];
    if (ctx.score != null && ctx.score < 70) miss.push(`điểm xếp hạng ≥ 70 (hiện ${ctx.score})`);
    if (ctx.aboveMa200 === false && ctx.ma200) miss.push(`giá đóng cửa trên MA200 ${fmt(up(ctx.ma200))}`);
    // Điều kiện còn thiếu: từ tín hiệu định lượng, hoặc từ yếu tố thị trường AI đánh giá xấu
    if (ctx.marketWait) miss.push(ctx.marketWait);
    fresh.push({ side: 'wait', condition: code === 'SELL' ? 'Không mua mã này' : `Chưa mua. Chỉ xem xét khi đạt: ${miss.join(' và ') || 'tín hiệu rõ hơn'}` });
    if (code !== 'SELL') fresh.push({ side: 'buy', zone: zone2 ?? zone1, portion: W / 3, condition: 'Nếu điều kiện trên đạt: mua lần đầu 1/3 tỷ trọng ở vùng hỗ trợ này' });
  }

  // ----- Đang nắm giữ -----
  const hold = [];
  const h = ctx.holding;
  // Người đang giữ: cắt lỗ neo từ ngày mua, chỉ nâng (holderStop); không có thì dùng cắt lỗ của bậc thang hôm nay
  const hs = ctx.holdStop ?? L.stop;
  const take = (price) => (h && price < h.avgCost ? 'Giảm' : 'Chốt lời');
  if (code === 'BUY') {
    if (zone2) hold.push({ side: 'buy', zone: zone2, portion: W * 0.3, condition: 'Mua thêm khi chỉnh về hỗ trợ 2 (tổng tỷ trọng không vượt mức tối đa)' });
    hold.push({ side: 'buy', price: up(L.r1 + tick(L.r1)), portion: W * 0.3, condition: `Mua thêm khi ${breakout}` });
    hold.push({ side: 'sell', price: L.r2, portionOfHolding: 1 / 3, condition: `${take(L.r2)} 1/3 ở kháng cự 2` });
    hold.push({ side: 'sell', price: null, portionOfHolding: 2 / 3, condition: `Phần còn lại: khi giá vượt ${fmt(L.r1)}, dời cắt lỗ lên ${fmt(down(L.r1 - L.atr))}; giữ đến khi thủng` });
  } else if (code === 'ACCUMULATE' || code === 'HOLD') {
    hold.push({ side: 'wait', condition: 'Không mua thêm' });
    hold.push({ side: 'sell', price: L.r1, portionOfHolding: 1 / 3, condition: `${take(L.r1)} 1/3 khi giá lên kháng cự 1` });
    hold.push({ side: 'sell', price: L.r2, portionOfHolding: 1 / 3, condition: `${take(L.r2)} thêm 1/3 ở kháng cự 2` });
  } else if (code === 'AVOID') {
    hold.push({ side: 'wait', condition: 'Không mua thêm, không bình quân giá xuống' });
    hold.push({ side: 'sell', zone: [down(L.r1 - 0.3 * L.atr), L.r1], portionOfHolding: 1 / 2, condition: `${take(L.r1)} 1/2 khi giá hồi lên gần kháng cự 1` });
    hold.push({ side: 'sell', price: L.s1, portionOfHolding: 1 / 2, condition: `Bán phần còn lại nếu đóng cửa dưới hỗ trợ 1 ${fmt(L.s1)}` });
  } else {
    hold.push({ side: 'sell', price: L.close, portionOfHolding: 1 / 2, condition: 'Bán 1/2 ngay phiên tới' });
    hold.push({ side: 'sell', zone: [down(L.r1 - 0.3 * L.atr), L.r1], portionOfHolding: 1 / 2, condition: `Bán phần còn lại khi hồi lên kháng cự 1, hoặc ngay khi thủng ${fmt(L.s1)}` });
  }
  if (code !== 'SELL' && code !== 'AVOID') hold.push({ side: 'stop', price: hs, portionOfHolding: 1, condition: `Bán toàn bộ nếu đóng cửa dưới ${fmt(hs)}` });

  // Cá nhân hóa theo vị thế thật: số cổ phiếu mỗi bước bán, cảnh báo kỷ luật
  if (h?.qty) {
    // Mỗi bước bán đúng tỷ lệ của nó (lô 100 nếu ≥ 300 cp); bước "phần còn lại" (không có giá) nhận số dư
    const lot = h.qty >= 300 ? 100 : 1;
    const sells = hold.filter((s) => s.side === 'sell' && s.portionOfHolding);
    let used = 0;
    for (const s of sells.filter((x) => x.price != null || x.zone)) {
      s.shares = Math.min(h.qty - used, Math.max(lot, Math.floor((h.qty * s.portionOfHolding) / lot) * lot));
      used += s.shares;
    }
    const rest = sells.find((x) => x.price == null && !x.zone);
    if (rest) rest.shares = h.qty - used;
    else if (used < h.qty && !['AVOID', 'SELL'].includes(code)) {
      const at = hold.findIndex((s) => s.side === 'stop');
      hold.splice(at < 0 ? hold.length : at, 0, { side: 'wait', shares: h.qty - used, condition: `Giữ ${(h.qty - used).toLocaleString('vi-VN')} cp còn lại với mức cắt lỗ bên dưới` });
    } else if (used < h.qty) sells.at(-1).shares += h.qty - used;
    const stopStep = hold.find((s) => s.side === 'stop');
    if (stopStep) stopStep.shares = h.qty;
    if (L.close < hs) hold.unshift({ side: 'stop', price: L.close, shares: h.qty, condition: `Giá đã thủng cắt lỗ ${fmt(hs)}: bán theo kỷ luật` });
    else if (h.pnlPct != null && h.pnlPct >= 0.1) hold.push({ side: 'stop', price: down(Math.max(hs, h.avgCost)), shares: h.qty, condition: `Đang lãi ${Math.round(h.pnlPct * 100)}%: nâng cắt lỗ lên tối thiểu ${fmt(down(Math.max(hs, h.avgCost)))} để bảo toàn lãi` });
    if (h.pending) hold.push({ side: 'wait', condition: `${h.pending.toLocaleString('vi-VN')} cp chưa về (T+2): hôm nay chỉ bán được tối đa ${(h.sellable ?? 0).toLocaleString('vi-VN')} cp` });
  }
  return { fresh, hold };
}
