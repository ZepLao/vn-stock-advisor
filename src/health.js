// Tự kiểm tra sức khỏe và báo qua Telegram khi có sự cố (chạy ngầm cùng server):
//  - database không kết nối được (dữ liệu, lịch sử bản tin không được lưu);
//  - nguồn giá không trả dữ liệu (mọi phân tích dựa vào giá);
//  - ngày giao dịch đã qua 15:30 mà tool tự đầu tư chưa xử lý phiên hôm đó.
// Mỗi sự cố báo một lần khi bắt đầu và một lần khi đã ổn lại, không lặp tin.
import { dbConfig, query } from './db.js';
import { fetchJson } from './http.js';

export const HEALTH_RULES = { minutes: 10, autotradeLate: 15 * 60 + 30 };

const vnNow = (now = new Date()) => {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  return { date: vn.toISOString().slice(0, 10), minutes: vn.getUTCHours() * 60 + vn.getUTCMinutes(), dow: vn.getUTCDay() };
};

/**
 * Đối chiếu kết quả kiểm tra với trạng thái trước (hàm thuần): trả về tin cần gửi và trạng thái mới.
 * @param {Record<string, { ok: boolean, detail?: string, label: string }>} checks
 * @param {Record<string, boolean>} prev  key → đang lỗi
 */
export function healthMessages(checks, prev = {}) {
  const next = { ...prev }, out = [];
  for (const [key, c] of Object.entries(checks)) {
    if (c.ok == null) continue; // không áp dụng lúc này
    const was = !!prev[key];
    if (!c.ok && !was) out.push(`⚠️ <b>${c.label}</b>: ${c.detail || 'lỗi'}`);
    if (c.ok && was) out.push(`✅ <b>${c.label}</b>: đã hoạt động lại`);
    next[key] = !c.ok;
  }
  return { messages: out, state: next };
}

/** Tool tự đầu tư đã xử lý phiên hôm nay chưa (hàm thuần): chỉ xét ngày có phiên, sau giờ HEALTH_RULES.autotradeLate. */
export function autotradeCheck({ now, lastIndexDate, lastProcessed, opened }, R = HEALTH_RULES) {
  const t = vnNow(now);
  if (!opened || lastIndexDate !== t.date || t.minutes < R.autotradeLate) return { ok: null };
  return lastProcessed === t.date
    ? { ok: true }
    : { ok: false, detail: `đã ${Math.floor(t.minutes / 60)}:${String(t.minutes % 60).padStart(2, '0')} mà chưa xử lý phiên ${t.date.split('-').reverse().join('/')} (phiên gần nhất đã xử lý: ${lastProcessed ? lastProcessed.split('-').reverse().join('/') : 'chưa có'})` };
}

async function runChecks() {
  const checks = {};
  if (dbConfig().enabled) {
    try { await query('SELECT 1'); checks.db = { ok: true, label: 'Database' }; }
    catch (err) { checks.db = { ok: false, label: 'Database', detail: `không kết nối được (${err.code || err.message}). Bật lại: docker start vnstock-db` }; }
  }
  // Nguồn giá: gọi thẳng VNDirect (không qua bộ đệm) lấy vài phiên VN-Index
  let lastIndexDate = null;
  try {
    const to = Math.floor(Date.now() / 1000);
    const r = await fetchJson(`https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=VNINDEX&from=${to - 10 * 86400}&to=${to}`, { timeout: 20000 });
    const t = r?.t || [];
    if (!t.length) throw new Error('không có dữ liệu');
    lastIndexDate = new Date(t.at(-1) * 1000 + 7 * 3600_000).toISOString().slice(0, 10);
    checks.price = { ok: true, label: 'Nguồn giá VNDirect' };
  } catch (err) {
    checks.price = { ok: false, label: 'Nguồn giá VNDirect', detail: `${err.message}. Tool tự chuyển sang nguồn dự phòng nếu có` };
  }
  try {
    const { getAutoTrade } = await import('./autotrade.js');
    const at = await getAutoTrade();
    checks.autotrade = { label: 'Tool tự đầu tư', ...autotradeCheck({ now: new Date(), lastIndexDate, lastProcessed: at?.lastDate, opened: !!at?.opened }) };
  } catch (err) {
    checks.autotrade = { ok: false, label: 'Tool tự đầu tư', detail: err.message };
  }
  return checks;
}

let state = {};
/** Kiểm tra mỗi `minutes` phút; `send` = gửi Telegram (null thì chỉ ghi log). */
export function startHealthWatch(send, R = HEALTH_RULES) {
  const tick = async () => {
    try {
      const { messages, state: next } = healthMessages(await runChecks(), state);
      state = next;
      if (!messages.length) return;
      const text = ['🩺 <b>KIỂM TRA TOOL</b>', ...messages].join('\n');
      console.warn(`[Sức khỏe] ${messages.join(' | ').replace(/<[^>]+>/g, '')}`);
      if (send) await send(text).catch((err) => console.error('[Sức khỏe] Lỗi gửi Telegram:', err.message));
    } catch (err) {
      console.error('[Sức khỏe] Lỗi kiểm tra:', err.message);
    }
  };
  setTimeout(tick, 60_000);
  return setInterval(tick, R.minutes * 60_000);
}
