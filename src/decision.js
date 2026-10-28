// Quyết định cuối = hệ thống định lượng (điểm xếp hạng, đã kiểm chứng) + AI thẩm định theo yếu tố thị trường.
// Nguyên tắc chống sai lệch: khi hai bên khác nhau thì lấy bên THẬN TRỌNG hơn. AI được quyền hạ mức
// (thị trường xấu, tin rủi ro…), không được nâng vượt tín hiệu định lượng chưa xác nhận.
import { RECOMMENDATIONS } from './analyze.js';
import { tradeSteps } from './tradeplan.js';
import { actionFor } from './brief.js';
import { pinnedNote } from './picks.js';

// Thứ tự từ thận trọng nhất đến tích cực nhất
const LEVEL = { SELL: 0, AVOID: 1, HOLD: 2, ACCUMULATE: 3, BUY: 4 };
const CODE_AT = Object.fromEntries(Object.entries(LEVEL).map(([k, v]) => [v, k]));
// Quyết định của AI quy về mã khuyến nghị của hệ thống
export const AI_TO_CODE = { MUA: 'BUY', MUA_THAM_DO: 'ACCUMULATE', GIU: 'HOLD', DUNG_NGOAI: 'AVOID', BAN_BOT: 'AVOID', BAN: 'SELL' };
const TONE = { BUY: 'up', ACCUMULATE: 'up', HOLD: 'ref', AVOID: 'down', SELL: 'down' };

/** Gộp: lấy mức thận trọng hơn. Trả về mã cuối và AI đã hạ, đồng ý hay tích cực hơn. */
export function fuseDecision(systemCode, aiDecision) {
  const aiCode = AI_TO_CODE[aiDecision];
  if (!aiCode || LEVEL[systemCode] == null) return { code: systemCode, relation: 'none' };
  const s = LEVEL[systemCode], a = LEVEL[aiCode];
  return { code: CODE_AT[Math.min(s, a)], aiCode, relation: a < s ? 'stricter' : a > s ? 'looser' : 'agree' };
}

export const ADD_MORE = { MUA_THEM: 'NÊN MUA THÊM', MUA_THEM_CO_DIEU_KIEN: 'MUA THÊM CÓ ĐIỀU KIỆN', KHONG_MUA_THEM: 'KHÔNG MUA THÊM' };
const SELL_KIND = { CHOT_LOI: 'Chốt lời', HA_TY_TRONG: 'Hạ tỷ trọng', CAT_LO: 'Cắt lỗ' };
const fmt = (v) => (v == null ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: 2 }));
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Kế hoạch cho người đang nắm giữ do giám đốc đầu tư lập, đã kiểm tra lại bằng luật cứng:
 * - chỉ được mua thêm khi quyết định cuối là NÊN MUA / CÂN NHẮC MUA;
 * - vùng mua thêm phải trên cắt lỗ và không cao hơn giá hiện tại quá 1 biên độ (7%);
 * - quyết định cuối không phải NÊN MUA thì không bình quân giá xuống dưới giá vốn;
 * - số cổ phiếu tính theo vị thế thật (lô 100 khi ≥ 300 cp).
 * @returns {{ addMore, addLabel, addReason, blocked, holdView, noAdd, stop, steps } | null}
 */
export function holderPlan(code, plan, { close, stop: sysStop, holding = null } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const sane = (v) => (Number.isFinite(v) && v > close * 0.5 && v < close * 2 ? r2(v) : null);
  const str = (v) => String(v || '').trim();
  const pctOf = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) / 100 : null);
  let stop = sane(plan.stopLoss);
  if (stop == null || stop >= close) stop = sysStop ?? null;

  let addMore = ADD_MORE[plan.addMore] ? plan.addMore : 'KHONG_MUA_THEM';
  let blocked = null;
  let zones = (Array.isArray(plan.addZones) ? plan.addZones : []).map((z) => {
    const f = sane(z?.from), t = sane(z?.to), p = pctOf(z?.percentOfHolding, 5, 100);
    if (f == null || t == null || p == null) return null;
    return { zone: [Math.min(f, t), Math.max(f, t)], portionOfHolding: p, condition: str(z.condition) };
  }).filter((z) => z && z.zone[1] <= close * 1.07 && (stop == null || z.zone[0] > stop));
  if (!['BUY', 'ACCUMULATE'].includes(code) && (addMore !== 'KHONG_MUA_THEM' || zones.length)) {
    blocked = 'Quyết định cuối không phải mua nên không mua thêm, dù hội đồng có đề xuất vùng mua thêm';
    addMore = 'KHONG_MUA_THEM';
  }
  if (addMore === 'KHONG_MUA_THEM') zones = [];
  if (code !== 'BUY' && holding?.avgCost) {
    const before = zones.length;
    zones = zones.filter((z) => z.zone[1] >= holding.avgCost);
    if (zones.length < before) blocked = `Bỏ vùng mua thêm dưới giá vốn ${fmt(holding.avgCost)}: chưa phải xu hướng tăng rõ, không bình quân giá xuống`;
    if (!zones.length && addMore !== 'KHONG_MUA_THEM') addMore = 'KHONG_MUA_THEM';
  }

  const noAdd = (Array.isArray(plan.noAddZones) ? plan.noAddZones : [])
    .map((z) => ({ side: z?.side === 'DUOI' ? 'DUOI' : 'TREN', price: sane(z?.price), reason: str(z?.reason) }))
    .filter((z) => z.price != null);

  const sells = (Array.isArray(plan.sellSteps) ? plan.sellSteps : []).map((s) => {
    const price = sane(s?.price), p = pctOf(s?.percentOfHolding, 5, 100);
    if (price == null || p == null) return null;
    let kind = SELL_KIND[s.kind] ? s.kind : 'CHOT_LOI';
    if (kind !== 'CAT_LO' && price <= close * 0.97 && stop != null && price <= stop) kind = 'CAT_LO';
    if (kind === 'CHOT_LOI' && holding?.avgCost && price < holding.avgCost) kind = 'HA_TY_TRONG';
    return { side: kind === 'CAT_LO' ? 'stop' : 'sell', kind, price, portionOfHolding: p, condition: `${SELL_KIND[kind]}: ${str(s.condition)}` };
  }).filter(Boolean).sort((x, y) => (x.side === 'stop') - (y.side === 'stop') || x.price - y.price);

  const steps = [
    ...zones.map((z) => ({ side: 'buy', zone: z.zone, portionOfHolding: z.portionOfHolding, condition: `Mua thêm: ${z.condition}` })),
    ...(addMore === 'KHONG_MUA_THEM' ? [{ side: 'wait', condition: 'Không mua thêm ở thời điểm này' }] : []),
    ...sells,
  ];
  if (stop != null && !sells.some((s) => s.side === 'stop')) {
    steps.push({ side: 'stop', price: stop, portionOfHolding: 1, condition: `Cắt lỗ: bán toàn bộ nếu đóng cửa dưới ${fmt(stop)}` });
  }

  // Số cổ phiếu theo vị thế thật
  if (holding?.qty) {
    const lot = holding.qty >= 300 ? 100 : 1;
    const round = (n) => Math.max(lot, Math.floor(n / lot) * lot);
    let left = holding.qty;
    for (const s of steps) {
      if (s.side === 'buy') s.shares = round(holding.qty * s.portionOfHolding);
      else if (s.side === 'sell') { s.shares = Math.min(left, round(holding.qty * s.portionOfHolding)); left -= s.shares; }
      else if (s.side === 'stop') s.shares = s.portionOfHolding >= 1 ? holding.qty : Math.min(holding.qty, round(holding.qty * s.portionOfHolding));
    }
    if (stop != null && close < stop) steps.unshift({ side: 'stop', price: close, shares: holding.qty, condition: `Giá đã thủng cắt lỗ ${fmt(stop)}: bán theo kỷ luật` });
    if (holding.pending) steps.push({ side: 'wait', condition: `${holding.pending.toLocaleString('vi-VN')} cp chưa về (T+2): hôm nay chỉ bán được tối đa ${(holding.sellable ?? 0).toLocaleString('vi-VN')} cp` });
  }

  return {
    addMore, addLabel: ADD_MORE[addMore], addReason: str(plan.addReason), blocked,
    holdView: str(plan.holdView), noAdd, stop, steps,
  };
}

/**
 * Quyết định cuối kèm kế hoạch mua/bán tính lại theo mức đã gộp.
 * @param {object} a kết quả analyzeSymbol (có brief)
 * @param {object} ai kết quả aiAnalyze (có decision, planReview, marketChecks)
 * @param {object} [committee] thẩm định của giám đốc đầu tư (verdict của hội đồng). Khi có, đây là
 *   quyết định AI dùng để gộp với hệ thống (giám đốc đã đọc phân tích Gemini), và kế hoạch cho người
 *   đang nắm giữ lấy từ holderPlan của hội đồng.
 */
export function finalDecision(a, ai, committee = null) {
  const b = a.brief;
  if (!b || !ai) return null;
  const sys = a.recommendation.code;
  const src = committee?.decision ? committee : ai;
  const fused = fuseDecision(sys, src.decision);
  const { relation, aiCode } = fused;
  // Giá bị ghim (chào mua/hoán đổi): mua vào không có dư địa lãi, tối đa là GIỮ
  const pinned = LEVEL[fused.code] > LEVEL.HOLD ? pinnedNote(a.recentBars) : null;
  const code = pinned ? 'HOLD' : fused.code;
  const label = RECOMMENDATIONS.find((r) => r.code === code)?.label || code;
  const sysLabel = a.recommendation.label;
  const who = committee ? 'Hội đồng đầu tư' : 'AI';
  const why = committee ? (committee.debateSummary || '') : (ai.planReview?.reason || ai.headline || '');
  const bad = (ai.marketChecks || []).filter((x) => x.status === 'XAU').map((x) => x.label.toLowerCase());
  let note;
  if (relation === 'stricter') note = `${who} hạ từ ${sysLabel} xuống ${label}${bad.length ? ` (yếu tố xấu: ${bad.join(', ')})` : ''}. ${why}`;
  else if (relation === 'looser') note = `${who} tích cực hơn (${src.decisionLabel}) nhưng tín hiệu định lượng chưa xác nhận nên giữ ${label}. ${why}`;
  else note = `${who} đồng ý ${label}. ${why}`;
  if (pinned) note = `Không mua mới: ${pinned}. ${note}`;

  const i = a.technical.indicators;
  const holding = a.holding ?? b.holding ?? null;
  const steps = b.levels ? tradeSteps(code, b.levels, {
    weight: b.levels.weight ?? 0.1, rsi: i.rsi14, avgVol20: i.avgVolume20, ma200: i.sma200,
    score: a.ranking?.score, aboveMa200: a.ranking?.aboveMa200, holding, holdStop: b.levels.holdStop,
    marketWait: relation === 'stricter' && bad.length ? `các yếu tố thị trường cải thiện (${bad.join(', ')})` : null,
  }) : null;
  const holder = committee ? holderPlan(code, committee.holderPlan, { close: a.price.close, stop: b.levels?.holdStop ?? b.levels?.stop, holding }) : null;
  if (steps && holder?.steps.length) steps.hold = holder.steps;
  return {
    code, label, tone: TONE[code], relation, aiCode,
    systemCode: sys, systemLabel: sysLabel,
    by: committee ? 'committee' : 'ai',
    gemini: { decision: ai.decision, label: ai.decisionLabel, confidence: ai.confidence },
    committee: committee ? { decision: committee.decision, label: committee.decisionLabel, confidence: committee.confidence } : null,
    note: note.trim(),
    action: actionFor(code, b.levels),
    steps,
    holder,
    marketChecks: ai.marketChecks || [],
    priceDate: a.price.date, price: a.price.close,
  };
}
