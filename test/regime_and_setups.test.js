import test from 'node:test';
import assert from 'node:assert/strict';
import { countDistributionDays, calculateMarketBreadth, evaluateMarketRegime, REGIMES } from '../src/regime.js';
import { chandelierExit } from '../src/tradeplan.js';
import { detectVcpPattern, detectPocketPivot } from '../src/screener.js';
import { monteCarloForecast } from '../src/forecast.js';

test('countDistributionDays: đếm chính xác số phiên phân phối theo O\'Neil', () => {
  // Tạo chuỗi nến giả lập
  const bars = [
    { time: '2026-01-01', close: 100, volume: 1000 },
    { time: '2026-01-02', close: 99.5, volume: 1200 }, // Giảm 0.5%, vol > prev -> ngày phân phối 1
    { time: '2026-01-03', close: 101, volume: 1500 },  // Tăng
    { time: '2026-01-04', close: 100.2, volume: 1100 }, // Giảm 0.79%, vol < prev -> KHÔNG phải phân phối
    { time: '2026-01-05', close: 99.8, volume: 1300 }, // Giảm 0.4%, vol > prev -> ngày phân phối 2
  ];

  const res = countDistributionDays(bars, 25);
  assert.equal(res.count, 2);
  assert.equal(res.days[0].time, '2026-01-05');
  assert.equal(res.days[1].time, '2026-01-02');
});

test('calculateMarketBreadth & evaluateMarketRegime: phân loại đúng trạng thái thị trường', () => {
  // 60 nến tăng dần
  const indexBars = Array.from({ length: 60 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close: 1000 + i * 5,
    volume: 50000,
  }));

  const breadthGood = { total: 20, pctAboveMa20: 75, pctAboveMa50: 70 };
  const regimeUptrend = evaluateMarketRegime(indexBars, breadthGood);
  assert.equal(regimeUptrend.regime, REGIMES.CONFIRMED_UPTREND.code);
  assert.equal(regimeUptrend.allowNewBuys, true);

  // Giả lập chuỗi phân phối nặng và gãy xu hướng
  const badBars = Array.from({ length: 60 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    close: 1200 - i * 5,
    volume: 50000 + (i % 2 === 0 ? 10000 : -5000),
  }));
  const breadthBad = { total: 20, pctAboveMa20: 20, pctAboveMa50: 15 };
  const regimeBad = evaluateMarketRegime(badBars, breadthBad);
  assert.equal(regimeBad.regime, REGIMES.MARKET_CORRECTION.code);
  // Thị trường điều chỉnh: quản trị rủi ro tối đa, phòng thủ tiền mặt, tạm ngừng mở vị thế mua mới (fail-safe)
  assert.equal(regimeBad.allowNewBuys, false);
});

test('chandelierExit: mức Chandelier nằm dưới đỉnh gần nhất', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: 50 + i * 0.5,
    high: 52 + i * 0.5,
    low: 49.5 + i * 0.5,
    close: 51 + i * 0.5,
    volume: 10000,
  }));

  const chan = chandelierExit(bars, 22, 2.5);
  assert.ok(chan != null && chan > 0);
  assert.ok(chan < bars.at(-1).high);
});

test('detectVcpPattern: nhận diện chính xác mẫu hình co hẹp biến động và cạn vol', () => {
  // Xây dựng 60 nến co hẹp biên độ:
  // Khoảng 1: dao động 18%
  // Khoảng 2: dao động 9%
  // Khoảng 3: dao động 3.5%, vol cạn kiệt
  const bars = [];
  for (let i = 0; i < 60; i++) {
    let range, base, vol;
    if (i < 27) {
      range = 10;
      base = 100;
      vol = 10000;
    } else if (i < 48) {
      range = 5;
      base = 105;
      vol = 7000;
    } else {
      range = 2;
      base = 107;
      vol = 3000; // cạn vol < 50%
    }
    bars.push({
      time: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: base,
      high: base + range,
      low: base - range,
      close: base + range * 0.8,
      volume: vol,
    });
  }

  const vcp = detectVcpPattern(bars);
  assert.equal(vcp.isVcp, true);
  assert.ok(vcp.volDryUp);
  assert.ok(vcp.contractions[0] > vcp.contractions[1]);
  assert.ok(vcp.contractions[1] > vcp.contractions[2]);
});

test('detectPocketPivot: nhận diện phiên dòng tiền mua gom đột biến', () => {
  const bars = Array.from({ length: 25 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: 50,
    high: 51,
    low: 49,
    close: i % 2 === 0 ? 49.5 : 50.5,
    volume: 5000,
  }));

  // Phiên cuối: tăng mạnh với vol 12000 > max down vol 5000
  bars.push({
    time: '2026-02-01',
    open: 50,
    high: 53,
    low: 50,
    close: 52.5,
    volume: 12000,
  });

  const pp = detectPocketPivot(bars);
  assert.equal(pp.isPocketPivot, true);
  assert.ok(pp.volRatio >= 2.0);
});

test('monteCarloForecast: sinh chuỗi dự phóng tương lai projectionSeries đủ 20 phiên', () => {
  const baseDate = new Date('2026-01-01');
  const bars = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(baseDate.getTime() + i * 86400000);
    return {
      time: d.toISOString().slice(0, 10),
      open: 100 + i * 0.2,
      high: 101 + i * 0.2,
      low: 99.5 + i * 0.2,
      close: 100.5 + i * 0.2,
      volume: 10000,
    };
  });

  const mc = monteCarloForecast(bars, 20, 100);
  assert.ok(mc != null);
  assert.equal(mc.projectionSeries.length, 20);
  const p1 = mc.projectionSeries[0];
  const p20 = mc.projectionSeries[19];
  assert.ok(p1.p90 >= p1.p50);
  assert.ok(p1.p50 >= p1.p10);
  assert.ok(p20.time != null);
});
