// Nhận lệnh từ Telegram: nhắn "mua HPG 1000 25.5 21/10" hoặc "bán VPB 500 24.2" để ghi giao dịch vào danh mục,
// "danh mục" để xem danh mục, "hoàn tác" để xóa giao dịch vừa thêm qua bot. Chỉ nhận tin từ đúng TELEGRAM_CHAT_ID.
// Dùng long polling (getUpdates), không cần mở cổng ra internet.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, sendMessage, telegramConfig } from './telegram.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'telegrambot.json');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d }));

export const HELP = [
  '🤖 <b>TRỢ LÝ CHỨNG KHOÁN (VN-STOCK BOT)</b>',
  '━━━━━━━━━━━━━━━━━━━━',
  '📝 <b>Ghi nhận giao dịch vào danh mục:</b>',
  '• <code>mua HPG 1000 25.5 21/10</code>',
  '• <code>bán VPB 500 24.2</code>',
  '<i>(Cú pháp: mua/bán [mã] [số lượng] [giá] [ngày])</i>',
  '',
  '💵 <b>Quản lý vốn:</b>',
  '• <code>nạp 50tr</code> · <code>rút 10tr</code> · <code>cổ tức 1,2tr</code>',
  '• <code>số dư 80tr</code> — đặt số dư tiền theo công ty chứng khoán',
  '• <code>vốn</code> — tổng tài sản, tiền mặt, số mã nên giữ',
  '',
  '⚡ <b>Lệnh tra cứu nhanh:</b>',
  '• <code>danh mục</code> — Xem danh mục nắm giữ & lãi/lỗ',
  '• <code>tuần</code> — Xem triển vọng thị trường tuần (AI)',
  '• <code>hoàn tác</code> — Xóa giao dịch / dòng tiền vừa ghi qua bot',
].join('\n');

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/** Số lượng: "1000", "1.000", "1,000", "1k" → 1000. */
function parseQty(t) {
  const s = t.toLowerCase().replace(/cp$/, '');
  if (/^\d+(\.\d+)?k$/.test(s)) return Math.round(parseFloat(s) * 1000);
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/** Giá nghìn đồng: "25.5", "25,5" → 25.5; "25500" hoặc "25.500" (đồng) → 25.5. */
function parsePrice(t) {
  let s = t.toLowerCase().replace(/(k|đ|d)$/, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s) && Number(s.replace(/[.,]/g, '')) >= 1000) return Number(s.replace(/[.,]/g, '')) / 1000;
  s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const v = Number(s);
  return v >= 1000 ? v / 1000 : v;
}

/** Ngày: "21/10", "21/10/2026", "21-10-26", "2026-10-21", "hôm nay", "hqua" → YYYY-MM-DD. */
function parseDate(t, today) {
  const y0 = Number(today.slice(0, 4));
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return fmtDate(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (!m) return null;
  let y = m[3] ? Number(m[3]) : y0;
  if (y < 100) y += 2000;
  return fmtDate(y, +m[2], +m[1]);
}
function fmtDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Số tiền (đồng): "50tr", "50 triệu", "1,5 tỷ", "500k", "50000000", "50.000.000" → số đồng; NaN nếu không đọc được. */
export function parseAmount(t) {
  const m = strip(String(t || '')).replace(/\s+/g, '').match(/^(\d+(?:[.,]\d+)*)(tr|trieu|m|ty|ti|b|k|nghin|ngan|d|dong|vnd)?$/);
  if (!m) return NaN;
  let n = m[1];
  const unit = m[2] || '';
  // "50.000.000" / "1,000,000": dấu ngăn nghìn; "1,5" / "1.5": thập phân
  if (/^\d{1,3}([.,]\d{3})+$/.test(n) && !unit) n = n.replace(/[.,]/g, '');
  else n = n.replace(',', '.');
  const v = Number(n);
  if (!Number.isFinite(v)) return NaN;
  const mul = /^(tr|trieu|m)$/.test(unit) ? 1e6 : /^(ty|ti|b)$/.test(unit) ? 1e9 : /^(k|nghin|ngan)$/.test(unit) ? 1e3 : 1;
  return Math.round(v * mul);
}

const CASH_CMD = [[/^(nap|nap tien|deposit)\b/, 'DEPOSIT'], [/^(rut|rut tien|withdraw)\b/, 'WITHDRAW'], [/^(co tuc|cotuc|dividend)\b/, 'DIVIDEND'], [/^(so du|sodu|dat so du|balance)\b/, 'SET']];

/**
 * Đọc tin nhắn thành lệnh.
 * @returns {{ cmd: 'trade', type: 'BUY'|'SELL', symbol, qty, price, date } | { cmd: 'portfolio'|'undo'|'help' } | { cmd: 'error', error } | null}
 */
export function parseCommand(text, today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const plain = strip(raw).replace(/^\//, '');
  if (/^(help|start|huong dan|\?)\b/.test(plain)) return { cmd: 'help' };
  if (/^(danh muc|dm|portfolio)\b/.test(plain)) return { cmd: 'portfolio' };
  if (/^(tuan|xu huong|trien vong|outlook)\b/.test(plain)) return { cmd: 'outlook' };
  if (/^(hoan tac|undo|xoa)\b/.test(plain)) return { cmd: 'undo' };
  if (/^(von|tien|tien mat|tai san|capital)$/.test(plain)) return { cmd: 'capital' };
  for (const [re, type] of CASH_CMD) {
    const m = plain.match(re);
    if (!m) continue;
    const parts = raw.split(/\s+/).slice(m[0].split(' ').length);
    const dIdx = parts.findIndex((x) => /^\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?$/.test(x));
    const date = dIdx >= 0 ? parseDate(parts[dIdx], today) : today;
    if (!date) return { cmd: 'error', error: `Ngày "${parts[dIdx]}" không hợp lệ (vd 21/10).` };
    const amount = parseAmount(parts.filter((_, i) => i !== dIdx).join(''));
    if (!(amount >= (type === 'SET' ? 0 : 1))) return { cmd: 'error', error: 'Số tiền không hợp lệ (vd 50tr, 1,5 tỷ, 50000000).' };
    return { cmd: 'cash', type, amount, date };
  }

  // "mua HPG …" hoặc "HPG mua …"; tách dấu ":" "," cuối từ
  const tokens = raw.replace(/[:;]/g, ' ').split(/\s+/).map((x) => x.replace(/,$/, '')).filter(Boolean);
  const act = tokens.findIndex((x, i) => i <= 1 && /^(mua|buy|ban|sell)$/.test(strip(x)));
  if (act < 0) return null;
  const type = /^(mua|buy)$/.test(strip(tokens[act])) ? 'BUY' : 'SELL';
  const rest = tokens.filter((_, i) => i !== act);
  const FILLER = /^(cp|co|phieu|ma|ngay|luc|voi|khoi|luong|so)$/;
  const PRICE_TAG = /^(gia|@|price)$/, QTY_TAG = /^(sl|kl|x|qty)$/;

  let symbol = null, date = today, qty = null, price = null;
  const nums = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i], s = strip(t);
    if (FILLER.test(s)) continue;
    if (s === 'hom' && strip(rest[i + 1] || '') === 'nay') { i++; continue; }
    if (s === 'homnay') continue;
    if (PRICE_TAG.test(s) || QTY_TAG.test(s)) {
      const v = rest[i + 1];
      if (v == null) continue;
      if (PRICE_TAG.test(s)) price = parsePrice(v); else qty = parseQty(v);
      i++;
      continue;
    }
    if (!symbol && /^[A-Za-z][A-Za-z0-9]{2}$/.test(t)) { symbol = t.toUpperCase(); continue; }
    if (/^\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?$/.test(t)) {
      date = parseDate(t, today);
      if (!date) return { cmd: 'error', error: `Ngày "${t}" không hợp lệ (vd 21/10 hoặc 21/10/2026).` };
      continue;
    }
    nums.push(t);
  }
  if (!symbol) return { cmd: 'error', error: 'Không thấy mã cổ phiếu (3 ký tự, vd HPG).' };
  // Số không có nhãn: số lượng trước, giá sau; nếu viết ngược (giá có phần thập phân, số lượng tròn trăm) thì đổi lại
  if (qty == null && price == null && nums.length >= 2) {
    let [q, p] = nums;
    if (/[.,]\d{1,2}$/.test(q) && parseQty(p) >= 100 && parseQty(p) % 100 === 0) [q, p] = [p, q];
    qty = parseQty(q); price = parsePrice(p);
  } else if (qty == null && nums.length) qty = parseQty(nums[0]);
  else if (price == null && nums.length) price = parsePrice(nums[0]);
  if (qty == null || price == null) return { cmd: 'error', error: 'Thiếu số lượng hoặc giá.' };
  if (!(qty > 0)) return { cmd: 'error', error: 'Số lượng không hợp lệ.' };
  if (!(price > 0)) return { cmd: 'error', error: 'Giá không hợp lệ.' };
  return { cmd: 'trade', type, symbol, qty, price, date };
}

// ---------- Xử lý ----------
let st = null;
async function loadState() {
  if (st) return st;
  try { st = JSON.parse(await readFile(FILE, 'utf8')); } catch { st = {}; }
  st.added ??= [];
  return st;
}
async function saveState() {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(st), 'utf8');
}

const ddmmyyyy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

const tr = (v) => `${num(v / 1e6, 1)} tr`;

/** Tóm tắt vốn cho bot. */
export function capitalText(c) {
  if (!c || c.source !== 'portfolio') return '💵 Chưa nhập vốn. Nhắn <code>nạp 50tr</code> hoặc <code>số dư 50tr</code> (số dư tiền ở công ty chứng khoán).';
  const L = ['💵 <b>VỐN</b>', `Vốn ${tr(c.netContributed)} · đã mua ${tr(c.invested ?? 0)}${c.realized ? ` · lãi đã chốt ${tr(c.realized)}` : ''}${c.dividends ? ` · cổ tức ${tr(c.dividends)}` : ''}`,
    `→ Tiền mặt còn <b>${tr(c.cash)}</b>${c.pendingSale ? ` (chờ về ${tr(c.pendingSale)})` : ''}`,
    '<i>Lời lỗ cổ phiếu đang giữ: nhắn "danh mục".</i>'];
  L.push(c.slots === 0 ? 'Vốn chọn mã dưới 20 triệu: nên mua ETF (vd E1VFVN30).'
    : `Quy tắc: tối đa ${c.slots} mã, 1 suất ≈ ${tr(c.slotValue)} · đang giữ ${c.picks} mã, còn ${c.freeSlots} suất`);
  if (c.warning) L.push(`⚠️ ${esc(c.warning)}`);
  return L.join('\n');
}

async function portfolioText(getPortfolio) {
  const p = await getPortfolio();
  if (!p.holdings?.length) return '📭 Danh mục của bạn hiện đang trống.';
  const s = p.summary;
  const pnlSign = s.unrealizedPct >= 0 ? '+' : '';
  const lines = [
    '🧾 <b>DANH MỤC NẮM GIỮ</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `📊 Tổng NAV: <b>${num(s.marketValue / 1e6, 2)} tr</b> · Hiệu suất: <b>${pnlSign}${num(s.unrealizedPct, 1)}%</b>`,
  ];
  for (const h of p.holdings) {
    const pnl = h.unrealizedPct >= 0 ? `lãi <b>+${num(h.unrealizedPct, 1)}%</b>` : `lỗ <b>−${num(Math.abs(h.unrealizedPct), 1)}%</b>`;
    lines.push(
      '',
      `▸ <b>${esc(h.symbol)}</b> · Giá <b>${num(h.close)}</b> (vốn ${num(h.avgCost)} · ${pnl})`,
      `  💼 Khối lượng: <b>${num(h.qty, 0)}</b> cp`
    );
  }
  return lines.join('\n');
}

/** Xử lý một tin nhắn, trả về nội dung trả lời (HTML) hoặc null nếu không phải lệnh. */
export async function handleMessage(text, deps = {}) {
  const c = parseCommand(text);
  // Không hiểu: luôn trả lời kèm hướng dẫn, không im lặng
  if (!c) return `Mình chưa hiểu "${esc(String(text).slice(0, 60))}".\n\n${HELP}`;
  const { addTransaction, removeTransaction, getPortfolio, addCash, removeCash, getCapitalInfo } = deps.portfolio || await import('./portfolio.js');
  if (c.cmd === 'help') return HELP;
  if (c.cmd === 'error') return `⚠️ ${esc(c.error)}\n\n${HELP}`;
  if (c.cmd === 'portfolio') return portfolioText(getPortfolio);
  if (c.cmd === 'capital') return capitalText(await getCapitalInfo());
  if (c.cmd === 'outlook') {
    const { getOutlook, buildOutlook, formatOutlook, nextWeek } = deps.outlook || await import('./outlook.js');
    const prev = await getOutlook();
    // Dùng bản của tuần này nếu đã có, chưa có thì AI phân tích mới (mất khoảng 1 phút)
    return formatOutlook(prev?.week?.monday === nextWeek().monday ? prev : await buildOutlook());
  }
  await loadState();
  if (c.cmd === 'undo') {
    const last = st.added.pop();
    if (!last) return 'Không có giao dịch nào vừa thêm qua bot để hoàn tác.';
    if (last.kind === 'cash') {
      await removeCash(last.id);
      await saveState();
      return `↩️ Đã xóa dòng tiền: ${esc(last.label)} ${tr(last.amount)} ngày ${ddmmyyyy(last.date)}`;
    }
    await removeTransaction(last.id);
    await saveState();
    return `↩️ Đã xóa: ${last.type === 'BUY' ? 'MUA' : 'BÁN'} <b>${esc(last.symbol)}</b> ${num(last.qty, 0)} cp giá ${num(last.price)} ngày ${ddmmyyyy(last.date)}`;
  }
  if (c.cmd === 'cash') {
    try {
      const x = await addCash({ type: c.type, amount: c.amount, date: c.date, note: 'Telegram' });
      const label = { DEPOSIT: 'Nạp tiền', WITHDRAW: 'Rút tiền', DIVIDEND: 'Cổ tức tiền', SET: 'Đặt số dư' }[c.type];
      st.added.push({ kind: 'cash', id: x.id, label, amount: x.amount, date: x.date });
      st.added = st.added.slice(-20);
      await saveState();
      return [`✅ Đã ghi ${label.toLowerCase()} <b>${tr(x.amount)}</b> ngày ${ddmmyyyy(x.date)}`, '', capitalText(await getCapitalInfo()), '<i>Nhắn "hoàn tác" nếu ghi nhầm.</i>'].join('\n');
    } catch (err) {
      return `⚠️ Chưa ghi được: ${esc(err.message)}`;
    }
  }
  try {
    const tx = await addTransaction({ type: c.type, symbol: c.symbol, qty: c.qty, price: c.price, date: c.date, note: 'Telegram' });
    st.added.push({ id: tx.id, type: tx.type, symbol: tx.symbol, qty: tx.qty, price: tx.price, date: tx.date });
    st.added = st.added.slice(-20);
    await saveState();
    const h = (await getPortfolio().catch(() => null))?.holdings?.find((x) => x.symbol === tx.symbol);
    return [
      `✅ Đã ghi ${tx.type === 'BUY' ? 'MUA' : 'BÁN'} <b>${esc(tx.symbol)}</b>`,
      `${num(tx.qty, 0)} cp · giá ${num(tx.price)} · ngày ${ddmmyyyy(tx.date)}`,
      h ? `Đang giữ ${num(h.qty, 0)} cp, giá vốn ${num(h.avgCost)}` : `Đã bán hết ${esc(tx.symbol)}`,
      '<i>Nhắn "hoàn tác" nếu ghi nhầm.</i>',
    ].join('\n');
  } catch (err) {
    return `⚠️ Chưa ghi được: ${esc(err.message)}`;
  }
}

/** Nhận tin liên tục (long polling). Bỏ qua tin cũ trước lúc khởi động lần đầu và tin từ chat khác. */
export function startTelegramBot() {
  const { enabled, chatId } = telegramConfig();
  if (!enabled) return false;
  let stopped = false;
  (async () => {
    await loadState();
    if (st.offset == null) {
      // Lần đầu: bỏ qua tin tồn đọng
      const old = await api('getUpdates', { timeout: 0 }).catch(() => []);
      st.offset = old.length ? old.at(-1).update_id + 1 : 0;
      await saveState();
    }
    while (!stopped) {
      try {
        const updates = await api('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
        for (const u of updates) {
          st.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text) continue;
          if (String(m.chat?.id) !== String(chatId)) {
            console.warn(`[Bot] Bỏ qua tin từ chat ${m.chat?.id} (không phải TELEGRAM_CHAT_ID ${chatId})`);
            continue;
          }
          console.log(`[Bot] Nhận: ${m.text}`);
          const reply = await handleMessage(m.text).catch((err) => `⚠️ Lỗi: ${esc(err.message)}`);
          console.log(`[Bot] Trả lời: ${String(reply).split('\n')[0]}`);
          if (reply) await sendMessage(reply).catch((err) => console.error('[Bot] Lỗi trả lời:', err.message));
        }
        if (updates.length) await saveState();
      } catch (err) {
        if (!/aborted|timeout/i.test(err.message)) console.error('[Bot] Lỗi nhận tin:', err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return () => { stopped = true; };
}
