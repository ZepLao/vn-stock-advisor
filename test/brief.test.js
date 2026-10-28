import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, positionSize } from '../src/brief.js';

const base = (over = {}) => ({
  symbol: 'AAA', total: 10, price: { close: 20, changePct: 1, date: '2026-10-16' },
  recommendation: { code: 'BUY', label: 'NÊN MUA' },
  ranking: { score: 80, position: 2, universe: 100, aboveMa200: true, factors: { mom: 0.3, high: -0.05 } },
  technical: { indicators: { sma200: 18, rsi14: 60 } },
  fundamental: { data: { pe: 10, roe: 0.2, profitGrowthTTM: 0.15, epsTTM: 2000 } },
  foreign: { net20: 50e9, ratio20: 4 },
  news: { count: 5, score: 30, positive: 4, negative: 1 },
  plan: { support: 18.5, stopLoss: 19.2, target: 22, riskReward: 2 },
  warnings: [],
  ...over,
});

test('Tỷ trọng theo rủi ro 1% vốn, tối đa 25%', () => {
  assert.equal(positionSize(20, 19).weight, 0.2); // cắt lỗ cách 5% → 20% vốn
  assert.equal(positionSize(20, 19.8).weight, 0.25); // cắt lỗ quá gần → chặn ở 25%
  assert.equal(positionSize(20, 21), null);
});

test('Tóm tắt: kết luận, việc nên làm (một suất, LO giá đóng cửa, cảnh báo −15%), lý do có số liệu', () => {
  const b = buildBrief(base(), { name: 'Ngân hàng', net: 8e12, rank: 1, total: 27, period: 5 });
  assert.equal(b.verdict, 'NÊN MUA');
  assert.match(b.action, /một suất \(10% vốn\) bằng lệnh LO giá 20; giữ khoảng 40 phiên, cảnh báo nếu đóng cửa dưới 17/);
  assert.ok(b.reasons.length >= 4 && b.reasons.length <= 6);
  assert.ok(b.reasons.some((r) => /Ngân hàng được mua ròng 8\.000 tỷ\/5 phiên \(top hút tiền\)/.test(r.text)));
  assert.ok(b.reasons.some((r) => /Khối ngoại mua ròng 50 tỷ/.test(r.text)));
  assert.ok(b.levels.buyFrom > b.levels.stop, `${b.levels.buyFrom} > ${b.levels.stop}`);
  assert.equal(b.levels.buyFrom, 20);
  assert.equal(b.levels.stop, 17); // −15% giá mua, không cắt sát theo hỗ trợ
  assert.equal(b.levels.supportStop, 19.2); // cắt lỗ theo hỗ trợ cũ chỉ để tham khảo
});

test('Tóm tắt: doanh nghiệp lỗ và dưới MA200 hiện là lý do tiêu cực', () => {
  const b = buildBrief(base({
    recommendation: { code: 'AVOID', label: 'CHƯA NÊN MUA' },
    ranking: { score: 75, position: 5, universe: 100, aboveMa200: false, factors: { mom: 0.1, high: -0.2 } },
    fundamental: { data: { epsTTM: -500 } },
  }));
  assert.match(b.action, /Không mua mới/);
  assert.equal(b.tone, 'down');
  assert.ok(b.reasons.some((r) => r.tone === 'down' && /dưới MA200/.test(r.text)));
  assert.ok(b.reasons.some((r) => r.tone === 'down' && /đang lỗ/.test(r.text)));
});

test('Hướng dẫn 2 trường hợp theo quy tắc: mua một lần LO, giữ 40 phiên, không cắt lỗ sát', async () => {
  const { playbook } = await import('../src/brief.js');
  const c = { close: 20, stop: 17, weight: 0.1, aboveMa200: true, ma200: 18, score: 80 };
  const buy = playbook('BUY', c);
  assert.match(buy.newBuyer[0], /lệnh LO giá 20 cho phiên tới, một suất 10% vốn/);
  assert.match(buy.newBuyer[1], /Giữ khoảng 40 phiên.*dưới 17 \(−15%\), không cắt lỗ sát/);
  assert.ok(!buy.holder.some((x) => /Chốt lời/.test(x)));

  const hold = playbook('HOLD', { ...c, score: 55, aboveMa200: false, ma200: 21 });
  assert.match(hold.newBuyer[1], /điểm xếp hạng lên ≥ 70 \(hiện 55\) hoặc vào nhóm xu hướng chuẩn và giá vượt lên trên MA200 21/);
  // Giữ đến hạn rồi bán nếu không còn trong nhóm mua
  assert.match(playbook('HOLD', { ...c, heldSessions: 12 }).holder[0], /Giữ đến đủ 40 phiên \(đã giữ 12\/40 phiên\)/);
  assert.match(playbook('HOLD', { ...c, heldSessions: 41 }).holder[0], /bán ở phiên tới/);
  assert.match(playbook('AVOID', { ...c, avoid: true }).holder[0], /⛔/);

  // Vị thế thật: dưới ngưỡng cảnh báo −15% giá vốn lên đầu, cổ phiếu chưa về T+2
  const loss = playbook('HOLD', { ...c, holdStop: 19.55, close: 19, holding: { qty: 1000, sellable: 0, pending: 1000, avgCost: 23, pnlPct: -0.17 } });
  assert.match(loss.position, /1\.000 cp, giá vốn 23, lỗ 17,0%/);
  assert.match(loss.holder[0], /dưới ngưỡng cảnh báo 19,55/);
  assert.ok(loss.holder.some((x) => /T\+2/.test(x)));
});
