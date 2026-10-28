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
