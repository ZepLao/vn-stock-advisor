// Backtest chiến lược trên giá ngày theo luật thị trường cơ sở Việt Nam.
// Luật khớp lệnh tham khảo engine vietnam_equity của Vibe-Trading, áp dụng cho cả 3 sàn:
//  - Chỉ mua (long-only), không bán khống, không margin.
//  - Thanh toán T+2: cổ phiếu mua ở phiên N chỉ bán được từ phiên N+2.
//  - Biên độ so với giá tham chiếu (đóng cửa phiên trước): HOSE ±7%, HNX ±10%, UPCoM ±15%.
//    Phiên mở cửa ở giá trần thì không mua được (không có người bán), mở ở giá sàn thì không bán được.
//  - Lô chẵn 100 cổ phiếu; giá khớp làm tròn theo bước giá về phía bất lợi cho người giao dịch.
//  - Phí môi giới 0,15% mỗi chiều + thuế TNCN 0,1% trên giá trị bán.
// Tín hiệu tính trên giá đóng cửa phiên i, lệnh khớp ở giá mở cửa phiên i+1 (không nhìn trước tương lai).
// Giá tính bằng nghìn đồng như phần còn lại của tool; tiền tính bằng đồng.
import { getPriceHistory, getCompanyInfo } from './data.js';
import { cached } from './http.js';
import { technicalAnalysis } from './analyze.js';
import { sma, rsi, macd } from './indicators.js';

export const BANDS = { HOSE: 0.07, HNX: 0.10, UPCOM: 0.15 };
export const LOT = 100;
export const DEFAULTS = {
  initialCash: 100_000_000,
  brokerage: 0.0015,
  sellTax: 0.001,
  slippage: 0.001,
  settlementBars: 2,
  positionPct: 1,      // tỷ lệ tiền mặt dùng cho mỗi lần mua
  stopLossPct: null,   // cắt lỗ theo % giá vốn (đánh giá trên giá đóng cửa)
  takeProfitPct: null, // chốt lời theo % giá vốn
};
const BARS_PER_YEAR = 252;
const EPS = 1e-9;

/** Bước giá (nghìn đồng). HOSE: <10 → 0,01; 10–49,95 → 0,05; ≥50 → 0,1. HNX/UPCoM: 0,1. */
export function tickSize(price, exchange = 'HOSE') {
  if (exchange !== 'HOSE') return 0.1;
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  return 0.1;
}

// Làm tròn trên lưới bước giá; cộng/trừ EPS để sai số dấu phẩy động không đẩy sang bước kế tiếp
export function roundDown(price, exchange) {
  const t = tickSize(price, exchange);
  return Math.round(Math.floor(price / t + EPS) * t * 1000) / 1000;
}

export function roundUp(price, exchange) {
  const t = tickSize(price, exchange);
  return Math.round(Math.ceil(price / t - EPS) * t * 1000) / 1000;
}

/** Giá trần (làm tròn xuống) và giá sàn (làm tròn lên) để cả hai đều nằm trong biên độ. */
export function priceLimits(ref, band, exchange) {
  return { ceiling: roundDown(ref * (1 + band), exchange), floor: roundUp(ref * (1 - band), exchange) };
}

// ---------- Chiến lược: trả mảng target[i] ∈ {0, 1} = muốn nắm giữ sau khi đóng cửa phiên i ----------

// Giữ trạng thái giữa hai ngưỡng: vào khi enter(i), thoát khi exit(i)
function hysteresis(n, from, enter, exit) {
  const out = new Array(n).fill(0);
  let pos = 0;
  for (let i = from; i < n; i++) {
    if (!pos && enter(i)) pos = 1;
    else if (pos && exit(i)) pos = 0;
    out[i] = pos;
  }
  return out;
}

/**
 * Điểm kỹ thuật của hệ thống tại từng phiên, chỉ dùng dữ liệu đến phiên đó.
 * Không có lịch sử khối ngoại nên phần điểm khối ngoại không được tính.
 */
export function scoreSeries(bars, indexBars = null, warmup = 60) {
  const n = bars.length;
  const scores = new Array(n).fill(null);
  const ic = indexBars?.map((b) => b.close) || [];
  const i20 = sma(ic, 20), i50 = sma(ic, 50);
  let j = -1;
  for (let i = warmup; i < n; i++) {
    const t = bars[i].time;
    while (j + 1 < (indexBars?.length || 0) && indexBars[j + 1].time <= t) j++;
    let market = null;
    if (j >= 0 && i50[j] != null) {
      const c = ic[j];
      market = { trend: c > i50[j] && i20[j] > i50[j] ? 'up' : c < i50[j] && i20[j] < i50[j] ? 'down' : 'sideways' };
    }
    const idx = j >= 0 ? indexBars.slice(0, j + 1) : null;
    scores[i] = technicalAnalysis(bars.slice(0, i + 1), market, { indexBars: idx }).score;
  }
  return scores;
}

export const STRATEGIES = {
  score: {
    label: 'Điểm kỹ thuật của hệ thống',
    desc: 'Mua khi điểm kỹ thuật ≥ ngưỡng mua, bán khi điểm ≤ ngưỡng bán. Kiểm chứng chính bộ quy tắc chấm điểm của tool.',
    params: { buy: 30, sell: -10 },
    signals: (bars, p, ctx) => {
      const s = ctx.scores;
      return hysteresis(bars.length, 0, (i) => s[i] != null && s[i] >= p.buy, (i) => s[i] != null && s[i] <= p.sell);
    },
  },
  ma_cross: {
    label: 'Giao cắt MA',
    desc: 'Nắm giữ khi MA nhanh nằm trên MA chậm.',
    params: { fast: 20, slow: 50 },
    signals: (bars, p) => {
      const c = bars.map((b) => b.close);
      const f = sma(c, p.fast), s = sma(c, p.slow);
      return c.map((_, i) => (f[i] != null && s[i] != null && f[i] > s[i] ? 1 : 0));
    },
  },
  rsi_reversion: {
    label: 'RSI quá bán hồi phục',
    desc: 'Mua khi RSI14 < ngưỡng quá bán, bán khi RSI14 > ngưỡng thoát.',
    params: { low: 30, exit: 60 },
    signals: (bars, p) => {
      const r = rsi(bars.map((b) => b.close), 14);
      return hysteresis(bars.length, 0, (i) => r[i] != null && r[i] < p.low, (i) => r[i] != null && r[i] > p.exit);
    },
  },
  macd: {
    label: 'MACD',
    desc: 'Nắm giữ khi MACD nằm trên đường tín hiệu và trên 0 (lọc bớt tín hiệu nhiễu trong xu hướng giảm).',
    params: {},
    signals: (bars) => {
      const m = macd(bars.map((b) => b.close));
      return m.hist.map((h, i) => (h != null && h > 0 && m.line[i] > 0 ? 1 : 0));
    },
  },
  breakout: {
    label: 'Bứt phá đỉnh (Donchian)',
    desc: 'Mua khi đóng cửa vượt đỉnh cao nhất N phiên trước, bán khi thủng đáy thấp nhất M phiên trước.',
    params: { entry: 20, exit: 10 },
    signals: (bars, p) => {
      const hh = (i, k) => Math.max(...bars.slice(i - k, i).map((b) => b.high));
      const ll = (i, k) => Math.min(...bars.slice(i - k, i).map((b) => b.low));
      return hysteresis(bars.length, Math.max(p.entry, p.exit),
        (i) => bars[i].close > hh(i, p.entry), (i) => bars[i].close < ll(i, p.exit));
    },
  },
};

// ---------- Engine ----------

/**
 * Chạy mô phỏng trên `bars` với mảng `target` (0/1). Trả về đường vốn, giao dịch và các lần lệnh bị chặn.
 * @param {object[]} bars
 * @param {number[]} target
 * @param {object} cfg DEFAULTS + exchange + start (phiên bắt đầu được giao dịch)
 */
export function simulate(bars, target, cfg) {
  const c = { ...DEFAULTS, ...cfg };
  const exchange = c.exchange || 'HOSE';
  const band = c.band ?? BANDS[exchange] ?? BANDS.HOSE;
  const start = c.start ?? 0;
  let cash = c.initialCash;
  let pos = null; // { shares, price, cost, idx, time }
  let exitReason = null;
  const trades = [];
  const blocked = { ceiling: 0, floor: 0, settlement: 0, cash: 0 };
  const equity = [];
  let fees = 0;
  let inMarket = 0;

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i];
    const want = i > start ? (exitReason ? 0 : target[i - 1]) : 0;
    const ref = bars[i - 1]?.close;

    if (ref && want === 1 && !pos) {
      const { ceiling } = priceLimits(ref, band, exchange);
      // Mở cửa sát giá trần (trong 1 bước giá): coi như trắng bên bán, không mua được
      if (bar.open >= ceiling - tickSize(ceiling, exchange) + EPS) blocked.ceiling++;
      else {
        const price = Math.min(roundUp(bar.open * (1 + c.slippage), exchange), ceiling);
        const budget = cash * c.positionPct;
        const shares = Math.floor(budget / (price * 1000 * (1 + c.brokerage)) / LOT) * LOT;
        if (shares <= 0) blocked.cash++;
        else {
          const gross = shares * price * 1000;
          const fee = gross * c.brokerage;
          cash -= gross + fee;
          fees += fee;
          pos = { shares, price, cost: gross + fee, idx: i, time: bar.time };
        }
      }
    } else if (ref && want === 0 && pos) {
      const { floor } = priceLimits(ref, band, exchange);
      if (i - pos.idx < c.settlementBars) blocked.settlement++;
      else if (bar.open <= floor + tickSize(floor, exchange) - EPS) blocked.floor++;
      else {
        const price = Math.max(roundDown(bar.open * (1 - c.slippage), exchange), floor);
        const gross = pos.shares * price * 1000;
        const fee = gross * (c.brokerage + c.sellTax);
        cash += gross - fee;
        fees += fee;
        const pnl = gross - fee - pos.cost;
        trades.push({
          entryTime: pos.time, exitTime: bar.time, entryPrice: pos.price, exitPrice: price,
          shares: pos.shares, pnl: Math.round(pnl), returnPct: round((pnl / pos.cost) * 100, 2),
          bars: i - pos.idx, reason: exitReason || 'signal',
        });
        pos = null;
        exitReason = null;
      }
    }

    const value = cash + (pos ? pos.shares * bar.close * 1000 : 0);
    equity.push({ time: bar.time, value });
    if (pos) inMarket++;

    // Cắt lỗ / chốt lời đánh giá trên giá đóng cửa, thoát ở phiên sau
    if (pos && !exitReason) {
      const chg = bar.close / pos.price - 1;
      if (c.stopLossPct && chg <= -c.stopLossPct) exitReason = 'stop';
      else if (c.takeProfitPct && chg >= c.takeProfitPct) exitReason = 'target';
    }
  }

  const lastBar = bars.at(-1);
  const open = pos ? {
    entryTime: pos.time, entryPrice: pos.price, shares: pos.shares,
    returnPct: round(((pos.shares * lastBar.close * 1000 * (1 - c.brokerage - c.sellTax)) / pos.cost - 1) * 100, 2),
  } : null;
  return { equity, trades, blocked, fees: Math.round(fees), openPosition: open, exposure: equity.length ? inMarket / equity.length : 0 };
}

// ---------- Chỉ số hiệu quả ----------

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

export function returnsOf(values) {
  const out = [];
  for (let i = 1; i < values.length; i++) out.push(values[i - 1] ? values[i] / values[i - 1] - 1 : 0);
  return out;
}

/** Sụt giảm lớn nhất (số âm). Đỉnh ban đầu là vốn ban đầu nên lỗ ngay phiên đầu vẫn được tính. */
export function maxDrawdown(values, initial = values[0]) {
  let peak = initial, dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}

export function tradeStats(trades) {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0), losses = pnls.filter((p) => p <= 0);
  const grossWin = wins.reduce((s, v) => s + v, 0), grossLoss = -losses.reduce((s, v) => s + v, 0);
  let streak = 0, maxStreak = 0;
  for (const p of pnls) { streak = p <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  return {
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgWinPct: wins.length ? mean(trades.filter((t) => t.pnl > 0).map((t) => t.returnPct)) : null,
    avgLossPct: losses.length ? mean(trades.filter((t) => t.pnl <= 0).map((t) => t.returnPct)) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
    maxConsecutiveLoss: maxStreak,
    avgHoldingBars: trades.length ? mean(trades.map((t) => t.bars)) : null,
  };
}

/**
 * Bộ chỉ số tương tự calc_metrics của Vibe-Trading.
 * @param {number[]} values đường vốn theo phiên
 * @param {number[]|null} benchValues giá VN-Index cùng các phiên (để tính beta, lợi nhuận vượt trội)
 */
export function calcMetrics(values, trades, initialCash, benchValues = null) {
  const n = values.length;
  if (!n) return null;
  const rets = returnsOf([initialCash, ...values]);
  const total = values[n - 1] / initialCash - 1;
  const annual = total <= -1 ? -1 : (1 + total) ** (BARS_PER_YEAR / Math.max(n, 1)) - 1;
  const vol = std(rets);
  const sharpe = vol ? (mean(rets) / vol) * Math.sqrt(BARS_PER_YEAR) : 0;
  const downside = Math.sqrt(rets.reduce((s, r) => s + (r < 0 ? r * r : 0), 0) / rets.length);
  const sortino = downside ? (mean(rets) / downside) * Math.sqrt(BARS_PER_YEAR) : 0;
  const mdd = maxDrawdown(values, initialCash);
  const out = {
    finalValue: Math.round(values[n - 1]),
    totalReturn: total,
    annualReturn: annual,
    volatility: vol * Math.sqrt(BARS_PER_YEAR),
    maxDrawdown: mdd,
    sharpe,
    sortino,
    calmar: mdd < 0 ? annual / -mdd : 0,
    ...tradeStats(trades),
  };
  if (benchValues?.length === n) {
    const br = returnsOf(benchValues);
    const pr = rets.slice(1);
    const bm = mean(br), pm = mean(pr);
    let cov = 0, varB = 0;
    for (let i = 0; i < br.length; i++) { cov += (pr[i] - pm) * (br[i] - bm); varB += (br[i] - bm) ** 2; }
    out.benchmarkReturn = benchValues[n - 1] / benchValues[0] - 1;
    out.excessReturn = total - out.benchmarkReturn;
    out.beta = varB ? cov / varB : 0;
  }
  return out;
}

// ---------- Kiểm định độ tin cậy (tham khảo validation.py của Vibe-Trading) ----------

// Bộ sinh số ngẫu nhiên có seed để kết quả lặp lại được
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];

/**
 * Bootstrap: lấy mẫu có hoàn lại tỷ suất của từng giao dịch, ghép thành chuỗi cùng số lệnh.
 * Cho biết lợi nhuận có ổn định không hay chỉ nhờ vài lệnh may mắn.
 */
export function bootstrapTrades(trades, { n = 2000, seed = 42 } = {}) {
  if (trades.length < 5) return { error: 'Cần ít nhất 5 giao dịch đã đóng để kiểm định' };
  const r = trades.map((t) => t.returnPct / 100);
  const rand = rng(seed);
  const totals = [], dds = [];
  for (let s = 0; s < n; s++) {
    let eq = 1, peak = 1, dd = 0;
    for (let k = 0; k < r.length; k++) {
      eq *= 1 + r[Math.floor(rand() * r.length)];
      peak = Math.max(peak, eq);
      dd = Math.min(dd, eq / peak - 1);
    }
    totals.push(eq - 1);
    dds.push(dd);
  }
  totals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  return {
    simulations: n,
    probProfit: totals.filter((v) => v > 0).length / n,
    returnP5: percentile(totals, 5), returnP50: percentile(totals, 50), returnP95: percentile(totals, 95),
    drawdownP5: percentile(dds, 5), drawdownP50: percentile(dds, 50),
  };
}

/** Chia giai đoạn kiểm định thành các cửa sổ liên tiếp, xem chiến lược có lãi đều hay chỉ trong một giai đoạn. */
export function walkForward(equity, trades, windows = 4) {
  if (equity.length < windows * 20) return { error: 'Không đủ dữ liệu để chia giai đoạn' };
  const size = Math.floor(equity.length / windows);
  const out = [];
  for (let w = 0; w < windows; w++) {
    const seg = equity.slice(w * size, w === windows - 1 ? equity.length : (w + 1) * size);
    const from = seg[0].time, to = seg.at(-1).time;
    const wt = trades.filter((t) => t.entryTime >= from && t.entryTime <= to);
    out.push({
      from, to,
      returnPct: round((seg.at(-1).value / seg[0].value - 1) * 100, 2),
      maxDrawdownPct: round(maxDrawdown(seg.map((e) => e.value)) * 100, 2),
      trades: wt.length,
      winRate: wt.length ? round(wt.filter((t) => t.pnl > 0).length / wt.length, 2) : null,
    });
  }
  const profitable = out.filter((w) => w.returnPct > 0).length;
  const losing = out.filter((w) => w.returnPct < 0).length;
  return { windows: out, profitable, losing, consistency: profitable / windows };
}

// ---------- Chạy backtest cho một mã ----------

function parseParams(def, raw = {}) {
  const out = { ...def };
  for (const k of Object.keys(def)) {
    const v = Number(raw[k]);
    if (raw[k] !== undefined && raw[k] !== '' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Mảng giá trị VN-Index cùng ngày với từng điểm của đường vốn (dùng giá gần nhất nếu thiếu ngày). */
function alignBench(equity, indexBars) {
  if (!indexBars?.length) return null;
  const out = [];
  let j = 0, lastV = null;
  for (const e of equity) {
    while (j < indexBars.length && indexBars[j].time <= e.time) lastV = indexBars[j++].close;
    out.push(lastV);
  }
  return out.every((v) => v != null) ? out : null;
}

// Điểm kỹ thuật lịch sử tốn thời gian nhất: cache theo mã + phiên cuối
function cachedScores(symbol, bars, indexBars) {
  return cached(`bt-scores:${symbol}:${bars.length}:${bars.at(-1).time}`, 30 * 60_000, () => scoreSeries(bars, indexBars));
}

/**
 * Backtest một mã.
 * @param {string} symbol
 * @param {{ strategy?: string, years?: number, params?: object, stopLossPct?: number, takeProfitPct?: number,
 *   positionPct?: number, initialCash?: number }} opts
 */
export async function runBacktest(symbol, opts = {}) {
  symbol = String(symbol).trim().toUpperCase();
  const key = opts.strategy || 'score';
  const strat = STRATEGIES[key];
  if (!strat) throw new Error(`Chiến lược không hợp lệ (${Object.keys(STRATEGIES).join(', ')})`);
  const years = Math.min(4, Math.max(1, Number(opts.years) || 3));
  const params = parseParams(strat.params, opts.params);
  const pctOpt = (v) => (v == null || v === '' || !Number(v) ? null : Math.min(0.9, Math.abs(Number(v)) / 100));
  const cfg = {
    initialCash: Number(opts.initialCash) > 0 ? Number(opts.initialCash) : DEFAULTS.initialCash,
    positionPct: opts.positionPct ? Math.min(1, Math.max(0.1, Number(opts.positionPct) / 100)) : 1,
    stopLossPct: pctOpt(opts.stopLossPct),
    takeProfitPct: pctOpt(opts.takeProfitPct),
  };

  // Lấy thêm ~1 năm làm giai đoạn khởi động cho MA200 trước giai đoạn kiểm định
  const days = Math.round((years + 1.2) * 365);
  const [priceRes, info, indexRes] = await Promise.all([
    getPriceHistory(symbol, days),
    getCompanyInfo(symbol).catch(() => undefined),
    getPriceHistory('VNINDEX', days).catch(() => null),
  ]);
  if (info === null) throw new Error(`Không tìm thấy mã ${symbol}`);
  const bars = priceRes.bars;
  const exchange = BANDS[info?.exchange] ? info.exchange : 'HOSE';
  const testBars = Math.min(Math.round(years * BARS_PER_YEAR), bars.length - 60);
  if (testBars < 60) throw new Error(`Mã ${symbol} có quá ít dữ liệu để backtest (${bars.length} phiên)`);
  const start = bars.length - testBars;
  const indexBars = indexRes?.bars || null;

  const ctx = {};
  if (key === 'score') ctx.scores = await cachedScores(symbol, bars, indexBars);
  const target = strat.signals(bars, params, ctx);
  const sim = simulate(bars, target, { ...cfg, exchange, start });
  const values = sim.equity.map((e) => e.value);
  const bench = alignBench(sim.equity, indexBars);
  const metrics = calcMetrics(values, sim.trades, cfg.initialCash, bench);

  // Mua và nắm giữ cùng mã trong cùng giai đoạn (đã trừ phí) để so sánh
  const bh = simulate(bars, bars.map(() => 1), { ...cfg, exchange, start, stopLossPct: null, takeProfitPct: null, positionPct: 1 });
  const bhValues = bh.equity.map((e) => e.value);
  const buyHold = { totalReturn: bhValues.at(-1) / cfg.initialCash - 1, maxDrawdown: maxDrawdown(bhValues, cfg.initialCash) };

  // Độ nhạy tham số (chỉ cho chiến lược điểm hệ thống vì điểm đã tính sẵn): lưới ngưỡng mua × bán
  let sensitivity = null;
  if (key === 'score') {
    const buys = [20, 30, 40, 50], sells = [-20, -10, 0, 10];
    sensitivity = {
      buys, sells,
      grid: sells.map((s) => buys.map((b) => {
        if (s >= b) return null;
        const t = strat.signals(bars, { buy: b, sell: s }, ctx);
        const r = simulate(bars, t, { ...cfg, exchange, start });
        return { returnPct: round((r.equity.at(-1).value / cfg.initialCash - 1) * 100, 1), trades: r.trades.length };
      })),
    };
  }

  // Thu gọn đường vốn để vẽ (tối đa ~400 điểm)
  const step = Math.max(1, Math.ceil(sim.equity.length / 400));
  const curve = [];
  sim.equity.forEach((e, k) => {
    if (k % step && k !== sim.equity.length - 1) return;
    curve.push({
      time: e.time,
      equity: Math.round(e.value),
      buyHold: Math.round(bh.equity[k].value),
      index: bench ? Math.round((bench[k] / bench[0]) * cfg.initialCash) : null,
    });
  });

  // Trạng thái tín hiệu ở phiên cuối: chiến lược đang muốn nắm giữ hay đứng ngoài
  const lastTarget = target.at(-1);
  return {
    symbol, exchange, strategy: key, strategyLabel: strat.label, strategyDesc: strat.desc, params,
    config: { ...DEFAULTS, ...cfg, band: BANDS[exchange] },
    period: { from: bars[start].time, to: bars.at(-1).time, bars: testBars, years },
    metrics: roundMetrics(metrics),
    buyHold: roundMetrics(buyHold),
    blocked: sim.blocked,
    fees: sim.fees,
    exposure: round(sim.exposure, 3),
    openPosition: sim.openPosition,
    currentSignal: lastTarget ? 'HOLD' : 'FLAT',
    currentScore: ctx.scores ? ctx.scores.at(-1) : null,
    trades: sim.trades.slice(-60).reverse(),
    bootstrap: bootstrapTrades(sim.trades),
    walkForward: walkForward(sim.equity, sim.trades),
    sensitivity,
    curve,
    notes: [
      key === 'score' ? 'Điểm lịch sử không gồm khối ngoại và tin tức (không có dữ liệu quá khứ), chỉ là phần kỹ thuật.' : null,
      'Giá lịch sử đã điều chỉnh theo cổ tức/chia tách nên mức trần/sàn được kiểm tra với dung sai 1 bước giá.',
      'Kết quả quá khứ không đảm bảo cho tương lai; số lệnh ít thì các chỉ số kém tin cậy.',
    ].filter(Boolean),
  };
}

function roundMetrics(m) {
  if (!m) return m;
  const out = {};
  for (const [k, v] of Object.entries(m)) out[k] = typeof v === 'number' ? (Number.isFinite(v) ? round(v, 4) : null) : v;
  return out;
}

/** Danh sách chiến lược cho giao diện. */
export function listStrategies() {
  return Object.entries(STRATEGIES).map(([id, s]) => ({ id, label: s.label, desc: s.desc, params: s.params }));
}

/** Tóm tắt ngắn để đưa vào prompt AI (căn cứ lịch sử cho Hội đồng đầu tư). */
export function backtestBrief(bt) {
  const m = bt.metrics;
  const p = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  return `Backtest "${bt.strategyLabel}" ${bt.period.from} → ${bt.period.to} (${bt.period.years} năm, đã trừ phí/thuế, luật T+2 và biên độ ${Math.round(bt.config.band * 100)}%): `
    + `lợi nhuận ${p(m.totalReturn)} (mua và nắm giữ ${p(bt.buyHold.totalReturn)}, VN-Index ${p(m.benchmarkReturn)}), `
    + `sụt giảm tối đa ${p(m.maxDrawdown)}, Sharpe ${m.sharpe?.toFixed(2) ?? 'n/a'}, ${m.tradeCount} lệnh, tỷ lệ thắng ${p(m.winRate)}, `
    + `profit factor ${m.profitFactor?.toFixed(2) ?? 'n/a'}${bt.bootstrap?.probProfit != null ? `, xác suất có lãi (bootstrap) ${p(bt.bootstrap.probProfit)}` : ''}`
    + `${bt.walkForward?.windows ? `, chia ${bt.walkForward.windows.length} giai đoạn: ${bt.walkForward.profitable} lãi, ${bt.walkForward.losing} lỗ` : ''}. `
    + `Tín hiệu hiện tại: ${bt.currentSignal === 'HOLD' ? 'đang nắm giữ' : 'đứng ngoài'}.`;
}
