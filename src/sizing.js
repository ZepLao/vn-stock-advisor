// Định cỡ vị thế: rủi ro mỗi lệnh cố định (1% vốn) nhưng tính cả phần lỗ VƯỢT cắt lỗ, rồi chặn bởi thanh khoản,
// tổng rủi ro đang mở của danh mục (heat) và mức tập trung ngành. Lấy mức nhỏ nhất trong các giới hạn.
//
// Vì sao không dùng thẳng khoảng cách cắt lỗ: cắt lỗ là "đóng cửa dưới X" nên lệnh bán khớp ở giá mở cửa phiên sau
// (có thể gap, có thể kẹt sàn), và mua hôm nay phải chờ T+2 mới bán được. Lỗ thật khi chạm cắt lỗ thường lớn hơn thiết kế.

export const SIZING = {
  riskPerTrade: 0.01, // lỗ tối đa mỗi lệnh / tổng vốn
  cap: 0.25,          // tỷ trọng tối đa một mã
  maxHeat: 0.06,      // tổng lỗ nếu mọi vị thế cùng chạm cắt lỗ / tổng vốn
  maxAdv: 0.1,        // giá trị vị thế ≤ 10% giá trị khớp lệnh TB 20 phiên (thoát được trong ~1 phiên mà không đè giá)
  sectorMax: 0.3,     // tổng tỷ trọng một ngành
  sectorCount: 2,     // số mã tối đa cùng ngành
  overshoot: 0.5,     // trượt qua cắt lỗ kỳ vọng = nửa CVaR95 1 phiên (giả định, chưa hiệu chỉnh trên lệnh thật)
  lookback: 250,
};

const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

function cvar95(rets) {
  if (rets.length < 60) return null;
  const s = [...rets].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length * 0.05));
  return Math.max(0, -s.slice(0, k).reduce((a, b) => a + b, 0) / k);
}

/** Lỗ đuôi lịch sử (số dương): CVaR95 lợi suất 1 phiên và 3 phiên (mua hôm nay, sớm nhất bán ở phiên thứ 3). */
export function tailLoss(bars, lookback = SIZING.lookback) {
  const c = bars.slice(-(lookback + 3)).map((b) => b.close);
  const r1 = [], r3 = [];
  for (let i = 1; i < c.length; i++) r1.push(c[i] / c[i - 1] - 1);
  for (let i = 3; i < c.length; i++) r3.push(c[i] / c[i - 3] - 1);
  return { cvar1: r4(cvar95(r1)), cvar3: r4(cvar95(r3)) };
}

/**
 * Tỷ trọng gợi ý (phần của tổng vốn).
 * @param {number} close
 * @param {number} stopLoss
 * @param {{ bars?: object[], value20?: number, capital?: number|null, heat?: number|null,
 *   sector?: { name: string, weight: number|null, count: number }|null }} ctx
 *   capital: tổng vốn tài khoản (đồng, ACCOUNT_CAPITAL); không có thì bỏ giới hạn thanh khoản / heat / tỷ trọng ngành.
 *   heat: tổng rủi ro đang mở / vốn. sector: các mã KHÁC đang giữ cùng ngành (tỷ trọng theo vốn, số mã).
 * @returns {{ weight, stopDistance, effectiveLoss, tail, binding, limits: { key, weight, text }[] } | null}
 */
export function positionSize(close, stopLoss, ctx = {}) {
  const { bars = null, value20 = null, capital = null, heat = null, sector = null, ...over } = ctx;
  const R = { ...SIZING, ...over };
  if (!close || !stopLoss || stopLoss >= close) return null;
  const dist = (close - stopLoss) / close;
  const tail = bars?.length ? tailLoss(bars, R.lookback) : { cvar1: null, cvar3: null };
  const effectiveLoss = Math.max(dist + R.overshoot * (tail.cvar1 ?? 0), tail.cvar3 ?? 0);
  const p = (v) => `${(Math.round(v * 1000) / 10).toLocaleString('vi-VN')}%`;

  const limits = [
    { key: 'risk', weight: R.riskPerTrade / effectiveLoss, text: `rủi ro ${p(R.riskPerTrade)} vốn / lỗ dự kiến khi chạm cắt lỗ ${p(effectiveLoss)}` },
    { key: 'cap', weight: R.cap, text: `tối đa ${p(R.cap)} vốn một mã` },
  ];
  if (capital > 0) {
    if (value20 > 0) limits.push({ key: 'liquidity', weight: (R.maxAdv * value20) / capital, text: `thanh khoản: ≤ ${p(R.maxAdv)} giá trị khớp TB20 phiên` });
    if (heat != null) limits.push({ key: 'heat', weight: Math.max(0, R.maxHeat - heat) / effectiveLoss, text: `rủi ro đang mở của danh mục ${p(heat)}/${p(R.maxHeat)} vốn` });
    if (sector?.weight != null) limits.push({ key: 'sector', weight: Math.max(0, R.sectorMax - sector.weight), text: `ngành ${sector.name} đã chiếm ${p(sector.weight)}/${p(R.sectorMax)} vốn` });
  }
  if (sector && sector.count >= R.sectorCount) limits.push({ key: 'sectorCount', weight: 0, text: `đã giữ ${sector.count} mã ngành ${sector.name}` });

  const bind = limits.reduce((m, x) => (x.weight < m.weight ? x : m));
  return {
    weight: Math.max(0, Math.round(bind.weight * 100) / 100),
    stopDistance: dist, effectiveLoss: r4(effectiveLoss), tail,
    binding: bind.key,
    limits: limits.map((x) => ({ ...x, weight: r4(x.weight) })),
  };
}

/**
 * Rủi ro đang mở: tổng số tiền mất nếu mọi vị thế cùng chạm cắt lỗ, chia cho vốn.
 * Vị thế không có cắt lỗ (hoặc giá đã dưới cắt lỗ) tính như mất một biên độ sàn HOSE (7%).
 * @param {{ value: number, close: number|null, stop: number|null }[]} positions
 */
export function portfolioHeat(positions, capital) {
  if (!(capital > 0)) return null;
  const risk = positions.reduce((s, x) => {
    const dist = x.stop != null && x.close != null && x.stop < x.close ? (x.close - x.stop) / x.close : 0.07;
    return s + x.value * dist;
  }, 0);
  return risk / capital;
}

/** Tổng vốn tài khoản (đồng) từ .env; null nếu chưa đặt. */
export function accountCapital() {
  const v = Number(process.env.ACCOUNT_CAPITAL);
  return v > 0 ? v : null;
}

/**
 * Tỷ trọng theo SUẤT cho quy tắc mua đang dùng (danh mục cuốn chiếu, không cắt lỗ sát nên không định cỡ theo khoảng cách
 * cắt lỗ): một suất = 1/slots vốn, tối đa `slots` mã, mỗi ngành tối đa `perSector` mã, và (nếu biết vốn) không quá
 * maxAdv × giá trị khớp TB20 phiên. Backtest: chia đều suất ngang hoặc hơn tỷ trọng ngược biến động (rolling.js).
 * @param {{ value20?: number, capital?: number|null, sector?: { name: string, count: number }|null }} ctx
 */
export const SLOT_RULES = { slots: 10, perSector: 3, maxAdv: SIZING.maxAdv };
export function slotSize({ value20 = null, capital = null, sector = null, slots = null } = {}, R = SLOT_RULES) {
  const p = (v) => `${(Math.round(v * 1000) / 10).toLocaleString('vi-VN')}%`;
  const n = slots ?? R.slots;
  if (n === 0) return { weight: 0, binding: 'capital', slots: 0, limits: [{ key: 'capital', weight: 0, text: 'vốn chọn mã dưới 20 triệu: một suất không đủ lô 100 cp, nên mua ETF' }] };
  const limits = [{ key: 'slot', weight: 1 / n, text: `1 suất = ${p(1 / n)} vốn chọn mã (tối đa ${n} mã)` }];
  if (capital > 0 && value20 > 0) limits.push({ key: 'liquidity', weight: (R.maxAdv * value20) / capital, text: `thanh khoản: ≤ ${p(R.maxAdv)} giá trị khớp TB20 phiên` });
  if (sector && sector.count >= R.perSector) limits.push({ key: 'sectorCount', weight: 0, text: `đã giữ ${sector.count} mã ngành ${sector.name} (tối đa ${R.perSector})` });
  const bind = limits.reduce((m, x) => (x.weight < m.weight ? x : m));
  return { weight: Math.max(0, Math.round(bind.weight * 1000) / 1000), binding: bind.key, slots: n, limits: limits.map((x) => ({ ...x, weight: r4(x.weight) })) };
}

/**
 * Số suất theo vốn PHẦN CHỌN MÃ (vốn trừ lõi ETF). Nghiên cứu 10/2026 trên danh mục cuốn chiếu, rổ theo thời điểm, lô 100,
 * Sharpe trung bình 3 và 4 năm (quy tắc chọn đăng ký trước: Sharpe cao nhất, chênh < 0,05 thì sụt nhỏ hơn):
 *  - ≥ 50 triệu: 7 suất (50 tr 1,38 / 100 tr 1,25 / 300 tr 1,34 / 1 tỷ 1,35, đều hơn 10 suất 0,99–1,29; 5 suất không ổn định);
 *  - 20–50 triệu: 10 suất (ngang 7 suất, sụt −9% so với −16% vì suất không đủ một lô thì để tiền mặt);
 *  - dưới 20 triệu: 0 = chưa nên chọn mã (một suất không đủ lô 100 cp của phần lớn mã; chưa kiểm chứng) → mua ETF.
 */
export const SLOT_TIERS = [{ min: 50e6, slots: 7 }, { min: 20e6, slots: 10 }, { min: 0, slots: 0 }];
export function slotsForCapital(capital) {
  if (!(capital > 0)) return 7;
  return SLOT_TIERS.find((t) => capital >= t.min).slots;
}

/**
 * Lõi ETF tùy chọn (CORE_ETF, CORE_PCT trong .env). Nghiên cứu: 50% E1VFVN30 + 50% danh mục quy tắc, cân lại khi lệch > 10
 * điểm %, Sharpe 1,36 / 1,14 (3 / 4 năm) ngang 100% chọn mã (1,35 / 1,14) nhưng sụt tối đa −14,8% / −15,2% thay vì
 * −17,7% / −17,3%; FUEVFVND kém hơn rõ. Mặc định tắt (CORE_PCT = 0).
 */
export const CORE_RULES = { drift: 0.1, suggest: { symbol: 'E1VFVN30', pct: 0.5 } };
export function coreConfig() {
  const symbol = (process.env.CORE_ETF || '').trim().toUpperCase() || null;
  const pct = Math.min(0.9, Math.max(0, Number(process.env.CORE_PCT) || 0));
  return symbol && pct > 0 ? { symbol, pct } : { symbol: null, pct: 0 };
}

/**
 * Lệnh cho lõi ETF (hàm thuần): mua khi chưa có, cân lại khi tỷ trọng lệch quá CORE_RULES.drift so với mục tiêu.
 * @returns {{ side: 'buy'|'sell'|'hold', shares: number, value: number, weight: number|null, target: number }}
 */
export function coreOrder({ pct, capital, price, qty = 0 }) {
  const target = capital * pct, cur = qty * price * 1000;
  const weight = capital > 0 ? cur / capital : null;
  const off = weight == null || (qty === 0 && pct > 0) || Math.abs(weight - pct) > CORE_RULES.drift;
  const shares = off && price > 0 ? Math.round((target - cur) / (price * 1000) / 100) * 100 : 0;
  return { side: shares > 0 ? 'buy' : shares < 0 ? 'sell' : 'hold', shares: Math.abs(shares), value: Math.abs(shares) * price * 1000, weight, target };
}
