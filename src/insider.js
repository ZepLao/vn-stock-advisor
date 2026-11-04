// Giao dịch của người nội bộ và người liên quan (nguồn: bảng "Giao dịch cổ đông" của CafeF, có lịch sử từ 2008).
// Nghiên cứu ở Việt Nam: giá phản ứng sau THÔNG BÁO ĐĂNG KÝ giao dịch (đăng ký mua → tăng, đăng ký bán → giảm),
// không phản ứng khi báo cáo kết quả. Vì vậy tín hiệu dùng khối lượng ĐĂNG KÝ theo ngày công bố.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './http.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'insider_hist.json');
const URL = (s) => `https://cafef.vn/du-lieu/Ajax/PageNew/DataHistory/GDCoDong.ashx?Symbol=${s}&PageIndex=1&PageSize=2000`;
export const INSIDER_WINDOW_DAYS = 60;
export const INSIDER_FACTOR = { key: 'ins', label: 'Người nội bộ đăng ký mua ròng 60 ngày', sign: 1 };

// "/Date(1791306000000)/" → ngày theo giờ Việt Nam
const vnDate = (s) => {
  const ms = Number(String(s || '').match(/-?\d+/)?.[0]);
  return Number.isFinite(ms) ? new Date(ms + 7 * 3600_000).toISOString().slice(0, 10) : null;
};

/** Chuẩn hóa một dòng CafeF (hàm thuần). Bỏ dòng không có ngày công bố hoặc không có khối lượng đăng ký. */
export function parseInsiderRow(x) {
  const published = vnDate(x.PublishedDate);
  const buy = Number(x.PlanBuyVolume) || 0, sell = Number(x.PlanSellVolume) || 0;
  if (!published || (!buy && !sell)) return null;
  return {
    published, buy, sell,
    realBuy: Number(x.RealBuyVolume) || 0, realSell: Number(x.RealSellVolume) || 0,
    who: x.TransactionMan || '', role: x.TransactionManPosition || '', related: x.RelatedManPosition || '',
  };
}

/** Lịch sử đăng ký giao dịch nội bộ cho danh sách mã, lưu đệm ra file (chỉ tải mã chưa có hoặc khi refresh). */
export async function loadInsider(symbols, { refresh = false, log = () => {}, concurrency = 4 } = {}) {
  let cache = {};
  try { cache = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* chưa có */ }
  const need = symbols.filter((s) => refresh || !cache[s]);
  log(`Giao dịch nội bộ: có sẵn ${symbols.length - need.length} mã, tải thêm ${need.length} mã…`);
  for (let k = 0; k < need.length; k += concurrency) {
    await Promise.all(need.slice(k, k + concurrency).map(async (s) => {
      const r = await fetchJson(URL(s), { timeout: 30000 }).catch(() => null);
      const rows = r?.Data?.Data;
      if (Array.isArray(rows)) cache[s] = rows.map(parseInsiderRow).filter(Boolean);
    }));
  }
  if (need.length) await writeFile(FILE, JSON.stringify(cache), 'utf8');
  return cache;
}

/**
 * Tín hiệu tại phiên i (hàm thuần): tổng (đăng ký mua − đăng ký bán) của các thông báo công bố TRƯỚC phiên i trong `window`
 * ngày, chia khối lượng giao dịch trung bình 20 phiên. Không có thông báo = 0 (không có tín hiệu).
 */
export function insiderReader(bars, events, window = INSIDER_WINDOW_DAYS) {
  const ev = [...(events || [])].sort((a, b) => a.published.localeCompare(b.published));
  return (i) => {
    const b = bars[i];
    if (!b || i < 20) return null;
    const from = new Date(Date.parse(b.time) - window * 86400_000).toISOString().slice(0, 10);
    let net = 0;
    for (const e of ev) {
      if (e.published >= b.time) break; // công bố cùng ngày (thường sau giờ đóng cửa) chưa dùng được
      if (e.published > from) net += e.buy - e.sell;
    }
    let vol = 0;
    for (let k = i - 19; k <= i; k++) vol += bars[k].volume || 0;
    vol /= 20;
    return vol > 0 ? net / vol : null;
  };
}
