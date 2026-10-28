// Danh mục theo dõi, quét định kỳ và ghi cảnh báo khi khuyến nghị thay đổi
// hoặc giá chạm ngưỡng người dùng đặt.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSymbol, summarize } from './analyze.js';
import { aiAnalyze, aiConfig } from './ai.js';
import { recordPrediction } from './predictions.js';
import { finalDecision } from './decision.js';
import { recordForecast } from './forecast.js';
import { forwardAlert } from './telegram.js';

const AI_DIRECTION = { MUA: 1, MUA_THAM_DO: 1, GIU: 0, DUNG_NGOAI: -1, BAN_BOT: -1, BAN: -1 };

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const STATE_FILE = join(DATA_DIR, 'state.json');
const MAX_ALERTS = 200;

const DEFAULT_STATE = {
  watchlist: [
    { symbol: 'FPT' }, { symbol: 'VCB' }, { symbol: 'HPG' }, { symbol: 'MWG' }, { symbol: 'VNM' },
  ],
  snapshots: {}, // symbol -> bản tóm tắt lần quét gần nhất
  ai: {}, // symbol -> kết quả phân tích Gemini gần nhất
  alerts: [],
};

let state = null;
let saving = Promise.resolve();

async function load() {
  if (state) return state;
  try {
    state = { ...structuredClone(DEFAULT_STATE), ...JSON.parse(await readFile(STATE_FILE, 'utf8')) };
  } catch {
    state = structuredClone(DEFAULT_STATE);
  }
  return state;
}

function save() {
  // Ghi tuần tự để tránh hai lần ghi chồng lên nhau
  saving = saving.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  }).catch((err) => console.error('Lỗi ghi state:', err.message));
  return saving;
}

function addAlert(symbol, type, message, { forward = true } = {}) {
  state.alerts.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: new Date().toISOString(), symbol, type, message, read: false });
  state.alerts.length = Math.min(state.alerts.length, MAX_ALERTS);
  console.log(`[Cảnh báo] ${symbol}: ${message}`);
  if (forward) forwardAlert(symbol, message);
}

/** Ghi cảnh báo từ module khác (vd. radar cơ hội mua) vào danh sách trong app; Telegram do nơi gọi tự gửi. */
export async function pushAlert(symbol, type, message) {
  await load();
  addAlert(symbol, type, message, { forward: false });
  await save();
}

export async function getWatchlist() {
  await load();
  return state.watchlist.map((w) => {
    const ai = state.ai[w.symbol];
    return {
      ...w,
      snapshot: state.snapshots[w.symbol] || null,
      ai: ai ? { decision: ai.decision, decisionLabel: ai.decisionLabel, confidence: ai.confidence, createdAt: ai.createdAt } : null,
    };
  });
}

export async function getAiResult(symbol) {
  await load();
  return state.ai[symbol.toUpperCase()] || null;
}

/** Phân tích bằng Gemini, lưu kết quả và cảnh báo nếu quyết định AI thay đổi. */
export async function runAi(symbol, { force = false, analysis = null } = {}) {
  await load();
  const a = analysis || await analyzeSymbol(symbol, { withChart: false });
  const result = { ...(await aiAnalyze(a, { force })) };
  // Quyết định cuối: hệ thống + AI thẩm định, lấy bên thận trọng hơn; kế hoạch mua/bán tính lại theo mức cuối
  result.final = finalDecision(a, result);
  const prev = state.ai[a.symbol];
  if (prev && prev.decision !== result.decision && state.watchlist.some((w) => w.symbol === a.symbol)) {
    addAlert(a.symbol, 'ai', `Gemini đổi quyết định từ ${prev.decisionLabel} sang ${result.decisionLabel} (tin cậy ${result.confidence}%)`);
  }
  state.ai[a.symbol] = result;
  await save();
  recordForecast(a.symbol, { date: a.price.date, close: a.price.close, forecast: result.forecast, cone: a.cone }).catch(() => {});
  if (result.final) {
    const dir = { BUY: 1, ACCUMULATE: 1, HOLD: 0, AVOID: -1, SELL: -1 }[result.final.code];
    recordPrediction({ source: 'final', symbol: a.symbol, date: a.price.date, direction: dir, label: result.final.label, price: a.price.close, detail: result.final.relation, confidence: result.confidence });
  }
  // Lãi kỳ vọng theo kịch bản AI (giá kỳ vọng / giá hiện tại − 1) để chấm sai số và độ hiệu chỉnh của con số % AI đưa ra
  const ex = result.forecast?.expected;
  const expected = ex && a.price.close ? Object.fromEntries([5, 10, 20].filter((h) => Number.isFinite(ex[`p${h}`])).map((h) => [h, Math.round((ex[`p${h}`] / a.price.close - 1) * 1e4) / 1e4])) : undefined;
  recordPrediction({ source: 'ai', symbol: a.symbol, date: a.price.date, direction: AI_DIRECTION[result.decision], label: result.decisionLabel, price: a.price.close, detail: `Tin cậy ${result.confidence}%`, confidence: result.confidence, expected });
  return result;
}

export async function addToWatchlist(symbol, { priceAbove = null, priceBelow = null, note = '' } = {}) {
  await load();
  symbol = symbol.toUpperCase();
  const existing = state.watchlist.find((w) => w.symbol === symbol);
  const entry = { symbol, priceAbove: num(priceAbove), priceBelow: num(priceBelow), note: String(note || '').slice(0, 200) };
  if (existing) Object.assign(existing, entry);
  else state.watchlist.push(entry);
  await save();
  return entry;
}

function num(v) {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? null : n;
}

export async function removeFromWatchlist(symbol) {
  await load();
  state.watchlist = state.watchlist.filter((w) => w.symbol !== symbol.toUpperCase());
  delete state.snapshots[symbol.toUpperCase()];
  await save();
}

export async function getAlerts() {
  await load();
  return state.alerts;
}

export async function markAlertsRead() {
  await load();
  state.alerts.forEach((a) => (a.read = true));
  await save();
}

export async function triggerTestAlert(symbol = 'FPT', message = null) {
  await load();
  symbol = (symbol || 'FPT').toUpperCase();
  const msg = message || `[TEST CẢNH BÁO] ${symbol}: Đã kích hoạt cảnh báo thử nghiệm thành công!`;
  addAlert(symbol, 'test', msg);
  await save();
  return { ok: true, alert: { symbol, message: msg } };
}

/** So sánh kết quả mới với lần quét trước và sinh cảnh báo. */
function checkAlerts(entry, prev, cur) {
  const { symbol } = cur;
  // Không báo khi chỉ đổi cách tính (điểm cũ → điểm xếp hạng)
  if (prev && prev.recommendation.code !== cur.recommendation.code && prev.recommendation.basis === cur.recommendation.basis) {
    addAlert(symbol, 'recommendation',
      `Khuyến nghị đổi từ ${prev.recommendation.label} sang ${cur.recommendation.label} (điểm ${prev.total} → ${cur.total})`);
  }
  const price = cur.price.close;
  const prevPrice = prev?.price?.close;
  if (entry.priceAbove != null && price >= entry.priceAbove && !(prevPrice >= entry.priceAbove)) {
    addAlert(symbol, 'price', `Giá ${price} đã vượt ngưỡng ${entry.priceAbove}`);
  }
  if (entry.priceBelow != null && price <= entry.priceBelow && !(prevPrice <= entry.priceBelow)) {
    addAlert(symbol, 'price', `Giá ${price} đã xuống dưới ngưỡng ${entry.priceBelow}`);
  }
  if (cur.warnings > (prev?.warnings ?? 0)) {
    addAlert(symbol, 'warning', 'Xuất hiện cảnh báo rủi ro mới, xem chi tiết mã này');
  }
}

let scanning = null;

/** Quét toàn bộ danh mục, tối đa 3 mã chạy song song. */
export function scanWatchlist() {
  if (scanning) return scanning;
  scanning = (async () => {
    await load();
    const queue = [...state.watchlist];
    const errors = [];
    const worker = async () => {
      while (queue.length) {
        const entry = queue.shift();
        try {
          const cur = summarize(await analyzeSymbol(entry.symbol, { withChart: false }));
          checkAlerts(entry, state.snapshots[entry.symbol], cur);
          state.snapshots[entry.symbol] = cur;
        } catch (err) {
          errors.push({ symbol: entry.symbol, error: err.message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await save();

    // Tự động phân tích AI (bật bằng GEMINI_AUTO_SCAN=1). Chạy tuần tự để không vượt hạn mức,
    // chỉ gọi lại khi kết quả cũ hơn GEMINI_AUTO_HOURS giờ (mặc định 4).
    if (process.env.GEMINI_AUTO_SCAN === '1' && aiConfig().enabled) {
      const maxAge = (Number(process.env.GEMINI_AUTO_HOURS) || 4) * 3600_000;
      for (const entry of state.watchlist) {
        const prev = state.ai[entry.symbol];
        if (prev && Date.now() - Date.parse(prev.createdAt) < maxAge) continue;
        try {
          await runAi(entry.symbol);
        } catch (err) {
          errors.push({ symbol: entry.symbol, error: `AI: ${err.message}` });
          if (/hạn mức|API_KEY/.test(err.message)) break;
        }
      }
    }
    return { scanned: state.watchlist.length, errors };
  })().finally(() => (scanning = null));
  return scanning;
}

// Giờ giao dịch HOSE/HNX: 9:00 - 15:00, thứ 2 - thứ 6 (giờ Việt Nam)
export function isTradingHours(date = new Date()) {
  const vn = new Date(date.getTime() + 7 * 3600_000);
  const day = vn.getUTCDay();
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 9 * 60 && minutes <= 15 * 60 + 5;
}

/** Quét ngay khi khởi động, sau đó quét mỗi `minutes` phút trong giờ giao dịch. */
export function startMonitor(minutes = 10) {
  const run = () => scanWatchlist()
    .then((r) => r.errors.length && console.warn('Lỗi khi quét:', r.errors))
    .catch((err) => console.error('Lỗi quét danh mục:', err.message));
  run();
  return setInterval(() => isTradingHours() && run(), minutes * 60_000);
}
