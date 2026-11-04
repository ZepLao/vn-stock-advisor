import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekOf, perfSeries, buildScorecard, formatScorecard } from '../src/scorecard.js';

test('weekOf: thứ 2 → thứ 6 của tuần', () => {
  assert.deepEqual(weekOf('2026-11-05'), { from: '2026-11-02', to: '2026-11-06' });
  assert.deepEqual(weekOf('2026-11-02'), { from: '2026-11-02', to: '2026-11-06' });
  assert.deepEqual(weekOf('2026-11-08'), { from: '2026-11-02', to: '2026-11-06' }); // chủ nhật thuộc tuần trước đó
});

test('perfSeries: nạp thêm tiền không tính là lãi', () => {
  const p = perfSeries([
    { date: 'a', nav: 100, funded: 100 },
    { date: 'b', nav: 210, funded: 200 }, // nạp 100, lãi thật 10
    { date: 'c', nav: 210, funded: 200 },
  ]);
  assert.equal(p[1].perf, 1.1);
  assert.equal(p[2].perf, 1.1);
});

test('buildScorecard: tuần này so với VN-Index, lệnh trong tuần, khuyến nghị kết thúc trong tuần', () => {
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const index = days.map((time, k) => ({ time, close: 1000 + k }));
  const equity = days.map((date, k) => ({ date, nav: k < 5 ? 100 : 104, funded: 100, index: k < 5 ? 1000 : 1010 }));
  const orders = [{ date: '2026-11-03', side: 'BUY' }, { date: '2026-11-04', side: 'SELL', pnl: 5 }, { date: '2026-10-27', side: 'SELL', pnl: -3 }];
  const res = (beat, ex) => ({ 5: { beatBasket: beat, excessBasket: ex } });
  const scored = [
    { source: 'rank_top', direction: 1, date: '2026-10-26', symbol: 'AAA', result: res(true, 0.02) }, // kết thúc 02/11: trong tuần
    { source: 'rank_top', direction: 1, date: '2026-10-27', symbol: 'BBB', result: res(false, -0.03) },
    { source: 'rank_top', direction: -1, date: '2026-10-28', symbol: 'CCC', result: res(true, -0.01) },
    { source: 'rank_top', direction: 1, date: '2026-10-20', symbol: 'OLD', result: res(true, 0.05) }, // kết thúc tuần trước
  ];
  const sc = buildScorecard({ equity, orders, scored, index, asOf: '2026-11-06' });
  assert.equal(sc.week.from, '2026-11-02');
  assert.ok(Math.abs(sc.tool.week.ret - 0.04) < 1e-12);
  assert.ok(Math.abs(sc.tool.week.index - 0.01) < 1e-12);
  assert.ok(Math.abs(sc.tool.week.vs - 0.03) < 1e-12);
  assert.deepEqual(sc.tool.trades, { buys: 1, sells: 1, wins: 1, pnl: 5 });
  const f = sc.calls.find((c) => c.source === 'rank_top');
  assert.equal(f.buy.n, 2);
  assert.equal(f.buy.right, 1);
  assert.deepEqual(f.buy.worst, ['BBB']);
  assert.equal(f.avoid.n, 1);
  assert.match(sc.verdict, /hơn VN-Index 3,0 điểm %/);
  assert.ok(formatScorecard(sc).some((l) => l.includes('1/2 đúng (50%)')));
});

test('buildScorecard: cả tuần để tiền mặt thì ghi rõ là đứng ngoài, không phải chọn mã giỏi', () => {
  const index = [{ time: '2026-10-30', close: 1000 }, { time: '2026-11-02', close: 990 }];
  const equity = [{ date: '2026-10-30', nav: 100, cash: 100, funded: 100, index: 1000 }, { date: '2026-11-02', nav: 100, cash: 100, funded: 100, index: 990 }];
  const sc = buildScorecard({ equity, index, asOf: '2026-11-02' });
  assert.equal(sc.tool.cashOnly, true);
  assert.ok(sc.verdict.includes('đứng ngoài (100% tiền mặt) nên tránh được mức giảm 1,0%'));
});

test('buildScorecard: chưa mở tài khoản tự đầu tư vẫn ra bảng khuyến nghị', () => {
  const sc = buildScorecard({ equity: [], orders: [], scored: [], index: [{ time: '2026-11-06', close: 1 }], asOf: '2026-11-06' });
  assert.equal(sc.tool, null);
  assert.match(sc.verdict, /Chưa đủ dữ liệu/);
});

test('buildScorecard: lệnh mua khi luật thị trường chặn được tính riêng (lỗ đã tránh), không tính vào tỷ lệ đúng', () => {
  const days = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const index = days.map((time, k) => ({ time, close: 1000 + k }));
  const res = (beat, ex) => ({ 5: { beatBasket: beat, excessBasket: ex } });
  const scored = [
    { source: 'rank_top', direction: 1, date: '2026-10-26', symbol: 'A', result: res(false, -0.03) }, // thị trường yếu: bị chặn
    { source: 'rank_top', direction: 1, date: '2026-10-27', symbol: 'B', result: res(true, 0.02) }, // thị trường khỏe: tính
  ];
  const breadthAt = (d) => (d === '2026-10-26' ? 0.3 : 0.6);
  const sc = buildScorecard({ scored, index, asOf: '2026-11-06', breadthAt });
  const c = sc.calls.find((x) => x.source === 'rank_top');
  assert.equal(c.buy.n, 1);
  assert.equal(c.buy.right, 1);
  assert.equal(c.blocked.n, 1);
  assert.equal(c.blocked.avgExcess, -0.03);
});

test('breadthFromBars: tỷ lệ mã trên MA50', async () => {
  const { breadthFromBars } = await import('../src/scorecard.js');
  const day = (k) => new Date(Date.UTC(2026, 0, 1) + k * 86400_000).toISOString().slice(0, 10);
  const mk = (up) => Array.from({ length: 60 }, (_, k) => ({ time: day(k), close: up ? 10 + k : 70 - k }));
  const f = breadthFromBars({ A: mk(true), B: mk(true), C: mk(false), D: mk(true) }, 2);
  assert.equal(f(day(55)), 0.75);
  assert.equal(f(day(10)), null);
});
