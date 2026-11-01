import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityCheck, liquidityCheck, sectorCheck } from '../src/screener.js';

test('Ngành: đạt khi đang được mua ròng hoặc thuộc top 5 ngành hút tiền', () => {
  assert.equal(sectorCheck({ name: 'Thép', rank: 3, total: 27, net: 6.8e11 }).pass, true);
  assert.equal(sectorCheck({ name: 'Dược', rank: 8, total: 27, net: 5.4e10 }).pass, true); // ngoài top 5 nhưng mua ròng
  assert.equal(sectorCheck({ name: 'X', rank: 4, total: 27, net: -1e9 }).pass, true); // top 5 dù ròng âm
  const out = sectorCheck({ name: 'Bất động sản', rank: 27, total: 27, net: -2.7e12 });
  assert.equal(out.pass, false);
  assert.match(out.label, /bị bán ròng -2700 tỷ/);
  assert.equal(sectorCheck(null).pass, false);
});

const good = { epsTTM: 3000, roe: 0.2, profitGrowthTTM: 0.15, revenueGrowthTTM: 0.1, pe: 12, debtToEquity: 0.5 };

test('Cổ ngon: đạt đủ tiêu chí thì qua, thiếu một tiêu chí thì loại và nêu lý do', () => {
  const ok = qualityCheck(good, 'Công nghệ phần mềm');
  assert.equal(ok.pass, true);
  assert.ok(ok.score > 0 && ok.score <= 100);
  const lowRoe = qualityCheck({ ...good, roe: 0.08 }, '');
  assert.equal(lowRoe.pass, false);
  assert.match(lowRoe.failed[0], /ROE 8\.0% < 12%/);
  assert.equal(qualityCheck({ ...good, profitGrowthTTM: -0.1 }).pass, false);
  assert.equal(qualityCheck({ ...good, pe: 40 }).pass, false);
  assert.equal(qualityCheck({ ...good, epsTTM: -5 }).pass, false);
  assert.equal(qualityCheck(null).pass, false);
  assert.equal(qualityCheck({ ...good, roe: null }).pass, false); // thiếu dữ liệu = không xác minh được
});

test('Cổ ngon: nợ vay cao bị loại, trừ ngân hàng / chứng khoán / bảo hiểm', () => {
  assert.equal(qualityCheck({ ...good, debtToEquity: 2.5 }, 'Bất động sản').pass, false);
  assert.equal(qualityCheck({ ...good, debtToEquity: 2.5 }, 'Chứng khoán & Dịch vụ tài chính').pass, true);
  assert.equal(qualityCheck({ ...good, debtToEquity: null }, 'Ngân hàng').pass, true);
});

test('Thanh khoản đều: cần TB ≥ 5 tỷ và ≥ 16/20 phiên đạt 5 tỷ', () => {
  // giá 10 nghìn đồng, 1 triệu cp = 10 tỷ/phiên; 100 nghìn cp = 1 tỷ/phiên
  const bars = (big, small) => [...Array(big).fill({ close: 10, volume: 1_000_000 }), ...Array(small).fill({ close: 10, volume: 100_000 })];
  const steady = liquidityCheck(bars(20, 0), 5e9);
  assert.equal(steady.pass, true);
  assert.equal(steady.okDays, 20);
  // TB vẫn ≥ 5 tỷ (12×10 + 8×1 = 128 tỷ / 20 = 6,4 tỷ) nhưng chỉ 12/20 phiên đạt → không đều, loại
  const spiky = liquidityCheck(bars(12, 8), 5e9);
  assert.ok(spiky.avg >= 5e9);
  assert.equal(spiky.pass, false);
  assert.equal(liquidityCheck(bars(16, 4), 5e9).pass, true);
});

test('Chế độ phòng thủ / Ngược dòng: khi phễu ngành = 0 vẫn giữ được mã cơ bản tốt + xu hướng mạnh', () => {
  const scanned = [
    {
      symbol: 'MSB',
      liquidity: { pass: true },
      quality: { pass: true },
      sector: { pass: false, name: 'Ngân hàng' },
      quick: 91,
      aboveMa200: true,
      stockRisk: { isRisky: false },
      combined: 85,
      trendPick: true,
    },
    {
      symbol: 'BAD',
      liquidity: { pass: true },
      quality: { pass: false },
      sector: { pass: false, name: 'Bất động sản' },
      quick: 35,
      aboveMa200: false,
      stockRisk: { isRisky: true },
      combined: 30,
      trendPick: false,
    },
  ];

  const trendOk = (c) => c.quick != null && c.quick >= 70 && c.aboveMa200 !== false && !c.stockRisk?.isRisky;
  let shortlist = scanned.filter((c) => c.liquidity.pass && c.quality.pass && c.sector.pass && trendOk(c));
  assert.equal(shortlist.length, 0, 'Phễu chuẩn cho ra 0 mã khi ngành bị bán');

  let isCounterTrend = false;
  if (!shortlist.length) {
    const counterList = scanned.filter((c) => c.liquidity.pass && c.quality.pass && trendOk(c));
    if (counterList.length > 0) {
      shortlist = counterList;
      isCounterTrend = true;
    }
  }

  assert.equal(isCounterTrend, true, 'Kích hoạt cờ ngược dòng');
  assert.equal(shortlist.length, 1, 'Lấy được mã MSB');
  assert.equal(shortlist[0].symbol, 'MSB');
});
