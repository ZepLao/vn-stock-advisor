// Các yếu tố tính từ giá (và BCTC quý nếu có) tại từng phiên, chỉ dùng dữ liệu đến phiên đó.
// Dùng chung cho nghiên cứu yếu tố (research.js) và mô hình xếp hạng thử nghiệm (ranking.js, MODELS.v2).
import { atr, adx, sma } from './indicators.js';

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/** Hàm đọc mọi yếu tố ứng viên tại phiên i (chỉ dữ liệu đến phiên i). */
export function factorPanel(bars, earn = null) {
  const c = bars.map((b) => b.close);
  const r = c.map((v, i) => (i ? v / c[i - 1] - 1 : 0));
  const val = bars.map((b) => b.close * b.volume * 1000);
  const a = atr(bars, 14), d = adx(bars, 14).adx, m200 = sma(c, 200);
  return (i) => {
    if (i < 130 || i >= bars.length) return null;
    let hi = -Infinity;
    for (let k = Math.max(0, i - 250); k <= i; k++) hi = Math.max(hi, c[k]);
    const r60 = r.slice(Math.max(1, i - 59), i + 1), r20 = r.slice(Math.max(1, i - 19), i + 1);
    const v5 = mean(val.slice(i - 4, i + 1)), v60 = mean(val.slice(Math.max(0, i - 59), i + 1));
    const ami = mean(r20.map((x, k) => { const v = val[i - r20.length + 1 + k]; return v > 0 ? Math.abs(x) / v * 1e9 : null; }).filter((x) => x != null));
    return {
      mom: i >= 250 ? c[i - 20] / c[i - 250] - 1 : null,
      high: c[i] / hi - 1,
      atr: a[i] != null ? a[i] / c[i] : null,
      adx: d[i],
      rev1m: c[i] / c[i - 20] - 1,
      mom6: c[i - 20] / c[i - 125] - 1,
      ivol: sd(r60),
      maxret: Math.max(...r20),
      amihud: ami,
      attention: v60 > 0 ? v5 / v60 : null,
      ma200: m200[i] != null ? c[i] / m200[i] - 1 : null,
      eg: earn ? earn(bars[i].time) : null,
      aboveMa200: m200[i] != null ? c[i] > m200[i] : null,
      close: c[i],
    };
  };
}
