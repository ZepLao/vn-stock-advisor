// AI lọc tin tức theo mã: tin có thật sự nói về doanh nghiệp này không, tốt/xấu/trung lập, có phải rủi ro nghiêm trọng
// (pháp lý, mất khả năng trả nợ, đình chỉ…) trực tiếp với doanh nghiệp không. Thay cho chấm từ khóa vốn hay nhầm
// (tin nhắc mã khác, "điều tra" thị trường chung…). Mỗi tin chỉ phân loại một lần (lưu data/newsai.json);
// AI lỗi / hết hạn mức thì giữ cách chấm từ khóa. Tắt bằng NEWS_AI=0.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateJson } from './llm.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'newsai.json');
const MAX_CACHE = 8000;
const MAX_PER_CALL = 25;
export const LABELS = { TICH_CUC: 'tich_cuc', TIEU_CUC: 'tieu_cuc', TRUNG_LAP: 'trung_lap' };

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          relevant: { type: 'BOOLEAN' },
          label: { type: 'STRING', enum: Object.keys(LABELS) },
          risk: { type: 'BOOLEAN' },
          reason: { type: 'STRING' },
        },
        required: ['i', 'relevant', 'label', 'risk', 'reason'],
      },
    },
  },
  required: ['items'],
};

const SYSTEM = 'Bạn là chuyên viên lọc tin chứng khoán Việt Nam. Chỉ dựa vào tiêu đề và tóm tắt được cung cấp, không suy đoán thêm. Trả lời tiếng Việt có dấu, ngắn gọn.';

// Cùng một bài có thể liên quan mã này mà không liên quan mã khác: khóa theo cả mã
export const newsKey = (it, symbol) => `${symbol}|${it.link || it.title}`;

let cache = null;
let saving = Promise.resolve();
async function load() {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(FILE, 'utf8')); } catch { cache = {}; }
  return cache;
}
function save() {
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => (cache[a].at || '').localeCompare(cache[b].at || ''));
    for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete cache[k];
  }
  saving = saving.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(cache), 'utf8');
  }).catch((err) => console.error('[Lọc tin AI] Lỗi ghi:', err.message));
}

export function buildNewsPrompt(list, { symbol, companyName }) {
  const lines = [
    `Doanh nghiệp: ${symbol}${companyName ? ` — ${companyName}` : ''}.`,
    'Với mỗi tin dưới đây, xác định:',
    `- relevant: tin có nói trực tiếp về ${symbol} (hoạt động, kết quả, cổ đông, pháp lý, giao dịch cổ phiếu của chính doanh nghiệp) không. Tin thị trường chung chỉ liệt kê mã trong danh sách tăng/giảm, hoặc nói về doanh nghiệp khác, là false.`,
    `- label: tác động lên giá cổ phiếu ${symbol}: TICH_CUC, TIEU_CUC hoặc TRUNG_LAP (tin chỉ mô tả lại biến động giá là TRUNG_LAP).`,
    `- risk: true chỉ khi là rủi ro nghiêm trọng trực tiếp với ${symbol}: lãnh đạo/doanh nghiệp bị khởi tố, điều tra, bắt; hủy niêm yết, đình chỉ/kiểm soát/cảnh báo giao dịch; mất khả năng trả nợ, chậm trả trái phiếu; kiểm toán từ chối/ngoại trừ trọng yếu. Lỗ hay giá giảm đơn thuần là false.`,
    '- reason: lý do ngắn (≤ 15 từ).',
    '',
    ...list.map((it, i) => `[${i}] ${it.title}${it.summary ? ` — ${it.summary.slice(0, 160)}` : ''}`),
  ];
  return lines.join('\n');
}

/** Gộp nhãn AI vào tin: đổi nhãn/điểm cảm xúc theo AI, đánh dấu tin không liên quan. */
export function applyAiLabel(it, r) {
  if (!r) return { ...it, ai: null };
  const label = LABELS[r.label] || it.label;
  // Giữ độ mạnh của chấm từ khóa khi cùng chiều, nếu khác chiều dùng mức vừa phải
  const sign = label === 'tich_cuc' ? 1 : label === 'tieu_cuc' ? -1 : 0;
  const sentiment = sign === 0 ? 0 : Math.sign(it.sentiment) === sign ? it.sentiment : sign * 0.4;
  return { ...it, label, sentiment, ai: { relevant: r.relevant, risk: r.relevant && r.risk, reason: r.reason } };
}

// Đang phân loại ở nền theo mã: không gọi trùng khi nhiều lần phân tích cùng lúc
const inflight = new Map();

async function classify(left, { symbol, companyName, timeout }) {
  // Tối đa 2 lượt gọi mỗi lần (mỗi lượt 25 tin); tin còn lại để lần sau
  for (let k = 0; k < Math.min(left.length, 2 * MAX_PER_CALL); k += MAX_PER_CALL) {
    const todo = left.slice(k, k + MAX_PER_CALL);
    try {
      const { json } = await generateJson(buildNewsPrompt(todo, { symbol, companyName }), { system: SYSTEM, schema: SCHEMA, timeout, lite: true });
      const at = new Date().toISOString();
      for (const r of json?.items || []) {
        const it = todo[r.i];
        if (!it || typeof r.relevant !== 'boolean' || !LABELS[r.label]) continue;
        cache[newsKey(it, symbol)] = { relevant: r.relevant, label: r.label, risk: Boolean(r.risk), reason: String(r.reason || '').slice(0, 120), at, pub: it.publishedAt || null };
      }
      save();
    } catch (err) {
      console.warn(`[Lọc tin AI] ${symbol}: ${err.message.slice(0, 160)}`);
      break;
    }
  }
}

/**
 * Lọc và phân loại tin của một mã bằng AI. Trả về { items (đã bỏ tin không liên quan), removed, checked, pending }.
 * pending = số tin AI chưa phân loại được (dùng nhãn từ khóa).
 * Mặc định KHÔNG chờ AI: dùng ngay nhãn đã có, tin mới được phân loại ở nền cho lần phân tích sau (AI quá tải có thể
 * mất hàng chục giây và trước đây làm trang phân tích mã treo). wait = true thì chờ phân loại xong.
 */
export async function aiFilterNews(items, { symbol, companyName, timeout = 60_000, wait = false } = {}) {
  if (!items?.length || process.env.NEWS_AI === '0') return { items, removed: [], checked: 0, pending: items?.length || 0 };
  await load();
  const left = items.filter((it) => !cache[newsKey(it, symbol)]);
  if (left.length) {
    let job = inflight.get(symbol);
    if (!job) {
      job = classify(left, { symbol, companyName, timeout }).finally(() => inflight.delete(symbol));
      inflight.set(symbol, job);
    }
    if (wait) await job;
  }
  const out = items.map((it) => applyAiLabel(it, cache[newsKey(it, symbol)]));
  return {
    items: out.filter((it) => it.ai?.relevant !== false),
    removed: out.filter((it) => it.ai?.relevant === false),
    checked: out.filter((it) => it.ai).length,
    pending: out.filter((it) => !it.ai).length,
  };
}
