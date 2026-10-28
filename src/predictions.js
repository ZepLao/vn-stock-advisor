// Nhật ký dự đoán: ghi lại mọi khuyến nghị (hệ thống, xếp hạng, Gemini, hội đồng, cổ phiếu tiềm năng)
// rồi tự chấm sau 5, 10, 20 phiên dựa trên giá thực tế.
//
// Sổ CHỈ GHI THÊM (data/prediction_log.jsonl, mỗi dòng một bản ghi, không bao giờ sửa / xóa) để chứng minh được dự đoán
// có trước kết quả. Mỗi bản ghi mang phiên bản mô hình (version.js) và giờ ghi. Khi chấm, mỗi (nguồn, mã, phiên) lấy
// bản ghi CUỐI CÙNG ghi trước 9:00 phiên kế tiếp; bản ghi muộn hơn bị loại (đếm riêng). Lợi nhuận tính như người dùng
// làm theo được: mua giá MỞ CỬA phiên kế tiếp, giữ h phiên, bán giá đóng cửa phiên thứ h. Mã hủy niêm yết trong lúc
// chấm: giá cuối trừ DELIST_HAIRCUT; mã không lấy được giá: đếm riêng, không âm thầm bỏ.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, DELIST_HAIRCUT, DELIST_GAP } from './data.js';
import { cached, uncache } from './http.js';
import { modelVersion } from './version.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const LOG = process.env.PREDICTION_LOG_FILE || join(DIR, 'prediction_log.jsonl');
const LEGACY = process.env.PREDICTION_LEGACY_FILE || join(DIR, 'predictions.json'); // định dạng cũ (ghi đè): chỉ đọc một lần để chuyển sang sổ mới
export const HORIZONS = [5, 10, 20];
export const SOURCES = {
  rank_all: 'Điểm xếp hạng — toàn bộ rổ (mỗi phiên)',
  legacy_all: 'Điểm kiểu cũ — toàn bộ rổ (mỗi phiên)',
  final: 'Quyết định cuối (hệ thống + AI thẩm định)',
  rule: 'Khuyến nghị hệ thống (mã đã xem)',
  rank: 'Điểm xếp hạng (mã đã xem)',
  rank_top: 'Top 8 bảng xếp hạng',
  trend_pick: 'Xu hướng chuẩn — Trend Pick (8 năm nghiên cứu)',
  monte_carlo: 'Tín hiệu rủi ro Monte Carlo',
  ai: 'Gemini phân tích',
  committee: 'Hội đồng đầu tư',
  screener: 'Cổ phiếu tiềm năng (Gemini chọn)',
  outlook: 'Xu hướng VN-Index tuần (AI)',
  outlook_sector: 'Mã thuộc ngành AI dự báo triển vọng tuần',
  prio_main: 'Bản tin: mã AI xếp ƯU TIÊN MUA',
  prio_spec: 'Bản tin: mã AI xếp ĐẦU CƠ',
  funnel: 'Phễu Tiềm năng: mọi mã đã quét kèm bộ lọc đạt / rớt (để kiểm chứng từng bộ lọc)',
};

let state = null;
let loading = null;
let saving = Promise.resolve();
let buffer = [];
let timer = null;
const keyOf = (x) => `${x.source}|${x.symbol}|${x.date}`;
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Đọc sổ một lần, rồi bổ sung các bản ghi của predictions.json (định dạng cũ, ghi đè) chưa có trong sổ, với version
// 'legacy' và giờ ghi cuối cùng của chúng. Chạy lặp lại an toàn: tiến trình bản cũ còn ghi predictions.json thì lần nạp
// sau vẫn lấy được phần mới.
function load() {
  loading ??= (async () => {
    const text = await readFile(LOG, 'utf8').catch(() => '');
    const items = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch { /* dòng hỏng (ghi dở khi tắt máy): bỏ qua */ }
    }
    const old = await readFile(LEGACY, 'utf8').then(JSON.parse).catch(() => ({}));
    const seen = new Set(items.filter((x) => x.version === 'legacy').map((x) => `${keyOf(x)}|${x.recordedAt}`));
    const add = (old.items || []).filter((x) => !seen.has(`${keyOf(x)}|${x.at ?? null}`)).map((x) => ({
      id: randomUUID(), source: x.source, symbol: x.symbol, date: x.date, direction: x.direction, label: x.label,
      price: x.price ?? null, detail: x.detail, recordedAt: x.at ?? null, version: 'legacy',
    }));
    if (add.length) {
      await mkdir(dirname(LOG), { recursive: true });
      await appendFile(LOG, add.map((x) => `${JSON.stringify(x)}\n`).join(''), 'utf8');
      items.push(...add);
    }
    // Thứ tự theo giờ ghi (bản cũ chuyển sang sau có giờ sớm hơn) để "bản sau đè bản trước" khi chọn bản được chấm
    items.sort((a, b) => String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')));
    state = { items, last: new Map(items.map((x) => [keyOf(x), x])) };
    return state;
  })();
  return loading;
}

/** Ghi các dòng đang chờ xuống sổ (append, tuần tự). */
export function flushPredictions() {
  clearTimeout(timer);
  timer = null;
  const lines = buffer;
  buffer = [];
  if (lines.length) {
    saving = saving.then(async () => {
      await mkdir(dirname(LOG), { recursive: true });
      await appendFile(LOG, lines.join(''), 'utf8');
    }).catch((err) => console.error('Lỗi ghi nhật ký dự đoán:', err.message));
  }
  return saving;
}

/**
 * Ghi một dự đoán (thêm dòng mới, không sửa bản cũ). Bỏ qua nếu giống hệt bản ghi gần nhất cùng (nguồn, mã, phiên)
 * và cùng phiên bản mô hình — tránh phình sổ khi quét lại mỗi 10 phút.
 * @param {{ source: string, symbol: string, date: string, direction: -1|0|1, label: string, price?: number, detail?: string,
 *   score?: number, confidence?: number, band?: object, plan?: object, partial?: boolean,
 *   expected?: object, expectedExcess?: object, flags?: object }} p
 *   score: điểm liên tục của nguồn (vd điểm xếp hạng 0–100) để tính IC; confidence: độ tự tin AI (%);
 *   band: { 5: [p05, p95], 10: [...], 20: [...] } dải giá;
 *   plan: { buyFrom, buyTo, stop, target, horizonDays, weight } kế hoạch lệnh (horizonDays = số phiên nắm giữ);
 *   expected: { h: % } lãi dự báo sau h phiên (vd kỳ vọng theo kịch bản AI); expectedExcess: { h: % } lãi hơn rổ dự báo
 *   (bảng kỳ vọng thống kê); flags: cờ bộ lọc (phễu Tiềm năng); partial: dự đoán dựa trên nến trong phiên (chưa chốt).
 */
export async function recordPrediction(p) {
  if (!SOURCES[p.source] || !p.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return;
  await load();
  const item = {
    id: randomUUID(), source: p.source, symbol: p.symbol, date: p.date, direction: Math.sign(p.direction || 0),
    label: String(p.label || ''), price: p.price ?? null, detail: p.detail ? String(p.detail).slice(0, 160) : undefined,
    score: num(p.score), confidence: num(p.confidence), band: p.band ?? undefined, plan: p.plan ?? undefined,
    expected: p.expected ?? undefined, expectedExcess: p.expectedExcess ?? undefined, flags: p.flags ?? undefined,
    partial: p.partial ? true : undefined,
    version: modelVersion(), recordedAt: new Date().toISOString(),
  };
  const prev = state.last.get(keyOf(item));
  const same = prev && prev.version === item.version && ['direction', 'label', 'score', 'confidence', 'partial']
    .every((k) => (prev[k] ?? null) === (item[k] ?? null))
    && ['plan', 'expected', 'expectedExcess', 'flags'].every((k) => JSON.stringify(prev[k] ?? null) === JSON.stringify(item[k] ?? null));
  if (same) return;
  state.items.push(item);
  state.last.set(keyOf(item), item);
  buffer.push(`${JSON.stringify(item)}\n`);
  uncache('pred-eval');
  uncache('pred-scored');
  uncache('verify');
  timer ??= setTimeout(flushPredictions, 1000);
  timer.unref?.();
}

export function recordMany(list) {
  return Promise.all(list.map((p) => recordPrediction(p).catch(() => {})));
}

/** Toàn bộ sổ (đọc từ bộ nhớ), dùng cho đồng bộ database. */
export async function predictionLog() {
  return (await load()).items;
}

/** Hạn ghi của dự đoán phiên `date`: 9:00 giờ VN (02:00 UTC) phiên kế tiếp; null nếu chưa có phiên kế tiếp. */
export function entryCutoff(nextDate) {
  return nextDate ? `${nextDate}T02:00:00.000Z` : null;
}

/**
 * Bản ghi được chấm cho mỗi (nguồn, mã, phiên): bản cuối cùng ghi trước hạn (sổ theo thứ tự ghi nên bản sau đè bản trước).
 * @param {object[]} items
 * @param {(date: string) => string|null} nextSession phiên kế tiếp của một phiên (theo lịch VN-Index)
 * @returns {{ items: object[], late: Record<string, number> }}
 */
export function canonicalItems(items, nextSession) {
  const by = new Map();
  const late = {};
  for (const it of items) {
    const cut = entryCutoff(nextSession(it.date));
    if (cut && it.recordedAt && it.recordedAt >= cut) { late[it.source] = (late[it.source] || 0) + 1; continue; }
    by.set(keyOf(it), it);
  }
  return { items: [...by.values()], late };
}

// Giá vào lệnh: mở cửa phiên sau; chuỗi không có giá mở cửa thì dùng đóng cửa phiên tín hiệu
const entryAt = (bars, k) => (bars[k + 1]?.open > 0 ? bars[k + 1].open : bars[k]?.close);

/**
 * Lãi trung bình đồng tỷ trọng của cả rổ, cùng cách tính với từng dự đoán (mua mở cửa phiên sau `date`, bán đóng cửa
 * phiên thứ h): thước đo công bằng hơn VN-Index khi vài mã vốn hóa lớn kéo chỉ số.
 * @returns {(date: string, h: number) => number|null}
 */
export function basketReturns(barsBySymbol, indexBars, minCount = 20) {
  const maps = Object.values(barsBySymbol).filter(Boolean).map((bars) => new Map(bars.map((b) => [b.time, b])));
  const pos = new Map(indexBars.map((b, k) => [b.time, k]));
  const memo = new Map();
  return (date, h) => {
    const key = `${date}|${h}`;
    if (memo.has(key)) return memo.get(key);
    const j = pos.get(date);
    const next = j == null ? null : indexBars[j + 1]?.time;
    const end = j == null ? null : indexBars[j + h]?.time;
    let sum = 0, n = 0;
    if (next && end) for (const m of maps) {
      const a0 = m.get(date), a1 = m.get(next), b = m.get(end);
      const entry = a1?.open > 0 ? a1.open : a0?.close;
      if (entry > 0 && b?.close > 0) { sum += b.close / entry - 1; n++; }
    }
    const v = n >= minCount ? sum / n : null;
    memo.set(key, v);
    return v;
  };
}

/**
 * Chấm một dự đoán với chuỗi giá của mã, VN-Index và (tuỳ chọn) lãi rổ đồng tỷ trọng.
 * Mã ngừng giao dịch hẳn trước khi đủ h phiên: thoát ở giá cuối trừ DELIST_HAIRCUT (delisted: true).
 */
export function scoreItem(item, bars, indexBars, basket = null) {
  const i = bars.findIndex((b) => b.time === item.date);
  if (i < 0) return null;
  const j = indexBars.findIndex((b) => b.time === item.date);
  const out = {};
  const beat = (ret, ref) => (item.direction && ref != null ? (item.direction > 0 ? ret > ref : ret < ref) : null);
  // Phiên cuối của mã nằm ở đâu trên lịch VN-Index: cách cuối lịch ≥ DELIST_GAP phiên thì coi là đã ngừng giao dịch
  const lastPos = indexBars.findIndex((b) => b.time === bars.at(-1).time);
  const stopped = lastPos >= 0 && indexBars.length - 1 - lastPos >= DELIST_GAP;
  for (const h of HORIZONS) {
    const entry = entryAt(bars, i);
    let exit = i + h < bars.length ? bars[i + h].close : null, delisted = false;
    if (exit == null && stopped && j >= 0 && j + h < indexBars.length && i + 1 < bars.length) {
      exit = bars.at(-1).close * (1 - DELIST_HAIRCUT);
      delisted = true;
    }
    if (exit == null || !(entry > 0)) continue;
    const ret = exit / entry - 1;
    const iret = j >= 0 && j + h < indexBars.length ? indexBars[j + h].close / entryAt(indexBars, j) - 1 : null;
    const bret = basket?.(item.date, h) ?? null;
    out[h] = {
      exit, ret, excess: iret == null ? null : ret - iret,
      excessBasket: bret == null ? null : ret - bret,
      correct: item.direction ? Math.sign(ret) === item.direction : null,
      beatIndex: beat(ret, iret),
      beatBasket: beat(ret, bret),
      ...(delisted ? { delisted } : {}),
    };
  }
  return out;
}

/**
 * Các bản ghi được chấm kèm kết quả 5/10/20 phiên (cache 10 phút), dùng chung cho bảng độ chính xác và kiểm chứng (verify.js).
 * @returns {Promise<{ scored: object[], late: Record<string, number>, bars: Record<string, object[]|null>, index: object[] }>}
 */
export function scoredPredictions() {
  return cached('pred-scored', 10 * 60_000, async () => {
    await load();
    const indexRes = await getPriceHistory('VNINDEX').catch(() => null);
    const idx = indexRes?.bars || [];
    const at = new Map(idx.map((b, k) => [b.time, k]));
    const { items, late } = canonicalItems(state.items, (d) => (at.has(d) ? idx[at.get(d) + 1]?.time ?? null : null));
    const syms = [...new Set(items.map((x) => x.symbol))];
    const bars = {};
    for (let k = 0; k < syms.length; k += 6) {
      await Promise.all(syms.slice(k, k + 6).map(async (s) => {
        bars[s] = (await getPriceHistory(s).catch(() => null))?.bars || null;
      }));
    }
    const basket = basketReturns(bars, idx);
    const scored = items.map((it) => ({ ...it, result: bars[it.symbol] ? scoreItem(it, bars[it.symbol], idx, basket) : null }));
    return { scored, late, bars, index: idx, basket };
  });
}

export const PLAN_RULES = { fillDays: 5, horizonDays: 20 };

/**
 * Chấm một kế hoạch lệnh (plan) như người dùng làm theo: lệnh mua giới hạn ở cận trên vùng mua (không có vùng thì giá mở cửa
 * phiên sau), hiệu lực PLAN_RULES.fillDays phiên; khớp rồi thì ĐÓNG CỬA dưới cắt lỗ → bán mở cửa phiên sau, giá cao nhất
 * chạm mục tiêu → bán ở mục tiêu (mở cửa vượt thì giá mở cửa), hết horizonDays phiên → bán giá đóng cửa.
 * Cùng phiên chạm mục tiêu và đóng cửa dưới cắt lỗ thì tính cắt lỗ (thận trọng).
 * @returns {{ outcome: 'no_fill'|'stop'|'target'|'time', entry?, exit?, ret?, days?, targetPct?, stopPct? }|null} null = chưa đủ phiên
 */
export function scorePlan(item, bars, R = PLAN_RULES) {
  const p = item.plan;
  if (!p?.target || !p?.stop) return null;
  const i = bars.findIndex((b) => b.time === item.date);
  if (i < 0) return null;
  const limit = p.buyTo ?? p.entryTo ?? null;
  let f = -1, entry = null;
  for (let k = i + 1; k <= i + R.fillDays && k < bars.length; k++) {
    const b = bars[k];
    if (limit == null) { f = k; entry = b.open > 0 ? b.open : bars[k - 1].close; break; }
    if (b.low <= limit) { f = k; entry = Math.min(b.open, limit); break; }
  }
  if (f < 0) return i + R.fillDays < bars.length ? { outcome: 'no_fill' } : null;
  const H = Math.max(1, Math.round(p.horizonDays || R.horizonDays));
  const base = { entry, targetPct: p.target / entry - 1, stopPct: p.stop / entry - 1 };
  for (let k = f; k < f + H && k < bars.length; k++) {
    const b = bars[k];
    if (b.close < p.stop) {
      if (k + 1 >= bars.length) return null; // chưa có phiên bán
      const exit = bars[k + 1].open;
      return { ...base, outcome: 'stop', exit, ret: exit / entry - 1, days: k + 1 - f };
    }
    if (b.high >= p.target) {
      const exit = Math.max(b.open, p.target);
      return { ...base, outcome: 'target', exit, ret: exit / entry - 1, days: k - f };
    }
  }
  if (f + H - 1 >= bars.length) return null;
  const exit = bars[f + H - 1].close;
  return { ...base, outcome: 'time', exit, ret: exit / entry - 1, days: H };
}

/** Tổng hợp độ chính xác theo nguồn và khung thời gian (cache 10 phút). */
export function evaluatePredictions() {
  return cached('pred-eval', 10 * 60_000, async () => {
    const { scored, late, bars } = await scoredPredictions();
    const items = scored;

    const summary = Object.entries(SOURCES).filter(([source]) => source !== 'funnel').map(([source, label]) => {
      const mine = scored.filter((x) => x.source === source);
      const horizons = HORIZONS.map((h) => {
        const done = mine.filter((x) => x.direction && x.result?.[h]);
        const buys = done.filter((x) => x.direction > 0), sells = done.filter((x) => x.direction < 0);
        const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);
        const rate = (k) => {
          const has = done.filter((x) => x.result[h][k] != null);
          return has.length ? has.filter((x) => x.result[h][k]).length / has.length : null;
        };
        return {
          h,
          evaluated: done.length,
          delisted: done.filter((x) => x.result[h].delisted).length,
          hitRate: done.length ? done.filter((x) => x.result[h].correct).length / done.length : null,
          beatIndexRate: rate('beatIndex'),
          beatBasketRate: rate('beatBasket'),
          buyCount: buys.length, sellCount: sells.length,
          buyAvgReturn: avg(buys, (x) => x.result[h].ret),
          sellAvgReturn: avg(sells, (x) => x.result[h].ret),
          // Tín hiệu xếp hạng là tương đối (mua = hơn thị trường, tránh = kém thị trường) nên chấm chính theo VN-Index
          buyAvgExcess: avg(buys.filter((x) => x.result[h].excess != null), (x) => x.result[h].excess),
          sellAvgExcess: avg(sells.filter((x) => x.result[h].excess != null), (x) => x.result[h].excess),
          buyAvgExcessBasket: avg(buys.filter((x) => x.result[h].excessBasket != null), (x) => x.result[h].excessBasket),
          sellAvgExcessBasket: avg(sells.filter((x) => x.result[h].excessBasket != null), (x) => x.result[h].excessBasket),
        };
      });
      return {
        source, label,
        total: mine.length,
        directional: mine.filter((x) => x.direction).length,
        pending: mine.filter((x) => x.direction && bars[x.symbol] && !x.result?.[HORIZONS[0]]).length,
        late: late[source] || 0,
        missingPrice: mine.filter((x) => x.direction && !bars[x.symbol]).length,
        versions: [...new Set(mine.map((x) => x.version || 'legacy'))],
        horizons,
      };
    });
    const recent = scored.slice().sort((a, b) => b.date.localeCompare(a.date) || String(b.recordedAt).localeCompare(String(a.recordedAt))).slice(0, 80)
      .map((x) => ({ ...x, at: x.recordedAt }));
    return {
      updatedAt: new Date().toISOString(),
      method: 'Mua giá mở cửa phiên sau ngày dự đoán, bán giá đóng cửa phiên thứ h; mỗi mã/phiên lấy bản ghi cuối cùng trước 9:00 phiên sau.',
      totalItems: (await load()).items.length, scoredItems: items.length,
      firstDate: items.reduce((m, x) => (!m || x.date < m ? x.date : m), null),
      summary, recent,
    };
  });
}
