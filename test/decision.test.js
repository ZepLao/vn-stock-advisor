import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseDecision, finalDecision } from '../src/decision.js';

test('Gộp quyết định: lấy bên thận trọng hơn, AI không được nâng mức', () => {
  assert.deepEqual(fuseDecision('BUY', 'MUA'), { code: 'BUY', aiCode: 'BUY', relation: 'agree' });
  assert.equal(fuseDecision('BUY', 'GIU').code, 'HOLD');
  assert.equal(fuseDecision('BUY', 'DUNG_NGOAI').relation, 'stricter');
  assert.equal(fuseDecision('HOLD', 'MUA').code, 'HOLD'); // AI tích cực hơn: giữ mức hệ thống
  assert.equal(fuseDecision('HOLD', 'MUA').relation, 'looser');
  assert.equal(fuseDecision('AVOID', 'BAN').code, 'SELL');
  assert.equal(fuseDecision('BUY', 'KHONG_RO').relation, 'none');
});

test('Quyết định cuối: kế hoạch mua/bán tính lại theo mức đã hạ', () => {
  const a = {
    recommendation: { code: 'BUY', label: 'NÊN MUA' }, price: { close: 20.9, date: '2026-10-16' },
    technical: { indicators: { rsi14: 60, avgVolume20: 1e6, sma200: 19 } }, ranking: { score: 80, aboveMa200: true },
    brief: { levels: { r2: 22.2, r1: 21.2, close: 20.9, s1: 20.75, s2: 20.1, stop: 19.85, atr: 0.42, weight: 0.2 } },
  };
  const ai = {
    decision: 'DUNG_NGOAI', decisionLabel: 'ĐỨNG NGOÀI', headline: '',
    planReview: { verdict: 'THAN_TRONG_HON', reason: 'VN-Index dưới MA200.' },
    marketChecks: [{ factor: 'VN_INDEX', label: 'Xu hướng VN-Index', status: 'XAU', note: 'dưới MA200' }],
  };
  const f = finalDecision(a, ai);
  assert.equal(f.code, 'AVOID');
  assert.match(f.note, /AI hạ từ NÊN MUA xuống CHƯA NÊN MUA \(yếu tố xấu: xu hướng vn-index\)/);
  assert.equal(f.steps.fresh[0].side, 'wait'); // không còn bước mua ngay
  assert.match(f.action, /Không mua mới/);

  // Giá bị ghim (NAF 10/2026): hệ thống và AI cùng mua vẫn chỉ được GIỮ
  const pinned = Array.from({ length: 20 }, () => ({ high: 48.1, low: 47.8, close: 48 }));
  const g = finalDecision({ ...a, recentBars: pinned }, { ...ai, decision: 'MUA', marketChecks: [] });
  assert.equal(g.code, 'HOLD');
  assert.match(g.note, /bị ghim/);
});

test('Kế hoạch người đang nắm giữ: chặn mua thêm khi quyết định cuối không phải mua', async () => {
  const { holderPlan } = await import('../src/decision.js');
  const plan = {
    holdView: 'Giữ, xu hướng còn tốt.', addMore: 'MUA_THEM', addReason: 'Trên MA200.',
    addZones: [{ from: 20.2, to: 20.6, percentOfHolding: 30, condition: 'giữ được hỗ trợ' }],
    noAddZones: [{ side: 'TREN', price: 21.5, reason: 'sát kháng cự' }],
    sellSteps: [{ kind: 'CHOT_LOI', price: 22.2, percentOfHolding: 50, condition: 'chạm kháng cự 2' }],
    stopLoss: 19.8,
  };
  const holding = { qty: 1000, avgCost: 19, sellable: 1000, pending: 0 };
  const ok = holderPlan('BUY', plan, { close: 20.9, stop: 19.85, holding });
  assert.equal(ok.addMore, 'MUA_THEM');
  assert.deepEqual(ok.steps.map((s) => [s.side, s.shares]), [['buy', 300], ['sell', 500], ['stop', 1000]]);
  assert.equal(ok.noAdd[0].price, 21.5);

  const no = holderPlan('AVOID', plan, { close: 20.9, stop: 19.85, holding });
  assert.equal(no.addMore, 'KHONG_MUA_THEM');
  assert.ok(no.blocked);
  assert.ok(!no.steps.some((s) => s.side === 'buy'));
});

test('Kế hoạch người đang nắm giữ: không bình quân giá xuống, loại giá vô lý, bán dưới giá vốn là hạ tỷ trọng', async () => {
  const { holderPlan } = await import('../src/decision.js');
  const plan = {
    addMore: 'MUA_THEM_CO_DIEU_KIEN', addReason: '', holdView: '',
    addZones: [{ from: 20, to: 20.4, percentOfHolding: 20, condition: 'về hỗ trợ' }, { from: 5, to: 6, percentOfHolding: 20, condition: 'sai' }],
    noAddZones: [], sellSteps: [{ kind: 'CHOT_LOI', price: 21.5, percentOfHolding: 50, condition: 'hồi' }], stopLoss: 25,
  };
  const h = holderPlan('ACCUMULATE', plan, { close: 20.9, stop: 19.85, holding: { qty: 200, avgCost: 23 } });
  assert.equal(h.stop, 19.85); // cắt lỗ AI cao hơn giá hiện tại → dùng mức hệ thống
  assert.equal(h.addMore, 'KHONG_MUA_THEM');
  assert.match(h.blocked, /bình quân giá xuống/);
  assert.equal(h.steps.find((s) => s.side === 'sell').kind, 'HA_TY_TRONG');
});
