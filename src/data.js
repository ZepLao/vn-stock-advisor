// Lấy dữ liệu giá và chỉ số cơ bản từ các API công khai.
import { fetchJson, cached } from './http.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

// Chuẩn TradingView UDF: { s, t[], o[], h[], l[], c[], v[] }
function udfToBars(d) {
  if (!d || !Array.isArray(d.t) || d.t.length === 0) return null;
  return d.t.map((t, i) => ({
    time: new Date(t * 1000).toISOString().slice(0, 10),
    open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.v[i],
  }));
}

const PRICE_SOURCES = [
  {
    name: 'VNDirect',
    url: (s, from, to) => `https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${s}&from=${from}&to=${to}`,
    parse: (d) => udfToBars(d),
  },
  {
    name: 'VPS',
    url: (s, from, to) => `https://histdatafeed.vps.com.vn/tradingview/history?symbol=${s}&resolution=D&from=${from}&to=${to}`,
    parse: (d) => udfToBars(d),
  },
  {
    name: 'SSI',
    url: (s, from, to) => `https://iboard-api.ssi.com.vn/statistics/charts/history?resolution=1D&symbol=${s}&from=${from}&to=${to}`,
    parse: (d) => udfToBars(d?.data),
  },
];

// Phiên khớp lệnh liên tục + ATC của HOSE theo giờ Việt Nam (phút trong ngày): 9:00–11:30 và 13:00–14:45
const SESSIONS = [[540, 690], [780, 885]];
const SESSION_MIN = SESSIONS.reduce((s, [a, b]) => s + b - a, 0);
const SETTLE_MIN = 900; // sau 15:00 coi nến ngày đã chốt

/**
 * Kiểm tra xem hiện tại có đang trong phiên giao dịch của các sàn Việt Nam (HOSE/HNX) hay không.
 * Giờ GD: Thứ 2 - Thứ 6, từ 9:00 - 11:35 và 13:00 - 15:05 (giờ Việt Nam GMT+7).
 */
export function isTradingSession(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const day = vn.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return (m >= 540 && m <= 695) || (m >= 780 && m <= 905);
}

// TTL thông minh: trong giờ GD giá mới mỗi lượt quét 1 phút (giữ 50 giây), ngoài giờ GD nến tĩnh không đổi nên cache 30–60 phút
export const priceTTL = () => (isTradingSession() ? 50_000 : 30 * MIN);
export const moversTTL = () => (isTradingSession() ? 50_000 : 30 * MIN);

/**
 * Tiến độ phiên hôm nay theo giờ Việt Nam: { date, progress 0..1, closed }. closed = đã qua 15:00 (nến ngày đã chốt).
 */
export function sessionProgress(now = new Date()) {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const done = SESSIONS.reduce((s, [a, b]) => s + Math.max(0, Math.min(m, b) - a), 0);
  return { date: vn.toISOString().slice(0, 10), progress: done / SESSION_MIN, closed: m >= SETTLE_MIN };
}

/**
 * Đánh dấu nến cuối là nến TRONG PHIÊN (chưa chốt) nếu là ngày hôm nay và chưa qua 15:00: khối lượng mới là một phần
 * của cả phiên, không được so trực tiếp với khối lượng các phiên trước. Gắn `partial: true` và `progress` (0..1).
 */
export function markPartial(bars, now = new Date()) {
  const last = bars?.at(-1);
  if (!last) return bars;
  const s = sessionProgress(now);
  if (last.time === s.date && !s.closed) {
    last.partial = true;
    last.progress = s.progress;
  }
  return bars;
}

/** Khối lượng cả phiên ước tính từ nến trong phiên (tuyến tính theo thời gian, sàn 25% để tránh phóng đại đầu phiên). */
export function projectedVolume(bar) {
  return bar.partial ? bar.volume / Math.max(0.25, bar.progress ?? 1) : bar.volume;
}

/**
 * Giá ngày (đơn vị nghìn đồng với cổ phiếu, điểm với chỉ số) của ~1,5 năm gần nhất.
 * Thử lần lượt các nguồn, nguồn đầu tiên trả dữ liệu hợp lệ sẽ được dùng.
 */
export function getPriceHistory(symbol, days = 550) {
  return cached(`price:${symbol}:${days}`, priceTTL(), async () => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const errors = [];
    for (const src of PRICE_SOURCES) {
      try {
        const bars = src.parse(await fetchJson(src.url(symbol, from, to)));
        // Quanh giờ đóng cửa nguồn có thể trả nến tạm cho phiên chưa chốt (volume 0, high = low):
        // bỏ đi để không phân tích/chụp bằng giá phiên trước.
        const last = bars?.at(-1);
        if (bars?.length > 1 && !last.volume && last.high === last.low) bars.pop();
        if (bars && bars.length) return { source: src.name, bars: markPartial(bars) };
        errors.push(`${src.name}: không có dữ liệu`);
      } catch (err) {
        errors.push(`${src.name}: ${err.message}`);
      }
    }
    throw new Error(`Không lấy được giá ${symbol} (${errors.join('; ')})`);
  });
}

// Mã chỉ tiêu trong API ratios của VNDirect
const RATIO_CODES = {
  high52w: 51001,
  low52w: 51002,
  marketCap: 51003,
  sharesOutstanding: 51004,
  pe: 51006,
  beta: 51007,
  ps: 51011,
  pb: 51012,
  avgVol10d: 51016,
  bookValuePerShare: 51023,
  dividendYield: 51033,
  roa: 52001,
  roe: 52002,
  profitGrowthTTM: 52005,
  netProfitTTM: 52015,
  revenueTTM: 52016,
  netMarginTTM: 52021,
  grossMarginTTM: 53006,
  epsTTM: 53007,
  revenueGrowthTTM: 53030,
  profitGrowthQoQYoY: 53035,
  revenueGrowthQYoY: 53032,
  profitGrowth3Y: 53034,
  debtToEquity: 54018,
  currentRatio: 55001,
  foreignOwnership: 57052,
};

export function getFundamentals(symbol) {
  return cached(`fund:${symbol}`, 6 * HOUR, async () => {
    const codes = Object.values(RATIO_CODES).join(',');
    const url = `https://api-finfo.vndirect.com.vn/v4/ratios/latest?filter=itemCode:${codes}&where=code:${symbol}&order=reportDate&fields=itemCode,value,reportDate`;
    const res = await fetchJson(url);
    const byCode = new Map((res.data || []).map((d) => [Number(d.itemCode), d]));
    const out = { reportDate: null };
    for (const [key, code] of Object.entries(RATIO_CODES)) {
      const d = byCode.get(code);
      out[key] = d && Number.isFinite(d.value) ? d.value : null;
    }
    // Ngày báo cáo tài chính gần nhất (dựa trên chỉ tiêu ROE)
    out.reportDate = byCode.get(RATIO_CODES.roe)?.reportDate ?? null;
    return out;
  });
}

const FINFO = 'https://api-finfo.vndirect.com.vn/v4';

/** Giao dịch khối ngoại theo ngày của một mã (mới nhất trước). Giá trị tính bằng đồng. */
export function getForeignFlow(symbol, days = 20) {
  return cached(`foreign:${symbol}:${days}`, 10 * MIN, async () => {
    const url = `${FINFO}/foreigns?q=code:${symbol}&sort=tradingDate:desc&size=${days}&fields=tradingDate,buyVal,sellVal,netVal,netVol`;
    const res = await fetchJson(url);
    return (res.data || []).map((d) => ({
      date: d.tradingDate, buyVal: d.buyVal, sellVal: d.sellVal, netVal: d.netVal, netVol: d.netVol,
    }));
  });
}

export const FLOORS = ['HOSE', 'HNX', 'UPCOM'];

/**
 * Mã hủy niêm yết (dùng khi backtest và khi chấm dự đoán): thoát ở giá đóng cửa cuối cùng trừ đi tỷ lệ này. Thận trọng
 * vì ở Việt Nam mã bị hủy niêm yết bắt buộc thường mất thanh khoản và giảm sâu khi chuyển sang UPCoM.
 */
export const DELIST_HAIRCUT = 0.3;
// Hết dữ liệu giá ít nhất bấy nhiêu phiên (và không giao dịch lại) mới coi là hủy niêm yết, tránh nhầm với nguồn trễ
export const DELIST_GAP = 5;

/**
 * Tiêu chí chọn cổ phiếu cho bộ lọc tiềm năng và bảng xếp hạng (đổi trong .env):
 *  SCREEN_FLOORS    sàn được xét, mặc định HOSE (vd "HOSE,HNX")
 *  SCREEN_MIN_VALUE giá trị khớp lệnh trung bình 20 phiên tối thiểu, mặc định 5 tỷ đồng
 */
export function screenCriteria() {
  const floors = (process.env.SCREEN_FLOORS || 'HOSE').toUpperCase().split(',').map((s) => s.trim()).filter((s) => FLOORS.includes(s));
  const minValue = Number(process.env.SCREEN_MIN_VALUE) > 0 ? Number(process.env.SCREEN_MIN_VALUE) : 5e9;
  return { floors: floors.length ? floors : ['HOSE'], minValue };
}

/** Giá trị khớp lệnh trung bình `n` phiên tính đến phiên `end` (đồng; giá nghìn đồng × 1000). */
export function avgTradedValue(bars, n = 20, end = bars.length - 1) {
  const from = Math.max(0, end - n + 1);
  let sum = 0;
  for (let i = from; i <= end; i++) sum += bars[i].close * 1000 * bars[i].volume;
  return end >= from ? sum / (end - from + 1) : 0;
}

/**
 * Danh sách cổ phiếu ứng viên theo sàn đã chọn. Lấy rộng (phiên gần nhất khớp ≥ 1/5 ngưỡng) để không bỏ sót
 * mã có một phiên giao dịch thấp; ngưỡng trung bình 20 phiên được kiểm tra sau khi tải giá.
 */
export function getScreenUniverse() {
  const { floors, minValue } = screenCriteria();
  return cached(`universe:${floors.join(',')}:${minValue}`, 6 * HOUR, async () => {
    const { bars } = await getPriceHistory('VNINDEX', 550);
    const date = bars.at(-1)?.time;
    const lists = await Promise.all(floors.map((floor) => fetchJson(
      `${FINFO}/stock_prices?q=date:${date}~floor:${floor}~type:STOCK~nmValue:gte:${Math.round(minValue / 5)}&size=1000&fields=code,floor`,
    ).then((r) => r.data || [])));
    return lists.flat().filter((d) => /^[A-Z0-9]{3}$/.test(d.code)).map((d) => ({ symbol: d.code, exchange: d.floor }));
  });
}

/**
 * Rổ ứng viên TẠI MỘT NGÀY trong quá khứ (sàn, khớp lệnh phiên đó ≥ 1/5 ngưỡng), dùng cho backtest để tránh thiên lệch
 * sống sót: gồm cả mã sau này bị hủy niêm yết / chuyển sàn / cạn thanh khoản. Sàn trả về là sàn tại ngày đó.
 * Ngày không có phiên (nghỉ lễ) trả mảng rỗng.
 */
export function getUniverseAt(date) {
  const { floors, minValue } = screenCriteria();
  return cached(`universe-at:${date}:${floors.join(',')}:${minValue}`, 24 * HOUR, async () => {
    const lists = await Promise.all(floors.map((floor) => fetchJson(
      `${FINFO}/stock_prices?q=date:${date}~floor:${floor}~type:STOCK~nmValue:gte:${Math.round(minValue / 5)}&size=1000&fields=code,floor`,
    ).then((r) => r.data || [])));
    return lists.flat().filter((d) => /^[A-Z0-9]{3}$/.test(d.code)).map((d) => ({ symbol: d.code, exchange: d.floor }));
  });
}

/**
 * Top cổ phiếu của một sàn trong phiên gần nhất: tăng mạnh, giảm mạnh,
 * giá trị giao dịch lớn, khối ngoại mua ròng và bán ròng nhiều nhất.
 */
export function getMarketMovers(floor = 'HOSE', size = 10) {
  if (!FLOORS.includes(floor)) throw new Error('Sàn không hợp lệ');
  return cached(`movers:${floor}:${size}`, moversTTL(), async () => {
    // Ngày giao dịch gần nhất: lấy từ VN-Index (các sàn dùng chung lịch giao dịch)
    const { bars } = await getPriceHistory('VNINDEX', 550);
    const date = bars.at(-1)?.time;
    if (!date) throw new Error('Không lấy được ngày giao dịch gần nhất');

    const priceFields = 'code,close,change,pctChange,nmVolume,nmValue';
    const base = `${FINFO}/stock_prices?q=date:${date}~floor:${floor}~type:STOCK`;
    // Chỉ xếp hạng mã đạt ngưỡng giá trị giao dịch trong phiên (mặc định 5 tỷ, theo screenCriteria)
    const minValue = screenCriteria().minValue;
    const liquid = `${base}~nmValue:gte:${minValue}`;
    const fBase = `${FINFO}/foreigns?q=tradingDate:${date}~floor:${floor}~type:STOCK`;
    const fFields = 'code,buyVal,sellVal,netVal,netVol';

    const [gainers, losers, value, fBuy, fSell, all, fAll] = await Promise.all([
      fetchJson(`${liquid}&sort=pctChange:desc&size=${size}&fields=${priceFields}`),
      fetchJson(`${liquid}&sort=pctChange:asc&size=${size}&fields=${priceFields}`),
      fetchJson(`${base}&sort=nmValue:desc&size=${size}&fields=${priceFields}`),
      // Lấy dư để còn đủ mã sau khi bỏ mã thanh khoản thấp
      fetchJson(`${fBase}~netVal:gt:0&sort=netVal:desc&size=${size * 4}&fields=${fFields}`),
      fetchJson(`${fBase}~netVal:lt:0&sort=netVal:asc&size=${size * 4}&fields=${fFields}`),
      // Toàn sàn: độ rộng thị trường và tổng giao dịch khối ngoại
      fetchJson(`${base}&size=3000&fields=code,close,change,pctChange,nmValue`),
      fetchJson(`${fBase}&size=3000&fields=buyVal,sellVal,netVal`),
    ]);
    const sum = (arr, k) => arr.reduce((s, d) => s + (d[k] || 0), 0);
    const breadth = {
      advancers: all.data.filter((d) => d.pctChange > 0).length,
      decliners: all.data.filter((d) => d.pctChange < 0).length,
      unchanged: all.data.filter((d) => !d.pctChange).length,
      totalValue: sum(all.data, 'nmValue'),
    };
    const foreignTotal = { buyVal: sum(fAll.data, 'buyVal'), sellVal: sum(fAll.data, 'sellVal'), netVal: sum(fAll.data, 'netVal') };

    // Bổ sung giá và % thay đổi cho danh sách khối ngoại
    const fCodes = [...new Set([...fBuy.data, ...fSell.data].map((d) => d.code))];
    const prices = fCodes.length
      ? await fetchJson(`${base}~code:${fCodes.join(',')}&size=${fCodes.length}&fields=${priceFields}`)
      : { data: [] };
    const priceBy = new Map(prices.data.map((p) => [p.code, p]));

    const stock = (d) => ({
      symbol: d.code, close: d.close, change: d.change, changePct: d.pctChange, volume: d.nmVolume, value: d.nmValue,
    });
    const foreign = (d) => ({
      ...stock(priceBy.get(d.code) || { code: d.code }), buyVal: d.buyVal, sellVal: d.sellVal, netVal: d.netVal, netVol: d.netVol,
    });

    // Cổ phiếu ngày giao dịch có thể mua được: xét trọn bộ 4 yếu tố, trên MA200, an toàn rủi ro, thanh khoản đạt chuẩn
    let buyable = [];
    try {
      const { getRankBoard } = await import('./ranking.js');
      const board = await getRankBoard();
      const allPrices = new Map(all.data.map((p) => [p.code, p]));

      buyable = (board.rows || [])
        .filter((r) => (!floor || r.exchange === floor) && r.aboveMa200 !== false && !r.avoid && (r.score >= 70 || r.trendPick))
        .map((r) => {
          const live = allPrices.get(r.symbol);
          const close = live?.close ?? r.close;
          const change = live?.change ?? 0;
          const changePct = live?.pctChange ?? r.changePct ?? 0;
          const val = live?.nmValue ?? r.value20 ?? 0;
          const winProb = Math.min(88, Math.max(52, Math.round(50 + (r.score - 50) * 0.65 + (r.trendPick ? 6 : 0))));
          return {
            symbol: r.symbol,
            close,
            change,
            changePct,
            value: val,
            score: r.score,
            trendPick: Boolean(r.trendPick),
            aboveMa200: r.aboveMa200,
            trendState: r.trend?.trendState,
            winProb,
            action: r.trendPick ? '★ Siêu xu hướng' : r.score >= 85 ? 'Mua mạnh' : 'Có thể mua',
          };
        })
        .sort((a, b) => {
          if (a.trendPick !== b.trendPick) return b.trendPick ? 1 : -1;
          return (b.score || 0) - (a.score || 0);
        })
        .slice(0, size);

      // Ghi nhận vào sổ nhật ký dự đoán (prediction_log.jsonl) để tự động theo dõi và đối chiếu kết quả thực tế T+5, T+10, T+20
      if (buyable.length) {
        try {
          const { recordMany } = await import('./predictions.js');
          await recordMany(buyable.map((b) => ({
            source: 'buyable',
            symbol: b.symbol,
            date,
            direction: 1,
            label: `${b.action}: Điểm ${b.score} (Win ${b.winProb}%)`,
            price: b.close,
            score: b.score,
            confidence: b.winProb,
            detail: `4 yếu tố ${b.score}/100, trên MA200, trendState ${b.trendState || 'UP'}, thanh khoản ${(b.value / 1e9).toFixed(1)} tỷ`,
          })));
        } catch {
          // Bỏ qua nếu ghi sổ lỗi
        }
      }
    } catch {
      // Bỏ qua nếu bảng xếp hạng chưa sẵn sàng
    }

    return {
      floor,
      date,
      breadth,
      foreignTotal,
      gainers: gainers.data.map(stock),
      losers: losers.data.map(stock),
      topValue: value.data.map(stock),
      foreignBuy: fBuy.data.map(foreign).filter((x) => x.value >= minValue).slice(0, size),
      foreignSell: fSell.data.map(foreign).filter((x) => x.value >= minValue).slice(0, size),
      buyable,
      minValue,
    };
  });
}

export function getCompanyInfo(symbol) {
  return cached(`info:${symbol}`, 24 * HOUR, async () => {
    const url = `https://api-finfo.vndirect.com.vn/v4/stocks?q=code:${symbol}&fields=code,companyName,floor,type`;
    const res = await fetchJson(url);
    const d = res.data?.[0];
    return d ? { symbol: d.code, name: d.companyName, exchange: d.floor, type: d.type } : null;
  });
}
