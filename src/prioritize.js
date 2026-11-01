// Xếp ưu tiên các mã đề xuất mua trong bản tin: AI so sánh các mã VỚI NHAU (xu hướng, lời/lỗ kỳ vọng từ giá hiện tại,
// khoảng cách tới vùng mua, thanh khoản, cơ bản, dòng tiền ngành, độ tự tin của AI, trùng ngành với mã đang giữ) rồi chia
// ƯU TIÊN (mua trước, tỷ trọng chính) / CÓ THỂ MUA (mua sau, ít hơn) / ĐẦU CƠ (thăm dò nhỏ, rủi ro cao) / ĐỂ SAU.
// AI chỉ được xếp lại các mã đã qua bộ lọc + thẩm định, không thêm mã; tỷ trọng bị chặn bởi luật cứng (sanitizePriority).
// AI lỗi thì xếp theo luật (rulePriority). Mỗi lần xếp được ghi vào nhật ký dự đoán (prio_main / prio_spec) để chấm sau.
import { generateJson } from './llm.js';
import { recordMany } from './predictions.js';

export const TIERS = {
  UU_TIEN: { label: 'ƯU TIÊN MUA', icon: '🥇', share: 1 },
  NEN_MUA: { label: 'CÓ THỂ MUA', icon: '🥈', share: 0.6 },
  DAU_CO: { label: 'ĐẦU CƠ · thăm dò nhỏ', icon: '🎲', share: 0.4 },
  CHUA_MUA: { label: 'ĐỂ SAU', icon: '💤', share: 0 },
};
export const PRIO_RULES = { maxTop: 2, specMax: 0.05, totalMax: 0.5, cautionTotal: 0.3, maxPerSector: 3 };

const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const pct = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 10);

/** Tỷ trọng tối đa của một mã theo kế hoạch hệ thống (thăm dò = một nửa). */
export function maxWeight(a, final) {
  const w = a.brief?.levels?.weight ?? 0.1;
  return final?.code === 'ACCUMULATE' ? w / 2 : w;
}

/** Số liệu gọn của một mã để AI so sánh. `zone`: 'buy' (đang trong vùng mua) hoặc khác (chờ giá). */
export function pickFacts(a, final, zone, levels) {
  const i = a.technical?.indicators || {}, f = a.fundamental?.data || {}, L = levels || a.brief?.levels || {};
  const close = a.price?.close;
  return {
    symbol: a.symbol, sector: a.sector?.name || null, sectorRank: a.sector?.rank ? `${a.sector.rank}/${a.sector.total}` : null,
    close, zone: zone === 'buy' ? 'trong vùng mua' : 'chờ giá về vùng mua',
    buyZone: L.buyFrom != null ? [L.buyFrom, L.buyTo] : null,
    targetPct: L.target && close ? pct(L.target / close - 1) : null, stopPct: L.stop && close ? pct(L.stop / close - 1) : null,
    riskReward: L.riskReward ?? null, maxWeightPct: pct(maxWeight(a, final)),
    rankScore: a.ranking?.score ?? null, aboveMa200: a.ranking?.aboveMa200 ?? null,
    rsi14: r1(i.rsi14), adx14: r1(i.adx14), ret20dPct: r1(i.return20d), ret60dPct: r1(i.return60d), rs60: r1(i.rs60),
    atrPct: i.atr14 && close ? pct(i.atr14 / close) : null,
    value20Bn: a.value20 ? Math.round(a.value20 / 1e9) : null,
    pe: r1(f.pe), roePct: pct(f.roe), profitGrowthPct: pct(f.profitGrowthTTM), debtToEquity: r1(f.debtToEquity),
    foreignNet5Bn: a.foreign?.net5 != null ? r1(a.foreign.net5 / 1e9) : null,
    final: final?.label || null, aiConfidence: final?.gemini?.confidence ?? null,
    aiNote: String(final?.note || '').slice(0, 220),
  };
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' }, tier: { type: 'STRING', enum: Object.keys(TIERS) },
          weightPct: { type: 'NUMBER' }, reason: { type: 'STRING' },
        },
        required: ['symbol', 'tier', 'weightPct', 'reason'],
      },
    },
    best: { type: 'STRING' },
    bestReason: { type: 'STRING' },
    summary: { type: 'STRING' },
  },
  required: ['items', 'best', 'bestReason', 'summary'],
};

const SYSTEM = `Bạn là giám đốc đầu tư chứng khoán Việt Nam. Các mã dưới đây ĐỀU đã qua bộ lọc định lượng và AI thẩm định là có thể mua.
Việc của bạn là SO SÁNH CHÚNG VỚI NHAU để nhà đầu tư cá nhân biết mua mã nào trước. Chỉ dùng số liệu được cung cấp, không bịa.
Phân loại mỗi mã đúng một nhóm:
- UU_TIEN: tốt nhất trong danh sách (xu hướng mạnh, lời kỳ vọng/rủi ro tốt, thanh khoản tốt, cơ bản ổn, ngành được dòng tiền). Tối đa 2 mã, khác ngành nhau nếu được.
- NEN_MUA: ổn nhưng kém mã ưu tiên ở ít nhất một mặt; mua sau hoặc tỷ trọng nhỏ hơn.
- DAU_CO: rủi ro cao hơn (biến động lớn, cơ bản yếu, RSI quá cao, lời kỳ vọng thấp so với cắt lỗ, thanh khoản mỏng) nhưng có cơ hội; chỉ thăm dò rất nhỏ.
- CHUA_MUA: hôm nay không nên mua dù đạt điều kiện (ví dụ trùng ngành với mã đang giữ, lời kỳ vọng quá thấp so với rủi ro).
weightPct = % tổng vốn gợi ý, KHÔNG vượt maxWeightPct của mã. Mã "chờ giá" vẫn xếp nhóm bình thường, chỉ mua khi giá về vùng mua.
reason: 1 câu ngắn tiếng Việt nêu điểm khác biệt so với các mã còn lại (dẫn số liệu). best: mã nên mua nếu chỉ chọn 1. summary: 1 câu.`;

export function buildPriorityPrompt(facts, ctx = {}) {
  const L = [];
  if (ctx.market) L.push(`Thị trường: ${ctx.market}`);
  if (ctx.held?.length) L.push(`Đang nắm giữ: ${ctx.held.join(', ')}`);
  if (ctx.caution) L.push('Chế độ thận trọng: gợi ý gần đây thua thị trường, giảm tỷ trọng.');
  L.push('', 'Các mã đề xuất (JSON):', JSON.stringify(facts));
  return L.join('\n');
}

/** Xếp theo luật khi không có AI: trong vùng mua trước, rồi Nên mua trước Cân nhắc mua, rồi điểm xếp hạng + R/R. */
export function rulePriority(facts, R = PRIO_RULES) {
  const key = (f) => (f.zone === 'trong vùng mua' ? 1000 : 0) + (f.final === 'NÊN MUA' ? 100 : 0) + (f.rankScore || 0) + 10 * Math.min(f.riskReward || 0, 3);
  const sorted = [...facts].sort((a, b) => key(b) - key(a));
  let top = 0;
  const items = sorted.map((f) => {
    const risky = (f.rsi14 != null && f.rsi14 > 72) || (f.riskReward != null && f.riskReward < 0.8) || (f.atrPct != null && f.atrPct > 4);
    const tier = risky ? 'DAU_CO' : top++ < R.maxTop ? 'UU_TIEN' : 'NEN_MUA';
    return { symbol: f.symbol, tier, weightPct: null, reason: 'Xếp theo điểm xếp hạng, vùng mua và tỷ lệ lời/lỗ (AI chưa xếp được).' };
  });
  const best = items.find((x) => x.tier === 'UU_TIEN') || items[0];
  return { items, best: best?.symbol || null, bestReason: best ? 'điểm xếp hạng và vị trí giá tốt nhất trong danh sách' : '', summary: '' };
}

/**
 * Chặn kết quả AI bằng luật: chỉ mã trong danh sách, mỗi mã một dòng (thiếu thì lấy theo luật), tối đa 2 ƯU TIÊN,
 * tỷ trọng ≤ trần của mã × hệ số nhóm, ĐẦU CƠ ≤ 5%, tổng ≤ 50% vốn (thận trọng 30%), "best" phải là mã ƯU TIÊN,
 * tối đa `maxPerSector` mã cùng ngành được mua (mã thứ 3 trở đi chuyển ĐỂ SAU), mã có trần tỷ trọng 0 chuyển ĐỂ SAU.
 */
export function sanitizePriority(json, facts, { caution = false } = {}, R = PRIO_RULES) {
  const bySym = new Map(facts.map((f) => [f.symbol, f]));
  const fallback = rulePriority(facts, R).items; // đã sắp theo luật: mã thiếu được thêm theo thứ tự này
  const seen = new Set();
  const items = [];
  for (const x of Array.isArray(json?.items) ? json.items : []) {
    const s = String(x?.symbol || '').toUpperCase().trim();
    if (!bySym.has(s) || seen.has(s)) continue;
    seen.add(s);
    items.push({ symbol: s, tier: TIERS[x.tier] ? x.tier : 'NEN_MUA', weightPct: Number(x.weightPct), reason: String(x.reason || '').slice(0, 240) });
  }
  for (const x of fallback) if (!seen.has(x.symbol)) items.push({ ...x });
  let top = 0;
  for (const x of items) if (x.tier === 'UU_TIEN' && ++top > R.maxTop) x.tier = 'NEN_MUA';
  // Đa dạng ngành: duyệt theo thứ tự nhóm (ưu tiên trước) để mã tốt hơn giữ suất của ngành
  const perSector = new Map();
  const order = Object.keys(TIERS);
  for (const x of [...items].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier))) {
    const sec = bySym.get(x.symbol).sector;
    if (!sec || x.tier === 'CHUA_MUA') continue;
    const n = (perSector.get(sec) || 0) + 1;
    perSector.set(sec, n);
    if (n > R.maxPerSector) { x.tier = 'CHUA_MUA'; x.reason = `Đã có ${R.maxPerSector} mã ngành ${sec} trong danh sách mua: để sau để tránh dồn rủi ro một ngành. ${x.reason}`.slice(0, 240); }
  }
  for (const x of items) if (x.tier !== 'CHUA_MUA' && bySym.get(x.symbol).maxWeightPct === 0) x.tier = 'CHUA_MUA';
  for (const x of items) {
    const cap = (bySym.get(x.symbol).maxWeightPct ?? 10) * TIERS[x.tier].share;
    const lim = x.tier === 'DAU_CO' ? Math.min(cap, R.specMax * 100) : cap;
    const w = Number.isFinite(x.weightPct) && x.weightPct > 0 ? Math.min(x.weightPct, lim) : lim;
    x.weightPct = Math.round(w);
  }
  const total = items.reduce((s, x) => s + x.weightPct, 0), max = (caution ? R.cautionTotal : R.totalMax) * 100;
  if (total > max) for (const x of items) x.weightPct = Math.floor((x.weightPct * max) / total);
  items.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  const tops = items.filter((x) => x.tier === 'UU_TIEN');
  const best = tops.find((x) => x.symbol === String(json?.best || '').toUpperCase().trim()) || tops[0] || null;
  return {
    items, best: best?.symbol || null,
    bestReason: best && best.symbol === String(json?.best || '').toUpperCase().trim() ? String(json?.bestReason || '').slice(0, 240) : (best?.reason || ''),
    summary: String(json?.summary || '').slice(0, 300),
  };
}

/**
 * Xếp ưu tiên danh sách mã mua. picks: [{ a, final, zone, levels }]. Luôn trả kết quả (AI lỗi → theo luật).
 * @returns {Promise<{ items, best, bestReason, summary, by: 'ai'|'rule' }>}
 */
export async function prioritizePicks(picks, ctx = {}) {
  const facts = picks.map((p) => pickFacts(p.a, p.final, p.zone, p.levels));
  if (!facts.length) return { items: [], best: null, bestReason: '', summary: '', by: 'rule' };
  let out, by = 'ai';
  if (facts.length === 1) { out = sanitizePriority(null, facts, ctx); by = 'rule'; }
  else {
    try {
      const { json } = await generateJson(buildPriorityPrompt(facts, ctx), { system: SYSTEM, schema: SCHEMA, timeout: 120_000 });
      out = sanitizePriority(json, facts, ctx);
    } catch (err) {
      console.warn('[Ưu tiên] AI chưa xếp được, dùng luật:', err.message);
      out = sanitizePriority(null, facts, ctx);
      by = 'rule';
    }
  }
  const date = picks[0].a.price?.date;
  recordMany(out.items.filter((x) => x.tier === 'UU_TIEN' || x.tier === 'DAU_CO').map((x) => ({
    source: x.tier === 'UU_TIEN' ? 'prio_main' : 'prio_spec', symbol: x.symbol, date, direction: 1,
    label: TIERS[x.tier].label, price: picks.find((p) => p.a.symbol === x.symbol)?.a.price?.close, detail: `${x.weightPct}% · ${x.reason}`, score: x.weightPct,
  }))).catch(() => {});
  return { ...out, by };
}
