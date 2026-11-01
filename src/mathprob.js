// Động cơ xác suất & kỳ vọng toán học (Mathematical Probability Engine)
// Áp dụng định lý kỳ vọng toán học (Expected Value), tiêu chuẩn Kelly (Kelly Criterion),
// xác suất thực nghiệm Monte Carlo và phân phối lợi suất lịch sử để phủ quyết các khuyến nghị không có lợi thế thống kê.

export const MATH_DEFAULTS = {
  roundtripCost: 0.0035,   // 0.35% phí mua, phí bán và thuế bán
  minExpectedValue: 0.005, // EV tối thiểu +0.5% sau phí thuế
  maxProbLoss7: 0.35,      // xác suất có lúc lỗ >= 7% theo Monte Carlo tối đa 35%
  minWinRate: 0.45,        // xác suất thắng tối thiểu 45%
  maxKellyCap: 0.25,       // trần tỷ trọng Half-Kelly tối đa 25% vốn
  maxT2BreachProb: 0.25,   // xác suất sụt thủng cắt lỗ ngay trong 3 phiên T+2 tối đa 25%
  maxCvar3: 0.12,          // rủi ro đuôi 3 phiên CVaR95 tối đa 12%
};

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Tính toán xác suất thực nghiệm, kỳ vọng toán học và hệ số Kelly.
 * @param {object[]} bars chuỗi nến lịch sử
 * @param {object} levels mức giá (target, stop, targetPct, stopPct, close)
 * @param {object|null} mc kết quả mô phỏng Monte Carlo (monteCarloForecast)
 * @param {object|null} expectation kỳ vọng thống kê 4 năm theo nhóm điểm (expectationFor)
 * @param {object} [opts] tùy biến tham số
 */
export function calculateMathProbability(bars, levels, mc = null, expectation = null, opts = {}) {
  const cfg = { ...MATH_DEFAULTS, ...opts };
  if (!levels || !levels.targetPct || !levels.stopPct || !levels.close) {
    return null;
  }
  if ((!bars || bars.length < 20) && !mc && !expectation) {
    return null;
  }

  const gain = Math.max(0.005, Number(levels.targetPct));
  const loss = Math.max(0.005, Math.abs(Number(levels.stopPct)));
  const b = gain / loss; // Payoff ratio (tỷ lệ Lãi / Lỗ mục tiêu)

  // 1. Ước lượng xác suất thắng thực nghiệm (Empirical Win Rate)
  // Kết hợp từ 3 nguồn định lượng độc lập:
  // a) Monte Carlo: xác suất giá tăng sau 20 phiên (bỏ trôi dạt)
  const pMc = mc?.probUp != null ? mc.probUp : 0.50;

  // b) Kỳ vọng thống kê 4 năm theo nhóm điểm xếp hạng (Point-in-Time)
  const pExp = expectation?.h20?.pBeat != null ? expectation.h20.pBeat : 0.50;

  // c) Tần suất thắng 20 phiên thực tế của chính cổ phiếu trong 250 phiên gần nhất
  let pHist = 0.50;
  if (bars && bars.length >= 40) {
    const closes = bars.slice(-250).map((x) => x.close);
    const win20 = [];
    for (let i = 20; i < closes.length; i++) {
      win20.push(closes[i] / closes[i - 20] - 1 > cfg.roundtripCost);
    }
    if (win20.length >= 20) {
      pHist = win20.filter(Boolean).length / win20.length;
    }
  }

  // Tổng hợp xác suất thắng có hiệu chỉnh trọng số
  const pWin = round(0.40 * pMc + 0.35 * pExp + 0.25 * pHist, 4);
  const pLoss = round(1 - pWin, 4);

  // 5. Xác suất rủi ro đuôi (Tail Risk) & Rủi ro kẹt hàng T+2 (T+2 Settlement Lock-in Risk)
  // Tại thị trường cơ sở Việt Nam, mua ở T+0 thì sớm nhất phiên chiều T+2 (13:00) hoặc mở cửa T+3 mới bán được.
  // Trong 3 phiên này vị thế bị khóa hoàn toàn (locked-in). Nếu cổ phiếu giảm sốc hoặc bán sàn mất thanh khoản,
  // nhà đầu tư không thể cắt lỗ tại mức danh nghĩa, mà phải gánh chịu mức lỗ đuôi 3 phiên (CVaR3).
  let cvar3 = null;
  let pT2Breach = null;
  let maxT2Drop = null;
  if (bars && bars.length >= 40) {
    const closes = bars.slice(-250).map((x) => x.close);
    const r3 = [];
    for (let i = 3; i < closes.length; i++) {
      r3.push(closes[i] / closes[i - 3] - 1);
    }
    if (r3.length >= 30) {
      const sortedR3 = [...r3].sort((a, b) => a - b);
      const k5 = Math.max(1, Math.floor(sortedR3.length * 0.05));
      cvar3 = round(Math.max(0, -sortedR3.slice(0, k5).reduce((a, b) => a + b, 0) / k5), 4);
      pT2Breach = round(sortedR3.filter((r) => r <= -loss).length / sortedR3.length, 4);
      maxT2Drop = round(Math.abs(sortedR3[0]), 4);
    }
  }

  // Mức lỗ thực tế khi tính cả rủi ro kẹt hàng T+2
  const effectiveLoss = cvar3 != null ? round(Math.max(loss, cvar3), 4) : loss;
  const bEff = round(gain / effectiveLoss, 4);

  // Hiệu chỉnh Break-even, EV và Kelly theo mức lỗ thực tế có tính độ trễ T+2
  const breakEvenWinRate = round((effectiveLoss + cfg.roundtripCost) / (gain + effectiveLoss), 4);
  const ev = round(pWin * gain - pLoss * effectiveLoss - cfg.roundtripCost, 4);
  const evPct = round(ev * 100, 2);
  const kellyFraction = round((pWin * bEff - pLoss) / bEff, 4);
  const edge = round(pWin * (bEff + 1) - 1, 4);
  const halfKelly = kellyFraction > 0 ? round(Math.min(cfg.maxKellyCap, kellyFraction / 2), 4) : 0;

  const probLoss7 = mc?.probLoss7 != null ? mc.probLoss7 : 0.25;

  // 6. Kiểm định các chốt chặn toán học (Mathematical Gates)
  const reasons = [];
  let pass = true;

  if (ev <= cfg.minExpectedValue) {
    pass = false;
    reasons.push(`Kỳ vọng toán học âm hoặc quá thấp (EV = ${evPct >= 0 ? '+' : ''}${evPct}%): Không bù đắp được chi phí và rủi ro điều chỉnh`);
  }

  if (kellyFraction <= 0) {
    pass = false;
    reasons.push(`Hệ số Kelly f* = ${kellyFraction} ≤ 0: Vị thế không có lợi thế thống kê (Negative Edge = ${(edge * 100).toFixed(1)}%)`);
  }

  if (pWin < breakEvenWinRate) {
    pass = false;
    reasons.push(`Xác suất thắng ước tính (${(pWin * 100).toFixed(1)}%) thấp hơn tỷ lệ hòa vốn yêu cầu (${(breakEvenWinRate * 100).toFixed(1)}%)`);
  }

  if (probLoss7 >= cfg.maxProbLoss7) {
    pass = false;
    reasons.push(`Rủi ro sụt giảm sâu Monte Carlo cao: Xác suất có lúc lỗ ≥ 7% là ${(probLoss7 * 100).toFixed(1)}% (ngưỡng an toàn < ${(cfg.maxProbLoss7 * 100).toFixed(0)}%)`);
  }

  if (pWin < cfg.minWinRate) {
    pass = false;
    reasons.push(`Xác suất thắng (${(pWin * 100).toFixed(1)}%) dưới ngưỡng an toàn tối thiểu (${(cfg.minWinRate * 100).toFixed(0)}%)`);
  }

  // Kiểm định tỷ số Lãi/Lỗ tối thiểu (không vào lệnh nếu tiềm năng lãi không bù đắp được rủi ro cắt lỗ)
  if (bEff < 1.2) {
    pass = false;
    reasons.push(`Tỷ lệ Lãi/Lỗ bất lợi (R/R thực tế = ${round(bEff, 2)}x < 1.2x): Mục tiêu tăng giá quá gần kháng cự, không đủ bù đắp rủi ro cắt lỗ`);
  }

  // Kiểm định rủi ro kẹt hàng T+2
  if (pT2Breach != null && pT2Breach >= cfg.maxT2BreachProb) {
    pass = false;
    reasons.push(`Rủi ro kẹt hàng T+2 cao: Xác suất thủng cắt lỗ trước khi hàng về là ${(pT2Breach * 100).toFixed(1)}% (ngưỡng an toàn < ${(cfg.maxT2BreachProb * 100).toFixed(0)}%)`);
  }

  if (cvar3 != null && cvar3 >= cfg.maxCvar3) {
    pass = false;
    reasons.push(`Biên độ sụt giảm đuôi 3 phiên T+2 (CVaR3 = ${(cvar3 * 100).toFixed(1)}%) quá lớn, nguy cơ kẹt sàn khó thoát hàng`);
  }

  // Độ tin cậy toán học: dựa trên EV, Kelly, tỷ số R/R và tỷ lệ thắng
  const score = Math.max(0, Math.min(100, Math.round(
    (pass ? 50 : 20) +
    Math.max(-20, Math.min(25, ev * 300)) +
    Math.max(-20, Math.min(25, kellyFraction * 50))
  )));

  // 7. Ghi chú phân tích chi tiết nếu mua theo dự đoán
  const close = levels.close;
  const pWinPct = round(pWin * 100, 1);
  const pBePct = round(breakEvenWinRate * 100, 1);
  const pLoss7Pct = round(probLoss7 * 100, 1);
  const gainPct = round(gain * 100, 1);
  const lossPct = round(loss * 100, 1);
  const effLossPct = round(effectiveLoss * 100, 1);

  const t2Desc = cvar3 != null
    ? ` [Rủi ro T+2: Sụt đuôi 3 phiên -${(cvar3 * 100).toFixed(1)}%, xác suất chạm lỗ trước khi hàng về: ${(pT2Breach * 100).toFixed(1)}%]`
    : '';

  let note;
  if (pass) {
    note = `Nếu mua ở giá ${close.toLocaleString('vi-VN')} theo dự đoán (Mục tiêu +${gainPct}%, Dừng lỗ -${lossPct}%, Lỗ thực tế tính trượt T+2: -${effLossPct}%): Xác suất thắng ước tính đạt ${pWinPct}%, vượt tỷ lệ hòa vốn yêu cầu (${pBePct}%). Kỳ vọng toán học dương (+${evPct}%/lệnh), Kelly khuyến nghị ${(halfKelly * 100).toFixed(1)}% vốn.${t2Desc} ĐỦ ĐIỀU KIỆN TOÁN HỌC ĐỂ MUA.`;
  } else {
    const reasonParts = [];
    if (pWin < breakEvenWinRate) {
      reasonParts.push(`Xác suất thắng ước tính là ${pWinPct}%, dưới mức hòa vốn yêu cầu (${pBePct}% do R/R thực tế ${round(bEff, 2)}x)`);
    } else if (pWin < cfg.minWinRate) {
      reasonParts.push(`Xác suất thắng ước tính là ${pWinPct}%, dưới ngưỡng an toàn tối thiểu (${Math.round(cfg.minWinRate * 100)}%)`);
    } else {
      reasonParts.push(`Xác suất thắng ước tính là ${pWinPct}%`);
    }

    if (ev <= 0) {
      reasonParts.push(`Kỳ vọng toán học ÂM (${evPct}%/lệnh, trung bình lỗ ${Math.abs(evPct)}% mỗi lần vào lệnh)`);
    } else if (ev < cfg.minExpectedValue) {
      reasonParts.push(`Kỳ vọng toán học quá thấp (+${evPct}%/lệnh, không đủ bù rủi ro và phí thuế)`);
    } else {
      reasonParts.push(`Kỳ vọng EV dương (+${evPct}%/lệnh) nhưng bị chặn do rủi ro sụt giảm`);
    }

    if (probLoss7 >= cfg.maxProbLoss7) {
      reasonParts.push(`Xác suất sụt sâu ≥ 7% là ${pLoss7Pct}% (vượt ngưỡng an toàn ${Math.round(cfg.maxProbLoss7 * 100)}%)`);
    }

    note = `Nếu mua ở giá ${close.toLocaleString('vi-VN')} theo dự đoán (Mục tiêu +${gainPct}%, Dừng lỗ -${lossPct}%, Lỗ thực tế tính trượt T+2: -${effLossPct}%): ${reasonParts.join('. ')}.${t2Desc} TOÁN HỌC KHUYÊN: KHÔNG MUA / TẠM HOÃN.`;
  }

  return {
    pass,
    verdict: pass ? 'PASS' : 'REJECT',
    advice: pass ? 'ỦNG HỘ MUA' : 'KHÔNG NÊN MUA',
    summaryNote: note,
    pWin,
    pLoss,
    breakEvenWinRate,
    targetPct: round(gain, 4),
    stopPct: round(loss, 4),
    effectiveLoss,
    payoffRatio: round(bEff, 2),
    nominalPayoffRatio: round(b, 2),
    expectedValue: ev,
    expectedValuePct: evPct,
    kellyFraction,
    halfKelly,
    edge,
    probLoss7,
    confidenceScore: score,
    reasons,
    t2Risk: {
      cvar3,
      pT2Breach,
      maxT2Drop,
      effectiveLoss,
      isT2Safe: (pT2Breach == null || pT2Breach < cfg.maxT2BreachProb) && (cvar3 == null || cvar3 < cfg.maxCvar3),
      warning: (pT2Breach != null && pT2Breach >= cfg.maxT2BreachProb) || (cvar3 != null && cvar3 >= cfg.maxCvar3)
        ? `Rủi ro kẹt hàng T+2 cao: Biên độ sụt 3 phiên CVaR95 là -${(cvar3 * 100).toFixed(1)}%, ${(pT2Breach * 100).toFixed(1)}% số lần thủng cắt lỗ trước khi hàng về tài khoản.`
        : null,
    },
    details: {
      pMc: round(pMc, 3),
      pExp: round(pExp, 3),
      pHist: round(pHist, 3),
      cvar3: cvar3 != null ? round(cvar3, 3) : null,
      pT2Breach: pT2Breach != null ? round(pT2Breach, 3) : null,
      roundtripCost: cfg.roundtripCost,
    },
  };
}
