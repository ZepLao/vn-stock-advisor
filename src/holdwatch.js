// Theo dõi mã ĐANG NẮM GIỮ trong phiên: cứ HOLDWATCH_MINUTES phút (mặc định 5) xem giá các mã trong danh mục và báo
// ngay qua Telegram + danh sách cảnh báo trong app khi: thủng / sát mức cắt lỗ, chạm mức chốt lời, giảm hoặc tăng
// mạnh trong ngày (kể cả sát giá sàn / trần). Mức cắt lỗ và chốt lời giống bản tin (holdingLine: lãi ≥ 10% thì cắt lỗ
// nâng lên giá vốn), chốt một lần mỗi ngày ở lượt đầu tiên để không trôi theo giá trong phiên.
// Mỗi loại cảnh báo chỉ gửi một lần mỗi mã mỗi ngày; nhiều mức cùng lúc thì chỉ báo mức nặng nhất.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSymbol } from './analyze.js';
import { getPriceHistory } from './data.js';
import { heldSymbols } from './portfolio.js';
import { pushAlert } from './tracker.js';
import { telegramConfig, sendMessage, esc, num, sgn } from './telegram.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'holdwatch.json');

export const HOLD_RULES = {
  minutes: Number(process.env.HOLDWATCH_MINUTES) || 5,
  nearStop: 0.015, // cách mức cắt lỗ ≤ 1,5%
  // Biến động trong ngày so với giá tham chiếu; mức cuối ≈ sát sàn / trần HOSE (±7%)
  drops: [{ at: -0.03, key: 'drop3' }, { at: -0.05, key: 'drop5' }, { at: -0.065, key: 'floor' }],
  rises: [{ at: 0.04, key: 'rise4' }, { at: 0.065, key: 'ceil' }],
};

const vnNow = (now = new Date()) => new Date(now.getTime() + 7 * 3600_000);

/** Khung theo dõi: 9:15–14:50 thứ 2–6 (gồm ATC, bỏ ATO). */
export function holdWindow(now = new Date()) {
  const vn = vnNow(now);
  const day = vn.getUTCDay(), m = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 + 15 && m <= 14 * 60 + 50;
}

/** Mức cắt lỗ / chốt lời cho người đang giữ, như bản tin. */
export function holdLevels(a) {
  const L = a.brief?.levels, h = a.holding;
  if (!L || !h) return null;
  // Quy tắc không cắt lỗ sát, không chốt lời theo mục tiêu: chỉ ngưỡng cảnh báo xa −15% giá vốn (brief.js / tradeplan.js)
  return { stop: L.holdStop ?? L.stop ?? null, target: null };
}

/**
 * Cảnh báo cần gửi cho một mã (hàm thuần). `sent`: các khóa đã gửi hôm nay.
 * @returns {{ keys: string[], tone: 'down'|'warn'|'up', text: string }[]}
 */
export function holdingEvents({ close, prevClose, stop, target, chandelierStop }, sent = [], R = HOLD_RULES) {
  const out = [];
  const fresh = (k) => !sent.includes(k);
  if (stop != null && close < stop) {
    if (fresh('stop')) out.push({ keys: ['stop', 'nearStop'], tone: 'down', text: `⚠️ Dưới ngưỡng cảnh báo ${num(stop)} (−15% giá vốn) → <b>xem lại lý do nắm giữ</b>` });
  } else if (stop != null && close <= stop * (1 + R.nearStop) && fresh('nearStop')) {
    out.push({ keys: ['nearStop'], tone: 'warn', text: `⚠️ Sát cắt lỗ ${num(stop)} (còn ${sgn((stop / close - 1) * 100)}) → chuẩn bị bán nếu thủng` });
  } else if (chandelierStop != null && close < chandelierStop && fresh('chandelier')) {
    out.push({ keys: ['chandelier'], tone: 'warn', text: `🟡 Thủng Chandelier Trailing Stop ${num(chandelierStop)} → chốt phần còn lại để bảo toàn lãi` });
  }
  if (target != null && close >= target && fresh('target')) {
    out.push({ keys: ['target'], tone: 'up', text: `🟢 Chạm chốt lời ${num(target)} → <b>chốt 1/3</b>, nâng cắt lỗ` });
  }
  const chg = prevClose ? close / prevClose - 1 : null;
  if (chg != null) {
    const pick = (levels, hit) => {
      const crossed = levels.filter((l) => hit(l.at));
      const worst = crossed.at(-1);
      return worst && fresh(worst.key) ? { worst, keys: crossed.map((l) => l.key) } : null;
    };
    const d = pick(R.drops, (at) => chg <= at);
    if (d) out.push({ keys: d.keys, tone: 'down', text: d.worst.key === 'floor' ? `📉 Sát giá sàn (${sgn(chg * 100)} hôm nay)` : `📉 Giảm mạnh ${sgn(chg * 100)} hôm nay` });
    const u = pick(R.rises, (at) => chg >= at);
    if (u) out.push({ keys: u.keys, tone: 'up', text: u.worst.key === 'ceil' ? `🚀 Sát giá trần (${sgn(chg * 100)} hôm nay)` : `📈 Tăng mạnh ${sgn(chg * 100)} hôm nay` });
  }
  return out;
}

let state = null;
async function load(today) {
  if (!state) state = await readFile(FILE, 'utf8').then(JSON.parse).catch(() => ({}));
  if (state.date !== today) state = { date: today, sent: {}, levels: {} };
  return state;
}
async function save() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(state, null, 2), 'utf8');
}

let busy = false;

/** Một lượt kiểm tra. Trả về các cảnh báo đã gửi. */
export async function holdTick({ force = false } = {}) {
  if (busy || (!force && !holdWindow())) return [];
  busy = true;
  try {
    const today = vnNow().toISOString().slice(0, 10);
    const st = await load(today);
    const syms = await heldSymbols();
    const lines = [];
    for (const symbol of syms) {
      const bars = (await getPriceHistory(symbol).catch(() => null))?.bars;
      const last = bars?.at(-1);
      if (!last || last.time !== today) continue; // chưa có giá phiên hôm nay
      const prevClose = bars.at(-2)?.close;
      let lv = st.levels[symbol];
      if (!lv) {
        const a = await analyzeSymbol(symbol, { withChart: false }).catch(() => null);
        if (!a?.holding) continue;
        lv = st.levels[symbol] = { ...holdLevels(a), avgCost: a.holding.avgCost, qty: a.holding.qty, sellable: a.holding.sellable };
      }
      const sent = st.sent[symbol] ||= [];
      const ev = holdingEvents({ close: last.close, prevClose, stop: lv.stop, target: lv.target }, sent);
      if (!ev.length) continue;
      for (const e of ev) sent.push(...e.keys.filter((k) => !sent.includes(k)));
      const pnl = lv.avgCost ? (last.close / lv.avgCost - 1) * 100 : null;
      const chg = prevClose ? (last.close / prevClose - 1) * 100 : null;
      const head = `▸ <b>${esc(symbol)}</b>  <b>${num(last.close)}</b>  ${sgn(chg)}`
        + `${pnl != null ? ` · ${pnl >= 0 ? 'lãi' : 'lỗ'} <b>${sgn(pnl)}</b> (vốn ${num(lv.avgCost)})` : ''}`;
      const qty = lv.qty ? `\n  💼 Đang giữ <b>${num(lv.qty, 0)}</b> cp${lv.sellable < lv.qty ? ` (khả dụng ${num(lv.sellable, 0)})` : ''}` : '';
      lines.push(`${head}\n${ev.map((e) => `  👉 ${e.text}`).join('\n')}${qty}`);
      for (const e of ev) await pushAlert(symbol, 'holding', `${e.text.replace(/<[^>]+>/g, '')} · giá ${last.close}`).catch(() => {});
    }
    await save();
    if (lines.length && telegramConfig().enabled) {
      const time = vnNow().toISOString().slice(11, 16);
      await sendMessage([`⚡ <b>CẢNH BÁO DANH MỤC</b> · <code>${time}</code>`, '━━━━━━━━━━━━━━━━━━━━', ...lines].join('\n\n'));
    }
    return lines;
  } finally {
    busy = false;
  }
}

export function startHoldWatch() {
  if (process.env.HOLDWATCH === '0') return null;
  const run = () => holdTick()
    .then((l) => l.length && console.log(`[Danh mục] Đã gửi ${l.length} cảnh báo`))
    .catch((err) => console.error('[Danh mục] Lỗi theo dõi:', err.message));
  return setInterval(run, HOLD_RULES.minutes * 60_000);
}
