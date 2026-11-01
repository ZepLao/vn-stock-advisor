// Hội đồng đầu tư bằng Gemini (theo preset investment_committee của Vibe-Trading):
//  1. Chuyên viên phe MUA và phe BÁN phân tích song song trên cùng bộ dữ liệu.
//  2. Trưởng ban rủi ro kiêm giám đốc đầu tư đọc hai bản luận điểm, đối chiếu với kết quả backtest
//     và hồ sơ rủi ro lịch sử rồi ra quyết định cuối cùng.
//  0. Trước đó Gemini phân tích 6 yếu tố thị trường; kết luận của Gemini được đưa cho cả hội đồng.
// Quyết định cuối (src/decision.js) chỉ có sau khi đủ các bước. Kế hoạch cho người đang nắm giữ
// (mua thêm hay không, vùng mua thêm, vùng không mua, chốt lời/hạ tỷ trọng) do giám đốc đầu tư lập.
// Mỗi lần chạy tốn 4 lượt gọi AI; kết quả lưu ở data/committee.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSymbol } from './analyze.js';
import { aiConfig, buildPrompt, callWithRetry, DECISIONS, capitalLine } from './ai.js';
import { runRankPortfolio, PORTFOLIO_RULE } from './ranking.js';
import { riskProfile, riskBrief } from './risk.js';
import { getPriceHistory } from './data.js';
import { recordPrediction } from './predictions.js';
import { runAi } from './tracker.js';
import { finalDecision } from './decision.js';

const DIRECTION = { MUA: 1, MUA_THAM_DO: 1, GIU: 0, DUNG_NGOAI: -1, BAN_BOT: -1, BAN: -1 };

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'committee.json');
const MAX_SAVED = 40;

const RULES = `- Chỉ dùng số liệu có trong dữ liệu; không bịa số liệu, sự kiện, tin tức hay giá mục tiêu của công ty chứng khoán.
- Mỗi luận điểm phải dẫn số liệu cụ thể (giá, chỉ báo, chỉ số tài chính, tin nào, kết quả backtest).
- Giá tính bằng nghìn đồng. Biên độ HOSE ±7%, HNX ±10%, UPCoM ±15%; thanh toán T+2, không bán khống.
- Viết tiếng Việt CÓ DẤU đầy đủ, ngắn gọn, có con số. Không viết mã kỹ thuật kiểu MUA_THAM_DO trong văn bản.`;

const BULL_SYSTEM = `Bạn là chuyên viên phân tích phe MUA của một quỹ đầu tư tại Việt Nam.
Nhiệm vụ: xây dựng luận điểm mua mạnh nhất có thể cho mã cổ phiếu, nhưng trung thực và dựa trên dữ liệu.
Xem xét: xu hướng và điểm bứt phá, dòng tiền và khối ngoại, biên an toàn định giá, chất lượng tăng trưởng,
chất xúc tác từ tin tức, và bằng chứng lịch sử từ backtest nếu ủng hộ.
Bắt buộc nêu thành thật 2-3 kịch bản làm luận điểm mua sai.
${RULES}`;

const BEAR_SYSTEM = `Bạn là chuyên viên phân tích phe BÁN (quản trị rủi ro) của một quỹ đầu tư tại Việt Nam.
Nhiệm vụ: tìm mọi rủi ro giảm giá và phản biện đám đông, nhưng trung thực và dựa trên dữ liệu.
Xem xét: kháng cự, mô hình đỉnh, phân kỳ, giá tăng mà khối lượng giảm, định giá đắt so với tăng trưởng,
lợi nhuận suy giảm, nợ vay, tin xấu, khối ngoại bán, rủi ro thị trường chung, biến động và sụt giảm lịch sử
(VaR, CVaR, max drawdown), và bằng chứng backtest cho thấy tín hiệu kém tin cậy.
Không tự tính giá trị nội tại DCF. Bắt buộc nêu các tín hiệu sẽ bác bỏ luận điểm bán.
${RULES}`;

const JUDGE_SYSTEM = `Bạn là giám đốc đầu tư kiêm trưởng ban quản trị rủi ro, chủ tọa hội đồng đầu tư.
Bạn nhận dữ liệu gốc, bản luận điểm phe MUA và phe BÁN. Ưu tiên bằng chứng phe mua / phe bán 7–10 phiên gần nhất
(cổ phiếu đang được gom hay bị xả) hơn các chỉ báo dài hạn. Nhiệm vụ:
1. Kiểm tra từng luận điểm có đúng với dữ liệu gốc không; bác bỏ luận điểm sai hoặc không có số liệu.
2. Cân nhắc bằng chứng lịch sử: danh mục theo điểm xếp hạng (top 8 trên MA200) và vị trí hiện tại của mã.
   Từng mã được chọn chỉ thắng VN-Index ~51% số lần, nên không coi điểm xếp hạng cao là bảo đảm.
3. Đánh giá rủi ro: biến động, VaR/CVaR, thanh khoản, thị trường chung, tin rủi ro.
4. Đối chiếu với phân tích 6 yếu tố thị trường của Gemini và kế hoạch định lượng của hệ thống.
5. Ra quyết định cuối cùng, ưu tiên bảo toàn vốn khi hai phe cân bằng.
6. Lập kế hoạch RIÊNG cho người ĐANG NẮM GIỮ (holderPlan), theo vị thế thật nếu có (số cổ phiếu, giá vốn, lãi/lỗ):
   - addMore: MUA_THEM chỉ khi xu hướng tăng đã xác nhận và quyết định là MUA hoặc MUA_THAM_DO;
     MUA_THEM_CO_DIEU_KIEN khi chỉ mua thêm nếu đạt điều kiện cụ thể; còn lại KHONG_MUA_THEM.
   - addZones: từng vùng giá được mua thêm, lượng mua thêm theo % số cổ phiếu đang nắm và điều kiện kèm theo.
     Vùng mua thêm phải cao hơn giá cắt lỗ. Không bình quân giá xuống khi xu hướng giảm (dưới MA200, thủng hỗ trợ).
   - noAddZones: vùng giá KHÔNG được mua thêm (vd: trên X vì mua đuổi sát kháng cự; dưới Y vì thủng hỗ trợ, xu hướng hỏng).
   - sellSteps: chốt lời / hạ tỷ trọng / cắt lỗ theo từng mức giá, % số cổ phiếu đang nắm.
     Bán dưới giá vốn thì là hạ tỷ trọng (HA_TY_TRONG), không phải chốt lời.
   - holdView: tiếp tục giữ hay không và vì sao, có tính lãi/lỗ hiện tại của vị thế.
Tỷ trọng gợi ý phải phù hợp với biến động (biến động cao → tỷ trọng nhỏ). Cắt lỗ < giá hiện tại < mục tiêu.
Các lựa chọn decision: MUA, MUA_THAM_DO, GIU, DUNG_NGOAI, BAN_BOT, BAN.
${RULES}`;

const point = (extra) => ({
  type: 'OBJECT',
  properties: { text: { type: 'STRING' }, ...extra },
  required: ['text', ...Object.keys(extra)],
});

const BULL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    points: { type: 'ARRAY', items: point({ strength: { type: 'STRING', enum: ['CAO', 'TRUNG_BINH'] } }), description: '3-5 luận điểm mua mạnh nhất' },
    technical: { type: 'STRING', description: 'Tín hiệu kỹ thuật ủng hộ, kèm mức hỗ trợ/mục tiêu' },
    fundamental: { type: 'STRING', description: 'Định giá và tăng trưởng ủng hộ' },
    catalysts: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Chất xúc tác 1-3 tháng tới' },
    targetPrice: { type: 'NUMBER', description: 'Giá mục tiêu phe mua (nghìn đồng)' },
    invalidation: { type: 'ARRAY', items: { type: 'STRING' }, description: '2-3 kịch bản làm luận điểm mua sai' },
  },
  required: ['points', 'technical', 'fundamental', 'catalysts', 'targetPrice', 'invalidation'],
};

const BEAR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    points: { type: 'ARRAY', items: point({ severity: { type: 'STRING', enum: ['CAO', 'TRUNG_BINH'] } }), description: '3-5 rủi ro lớn nhất' },
    technical: { type: 'STRING', description: 'Rủi ro kỹ thuật: kháng cự, phân kỳ, mô hình đỉnh, mức thủng' },
    valuation: { type: 'STRING', description: 'Định giá có đắt không, so với tăng trưởng' },
    riskMetrics: { type: 'STRING', description: 'Diễn giải VaR/CVaR, biến động, sụt giảm lịch sử và kết quả backtest' },
    downsidePrice: { type: 'NUMBER', description: 'Mức giá rủi ro giảm về (nghìn đồng)' },
    disproof: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Tín hiệu sẽ bác bỏ luận điểm bán' },
  },
  required: ['points', 'technical', 'valuation', 'riskMetrics', 'downsidePrice', 'disproof'],
};

const JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    debateSummary: { type: 'STRING', description: '2-3 câu tóm tắt cuộc tranh luận' },
    winner: { type: 'STRING', enum: ['PHE_MUA', 'PHE_BAN', 'CAN_BANG'] },
    acceptedBull: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm phe mua được chấp nhận' },
    rejectedBull: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm phe mua bị bác bỏ và lý do' },
    acceptedBear: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Rủi ro phe bán được chấp nhận' },
    rejectedBear: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm phe bán bị bác bỏ và lý do' },
    backtestView: { type: 'STRING', description: 'Bằng chứng lịch sử (backtest) củng cố hay làm yếu quyết định' },
    riskReview: { type: 'STRING', description: 'Đánh giá rủi ro và mức chấp nhận được' },
    decision: { type: 'STRING', enum: Object.keys(DECISIONS) },
    confidence: { type: 'INTEGER', description: '0-100' },
    horizon: { type: 'STRING' },
    action: { type: 'STRING', description: 'Hành động cụ thể cho người chưa có và người đang nắm giữ' },
    positionSizing: { type: 'STRING', description: 'Tỷ trọng tối đa và cách giải ngân, gắn với mức biến động' },
    entryFrom: { type: 'NUMBER' },
    entryTo: { type: 'NUMBER' },
    stopLoss: { type: 'NUMBER' },
    targets: { type: 'ARRAY', items: { type: 'NUMBER' } },
    conditionsToChange: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Điều kiện khiến hội đồng đổi quyết định' },
    holderPlan: {
      type: 'OBJECT',
      description: 'Kế hoạch cho người ĐANG NẮM GIỮ cổ phiếu này',
      properties: {
        holdView: { type: 'STRING', description: '1-2 câu: tiếp tục giữ hay không và vì sao, có số liệu' },
        addMore: { type: 'STRING', enum: ['MUA_THEM', 'MUA_THEM_CO_DIEU_KIEN', 'KHONG_MUA_THEM'] },
        addReason: { type: 'STRING', description: '1-2 câu: vì sao nên / không nên mua thêm' },
        addZones: {
          type: 'ARRAY',
          description: 'Các vùng giá được mua thêm (rỗng nếu KHONG_MUA_THEM)',
          items: {
            type: 'OBJECT',
            properties: {
              from: { type: 'NUMBER' }, to: { type: 'NUMBER' },
              percentOfHolding: { type: 'NUMBER', description: 'Mua thêm bao nhiêu % so với số cổ phiếu đang nắm, 10-50' },
              condition: { type: 'STRING', description: 'Điều kiện cụ thể, tối đa 20 từ' },
            },
            required: ['from', 'to', 'percentOfHolding', 'condition'],
          },
        },
        noAddZones: {
          type: 'ARRAY',
          description: 'Vùng giá KHÔNG được mua thêm',
          items: {
            type: 'OBJECT',
            properties: {
              side: { type: 'STRING', enum: ['TREN', 'DUOI'], description: 'TREN = giá trên mức này, DUOI = giá dưới mức này' },
              price: { type: 'NUMBER' },
              reason: { type: 'STRING', description: 'Tối đa 15 từ' },
            },
            required: ['side', 'price', 'reason'],
          },
        },
        sellSteps: {
          type: 'ARRAY',
          description: 'Các bước bán theo thứ tự giá, gồm cả cắt lỗ',
          items: {
            type: 'OBJECT',
            properties: {
              kind: { type: 'STRING', enum: ['CHOT_LOI', 'HA_TY_TRONG', 'CAT_LO'] },
              price: { type: 'NUMBER' },
              percentOfHolding: { type: 'NUMBER', description: '% số cổ phiếu đang nắm, 10-100' },
              condition: { type: 'STRING', description: 'Tối đa 20 từ' },
            },
            required: ['kind', 'price', 'percentOfHolding', 'condition'],
          },
        },
        stopLoss: { type: 'NUMBER', description: 'Giá cắt lỗ toàn bộ vị thế (nghìn đồng)' },
      },
      required: ['holdView', 'addMore', 'addReason', 'addZones', 'noAddZones', 'sellSteps', 'stopLoss'],
      propertyOrdering: ['holdView', 'addMore', 'addReason', 'addZones', 'noAddZones', 'sellSteps', 'stopLoss'],
    },
  },
  required: ['debateSummary', 'winner', 'acceptedBull', 'rejectedBull', 'acceptedBear', 'rejectedBear', 'backtestView',
    'riskReview', 'decision', 'confidence', 'horizon', 'action', 'positionSizing', 'stopLoss', 'targets', 'conditionsToChange', 'holderPlan'],
  propertyOrdering: ['debateSummary', 'acceptedBull', 'rejectedBull', 'acceptedBear', 'rejectedBear', 'backtestView', 'riskReview',
    'winner', 'decision', 'confidence', 'horizon', 'action', 'positionSizing', 'entryFrom', 'entryTo', 'stopLoss', 'targets', 'conditionsToChange', 'holderPlan'],
};

const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
const pts = (v, key) => (Array.isArray(v) ? v.filter((x) => x?.text).map((x) => ({ text: String(x.text), level: String(x[key] || '') })) : []);

function sanitizeJudge(r, close) {
  const sane = (v) => (Number.isFinite(v) && v > close * 0.5 && v < close * 2 ? v : null);
  const ef = sane(r.entryFrom), et = sane(r.entryTo), sl = sane(r.stopLoss);
  return {
    debateSummary: String(r.debateSummary || ''),
    winner: ['PHE_MUA', 'PHE_BAN', 'CAN_BANG'].includes(r.winner) ? r.winner : 'CAN_BANG',
    acceptedBull: strs(r.acceptedBull), rejectedBull: strs(r.rejectedBull),
    acceptedBear: strs(r.acceptedBear), rejectedBear: strs(r.rejectedBear),
    backtestView: String(r.backtestView || ''),
    riskReview: String(r.riskReview || ''),
    decision: DECISIONS[r.decision] ? r.decision : 'GIU',
    decisionLabel: DECISIONS[r.decision] || DECISIONS.GIU,
    confidence: Math.max(0, Math.min(100, Math.round(r.confidence ?? 0))),
    horizon: String(r.horizon || ''),
    action: String(r.action || ''),
    positionSizing: String(r.positionSizing || ''),
    entryZone: ef != null && et != null ? { from: Math.min(ef, et), to: Math.max(ef, et) } : null,
    stopLoss: sl != null && sl < close ? sl : null,
    targets: (Array.isArray(r.targets) ? r.targets : []).map(sane).filter((v) => v != null && v > close).sort((a, b) => a - b),
    conditionsToChange: strs(r.conditionsToChange),
    // Kiểm tra giá và tính số cổ phiếu ở decision.js (cần mức cắt lỗ, vị thế và quyết định cuối)
    holderPlan: r.holderPlan && typeof r.holderPlan === 'object' ? r.holderPlan : null,
  };
}

const pc = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Căn cứ lịch sử: chiến lược danh mục theo điểm xếp hạng (backtest rổ theo thời điểm), KHÔNG dùng backtest điểm kỹ thuật kiểu cũ
 * (đã chứng minh không dự báo được hướng giá). Kèm vị trí hiện tại của mã trong quy tắc mua/giữ.
 */
function rankEvidence(bt, a) {
  const m = bt.metrics, acc = bt.accuracy;
  const r = a.ranking;
  const where = !r ? 'chưa có điểm xếp hạng'
    : r.pfRank == null ? 'dưới MA200 → ngoài nhóm được mua/giữ'
      : r.pfRank <= PORTFOLIO_RULE.top ? `hạng ${r.pfRank} trong nhóm trên MA200 → thuộc danh mục mẫu top ${PORTFOLIO_RULE.top}`
        : `hạng ${r.pfRank} trong nhóm trên MA200 → ngoài danh mục mẫu top ${PORTFOLIO_RULE.top}`;
  return `Danh mục theo điểm xếp hạng (top ${bt.config.top} mã trên MA200, đổi mỗi ${bt.config.rebalance} phiên), ${bt.period.from} → ${bt.period.to}: `
    + `lời ${pc(m.totalReturn)} so với VN-Index ${pc(m.benchmarkReturn)}, sụt giảm tối đa ${pc(m.maxDrawdown)}, tỷ lệ lệnh thắng ${pc(m.winRate)} (${m.tradeCount} lệnh), `
    + `${acc.periodsBeatIndex}/${acc.periods} kỳ thắng VN-Index; từng mã được chọn thắng VN-Index ${acc.picks ? pc(acc.picksBeatIndex / acc.picks) : 'n/a'} số lần`
    + `${bt.universe?.survivorshipBias ? ' (CẢNH BÁO: rổ hiện tại, có thiên lệch sống sót, kết quả bị thổi phồng)' : ''}. Vị trí của ${a.symbol}: ${where}.`;
}

const f2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : 'n/a');

/** Vị thế thật của người dùng (từ Danh mục) để hội đồng lập kế hoạch cho người đang nắm giữ. */
function holdingSection(a) {
  const h = a.holding;
  if (!h?.qty) {
    return '\n## Vị thế của nhà đầu tư\nChưa có cổ phiếu này trong Danh mục. Kế hoạch holderPlan lập cho người đang nắm giữ nói chung, '
      + 'tỷ lệ tính theo % số cổ phiếu đang nắm.';
  }
  const pnl = h.pnlPct != null ? `${h.pnlPct >= 0 ? 'lãi' : 'lỗ'} ${Math.abs(h.pnlPct * 100).toFixed(1)}% (đã trừ phí, thuế bán)` : 'n/a';
  return `\n## Vị thế THẬT của nhà đầu tư (lập holderPlan theo vị thế này)\nĐang nắm ${h.qty} cp, giá vốn ${f2(h.avgCost)}, ${pnl}`
    + `${h.openedAt ? `, mở vị thế từ ${h.openedAt}` : ''}; bán được ngay ${h.sellable ?? h.qty} cp${h.pending ? `, ${h.pending} cp chưa về (T+2)` : ''}.`;
}

/** Kết luận của Gemini (bước 1) để hội đồng đối chiếu. */
function geminiSection(g) {
  const L = ['\n## Phân tích của Gemini (bước 1, cần đối chiếu)'];
  const fa = g.flowAnalysis;
  if (fa) {
    L.push(`Phe mua / phe bán 10 phiên: ${fa.phaseLabel} (rõ ràng ${fa.strength}/100). Bên mua: ${fa.whoBuys}. Bên bán: ${fa.whoSells}.`);
    for (const e of fa.evidence) L.push(`- ${e}`);
    if (fa.advice) L.push(`Lời khuyên theo dòng tiền: ${fa.advice}`);
  }
  const bv = g.businessView;
  if (bv) L.push(`Doanh nghiệp: ${bv.earningsLabel} — ${bv.earningsNote} Định giá ${bv.valuationLabel}: ${bv.valuationNote} Sự kiện: ${bv.eventImpact}`);
  L.push(`Quyết định: ${g.decisionLabel}, tin cậy ${g.confidence}%. ${g.headline}`);
  L.push(g.summary);
  for (const c of g.marketChecks || []) L.push(`- ${c.label}: ${{ TOT: 'TỐT', TRUNG_TINH: 'TRUNG TÍNH', XAU: 'XẤU' }[c.status]} — ${c.note}`);
  if (g.planReview) L.push(`Thẩm định kế hoạch hệ thống: ${g.planReview.verdict} — ${g.planReview.reason}`);
  if (g.forHolders) L.push(`Gợi ý cho người đang nắm giữ: ${g.forHolders}`);
  return L.join('\n');
}

let saved = null;
async function load() {
  if (saved) return saved;
  try { saved = JSON.parse(await readFile(FILE, 'utf8')); } catch { saved = {}; }
  return saved;
}

async function persist(result) {
  await load();
  saved[result.symbol] = result;
  const keys = Object.keys(saved).sort((a, b) => Date.parse(saved[b].createdAt) - Date.parse(saved[a].createdAt));
  for (const k of keys.slice(MAX_SAVED)) delete saved[k];
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(saved, null, 2), 'utf8');
}

const jobs = new Map(); // symbol -> { status, stage, error, startedAt }

async function run(symbol, { force = false } = {}) {
  const job = jobs.get(symbol);
  const started = Date.now();
  job.step = 1;
  job.stage = 'Thu thập dữ liệu, chạy backtest và đo rủi ro';
  const [a, bt, priceRes, indexRes] = await Promise.all([
    analyzeSymbol(symbol, { withChart: false }),
    runRankPortfolio({}).catch(() => null),
    getPriceHistory(symbol).catch(() => null),
    getPriceHistory('VNINDEX').catch(() => null),
  ]);
  if (a.isIndex) throw new Error('Hội đồng đầu tư chỉ áp dụng cho cổ phiếu');
  const risk = priceRes ? riskProfile(priceRes.bars, indexRes?.bars) : null;

  job.step = 2;
  job.stage = 'Gemini phân tích 6 yếu tố thị trường';
  const gemini = await runAi(symbol, { analysis: a, force });

  const evidence = ['\n## Căn cứ lịch sử (máy tính, backtest rổ theo thời điểm; quá khứ không đảm bảo tương lai)'];
  if (bt) evidence.push(rankEvidence(bt, a));
  if (risk) evidence.push(riskBrief(risk));
  const base = buildPrompt(a).replace(/\nHãy phân tích và trả về JSON theo schema\.$/, '') + evidence.join('\n')
    + geminiSection(gemini) + holdingSection(a) + capitalLine(a.capital);

  job.step = 3;
  job.stage = 'Phe mua và phe bán đang lập luận';
  const ask = '\n\nTrả về JSON theo schema.';
  const [bull, bear] = await Promise.all([
    callWithRetry(base + ask, aiConfig().model, { system: BULL_SYSTEM, schema: BULL_SCHEMA }),
    callWithRetry(base + ask, aiConfig().model, { system: BEAR_SYSTEM, schema: BEAR_SCHEMA }),
  ]);

  job.step = 4;
  job.stage = 'Giám đốc đầu tư thẩm định, ra quyết định và lập kế hoạch cho người đang nắm giữ';
  const debate = `${base}\n\n## Luận điểm PHE MUA\n${JSON.stringify(bull.json, null, 1)}\n\n## Luận điểm PHE BÁN\n${JSON.stringify(bear.json, null, 1)}`
    + '\n\nThẩm định hai phe và trả về quyết định cuối cùng theo schema.';
  const judge = await callWithRetry(debate, aiConfig().model, { system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA });

  const close = a.price.close;
  const sane = (v) => (Number.isFinite(v) && v > close * 0.5 && v < close * 2 ? v : null);
  const verdict = sanitizeJudge(judge.json, close);
  return {
    symbol: a.symbol,
    name: a.info.name,
    price: close,
    priceDate: a.price.date,
    model: judge.model,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    tokens: [bull, bear, judge].reduce((s, r) => s + (r.usage?.totalTokenCount || 0), 0) + (gemini.tokens || 0),
    gemini,
    // Quyết định cuối: hệ thống + hội đồng (đã đọc phân tích Gemini), lấy bên thận trọng hơn
    final: finalDecision(a, gemini, verdict),
    ruleScore: { total: a.total, label: a.recommendation.label },
    backtest: bt ? { brief: rankEvidence(bt, a), totalReturn: bt.metrics.totalReturn, buyHold: bt.metrics.benchmarkReturn, winRate: bt.metrics.winRate, trades: bt.metrics.tradeCount, maxDrawdown: bt.metrics.maxDrawdown } : null,
    risk,
    bull: {
      points: pts(bull.json.points, 'strength'), technical: String(bull.json.technical || ''), fundamental: String(bull.json.fundamental || ''),
      catalysts: strs(bull.json.catalysts), targetPrice: sane(bull.json.targetPrice), invalidation: strs(bull.json.invalidation),
    },
    bear: {
      points: pts(bear.json.points, 'severity'), technical: String(bear.json.technical || ''), valuation: String(bear.json.valuation || ''),
      riskMetrics: String(bear.json.riskMetrics || ''), downsidePrice: sane(bear.json.downsidePrice), disproof: strs(bear.json.disproof),
    },
    verdict,
  };
}

/**
 * Chạy toàn bộ quy trình quyết định cho một mã (chạy nền): Gemini → phe mua/phe bán → giám đốc đầu tư.
 * Trả trạng thái ngay. { force } bắt Gemini phân tích lại thay vì dùng kết quả cache 30 phút.
 */
export async function startCommittee(symbol, { force = false } = {}) {
  symbol = String(symbol).toUpperCase();
  if (!aiConfig().enabled) throw new Error('Chưa cấu hình API key AI nào. Xem hướng dẫn trong README.md');
  const cur = jobs.get(symbol);
  if (cur?.status === 'running') return getCommittee(symbol);
  jobs.set(symbol, { status: 'running', step: 0, steps: 4, stage: 'Chuẩn bị', error: null, startedAt: new Date().toISOString() });
  run(symbol, { force }).then(async (result) => {
    await persist(result);
    recordPrediction({ source: 'committee', symbol, date: result.priceDate, direction: DIRECTION[result.verdict.decision], label: result.verdict.decisionLabel, price: result.price, detail: `Tin cậy ${result.verdict.confidence}%`, confidence: result.verdict.confidence });
    if (result.final) {
      const dir = { BUY: 1, ACCUMULATE: 1, HOLD: 0, AVOID: -1, SELL: -1 }[result.final.code];
      recordPrediction({ source: 'final', symbol, date: result.priceDate, direction: dir, label: result.final.label, price: result.price, detail: `hội đồng: ${result.final.relation}`, confidence: result.verdict.confidence });
    }
    jobs.set(symbol, { status: 'done', stage: null, error: null });
  }).catch((err) => {
    jobs.set(symbol, { status: 'error', stage: null, error: err.message });
    console.error(`[Hội đồng] ${symbol}:`, err.message);
  });
  return getCommittee(symbol);
}

/** Trạng thái phiên họp và kết quả gần nhất của mã. */
export async function getCommittee(symbol) {
  symbol = String(symbol).toUpperCase();
  await load();
  const job = jobs.get(symbol) || { status: 'idle', stage: null, error: null };
  return { ...job, result: saved[symbol] || null };
}
