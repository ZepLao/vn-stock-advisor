import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNewsItem, attachPriceReaction, parseRss } from '../src/news.js';

const item = (title) => scoreNewsItem({ title, summary: '', publishedAt: null });

test('phân loại nhóm sự kiện', () => {
  assert.ok(item('HPG báo lãi quý 3 tăng 50%').categories.includes('earnings'));
  assert.ok(item('VNM chốt quyền trả cổ tức tiền mặt').categories.includes('dividend'));
  assert.ok(item('Khối ngoại bán ròng mạnh FPT').categories.includes('flow'));
  assert.ok(item('Khởi tố nguyên lãnh đạo công ty').categories.includes('legal'));
  // "doanh" chứa "anh" nhưng không phải giao dịch nội bộ
  assert.ok(!item('Doanh nghiệp bán hàng tăng mạnh').categories.includes('insider'));
});

test('giao dịch nội bộ: mua là tích cực, bán là tiêu cực', () => {
  assert.equal(item('Lãnh đạo HPG đăng ký mua cổ phiếu khi thị trường điều chỉnh').label, 'tich_cuc');
  assert.equal(item('CẢNH BÁO | CON TRAI CHỦ TỊCH MUA 50 TRIỆU CỔ PHIẾU HPG').label, 'tich_cuc');
  assert.equal(item('Chị gái Phó Chủ tịch hoàn tất bán 350.000 cổ phiếu').label, 'tieu_cuc');
});

test('phản ứng giá: tin sau 15h tính cho phiên kế tiếp', () => {
  const bars = [
    { time: '2026-10-12', close: 100 },
    { time: '2026-10-13', close: 102 },
    { time: '2026-10-14', close: 99.96 },
  ];
  // 13/10 10:00 giờ VN = 03:00 UTC → phiên 13/10 (+2%)
  const morning = Date.UTC(2026, 9, 13, 3);
  // 13/10 16:00 giờ VN = 09:00 UTC → phiên 14/10 (−2%)
  const evening = Date.UTC(2026, 9, 13, 9);
  const [a, b] = attachPriceReaction([{ publishedAt: morning }, { publishedAt: evening }], bars);
  assert.deepEqual(a.reaction, { date: '2026-10-13', pct: 2 });
  assert.deepEqual(b.reaction, { date: '2026-10-14', pct: -2 });
});

test('parseRss: bỏ hậu tố tên báo của Google News, đọc năm 2 chữ số của CafeF', () => {
  const g = parseRss('<item><title>FPT tăng mạnh - CafeF</title><link>https://x</link><pubDate>Tue, 06 Oct 2026 17:03:00 GMT</pubDate><source url="https://cafef.vn">CafeF</source></item>', 'Google News');
  assert.equal(g[0].title, 'FPT tăng mạnh');
  const c = parseRss('<item><title><![CDATA[Tin A]]></title><pubDate>Thu, 15 Oct 26 19:11:00 +0700</pubDate></item>', 'CafeF');
  assert.equal(new Date(c[0].publishedAt).getUTCFullYear(), 2026);
});

test('Chỉ nhận tin từ báo tài chính uy tín, loại trang câu view và mục giải trí', async () => {
  const { isQualitySource, parseRss } = await import('../src/news.js');
  assert.equal(isQualitySource('https://cafef.vn'), true);
  assert.equal(isQualitySource('https://www.tinnhanhchungkhoan.vn'), true);
  assert.equal(isQualitySource('https://finance.vietstock.vn'), true);
  assert.equal(isQualitySource('https://nguoiquansat.vn'), false);
  assert.equal(isQualitySource('https://24hmoney.vn'), false);
  assert.equal(isQualitySource('https://ngoisao.vnexpress.net'), false);
  assert.equal(isQualitySource('https://cafef.vn.fake.com'), false);
  assert.equal(isQualitySource(null), false);
  const [it] = parseRss('<rss><item><title>FPT lãi lớn - CafeF</title><link>x</link><source url="https://cafef.vn">CafeF</source></item></rss>', 'Google News');
  assert.equal(it.sourceUrl, 'https://cafef.vn');
  assert.equal(it.title, 'FPT lãi lớn');
});
