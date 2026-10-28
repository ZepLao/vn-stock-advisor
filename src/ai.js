// Phân tích chuyên sâu bằng AI (Gemini, tự chuyển sang Mistral/Groq/OpenRouter… khi hết hạn mức — xem src/llm.js).
// AI nhận toàn bộ dữ liệu đã thu thập (giá, chỉ báo, chỉ số tài chính, tin tức, điểm theo quy tắc)
// và trả về quyết định MUA/BÁN/GIỮ có cấu trúc kèm lập luận.
import { cached, uncache } from './http.js';
import { providers, providerStatus, generateJson } from './llm.js';

const MIN = 60_000;

export const MARKET_FACTORS = {
  VN_INDEX: 'Xu hướng VN-Index', DO_RONG_THANH_KHOAN: 'Độ rộng & thanh khoản', KHOI_NGOAI: 'Khối ngoại',
  NGANH: 'Dòng tiền ngành', TIN_TUC: 'Tin tức & sự kiện', CO_BAN: 'Định giá & cơ bản',
};

export const FLOW_PHASES = {
  GOM: 'ĐANG ĐƯỢC GOM', GOM_YEU: 'CÓ DẤU HIỆU GOM', GIANG_CO: 'GIẰNG CO', XA_YEU: 'CÓ DẤU HIỆU XẢ', XA: 'ĐANG BỊ XẢ',
};
const READ_CODES = ['GOM', 'TRUNG_TINH', 'XA'];
export const SCENARIOS = { TANG: 'Tăng', CO_SO: 'Cơ sở', GIAM: 'Giảm' };
export const EARNINGS_VIEWS = { TANG_TOC: 'Lợi nhuận tăng tốc', ON_DINH: 'Tăng trưởng ổn định', CHAM_LAI: 'Tăng trưởng chậm lại', SUY_GIAM: 'Lợi nhuận suy giảm', CHUA_RO: 'Chưa rõ' };
export const VALUE_VIEWS = { RE: 'Rẻ', HOP_LY: 'Hợp lý', DAT: 'Đắt', CHUA_RO: 'Chưa rõ' };

export const DECISIONS = {
  MUA: 'MUA',
  MUA_THAM_DO: 'MUA THĂM DÒ',
  GIU: 'GIỮ / THEO DÕI',
  DUNG_NGOAI: 'ĐỨNG NGOÀI',
  BAN_BOT: 'BÁN BỚT',
  BAN: 'BÁN',
};

// Bật khi có ít nhất một nhà cung cấp AI; "model" là nhà cung cấp đứng đầu để hiển thị.
export function aiConfig() {
  const list = providers();
  const status = providerStatus();
  const first = status.find((p) => p.status === 'ready') || status[0];
  return {
    enabled: list.length > 0,
    model: first ? `${first.label} · ${first.model}` : '',
    providers: status,
  };
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: Object.keys(DECISIONS), description: 'Quyết định chính' },
    headline: { type: 'STRING', description: 'MỘT câu kết luận cho nhà đầu tư, tối đa 25 từ, nêu hành động và lý do chính' },
    marketFlowView: { type: 'STRING', description: '1-2 câu: dòng tiền thị trường chung, khối ngoại toàn sàn và của mã này đang ủng hộ hay bất lợi' },
    confidence: { type: 'INTEGER', description: 'Độ tin cậy 0-100' },
    horizon: { type: 'STRING', description: 'Khung thời gian nắm giữ phù hợp, ví dụ "ngắn hạn 2-4 tuần"' },
    summary: { type: 'STRING', description: 'Tóm tắt 3-5 câu lý do chính của quyết định' },
    forNewBuyers: { type: 'STRING', description: 'Hành động cụ thể cho người chưa có cổ phiếu' },
    forHolders: { type: 'STRING', description: 'Hành động cụ thể cho người đang nắm giữ' },
    entryZone: {
      type: 'OBJECT',
      properties: { from: { type: 'NUMBER' }, to: { type: 'NUMBER' } },
      description: 'Vùng giá mua hợp lý (nghìn đồng)',
    },
    stopLoss: { type: 'NUMBER', description: 'Giá cắt lỗ (nghìn đồng)' },
    targets: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Các mức chốt lời (nghìn đồng), tăng dần' },
    positionSizing: { type: 'STRING', description: 'Gợi ý tỷ trọng vốn và cách giải ngân' },
    bullCase: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm ủng hộ mua' },
    bearCase: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm phản bác / rủi ro' },
    newsInsights: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Nhận định rút ra từ tin tức, nêu rõ tin nào' },
    catalysts: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Sự kiện có thể làm giá thay đổi mạnh sắp tới' },
    watchItems: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Tín hiệu cần theo dõi để đổi quyết định' },
    ruleScoreComment: { type: 'STRING', description: 'Đồng ý hay không với điểm theo quy tắc của hệ thống và vì sao' },
    flowAnalysis: {
      type: 'OBJECT',
      description: 'PHẦN ƯU TIÊN: phe mua / phe bán trong 7–10 phiên gần nhất — cổ phiếu đang được gom hay bị xả',
      properties: {
        sessionReads: {
          type: 'ARRAY',
          description: 'Đọc TỪNG phiên trong bảng 10 phiên, theo thứ tự ngày',
          items: {
            type: 'OBJECT',
            properties: {
              date: { type: 'STRING', description: 'YYYY-MM-DD' },
              read: { type: 'STRING', enum: READ_CODES },
              note: { type: 'STRING', description: 'Tối đa 15 từ, có số liệu (KL, vị trí đóng cửa, khối ngoại, tự doanh, chủ động)' },
            },
            required: ['date', 'read', 'note'],
          },
        },
        phase: { type: 'STRING', enum: Object.keys(FLOW_PHASES), description: 'Kết luận cả giai đoạn' },
        strength: { type: 'INTEGER', description: 'Mức rõ ràng của kết luận 0-100' },
        whoBuys: { type: 'STRING', description: 'Ai đang mua mạnh (khối ngoại / tự doanh / lệnh lớn / nhỏ lẻ), có số liệu' },
        whoSells: { type: 'STRING', description: 'Ai đang bán mạnh, có số liệu' },
        evidence: { type: 'ARRAY', items: { type: 'STRING' }, description: '3-5 bằng chứng quan trọng nhất, mỗi ý có ngày và số liệu' },
        keySessions: { type: 'STRING', description: 'Phiên then chốt (đột biến KL, phiên phân phối/hấp thụ) và ý nghĩa' },
        advice: { type: 'STRING', description: 'Lời khuyên cụ thể theo kết luận gom/xả: nên làm gì, ở vùng giá nào, chờ tín hiệu gì' },
        adviceHolders: { type: 'STRING', description: 'Lời khuyên cho người đang nắm giữ dựa trên gom/xả' },
        confirmSignal: { type: 'STRING', description: 'Tín hiệu khối lượng nào sẽ xác nhận hoặc phủ định kết luận trong các phiên tới' },
      },
      required: ['sessionReads', 'phase', 'strength', 'whoBuys', 'whoSells', 'evidence', 'keySessions', 'advice', 'adviceHolders', 'confirmSignal'],
      propertyOrdering: ['sessionReads', 'whoBuys', 'whoSells', 'evidence', 'keySessions', 'phase', 'strength', 'advice', 'adviceHolders', 'confirmSignal'],
    },
    forecast: {
      type: 'OBJECT',
      description: 'Dự báo giá 5 / 10 / 20 phiên tới theo 3 kịch bản (nghìn đồng), neo theo dải thống kê được cung cấp',
      properties: {
        scenarios: {
          type: 'ARRAY',
          description: 'ĐÚNG 3 kịch bản TANG, CO_SO, GIAM; tổng xác suất = 100',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', enum: Object.keys(SCENARIOS) },
              probability: { type: 'INTEGER', description: 'Xác suất % (0-100)' },
              p5: { type: 'NUMBER', description: 'Giá sau 5 phiên' },
              p10: { type: 'NUMBER', description: 'Giá sau 10 phiên' },
              p20: { type: 'NUMBER', description: 'Giá sau 20 phiên' },
              trigger: { type: 'STRING', description: 'Điều kiện xảy ra kịch bản (khối lượng, mốc giá), tối đa 20 từ' },
            },
            required: ['name', 'probability', 'p5', 'p10', 'p20', 'trigger'],
          },
        },
        rationale: { type: 'STRING', description: '1-2 câu: vì sao chọn xác suất như vậy (gom/xả, xu hướng, thị trường)' },
      },
      required: ['scenarios', 'rationale'],
    },
    businessView: {
      type: 'OBJECT',
      description: 'Nhận định doanh nghiệp từ KQKD theo quý, định giá, sự kiện, cổ đông, khuyến nghị CTCK',
      properties: {
        earnings: { type: 'STRING', enum: Object.keys(EARNINGS_VIEWS), description: 'Xu hướng lợi nhuận theo quý' },
        earningsNote: { type: 'STRING', description: '1-2 câu có số liệu: tăng trưởng quý gần nhất, tăng tốc/chậm lại, biên lợi nhuận, chất lượng (dòng tiền)' },
        valuation: { type: 'STRING', enum: Object.keys(VALUE_VIEWS), description: 'Định giá so với lịch sử 5 năm và ngành' },
        valuationNote: { type: 'STRING', description: '1 câu có số liệu P/E, P/B so với trung vị lịch sử và ngành' },
        eventImpact: { type: 'STRING', description: 'Sự kiện sắp tới / gần đây ảnh hưởng giá thế nào (chốt quyền, pha loãng, ĐHCĐ, báo cáo quý tới); "Không có" nếu không có' },
        nextCatalyst: { type: 'STRING', description: 'Mốc sắp tới đáng chú ý nhất (vd báo cáo Q3 trước ngày X) và kỳ vọng' },
      },
      required: ['earnings', 'earningsNote', 'valuation', 'valuationNote', 'eventImpact', 'nextCatalyst'],
      propertyOrdering: ['earningsNote', 'earnings', 'valuationNote', 'valuation', 'eventImpact', 'nextCatalyst'],
    },
    marketChecks: {
      type: 'ARRAY',
      description: 'Đánh giá ĐỦ 6 yếu tố, mỗi yếu tố 1 dòng có số liệu',
      items: {
        type: 'OBJECT',
        properties: {
          factor: { type: 'STRING', enum: ['VN_INDEX', 'DO_RONG_THANH_KHOAN', 'KHOI_NGOAI', 'NGANH', 'TIN_TUC', 'CO_BAN'] },
          status: { type: 'STRING', enum: ['TOT', 'TRUNG_TINH', 'XAU'] },
          note: { type: 'STRING', description: 'Tối đa 15 từ, có số liệu' },
        },
        required: ['factor', 'status', 'note'],
      },
    },
    planReview: {
      type: 'OBJECT',
      description: 'Thẩm định khuyến nghị và kế hoạch mua/bán của hệ thống',
      properties: {
        verdict: { type: 'STRING', enum: ['DONG_Y', 'THAN_TRONG_HON', 'TICH_CUC_HON'] },
        reason: { type: 'STRING', description: '1-2 câu, nêu yếu tố thị trường quyết định' },
      },
      required: ['verdict', 'reason'],
    },
    dataGaps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Dữ liệu còn thiếu hoặc đáng ngờ' },
  },
  required: ['flowAnalysis', 'businessView', 'forecast', 'decision', 'headline', 'marketFlowView', 'confidence', 'horizon', 'summary', 'forNewBuyers', 'forHolders',
    'stopLoss', 'targets', 'positionSizing', 'bullCase', 'bearCase', 'newsInsights', 'catalysts', 'watchItems',
    'ruleScoreComment', 'dataGaps', 'marketChecks', 'planReview'],
  propertyOrdering: ['flowAnalysis', 'businessView', 'marketChecks', 'forecast', 'summary', 'bullCase', 'bearCase', 'newsInsights', 'marketFlowView', 'catalysts', 'ruleScoreComment', 'planReview',
    'decision', 'headline', 'confidence', 'horizon', 'forNewBuyers', 'forHolders', 'entryZone', 'stopLoss', 'targets',
    'positionSizing', 'watchItems', 'dataGaps'],
};

const SYSTEM = `Bạn là chuyên viên phân tích chứng khoán Việt Nam giàu kinh nghiệm, kỷ luật và thận trọng.
Nhiệm vụ: dựa HOÀN TOÀN vào dữ liệu được cung cấp, đưa ra quyết định giao dịch cho một mã cổ phiếu.
ƯU TIÊN SỐ 1: phân tích phe mua / phe bán trong 7–10 phiên gần nhất (bảng "PHE MUA / PHE BÁN") để kết luận cổ phiếu
đang được GOM (tích lũy) hay bị XẢ (phân phối), ai đang mua / bán, rồi mới xét đến các chỉ báo dài hạn.
Cách đọc từng phiên (khối lượng là chính, giá là để xác nhận):
- Giá tăng + KL cao hơn TB20 + đóng cửa gần đỉnh (vị trí đóng cửa > +0,3) = bên mua chủ động thắng → gom.
- Giá giảm + KL cao + đóng cửa gần đáy (< −0,3) = bị xả. KL đột biến ở vùng đỉnh mà đóng cửa thấp / râu trên dài = phân phối.
- Đi ngang hoặc giảm nhẹ nhưng KL lớn và đóng cửa cao = có lực hấp thụ (gom âm thầm). Giảm với KL rất thấp = cạn cung.
- Tăng với KL thấp dần = cầu yếu, dễ đảo chiều. Khối ngoại / tự doanh mua hoặc bán ròng liên tục nhiều phiên là tín hiệu mạnh.
- Mua/bán chủ động và lệnh lớn (≥ 500 triệu/lệnh) cho biết phe nào đang chủ động và tiền lớn đứng về phía nào.
- Cột "Máy chấm" chỉ là gợi ý theo quy tắc đơn giản; bạn tự đọc lại từng phiên, được phép kết luận khác và nói vì sao.
- Thiếu dữ liệu mua/bán chủ động ở các phiên cũ là bình thường (chỉ có từ khi tool bắt đầu lưu); ghi vào dataGaps.
Lời khuyên (advice) phải gắn với kết luận gom/xả: đang gom + giá giữ hỗ trợ → mua chia lần ở vùng hỗ trợ;
đang xả → không mua, người đang giữ hạ tỷ trọng khi hồi; giằng co → chờ phiên xác nhận (nêu rõ điều kiện KL và giá).
Doanh nghiệp (businessView), xếp sau phe mua/bán về độ ưu tiên ngắn hạn nhưng quyết định chất lượng khoản đầu tư:
- Lợi nhuận quý TĂNG TỐC (tăng trưởng so cùng kỳ quý sau cao hơn quý trước) là tín hiệu tốt đã được nghiên cứu nhiều;
  lợi nhuận chậm lại / suy giảm 2 quý liên tiếp là cảnh báo dù giá đang tăng. Tăng trưởng đột biến 1 quý cần xem có bền không.
- Dòng tiền kinh doanh / lợi nhuận 4 quý < 0,5 (doanh nghiệp thường) = lợi nhuận chất lượng thấp (chưa thu được tiền).
- Định giá: so P/E, P/B với trung vị 5 năm của chính mã (phân vị thấp = rẻ so với lịch sử) và với trung vị ngành.
  Rẻ do lợi nhuận đang suy giảm thì không phải cơ hội.
- Sự kiện: ngày giao dịch không hưởng quyền cổ tức/cổ phiếu thưởng làm giá điều chỉnh kỹ thuật; phát hành thêm giá thấp
  hơn thị giá gây pha loãng và áp lực bán; ĐHCĐ bất thường cần chú ý nội dung; cảnh báo/kiểm soát là rủi ro lớn.
- Khuyến nghị CTCK chỉ là tham khảo bên ngoài: dùng % kỳ vọng tại ngày báo cáo và độ mới; giá mục tiêu chưa điều chỉnh chia tách.
- Báo cáo quý tới sắp công bố: nêu kỳ vọng dựa trên xu hướng các quý gần nhất.
Dự báo giá (forecast): dải thống kê cho biết biên độ dao động bình thường của mã (không có hướng). Bạn đặt hướng và xác suất
cho 3 kịch bản dựa trên phe mua/bán, xu hướng và thị trường. Giá kịch bản nên nằm trong dải 5%–95% trừ khi có lý do rõ ràng;
kịch bản tăng ≥ cơ sở ≥ giảm ở mọi mốc; tổng xác suất 100. Không chắc chắn thì để xác suất các kịch bản gần nhau.
Kịch bản tăng là mức giá điển hình KHI giá đi lên nên phải ≥ mức 75% của dải, kịch bản giảm ≤ mức 25%; đừng đặt hai kịch bản
này sát giá hiện tại. Thực tế đã kiểm chứng: biến động thật thường rộng hơn bạn nghĩ.
Nguyên tắc:
- Chỉ dùng số liệu có trong dữ liệu; không bịa thêm số liệu, sự kiện hay tin tức. Thiếu dữ liệu thì ghi vào dataGaps.
- Cân nhắc cả xu hướng kỹ thuật, định giá, chất lượng tăng trưởng, tin tức và bối cảnh VN-Index.
- Điểm xếp hạng 4 yếu tố là tín hiệu định lượng chính (lợi thế lịch sử nhỏ, không chắc chắn); điểm kỹ thuật kiểu cũ chỉ để tham khảo. Chỉ chọn MUA khi
  mã thuộc nhóm điểm ≥ 70 và giá trên MA200, trừ khi có lý do rất rõ trong dữ liệu.
- Không dựa vào một chỉ báo đơn lẻ: xác nhận chéo xu hướng (MA + ADX), động lượng (RSI + MACD + Stochastic),
  dòng tiền (MFI + OBV + khối lượng + khối ngoại) và sức mạnh tương đối so với VN-Index. Nêu rõ khi các nhóm mâu thuẫn.
- Tiêu đề tin tức chỉ là tín hiệu; nhãn cảm xúc do máy chấm theo từ khóa nên có thể sai, hãy tự đánh giá lại.
  Đối chiếu tin với phản ứng giá của phiên sau khi tin ra: tin tốt mà giá giảm là dấu hiệu tin đã được phản ánh hoặc lực bán mạnh.
  Ưu tiên tin về kết quả kinh doanh, giao dịch nội bộ, cổ tức và pháp lý hơn tin mô tả diễn biến giá.
- Ưu tiên bảo toàn vốn: khi tín hiệu trái chiều hãy chọn GIU hoặc DUNG_NGOAI thay vì MUA.
- BẮT BUỘC kiểm tra 6 yếu tố trong marketChecks trước khi kết luận: xu hướng VN-Index (so với MA50, MA200),
  độ rộng và thanh khoản thị trường, khối ngoại (toàn sàn và mã này), dòng tiền ngành của mã, tin tức/sự kiện,
  định giá và tăng trưởng. Nếu từ 3 yếu tố XAU trở lên, hoặc VN-Index dưới MA200 kèm khối ngoại bán ròng mạnh,
  thì không chọn MUA (tối đa MUA_THAM_DO).
- Thẩm định kế hoạch của hệ thống trong planReview: DONG_Y nếu phù hợp; THAN_TRONG_HON nếu yếu tố thị trường,
  tin tức hoặc rủi ro khiến nên hạ mức (nêu yếu tố cụ thể); TICH_CUC_HON chỉ khi dữ liệu rất rõ ràng.
  Quyết định cuối sẽ lấy bên thận trọng hơn giữa bạn và hệ thống.
- Giá tính bằng nghìn đồng. Biên độ HOSE ±7%, HNX ±10%, UPCoM ±15%; giao dịch T+2.
- Cắt lỗ phải thấp hơn giá hiện tại; mục tiêu phải cao hơn giá hiện tại.
- Viết bằng tiếng Việt CÓ DẤU đầy đủ (không viết không dấu), ngắn gọn, cụ thể, có con số.
Các lựa chọn decision: MUA (mua mạnh), MUA_THAM_DO (mua tỷ trọng nhỏ), GIU (giữ/theo dõi), DUNG_NGOAI (chưa mua),
BAN_BOT (hạ tỷ trọng), BAN (bán toàn bộ).`;

const n = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : Number(v.toFixed(d)));
const p = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

const tỷ = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${(v / 1e9).toFixed(1)} tỷ`);
// Khối lượng theo nghìn cổ phiếu, không dùng dấu phân cách để AI không đọc nhầm (2513k = 2.513.000 cp)
const kcp = (v) => (v == null ? 'n/a' : `${Math.round(v / 1000)}k`);

const pc0 = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);

/** Hồ sơ doanh nghiệp: KQKD theo quý, định giá so với lịch sử / ngành, sự kiện, cổ đông, khuyến nghị CTCK. */
function companySection(a) {
  const c = a.company;
  if (!c) return '';
  const L = [];
  const e = c.earnings;
  if (e) {
    L.push(`\n## Kết quả kinh doanh theo quý (${e.bank ? 'ngân hàng: doanh thu = tổng thu nhập hoạt động' : 'tỷ đồng'})`);
    L.push('Quý | doanh thu (so cùng kỳ) | lợi nhuận sau thuế cty mẹ (so cùng kỳ) | biên LN gộp | biên LN ròng | dòng tiền KD');
    for (const q of e.quarters.slice(-8)) {
      L.push(`${q.label} | ${q.revenue != null ? Math.round(q.revenue / 1e9) : 'n/a'} (${pc0(q.revenueYoY)}) | ${q.profit != null ? Math.round(q.profit / 1e9) : 'n/a'} (${pc0(q.profitYoY)}) | ${q.grossMargin != null ? (q.grossMargin * 100).toFixed(1) + '%' : 'n/a'} | ${q.netMargin != null ? (q.netMargin * 100).toFixed(1) + '%' : 'n/a'} | ${q.cfo != null ? Math.round(q.cfo / 1e9) : 'n/a'}`);
    }
    L.push(`Máy tính: quý gần nhất ${e.latest} lợi nhuận ${pc0(e.profitYoY)} so cùng kỳ, thay đổi tốc độ ${e.accel != null ? (e.accel > 0 ? '+' : '') + Math.round(e.accel * 100) + ' điểm %' : 'n/a'} → ${e.trend}; `
      + `${e.growthStreak ? `${e.growthStreak} quý liên tiếp tăng trưởng` : e.declineStreak ? `${e.declineStreak} quý liên tiếp suy giảm` : ''}; LN 4 quý ${pc0(e.profitTTMGrowth)}; `
      + `ROE 4 quý ${e.roeTTM != null ? (e.roeTTM * 100).toFixed(1) + '%' : 'n/a'}; dòng tiền KD / LN 4 quý ${e.cfoToProfit ?? 'không áp dụng'}; `
      + `báo cáo ${e.nextReport.quarter} dự kiến trước ${e.nextReport.dueBy}.`);
  }
  const v = c.valuation;
  if (v) {
    L.push('\n## Định giá so với lịch sử 5 năm và ngành');
    const h = (x, name) => (x ? `${name} ${x.current} (trung vị 5 năm ${x.median}, thấp nhất ${x.min}, cao nhất ${x.max}, đắt hơn ${Math.round(x.percentile * 100)}% số ngày trong lịch sử)` : `${name} n/a`);
    L.push(`${h(v.pe, 'P/E')}; ${h(v.pb, 'P/B')}`);
    if (v.sector) L.push(`Trung vị ${v.sector.n} mã cùng ngành trong rổ: P/E ${v.sector.pe}, P/B ${v.sector.pb}, ROE ${v.sector.roe != null ? (v.sector.roe * 100).toFixed(1) + '%' : 'n/a'}`);
  }
  const ev = c.events;
  if (ev && (ev.upcoming.length || ev.recent.length || ev.alerts.length)) {
    L.push('\n## Sự kiện doanh nghiệp');
    for (const x of ev.upcoming) L.push(`SẮP TỚI ${x.date}: ${x.label} — ${x.note}${x.dilutive ? ' (có thể pha loãng / điều chỉnh giá)' : ''}`);
    for (const x of ev.recent.slice(0, 6)) L.push(`Đã diễn ra ${x.date}: ${x.label} — ${x.note}`);
    for (const x of ev.alerts) L.push(`CẢNH BÁO ${x.date}: ${x.label} — ${x.note}`);
  }
  if (c.holders?.length) L.push(`\nCổ đông lớn (dữ liệu ${c.holders[0].date}): ${c.holders.slice(0, 5).map((x) => `${x.name} ${x.pct}%`).join('; ')}`);
  if (c.brokers?.length) {
    L.push('\n## Khuyến nghị công ty chứng khoán ≤ 12 tháng (giá chưa điều chỉnh chia tách, dùng % kỳ vọng)');
    for (const b of c.brokers.slice(0, 6)) L.push(`${b.date} ${b.firm}: ${b.type}, giá lúc báo cáo ${b.reportPrice}, mục tiêu ${b.targetPrice} (${pc0(b.upside)}), cách đây ${b.ageDays} ngày`);
  }
  return L.join('\n');
}

/** Bảng phe mua / phe bán 7–10 phiên gần nhất (phần dữ liệu ưu tiên). */
function flowSection(a) {
  const f = a.orderFlow;
  if (!f) return '';
  const L = [`\n## ƯU TIÊN — PHE MUA / PHE BÁN ${f.n} PHIÊN GẦN NHẤT (${f.from} → ${f.to})`];
  L.push('Cột: ngày | mở,cao,thấp,đóng | % giá | khối lượng (×TB20) | vị trí đóng cửa trong biên độ (−1 đáy … +1 đỉnh) | khối ngoại ròng | tự doanh ròng | mua chủ động/bán chủ động, lệnh lớn mua/bán | máy chấm');
  const bars = new Map((a.recentBars || []).map((b) => [b.time, b]));
  for (const d of f.sessions) {
    const b = bars.get(d.date);
    const act = d.active ? `CĐ mua ${kcp(d.active.buy)}/bán ${kcp(d.active.sell)} (${Math.round(d.active.buyRatio * 100)}% mua), lệnh lớn mua ${kcp(d.active.bigBuy)}/bán ${kcp(d.active.bigSell)}` : 'CĐ: chưa có';
    L.push(`${d.date} | ${b ? `${b.open},${b.high},${b.low},${b.close}` : d.close} | ${d.chg > 0 ? '+' : ''}${d.chg}% | ${kcp(d.volume)} (×${d.volRatio}) | ${d.clv} | NN ${tỷ(d.foreignNet)} | TD ${tỷ(d.propNet)} | ${act} | ${d.read}${d.why.length ? ` (${d.why.join('; ')})` : ''}`);
  }
  L.push(`Tổng ${f.n} phiên: giá ${f.priceChg > 0 ? '+' : ''}${f.priceChg}%; KL phiên tăng / KL phiên giảm = ${f.upDownVolRatio ?? 'n/a'}; KL trung bình ×${f.volVs20} TB20; `
    + `chỉ số tích lũy/phân phối (KL theo vị trí đóng cửa) ${f.adLine}; khối ngoại ${tỷ(f.foreignNet)}; tự doanh ${tỷ(f.propNet)}; `
    + `máy chấm ${f.gomDays} phiên gom / ${f.xaDays} phiên xả, điểm ${f.score} → gợi ý ${f.phase}.`);
  if (f.activeDays) L.push(`Mua/bán chủ động có dữ liệu ${f.activeDays} phiên: mua ${kcp(f.activeBuy)} / bán ${kcp(f.activeSell)}; lệnh lớn mua ${kcp(f.bigBuy)} / bán ${kcp(f.bigSell)}.`);
  if (f.today && !f.sessions.some((d) => d.date === f.today.date)) {
    L.push(`Phiên đang diễn ra ${f.today.date}: chủ động mua ${kcp(f.today.buy)} / bán ${kcp(f.today.sell)} (${Math.round((f.today.buyRatio ?? 0) * 100)}% mua), lệnh lớn mua ${kcp(f.today.bigBuy)} / bán ${kcp(f.today.bigSell)}.`);
  }
  return L.join('\n');
}

function buildPrompt(a) {
  const f = a.fundamental.data;
  const i = a.technical.indicators;
  const lines = [];
  lines.push(`# Mã ${a.symbol} - ${a.info.name} (${a.info.exchange})`);
  lines.push(`Ngày dữ liệu: ${a.price.date}. Giá đóng cửa: ${a.price.close} (${a.price.changePct}% so với phiên trước).`);
  if (a.market) {
    const m = a.market;
    lines.push(`VN-Index: ${m.close} (${m.changePct}%), xu hướng ngắn: ${m.trend}; MA50 ${m.ma50 ?? 'n/a'}, MA200 ${m.ma200 ?? 'n/a'} → ${m.aboveMa200 === false ? 'DƯỚI MA200' : m.aboveMa200 ? 'trên MA200' : 'n/a'}; 20 phiên ${m.return20d ?? 'n/a'}%.`);
  }
  if (a.sector) {
    lines.push(`Ngành của mã: ${a.sector.name}, dòng tiền ròng ước tính ${(a.sector.net / 1e9).toFixed(0)} tỷ trong ${a.sector.period} phiên, xếp ${a.sector.rank}/${a.sector.total} ngành (1 = hút tiền mạnh nhất).`);
  }

  lines.push(flowSection(a));
  lines.push(companySection(a));
  if (a.cone?.length) {
    lines.push('\n## Dải dao động thống kê các phiên tới (từ lợi suất ~2 năm của chính mã này, không có hướng)');
    for (const c of a.cone) lines.push(`Sau ${c.h} phiên: 5% ${c.p05} | 25% ${c.p25} | trung vị ${c.p50} | 75% ${c.p75} | 95% ${c.p95}`);
  }

  lines.push('\n## Chỉ báo kỹ thuật (bối cảnh dài hạn, xếp sau phần phe mua / phe bán)');
  lines.push(`MA20 ${n(i.sma20)}, MA50 ${n(i.sma50)}, MA200 ${n(i.sma200)}; RSI14 ${n(i.rsi14, 1)}; MACD ${n(i.macd, 3)} / signal ${n(i.macdSignal, 3)} / hist ${n(i.macdHist, 3)}`);
  lines.push(`Bollinger ${n(i.bbLower)} - ${n(i.bbUpper)}; ATR14 ${n(i.atr14)}; KL phiên ${i.volume}, TB20 ${i.avgVolume20}`);
  lines.push(`Hiệu suất: 5 phiên ${i.return5d}%, 20 phiên ${i.return20d}%, 60 phiên ${i.return60d}%, 1 năm ${i.return250d}%`);
  if (a.plan) lines.push(`Hỗ trợ 20 phiên ${a.plan.support}, kháng cự 20 phiên ${a.plan.resistance}`);
  lines.push(`ADX14 ${n(i.adx14, 1)} (+DI ${n(i.plusDI, 1)} / −DI ${n(i.minusDI, 1)}); Stochastic %K ${n(i.stochK, 1)} / %D ${n(i.stochD, 1)}; MFI14 ${n(i.mfi14, 1)}; OBV ${i.obvTrend ?? 'n/a'}; phân kỳ RSI: ${i.rsiDivergence ?? 'không'}`);
  lines.push(`KL TB5 ${i.avgVolume5} so với TB20 ${i.avgVolume20}; sức mạnh so với VN-Index: 20 phiên ${i.rs20 ?? 'n/a'} điểm %, 60 phiên ${i.rs60 ?? 'n/a'} điểm %`);

  if (a.overview?.length) {
    lines.push('\n## Tổng hợp theo nhóm chỉ báo (máy tính)');
    for (const o of a.overview) lines.push(`- ${o.label}: ${o.verdict} (${o.detail})`);
  }

  if (a.marketFlow) {
    const mf = a.marketFlow;
    lines.push(`\n## Mua bán toàn sàn ${mf.floor} phiên ${mf.date}`);
    lines.push(`Độ rộng: ${mf.advancers} mã tăng / ${mf.decliners} mã giảm / ${mf.unchanged} đứng giá; giá trị khớp lệnh ${(mf.totalValue / 1e9).toFixed(0)} tỷ`);
    lines.push(`Khối ngoại toàn sàn: mua ${(mf.foreign.buyVal / 1e9).toFixed(0)} tỷ, bán ${(mf.foreign.sellVal / 1e9).toFixed(0)} tỷ, ròng ${(mf.foreign.netVal / 1e9).toFixed(0)} tỷ`);
    lines.push(`Khối ngoại mua ròng nhiều nhất: ${mf.topForeignBuy.join(', ')}; bán ròng nhiều nhất: ${mf.topForeignSell.join(', ')}`);
  }

  if (a.foreign?.history?.length) {
    lines.push('\n## Khối ngoại 20 phiên (ngày: mua ròng tỷ đồng)');
    lines.push(a.foreign.history.map((d) => `${d.date.slice(5)}: ${(d.netVal / 1e9).toFixed(1)}`).join('; '));
    lines.push(`Tổng 5 phiên ${(a.foreign.net5 / 1e9).toFixed(1)} tỷ, 20 phiên ${(a.foreign.net20 / 1e9).toFixed(1)} tỷ (${a.foreign.ratio20}% giá trị khớp lệnh)`);
  }

  if (!a.orderFlow) {
    lines.push('\n## Giá 10 phiên gần nhất (ngày,mở,cao,thấp,đóng,khối lượng)');
    for (const b of a.recentBars.slice(-10)) lines.push(`${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
  }

  if (f) {
    lines.push(`\n## Chỉ số tài chính (BCTC đến ${f.reportDate || 'n/a'})`);
    lines.push(`P/E ${n(f.pe, 1)}, P/B ${n(f.pb)}, P/S ${n(f.ps)}, EPS 4 quý ${n(f.epsTTM, 0)} đ, BVPS ${n(f.bookValuePerShare, 0)} đ`);
    lines.push(`ROE ${p(f.roe)}, ROA ${p(f.roa)}, biên LN gộp ${p(f.grossMarginTTM)}, biên LN ròng ${p(f.netMarginTTM)}`);
    lines.push(`Tăng trưởng LN 4 quý ${p(f.profitGrowthTTM)}, DT 4 quý ${p(f.revenueGrowthTTM)}, LN quý gần nhất so cùng kỳ ${p(f.profitGrowthQoQYoY)}, DT quý so cùng kỳ ${p(f.revenueGrowthQYoY)}, LN BQ 3 năm ${p(f.profitGrowth3Y)}`);
    lines.push(`Nợ vay/VCSH ${n(f.debtToEquity)}, thanh toán hiện hành ${n(f.currentRatio)}, tỷ suất cổ tức ${p(f.dividendYield)}, beta ${n(f.beta)}`);
    lines.push(`Vốn hóa ${n(f.marketCap / 1e9, 0)} tỷ đ, đỉnh/đáy 52 tuần ${n(f.high52w / 1000)}/${n(f.low52w / 1000)}, sở hữu nước ngoài ${p(f.foreignOwnership)}`);
  }

  if (a.news.categories?.length) {
    lines.push('\n## Tin theo nhóm sự kiện (số tin, điểm cảm xúc TB −100..100)');
    lines.push(a.news.categories.map((c) => `${c.label}: ${c.count} tin, ${c.sentiment}`).join('; '));
  }
  const removed = a.news.aiFilter?.removed?.length || 0;
  lines.push(`\n## Tin tức ${a.news.count} tin gần đây (mới nhất trước; [nhãn | nhóm] nguồn, ngày, giá phiên sau tin: tiêu đề; nhãn "AI:" = đã được AI lọc tin đọc và xác nhận liên quan, còn lại là nhãn từ khóa)${removed ? `. Đã bỏ ${removed} tin không nói về mã này.` : ''}`);
  for (const it of a.news.items.slice(0, 30)) {
    const date = it.publishedAt ? new Date(it.publishedAt).toISOString().slice(0, 10) : '?';
    const cats = it.categories?.length ? ` | ${it.categories.join(',')}` : '';
    const react = it.reaction ? `, giá ${it.reaction.pct > 0 ? '+' : ''}${it.reaction.pct}%` : '';
    const lbl = it.ai ? `AI:${it.label}${it.ai.risk ? ',RỦI RO' : ''}` : it.label;
    lines.push(`- [${lbl}${cats}] ${it.source}, ${date}${react}: ${it.title}${it.summary ? ` — ${it.summary.slice(0, 200)}` : ''}`);
  }

  if (a.ranking) {
    const r = a.ranking;
    lines.push('\n## Điểm xếp hạng 4 yếu tố (tín hiệu CHÍNH)');
    lines.push(`Điểm ${r.score}/100, hạng ${r.position}/${r.universe} trong rổ HOSE thanh khoản ≥ 5 tỷ; giá ${r.aboveMa200 === false ? 'DƯỚI' : 'trên'} MA200. Phân vị: động lượng 12 tháng ${r.parts.mom ?? 'n/a'}, gần đỉnh 52 tuần ${r.parts.high ?? 'n/a'}, biến động thấp ${r.parts.atr ?? 'n/a'}, ADX ${r.parts.adx ?? 'n/a'}.`);
    lines.push(`Khuyến nghị hệ thống: ${a.recommendation.label} — ${a.recommendation.desc}`);
    lines.push('Lưu ý bằng chứng: nghiên cứu cũ cho nhóm ≥ 70 trên MA200 lợi thế nhỏ so với VN-Index nhưng chạy trên rổ hiện tại (thiên lệch sống sót), nên lợi thế thật có thể nhỏ hơn hoặc không có. Không coi điểm xếp hạng là chắc chắn.');
    lines.push(`Hạng trong nhóm trên MA200: ${r.pfRank ?? 'không thuộc nhóm (dưới MA200)'}. Danh mục mẫu của hệ thống là top 8 mã trên MA200, đổi mỗi 20 phiên; từng mã được chọn chỉ thắng VN-Index ~51% số lần trong lịch sử, lợi thế (nếu có) đến từ cả rổ chứ không từ từng mã (danh mục mẫu không dùng cắt lỗ), và 12 tháng gần nhất danh mục này thua VN-Index.`);
  }
  lines.push('\n## Điểm kỹ thuật/cơ bản/tin tức kiểu cũ (−100..100) — CHỈ THAM KHẢO: đã kiểm chứng KHÔNG dự báo được hướng giá');
  lines.push(`Tổng ${a.total} (${a.legacy?.label ?? ''}). Kỹ thuật ${a.scores.technical}, cơ bản ${a.scores.fundamental ?? 'n/a'}, tin tức ${a.scores.news ?? 'n/a'}.`);
  for (const s of [...a.technical.signals, ...a.fundamental.signals, ...a.news.signals]) lines.push(`- (${s.points > 0 ? '+' : ''}${s.points}) ${s.text}`);
  for (const w of a.warnings) lines.push(`- CẢNH BÁO: ${w}`);

  const b = a.brief;
  if (b?.levels) {
    const l = b.levels;
    const side = { buy: 'Mua', sell: 'Bán', stop: 'Cắt lỗ', wait: 'Chờ' };
    const step = (x) => `${side[x.side]} ${x.zone ? `${x.zone[0]}-${x.zone[1]}` : x.price ?? ''}${x.portion ? ` (${Math.round(x.portion * 100)}% vốn)` : ''}: ${x.condition}`;
    lines.push('\n## Kế hoạch của hệ thống (cần bạn thẩm định)');
    lines.push(`Khuyến nghị: ${b.verdict}. Bậc thang giá: kháng cự 2 ${l.r2}, kháng cự 1 ${l.r1}, giá ${l.close}, hỗ trợ 1 ${l.s1}${l.s2 != null ? `, hỗ trợ 2 ${l.s2}` : ''}, cắt lỗ ${l.stop}; tỷ trọng tối đa ${Math.round((l.weight ?? 0.1) * 100)}% vốn.`);
    if (b.steps) {
      lines.push('Người chưa có: ' + b.steps.fresh.map(step).join(' | '));
      lines.push('Người đang giữ: ' + b.steps.hold.map(step).join(' | '));
    }
  }
  lines.push('\nHãy phân tích và trả về JSON theo schema.');
  return lines.join('\n');
}

/** Văn bản tiếng Việt có dấu: ≥ 5% chữ cái mang dấu (tiếng Việt có dấu thường 20–40%). */
export function hasDiacritics(text) {
  const letters = String(text).match(/\p{L}/gu) || [];
  if (letters.length < 30) return true; // quá ngắn để kết luận
  const marked = letters.filter((ch) => /[^a-zA-Z]/.test(ch.normalize('NFD').replace(/[̀-ͯ]/g, '')) || ch.normalize('NFD').length > 1).length;
  return marked / letters.length >= 0.05;
}

/** Giữ tên cũ cho các module đang dùng; tham số model bị bỏ qua vì lớp llm tự chọn nhà cung cấp. */
export async function callWithRetry(prompt, _model, { system = SYSTEM, schema = SCHEMA, timeout = 180_000 } = {}) {
  return generateJson(prompt, { system, schema, timeout });
}

/**
 * Làm sạch kịch bản: đủ 3 kịch bản, giá hợp lý, sắp tăng ≥ cơ sở ≥ giảm, xác suất chuẩn hóa về 100.
 * Có dải thống kê thì kịch bản tăng ít nhất bằng mức 75%, kịch bản giảm nhiều nhất bằng mức 25%: Gemini hay đặt
 * hai kịch bản này quá sát giá hiện tại (16–19/10: 3/7 mã vượt khỏi vùng 5 phiên chỉ sau 2 phiên).
 */
export function sanitizeForecast(f, close, cone = null) {
  if (!f || !Array.isArray(f.scenarios)) return null;
  const sane = (v) => (Number.isFinite(v) && v > close * 0.5 && v < close * 2 ? Math.round(v * 100) / 100 : null);
  const byName = new Map();
  for (const s of f.scenarios) {
    if (!SCENARIOS[s?.name] || byName.has(s.name)) continue;
    const p5 = sane(s.p5), p10 = sane(s.p10), p20 = sane(s.p20);
    if (p5 == null || p10 == null || p20 == null) continue;
    byName.set(s.name, { name: s.name, label: SCENARIOS[s.name], probability: Math.max(0, Number(s.probability) || 0), p5, p10, p20, trigger: String(s.trigger || '').trim() });
  }
  if (byName.size !== 3) return null;
  const list = ['TANG', 'CO_SO', 'GIAM'].map((k) => byName.get(k));
  // Bảo đảm thứ tự ở mọi mốc
  for (const h of ['p5', 'p10', 'p20']) {
    const v = list.map((s) => s[h]).sort((a, b) => b - a);
    list.forEach((s, i) => { s[h] = v[i]; });
    const c = cone?.find((x) => `p${x.h}` === h);
    if (c?.p75 != null) list[0][h] = Math.max(list[0][h], c.p75);
    if (c?.p25 != null) list[2][h] = Math.min(list[2][h], c.p25);
  }
  const tot = list.reduce((a, s) => a + s.probability, 0) || 3;
  list.forEach((s) => { s.probability = tot ? Math.round((s.probability / tot) * 100) : 33; });
  const expected = Object.fromEntries(['p5', 'p10', 'p20'].map((h) => [h, Math.round(list.reduce((a, s) => a + s[h] * s.probability, 0)) / 100]));
  return { scenarios: list, expected, rationale: String(f.rationale || '').trim() };
}

function sanitizeFlow(f) {
  if (!f || typeof f !== 'object' || !FLOW_PHASES[f.phase]) return null;
  const str = (v) => String(v || '').trim();
  return {
    phase: f.phase, phaseLabel: FLOW_PHASES[f.phase],
    strength: Math.max(0, Math.min(100, Math.round(f.strength ?? 0))),
    whoBuys: str(f.whoBuys), whoSells: str(f.whoSells),
    evidence: (Array.isArray(f.evidence) ? f.evidence : []).map(str).filter(Boolean),
    keySessions: str(f.keySessions), advice: str(f.advice), adviceHolders: str(f.adviceHolders), confirmSignal: str(f.confirmSignal),
    sessionReads: (Array.isArray(f.sessionReads) ? f.sessionReads : [])
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x?.date || '') && READ_CODES.includes(x.read))
      .map((x) => ({ date: x.date, read: x.read, note: str(x.note) })),
  };
}

// Kiểm tra lại số liệu Gemini trả về: loại bỏ mức giá vô lý so với giá hiện tại
function sanitize(r, close, cone = null) {
  const sane = (v) => (Number.isFinite(v) && v > close * 0.5 && v < close * 2 ? v : null);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  const stop = sane(r.stopLoss);
  const ez = r.entryZone && sane(r.entryZone.from) && sane(r.entryZone.to)
    ? { from: Math.min(r.entryZone.from, r.entryZone.to), to: Math.max(r.entryZone.from, r.entryZone.to) } : null;
  return {
    decision: DECISIONS[r.decision] ? r.decision : 'GIU',
    decisionLabel: DECISIONS[r.decision] || DECISIONS.GIU,
    confidence: Math.max(0, Math.min(100, Math.round(r.confidence ?? 0))),
    horizon: String(r.horizon || ''),
    summary: String(r.summary || ''),
    headline: String(r.headline || ''),
    marketFlowView: String(r.marketFlowView || ''),
    forNewBuyers: String(r.forNewBuyers || ''),
    forHolders: String(r.forHolders || ''),
    entryZone: ez,
    stopLoss: stop != null && stop < close ? stop : null,
    targets: (Array.isArray(r.targets) ? r.targets : []).map(sane).filter((v) => v != null && v > close).sort((a, b) => a - b),
    positionSizing: String(r.positionSizing || ''),
    bullCase: arr(r.bullCase),
    bearCase: arr(r.bearCase),
    newsInsights: arr(r.newsInsights),
    catalysts: arr(r.catalysts),
    watchItems: arr(r.watchItems),
    ruleScoreComment: String(r.ruleScoreComment || ''),
    dataGaps: arr(r.dataGaps),
    flowAnalysis: sanitizeFlow(r.flowAnalysis),
    forecast: sanitizeForecast(r.forecast, close, cone),
    businessView: r.businessView && EARNINGS_VIEWS[r.businessView.earnings] ? {
      earnings: r.businessView.earnings, earningsLabel: EARNINGS_VIEWS[r.businessView.earnings],
      earningsNote: String(r.businessView.earningsNote || ''),
      valuation: VALUE_VIEWS[r.businessView.valuation] ? r.businessView.valuation : 'CHUA_RO',
      valuationLabel: VALUE_VIEWS[r.businessView.valuation] || VALUE_VIEWS.CHUA_RO,
      valuationNote: String(r.businessView.valuationNote || ''),
      eventImpact: String(r.businessView.eventImpact || ''), nextCatalyst: String(r.businessView.nextCatalyst || ''),
    } : null,
    marketChecks: (Array.isArray(r.marketChecks) ? r.marketChecks : [])
      .filter((x) => MARKET_FACTORS[x?.factor] && ['TOT', 'TRUNG_TINH', 'XAU'].includes(x.status))
      .map((x) => ({ factor: x.factor, label: MARKET_FACTORS[x.factor], status: x.status, note: String(x.note || '') })),
    planReview: r.planReview && ['DONG_Y', 'THAN_TRONG_HON', 'TICH_CUC_HON'].includes(r.planReview.verdict)
      ? { verdict: r.planReview.verdict, reason: String(r.planReview.reason || '') } : null,
  };
}

/**
 * Gửi kết quả analyzeSymbol() cho Gemini. Kết quả được cache 30 phút cho mỗi mã + phiên giá + model,
 * truyền { force: true } để bắt buộc gọi lại.
 */
export function aiAnalyze(analysis, { force = false } = {}) {
  const cfg = aiConfig();
  if (!cfg.enabled) {
    return Promise.reject(new Error('Chưa cấu hình API key AI nào (GEMINI_API_KEY, MISTRAL_API_KEY…). Xem hướng dẫn trong README.md'));
  }
  if (analysis.isIndex) return Promise.reject(new Error('Phân tích AI chỉ áp dụng cho cổ phiếu'));
  const useModel = cfg.model;
  const key = `ai:${analysis.symbol}:${analysis.price.date}:${analysis.price.close}`;
  const run = async () => {
    const started = Date.now();
    const prompt = buildPrompt(analysis);
    let { json, usage, model } = await callWithRetry(prompt, useModel);
    // Model dự phòng đôi khi viết tiếng Việt không dấu: yêu cầu viết lại một lần
    if (!hasDiacritics(`${json.summary || ''} ${json.headline || ''} ${json.forNewBuyers || ''}`)) {
      const again = await callWithRetry(`${prompt}\n\nLƯU Ý: lần trước bạn viết tiếng Việt KHÔNG DẤU. Bắt buộc viết tiếng Việt CÓ DẤU đầy đủ trong mọi trường văn bản.`, useModel).catch(() => null);
      if (again?.json && hasDiacritics(`${again.json.summary || ''} ${again.json.headline || ''}`)) ({ json, usage, model } = again);
    }
    return {
      symbol: analysis.symbol,
      price: analysis.price.close,
      priceDate: analysis.price.date,
      model,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      tokens: usage?.totalTokenCount ?? null,
      ...sanitize(json, analysis.price.close, analysis.cone),
    };
  };
  if (force) uncache(key);
  return cached(key, 30 * MIN, run);
}

export { buildPrompt };

// ---------- Xếp hạng cổ phiếu tiềm năng (một lần gọi cho cả danh sách) ----------
export const PICK_VERDICTS = { MUA: 'MUA', MUA_THAM_DO: 'MUA THĂM DÒ', CHO_DIEM_MUA: 'CHỜ ĐIỂM MUA', LOAI: 'LOẠI' };

const PICK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    marketView: { type: 'STRING', description: '2-3 câu: bối cảnh thị trường và dòng tiền hiện tại có thuận lợi để mua mới không' },
    picks: {
      type: 'ARRAY',
      description: 'Đánh giá TỪNG mã trong danh sách, sắp xếp từ hấp dẫn nhất',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' },
          verdict: { type: 'STRING', enum: Object.keys(PICK_VERDICTS) },
          confidence: { type: 'INTEGER', description: '0-100' },
          thesis: { type: 'STRING', description: '2-3 câu: vì sao mã này có tiềm năng, dựa trên số liệu được cung cấp' },
          trigger: { type: 'STRING', description: 'Điều kiện cụ thể để mua (vd: giá về vùng X hoặc vượt Y kèm khối lượng)' },
          mainRisk: { type: 'STRING', description: 'Rủi ro lớn nhất' },
          entryFrom: { type: 'NUMBER' },
          entryTo: { type: 'NUMBER' },
          stopLoss: { type: 'NUMBER' },
          target: { type: 'NUMBER' },
          horizon: { type: 'STRING', description: 'Khung thời gian nắm giữ' },
          horizonDays: { type: 'INTEGER', description: 'Số PHIÊN giao dịch dự kiến để giá đạt mục tiêu (5–60)' },
        },
        required: ['symbol', 'verdict', 'confidence', 'thesis', 'trigger', 'mainRisk', 'entryFrom', 'entryTo', 'stopLoss', 'target', 'horizon', 'horizonDays'],
        propertyOrdering: ['symbol', 'thesis', 'mainRisk', 'verdict', 'confidence', 'trigger', 'entryFrom', 'entryTo', 'stopLoss', 'target', 'horizon', 'horizonDays'],
      },
    },
    note: { type: 'STRING', description: 'Lưu ý chung về quản lý vốn khi mua các mã này' },
  },
  required: ['marketView', 'picks', 'note'],
  propertyOrdering: ['marketView', 'picks', 'note'],
};

const PICK_SYSTEM = `Bạn là chuyên viên phân tích chứng khoán Việt Nam, kỷ luật và thận trọng.
Nhiệm vụ: từ danh sách cổ phiếu đã được bộ lọc định lượng chọn ra, đánh giá mã nào thực sự đáng mua trong 1-3 tháng tới.
Nguyên tắc:
- Chỉ dùng dữ liệu được cung cấp, không bịa số liệu hay tin tức. Không hứa hẹn lợi nhuận.
- Các mã đều đã qua lọc: điểm xếp hạng 4 yếu tố ≥ 70 và giá trên MA200; thanh khoản đều (giá trị khớp lệnh ≥ 5 tỷ
  ở ít nhất 16/20 phiên); doanh nghiệp "ngon" (có lãi, ROE ≥ 12%, lợi nhuận 4 quý không giảm, P/E ≤ 25, nợ vay/vốn chủ ≤ 1,5
  trừ ngân hàng/chứng khoán/bảo hiểm); thuộc ngành đang được mua ròng 5 phiên hoặc top 5 ngành hút tiền.
  Ưu tiên mã thuộc ngành dẫn dắt dòng tiền (hạng ngành cao, dòng tiền ròng lớn). Nhiệm vụ của bạn là loại mã có rủi ro tin tức, chất lượng lợi nhuận đáng ngờ
  (tăng trưởng đột biến một lần), định giá quá đắt so với tăng trưởng hoặc đang tăng quá nóng.
- Ưu tiên mã có nhiều nhóm tín hiệu cùng chiều (xu hướng, động lượng, dòng tiền, khối ngoại, cơ bản, tin tức).
- Thị trường chung xấu thì hạ mức quyết định (MUA → MUA_THAM_DO hoặc CHO_DIEM_MUA) và nói rõ.
- Mã đã tăng nóng (RSI > 70, xa MA20) thì chọn CHO_DIEM_MUA với vùng mua thấp hơn giá hiện tại.
- LOAI nếu rủi ro lớn hơn tiềm năng. Được phép loại nhiều mã.
- Giá tính bằng nghìn đồng; cắt lỗ < vùng mua < mục tiêu; tỷ lệ lợi nhuận/rủi ro nên ≥ 1,5. horizonDays = số phiên giao dịch.
- Mỗi mã có "Thống kê lịch sử" của nhóm điểm (4 năm, rổ theo thời điểm): lãi hơn rổ trung bình và khoảng p10–p90 sau 20 phiên.
  Đó là căn cứ cho con số %: mục tiêu vượt p90 + lãi của rổ thì phải nêu rõ lý do riêng của mã (tin, kết quả kinh doanh);
  không có lý do riêng thì đặt mục tiêu trong khoảng đó. Mục tiêu và horizonDays sẽ được chấm lại khi đủ phiên.
- Viết tiếng Việt CÓ DẤU đầy đủ, ngắn gọn, có con số. Trong văn bản không viết mã kỹ thuật như CHO_DIEM_MUA, MUA_THAM_DO;
  dùng "chờ điểm mua", "mua thăm dò".`;

function pickPrompt(cands, marketFlow, market) {
  const L = [];
  if (market) L.push(`VN-Index ${market.close} (${market.changePct}%), xu hướng ${market.trend}.`);
  if (marketFlow) {
    L.push(`Sàn ${marketFlow.floor} phiên ${marketFlow.date}: ${marketFlow.advancers} mã tăng / ${marketFlow.decliners} giảm; khối ngoại ròng ${(marketFlow.foreign.netVal / 1e9).toFixed(0)} tỷ.`);
  }
  L.push(`\n# ${cands.length} mã ứng viên`);
  for (const c of cands) {
    const i = c.indicators, f = c.fundamentals || {};
    L.push(`\n## ${c.symbol} - ${c.name} (${c.exchange}) giá ${c.close} (${c.changePct}% hôm nay)`);
    L.push(`Điểm xếp hạng 4 yếu tố: ${c.ranking?.score ?? 'n/a'} (hạng ${c.ranking?.position ?? '?'}/${c.ranking?.universe ?? '?'}); điểm chất lượng doanh nghiệp ${c.quality?.score ?? 'n/a'}/100`);
    if (c.earnings) L.push(`KQKD quý: ${c.earnings.quarters.map((q) => `${q.label} LN ${q.profitYoY != null ? Math.round(q.profitYoY * 100) + '%' : 'n/a'}`).join(', ')} → ${c.earnings.trend}; dòng tiền KD/LN ${c.earnings.cfoToProfit ?? 'không áp dụng'}; báo cáo ${c.earnings.nextReport?.quarter} trước ${c.earnings.nextReport?.dueBy}`);
    if (c.valuation?.pePct != null) L.push(`P/E đắt hơn ${Math.round(c.valuation.pePct * 100)}% số ngày trong 5 năm (trung vị ${c.valuation.peMedian}) → ${c.valuation.verdict}`);
    if (c.upcomingEvents?.length) L.push(`Sự kiện sắp tới: ${c.upcomingEvents.join('; ')}`);
    if (c.sector?.name) L.push(`Ngành ${c.sector.name}: hạng ${c.sector.rank}/${c.sector.total} về dòng tiền 5 phiên, ròng ${(c.sector.net / 1e9).toFixed(0)} tỷ, khối ngoại ngành ${((c.sector.foreignNet ?? 0) / 1e9).toFixed(0)} tỷ`);
    if (c.liquidity) L.push(`Thanh khoản: TB 20 phiên ${(c.liquidity.avg / 1e9).toFixed(1)} tỷ, ${c.liquidity.okDays}/${c.liquidity.days} phiên ≥ 5 tỷ, phiên gần nhất ${(c.liquidity.last / 1e9).toFixed(1)} tỷ`);
    if (c.fundamentals?.debtToEquity != null) L.push(`Nợ vay/vốn chủ ${c.fundamentals.debtToEquity.toFixed(2)}; LN quý gần nhất so cùng kỳ ${c.fundamentals.profitGrowthQoQYoY != null ? (c.fundamentals.profitGrowthQoQYoY * 100).toFixed(0) + '%' : 'n/a'}`);
    L.push(`Setup: ${c.setups.map((s) => s.label).join(', ') || 'không'}; điểm kiểu cũ (chỉ tham khảo): tổng ${c.total}, kỹ thuật ${c.scores.technical}, cơ bản ${c.scores.fundamental ?? 'n/a'}, tin ${c.scores.news ?? 'n/a'}`);
    L.push(`MA20 ${i.sma20}, MA50 ${i.sma50}, MA200 ${i.sma200}; RSI ${i.rsi14}; MACD hist ${i.macdHist}; ADX ${i.adx14} (+DI ${i.plusDI}/−DI ${i.minusDI}); Stoch ${i.stochK}; MFI ${i.mfi14}; OBV ${i.obvTrend}; RS 20 phiên so với VN-Index ${i.rs20}; hiệu suất 20/60 phiên ${i.return20d}%/${i.return60d}%`);
    L.push(`P/E ${f.pe?.toFixed?.(1) ?? 'n/a'}, P/B ${f.pb?.toFixed?.(2) ?? 'n/a'}, ROE ${f.roe != null ? (f.roe * 100).toFixed(1) + '%' : 'n/a'}, LN 4Q ${f.profitGrowthTTM != null ? (f.profitGrowthTTM * 100).toFixed(0) + '%' : 'n/a'}, DT 4Q ${f.revenueGrowthTTM != null ? (f.revenueGrowthTTM * 100).toFixed(0) + '%' : 'n/a'}`);
    if (c.foreign) L.push(`Khối ngoại: 5 phiên ${(c.foreign.net5 / 1e9).toFixed(1)} tỷ, 20 phiên ${(c.foreign.net20 / 1e9).toFixed(1)} tỷ`);
    if (c.plan) L.push(`Hỗ trợ ${c.plan.support}, kháng cự ${c.plan.resistance}, ATR ${c.plan.atr}`);
    const ex = c.expectation?.h20;
    if (ex) L.push(`Thống kê lịch sử nhóm điểm ${c.expectation.bucket.from}–${c.expectation.bucket.to} ${c.expectation.bucket.aboveMa200 ? 'trên' : 'dưới'} MA200 (4 năm): sau 20 phiên hơn rổ TB ${(ex.meanExcess * 100).toFixed(1)}%, p10 ${(ex.p10 * 100).toFixed(1)}%, p90 ${(ex.p90 * 100).toFixed(1)}%, thắng rổ ${Math.round(ex.pBeat * 100)}%, lãi tuyệt đối TB ${(ex.meanReturn * 100).toFixed(1)}%${ex.significant ? '' : ' (chưa có ý nghĩa thống kê)'}`);
    for (const n of (c.news || []).slice(0, 4)) L.push(`- Tin [${n.label}${n.reaction ? `, giá ${n.reaction.pct}%` : ''}]: ${n.title}`);
  }
  L.push('\nĐánh giá từng mã và trả về JSON theo schema.');
  return L.join('\n');
}

/** Gemini đánh giá và xếp hạng danh sách ứng viên. Trả về null nếu chưa cấu hình. */
export async function aiPickStocks(cands, { marketFlow = null, market = null } = {}) {
  const cfg = aiConfig();
  if (!cfg.enabled || !cands.length) return null;
  const started = Date.now();
  const { json, model, usage } = await callWithRetry(pickPrompt(cands, marketFlow, market), cfg.model,
    { system: PICK_SYSTEM, schema: PICK_SCHEMA, timeout: 150_000 });
  const bySym = new Map(cands.map((c) => [c.symbol, c]));
  const seen = new Set();
  const picks = (Array.isArray(json.picks) ? json.picks : []).map((p) => {
    const c = bySym.get(String(p.symbol || '').toUpperCase());
    if (!c || seen.has(c.symbol)) return null;
    seen.add(c.symbol);
    const sane = (v) => (Number.isFinite(v) && v > c.close * 0.5 && v < c.close * 2 ? v : null);
    const ef = sane(p.entryFrom), et = sane(p.entryTo), sl = sane(p.stopLoss), tg = sane(p.target);
    const lo = ef != null && et != null ? Math.min(ef, et) : null;
    const hi = ef != null && et != null ? Math.max(ef, et) : null;
    return {
      symbol: c.symbol,
      verdict: PICK_VERDICTS[p.verdict] ? p.verdict : 'CHO_DIEM_MUA',
      verdictLabel: PICK_VERDICTS[p.verdict] || PICK_VERDICTS.CHO_DIEM_MUA,
      confidence: Math.max(0, Math.min(100, Math.round(p.confidence ?? 0))),
      thesis: String(p.thesis || ''),
      trigger: String(p.trigger || ''),
      mainRisk: String(p.mainRisk || ''),
      entryZone: lo != null ? { from: lo, to: hi } : null,
      stopLoss: sl != null && (lo == null || sl < lo) ? sl : null,
      target: tg != null && tg > (hi ?? c.close) ? tg : null,
      horizon: String(p.horizon || ''),
      horizonDays: Number.isFinite(p.horizonDays) ? Math.min(60, Math.max(5, Math.round(p.horizonDays))) : 20,
    };
  }).filter(Boolean);
  return {
    model, createdAt: new Date().toISOString(), durationMs: Date.now() - started, tokens: usage?.totalTokenCount ?? null,
    marketView: String(json.marketView || ''), note: String(json.note || ''), picks,
  };
}
