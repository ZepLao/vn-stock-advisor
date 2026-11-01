// Sổ sự kiện tin tức (data/news_events.jsonl, chỉ ghi thêm): mỗi tin về một mã ghi một lần kèm giờ đăng, nhãn tốt/xấu
// (từ khóa, AI đọc lại nếu có), nhóm sự kiện và cờ rủi ro. Nguồn tin công khai chỉ giữ ~30 ngày nên phải tích lũy dần
// mới đo được tác động của tin.
//
// Đo tác động (event study, scoreNewsEvent): phiên sự kiện = phiên đầu tiên MỞ CỬA SAU giờ đăng (tin đăng trong giờ giao dịch
// tính từ phiên sau, vì lúc đó mới mua/bán được theo tin). Lãi bất thường h phiên = lãi của mã (mua mở cửa phiên sự kiện,
// bán đóng cửa phiên thứ h) − lãi rổ chia đều cùng cửa sổ. Kèm "gap" = biến động từ đóng cửa phiên trước đến mở cửa phiên
// sự kiện, để biết giá đã phản ánh tin trước khi kịp mua chưa.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = process.env.NEWS_EVENTS_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'news_events.jsonl');
export const NEWS_HORIZONS = [1, 5, 20];

let state = null;
let loading = null;
let saving = Promise.resolve();

function load() {
  loading ??= readFile(FILE, 'utf8').catch(() => '').then((text) => {
    const items = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch { /* dòng ghi dở */ }
    }
    state = { items, ids: new Set(items.map((x) => x.id)) };
    return state;
  });
  return loading;
}

const idOf = (symbol, it) => createHash('sha1').update(`${symbol}|${it.link || it.title}`).digest('hex').slice(0, 16);

/** Ghi các tin chưa có của một mã (bỏ tin không có giờ đăng: không xác định được phiên sự kiện). */
export async function recordNewsEvents(symbol, items) {
  await load();
  const add = [];
  for (const it of items || []) {
    if (!it.publishedAt || !(it.link || it.title)) continue;
    const id = idOf(symbol, it);
    if (state.ids.has(id)) continue;
    state.ids.add(id);
    add.push({
      id, symbol, title: String(it.title || '').slice(0, 200), link: it.link || null, source: it.source || null,
      publishedAt: new Date(it.publishedAt).toISOString(), label: it.label, sentiment: it.sentiment ?? null,
      categories: it.categories || [], aiLabel: it.ai?.label ?? null, aiRisk: it.ai?.risk ?? null, recordedAt: new Date().toISOString(),
    });
  }
  if (!add.length) return 0;
  state.items.push(...add);
  saving = saving.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await appendFile(FILE, add.map((x) => `${JSON.stringify(x)}\n`).join(''), 'utf8');
  }).catch((err) => console.error('Lỗi ghi sổ tin tức:', err.message));
  await saving;
  return add.length;
}

export async function newsEvents() {
  return (await load()).items;
}

/**
 * Lãi bất thường sau một tin (hàm thuần).
 * @param {object} ev sự kiện (publishedAt ISO)
 * @param {object[]} bars chuỗi giá của mã
 * @param {object[]} index lịch phiên VN-Index
 * @param {(date: string, h: number) => number|null} basket lãi rổ (predictions.basketReturns: mua mở cửa phiên SAU `date`)
 * @returns {{ session: string, gap: number|null, [h]: { ret, abnormal } } | null}
 */
export function scoreNewsEvent(ev, bars, index, basket) {
  const e = bars.findIndex((b) => `${b.time}T02:00:00.000Z` > ev.publishedAt);
  if (e < 1) return null;
  const entry = bars[e].open > 0 ? bars[e].open : bars[e - 1].close;
  const pos = index.findIndex((b) => b.time === bars[e].time);
  const prevDate = pos > 0 ? index[pos - 1].time : null;
  const out = { session: bars[e].time, gap: bars[e].open > 0 ? bars[e].open / bars[e - 1].close - 1 : null };
  for (const h of NEWS_HORIZONS) {
    if (e + h - 1 >= bars.length) continue;
    const ret = bars[e + h - 1].close / entry - 1;
    const b = prevDate ? basket(prevDate, h) : null;
    out[h] = { ret, abnormal: b == null ? null : ret - b };
  }
  return out;
}
