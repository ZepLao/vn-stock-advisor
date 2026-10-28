// Đồng bộ dữ liệu hằng ngày sang PostgreSQL (chạy bằng docker compose) để phân tích và cải thiện tool.
// File data/*.json vẫn là nơi app đọc/ghi chính; database là bản sao đầy đủ, giữ MỌI phiên bản phân tích AI /
// hội đồng (file JSON chỉ giữ bản mới nhất). Database tắt hoặc lỗi thì app vẫn chạy bình thường.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getPriceHistory } from './data.js';
import { predictionLog, canonicalItems } from './predictions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

export function dbConfig() {
  const e = process.env;
  if (e.DATABASE_URL) return { enabled: true, connectionString: e.DATABASE_URL };
  if (!e.DB_PASSWORD) return { enabled: false };
  return {
    enabled: true, host: e.DB_HOST || '127.0.0.1', port: Number(e.DB_PORT) || 5432,
    database: e.DB_NAME || 'vnstock', user: e.DB_USER || 'vnstock', password: e.DB_PASSWORD,
  };
}

let pool = null;
let ready = null;
function db() {
  const { enabled, ...cfg } = dbConfig();
  if (!enabled) return null;
  if (!pool) {
    pool = new pg.Pool({ ...cfg, max: 4, connectionTimeoutMillis: 5000 });
    pool.on('error', (err) => console.error('[DB] Lỗi kết nối:', err.message));
  }
  return pool;
}

/** Tạo bảng (an toàn khi chạy lại). */
function migrate() {
  ready ??= readFile(join(ROOT, 'db', 'schema.sql'), 'utf8')
    .then((sql) => db().query(sql))
    .catch((err) => { ready = null; throw err; });
  return ready;
}

export async function query(sql, params) {
  if (!db()) throw new Error('Chưa cấu hình database (DB_PASSWORD trong .env)');
  await migrate();
  return pool.query(sql, params);
}

/**
 * Ghi nhiều dòng: INSERT … ON CONFLICT (khóa) DO UPDATE (hoặc DO NOTHING nếu `update` = false), mỗi lần 500 dòng.
 * @param {string} table
 * @param {string[]} cols
 * @param {any[][]} rows
 * @param {string[]} key cột khóa chính
 */
export async function upsert(table, cols, rows, key, { update = true } = {}) {
  if (!rows.length) return 0;
  const set = cols.filter((c) => !key.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const tail = update && set ? `DO UPDATE SET ${set}` : 'DO NOTHING';
  for (let k = 0; k < rows.length; k += 500) {
    const chunk = rows.slice(k, k + 500);
    const values = chunk.map((r, i) => `(${r.map((_, j) => `$${i * cols.length + j + 1}`).join(', ')})`).join(', ');
    await query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values} ON CONFLICT (${key.join(', ')}) ${tail}`,
      chunk.flat().map((v) => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v ?? null)));
  }
  return rows.length;
}

const readJson = (name) => readFile(join(DATA, name), 'utf8').then(JSON.parse).catch(() => null);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? String(v).slice(0, 10) : null);
const json = (v) => (v == null ? null : JSON.stringify(v));

// ---------- Từng loại dữ liệu ----------
async function syncHistory() {
  const have = new Set((await query('SELECT to_char(date, \'YYYY-MM-DD\') AS d FROM market_daily')).rows.map((r) => r.d));
  const files = (await readdir(join(DATA, 'history')).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let n = 0;
  for (const f of files.sort()) {
    const date = f.slice(0, 10);
    if (have.has(date)) continue;
    const s = await readJson(join('history', f));
    if (!s?.rows) continue;
    const m = s.market || {};
    n += await upsert('stock_daily', [
      'date', 'symbol', 'close', 'value20', 'rank_score', 'above_ma200', 'rank_rec', 'tech_score', 'fund_score', 'legacy_total', 'legacy_rec',
      'f_mom', 'f_high', 'f_atr', 'f_adx', 'foreign_net1', 'foreign_net5', 'foreign_net20', 'foreign_ratio20',
      'pe', 'pb', 'roe', 'eps_ttm', 'profit_growth_ttm', 'revenue_growth_ttm', 'debt_to_equity', 'dividend_yield', 'report_date', 'raw',
    ], s.rows.map((r) => {
      const fu = r.fundamentals || {}, fo = r.foreign || {}, fa = r.factors || {};
      return [date, r.symbol, r.close, r.value20, r.rank, r.aboveMa200, r.rankRec, r.tech, r.fund, r.legacyTotal, r.legacyRec,
        fa.mom, fa.high, fa.atr, fa.adx, fo.net1, fo.net5, fo.net20, fo.ratio20,
        fu.pe, fu.pb, fu.roe, fu.epsTTM, fu.profitGrowthTTM, fu.revenueGrowthTTM, fu.debtToEquity, fu.dividendYield, dateOrNull(fu.reportDate), json(r)];
    }), ['date', 'symbol']);
    // market_daily ghi sau cùng: đánh dấu ngày đã đồng bộ xong
    await upsert('market_daily', ['date', 'close', 'change_pct', 'trend', 'ma50', 'ma200', 'above_ma200', 'return_20d', 'universe', 'raw'],
      [[date, m.close, m.changePct, m.trend, m.ma50, m.ma200, m.aboveMa200, m.return20d, s.universe, json({ market: m, criteria: s.criteria })]], ['date']);
  }
  return n;
}

// Sổ dự đoán chỉ ghi thêm → prediction_log (không bao giờ cập nhật dòng cũ); bản ghi được chấm của mỗi (nguồn, mã, phiên)
// (cuối cùng trước 9:00 phiên sau) → predictions cho các view chấm điểm
async function syncPredictions() {
  const log = await predictionLog();
  const last = (await query('SELECT max(recorded_at) AS t FROM prediction_log')).rows[0].t;
  const since = last ? last.getTime() - 60_000 : 0;
  const fresh = log.filter((x) => !x.recordedAt || Date.parse(x.recordedAt) > since);
  if (!fresh.length) return 0;
  await upsert('prediction_log', ['id', 'source', 'symbol', 'date', 'direction', 'label', 'price', 'detail', 'score', 'confidence', 'band', 'plan', 'partial', 'version', 'recorded_at'],
    fresh.map((x) => [x.id, x.source, x.symbol, x.date, x.direction, x.label, x.price, x.detail ?? null, x.score ?? null, x.confidence ?? null,
      x.band ?? null, x.plan ?? null, x.partial ?? null, x.version ?? null, x.recordedAt ?? null]), ['id'], { update: false });
  const idx = (await getPriceHistory('VNINDEX').catch(() => null))?.bars || [];
  const at = new Map(idx.map((b, k) => [b.time, k]));
  const touched = new Set(fresh.map((x) => `${x.source}|${x.symbol}|${x.date}`));
  const { items } = canonicalItems(log, (d) => (at.has(d) ? idx[at.get(d) + 1]?.time ?? null : null));
  return upsert('predictions', ['source', 'symbol', 'date', 'direction', 'label', 'price', 'detail', 'recorded_at', 'version', 'score', 'confidence'],
    items.filter((x) => touched.has(`${x.source}|${x.symbol}|${x.date}`))
      .map((x) => [x.source, x.symbol, x.date, x.direction, x.label, x.price, x.detail ?? null, x.recordedAt ?? null, x.version ?? null, x.score ?? null, x.confidence ?? null]),
    ['source', 'symbol', 'date']);
}

async function syncAi() {
  const s = await readJson('state.json');
  const ai = Object.values(s?.ai || {}).filter((r) => r?.createdAt && r.symbol);
  const n = await upsert('ai_analyses', ['symbol', 'created_at', 'price_date', 'price', 'model', 'decision', 'decision_label', 'confidence', 'final_code', 'final_label', 'final_relation', 'forecast', 'raw'],
    ai.map((r) => [r.symbol, r.createdAt, dateOrNull(r.priceDate), r.price, r.model, r.decision, r.decisionLabel, r.confidence,
      r.final?.code ?? null, r.final?.label ?? null, r.final?.relation ?? null, json(r.forecast), json(r)]), ['symbol', 'created_at'], { update: false });
  const alerts = (s?.alerts || []).filter((a) => a.id);
  await upsert('alerts', ['id', 'time', 'symbol', 'type', 'message'], alerts.map((a) => [a.id, a.time, a.symbol, a.type, a.message]), ['id'], { update: false });
  return n;
}

async function syncCommittee() {
  const c = await readJson('committee.json');
  const runs = Object.values(c || {}).filter((r) => r?.createdAt && r.symbol);
  return upsert('committee_runs', ['symbol', 'created_at', 'price_date', 'price', 'model', 'decision', 'final_code', 'final_label', 'raw'],
    runs.map((r) => [r.symbol, r.createdAt, dateOrNull(r.priceDate), r.price, r.model, r.verdict?.decision ?? null, r.final?.code ?? null, r.final?.label ?? null, json(r)]),
    ['symbol', 'created_at'], { update: false });
}

async function syncForecasts() {
  const f = await readJson('forecasts.json');
  const rows = Object.entries(f || {}).flatMap(([sym, byDate]) => Object.values(byDate).map((x) => [sym, x.date, x.close, x.source, x.at, json(x.scenarios), json(x.expected), json(x.band)]));
  return upsert('forecasts', ['symbol', 'date', 'close', 'source', 'recorded_at', 'scenarios', 'expected', 'band'], rows, ['symbol', 'date']);
}

async function syncOrderFlow() {
  const o = await readJson('orderflow.json');
  const rows = Object.entries(o || {}).flatMap(([sym, byDate]) => Object.values(byDate).filter((x) => x?.date).map((x) => [
    sym, x.date, x.buy, x.sell, x.auction, x.bigBuy, x.bigSell, x.bigBuyCount, x.bigSellCount, x.ticks, x.buyRatio, x.bigBuyRatio, x.at ?? null]));
  return upsert('order_flow', ['symbol', 'date', 'buy', 'sell', 'auction', 'big_buy', 'big_sell', 'big_buy_count', 'big_sell_count', 'ticks', 'buy_ratio', 'big_buy_ratio', 'captured_at'], rows, ['symbol', 'date']);
}

async function syncScreener() {
  const s = await readJson('screener.json');
  if (!s?.createdAt) return 0;
  return upsert('screener_runs', ['created_at', 'date', 'candidates', 'raw'], [[s.createdAt, dateOrNull(s.date), json(s.candidates ?? null), json(s)]], ['created_at'], { update: false });
}

async function syncPortfolio() {
  const p = await readJson('portfolio.json');
  if (!p?.transactions) return 0;
  const client = await (await migrate(), pool.connect());
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM portfolio_transactions');
    for (const t of p.transactions) {
      await client.query('INSERT INTO portfolio_transactions (id, seq, type, symbol, qty, price, date, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [t.id, t.seq, t.type, t.symbol, t.qty, t.price, dateOrNull(t.date), t.note || '']);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return p.transactions.length;
}

/** Giá ngày của rổ + VNINDEX + mã đã dự đoán: chỉ chạy khi có phiên mới (lần đầu nạp ~1,5 năm). */
async function syncBars() {
  // Trước 15:10 giờ VN nến hôm nay còn đang chạy: không ghi, nếu không phiên đó bị coi là đã nạp
  // và giá chốt không bao giờ được cập nhật (lỗi 22/10/2026: nến 9h30 nằm lại thay giá đóng cửa)
  const vn = new Date(Date.now() + 7 * 3600_000);
  const open = vn.getUTCHours() * 60 + vn.getUTCMinutes() < 15 * 60 + 10 ? vn.toISOString().slice(0, 10) : null;
  const closed = (bars) => bars.filter((b) => b.time !== open);
  const idx = closed((await getPriceHistory('VNINDEX')).bars);
  const latest = idx.at(-1)?.time;
  // Bỏ qua nến tạm (volume 0) đã lỡ ghi để phiên đó được nạp lại bằng giá chốt
  const have = (await query('SELECT to_char(max(date), \'YYYY-MM-DD\') AS d FROM daily_bars WHERE symbol = \'VNINDEX\' AND volume > 0')).rows[0].d;
  if (!latest || have === latest) return 0;
  const syms = new Set((await query(`
    SELECT symbol FROM stock_daily WHERE date = (SELECT max(date) FROM stock_daily)
    UNION SELECT DISTINCT symbol FROM predictions UNION SELECT DISTINCT symbol FROM portfolio_transactions`)).rows.map((r) => r.symbol));
  syms.delete('VNINDEX');
  const toRows = (s, bars) => closed(have ? bars.filter((b) => b.time > have) : bars).map((b) => [s, b.time, b.open, b.high, b.low, b.close, b.volume]);
  let n = 0;
  const list = [...syms];
  for (let k = 0; k < list.length; k += 6) {
    const got = await Promise.all(list.slice(k, k + 6).map((s) => getPriceHistory(s).then((r) => toRows(s, r.bars)).catch(() => [])));
    n += await upsert('daily_bars', ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'], got.flat(), ['symbol', 'date']);
  }
  // VNINDEX ghi sau cùng: đánh dấu phiên đã nạp xong
  n += await upsert('daily_bars', ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'], toRows('VNINDEX', idx), ['symbol', 'date']);
  return n;
}

async function syncSelfReview() {
  const t = await readJson('trades.json');
  let n = await upsert('trades', ['symbol', 'date', 'status', 'code', 'entry', 'stop', 'target', 'buy_from', 'buy_to', 'recorded_at'],
    (t?.items || []).map((x) => [x.symbol, x.date, x.status, x.code, x.entry, x.stop, x.target, x.buyFrom, x.buyTo, x.at]), ['symbol', 'date']);
  const reviews = (await readJson('reviews.json')) || [];
  n += await upsert('self_reviews', ['date', 'at', 'raw'], reviews.map((r) => [r.date, r.at, json(r)]), ['at'], { update: false });
  const tune = await readJson('tuning.json');
  n += await upsert('tuning_log', ['at', 'date', 'name', 'from_val', 'to_val', 'reason', 'evidence'],
    (tune?.log || []).map((x) => [x.at, dateOrNull(x.date), x.name, json(x.from), json(x.to), x.reason, json(x.evidence)]), ['at'], { update: false });
  return n;
}

async function syncNewsLabels() {
  const c = (await readJson('newsai.json')) || {};
  return upsert('news_labels', ['symbol', 'link', 'relevant', 'label', 'risk', 'reason', 'at', 'published_at'],
    Object.entries(c).map(([k, v]) => {
      const i = k.indexOf('|');
      return [k.slice(0, i), k.slice(i + 1), v.relevant, v.label, v.risk, v.reason, v.at, v.pub ? new Date(v.pub).toISOString() : null];
    }), ['symbol', 'link']);
}

const STEPS = {
  selfReview: syncSelfReview, newsLabels: syncNewsLabels, history: syncHistory, predictions: syncPredictions, ai: syncAi, committee: syncCommittee, forecasts: syncForecasts, orderFlow: syncOrderFlow, screener: syncScreener, portfolio: syncPortfolio, bars: syncBars };

let syncing = null;
/** Đồng bộ toàn bộ; mỗi phần lỗi riêng không chặn phần khác. Trả về số dòng ghi theo từng phần. */
export function syncAll() {
  if (!db()) return Promise.resolve({ enabled: false });
  syncing ??= (async () => {
    await migrate();
    const out = {};
    for (const [name, fn] of Object.entries(STEPS)) {
      try { out[name] = await fn(); } catch (err) { out[name] = `lỗi: ${err.message}`; }
    }
    return out;
  })().finally(() => (syncing = null));
  return syncing;
}

/** Ghi bản tin Telegram vừa gửi (bỏ qua nếu database tắt / lỗi). */
export function logTelegramReport(kind, text, unverified = []) {
  if (!db()) return;
  query('INSERT INTO telegram_reports (kind, text, unverified) VALUES ($1, $2, $3)', [kind, text, unverified])
    .catch((err) => console.error('[DB] Lỗi ghi bản tin:', err.message));
}

/** Đồng bộ khi khởi động và mỗi `minutes` phút. */
export function startDbSync(minutes = 10) {
  if (!db()) return null;
  const run = () => syncAll().then((r) => {
    const errs = Object.entries(r).filter(([, v]) => typeof v === 'string');
    if (errs.length) console.warn('[DB] Lỗi đồng bộ:', Object.fromEntries(errs));
    const wrote = Object.entries(r).filter(([, v]) => typeof v === 'number' && v > 0);
    if (wrote.length) console.log('[DB] Đã đồng bộ:', wrote.map(([k, v]) => `${k} ${v}`).join(', '));
  }).catch((err) => console.error('[DB] Không kết nối được database:', err.message));
  setTimeout(run, 30_000);
  return setInterval(run, minutes * 60_000);
}
