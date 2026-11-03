import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdingEvents, holdLevels, holdWindow } from '../src/holdwatch.js';

const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);
const keys = (ev) => ev.flatMap((e) => e.keys);

test('Khung theo dõi danh mục: 9:15–14:50 ngày thường', () => {
  assert.equal(holdWindow(at('2026-10-22', '09:10')), false);
  assert.equal(holdWindow(at('2026-10-22', '10:00')), true);
  assert.equal(holdWindow(at('2026-10-22', '14:45')), true); // ATC
  assert.equal(holdWindow(at('2026-10-24', '10:00')), false); // thứ 7
});

test('Mức theo dõi như bản tin: ngưỡng cảnh báo xa từ giá vốn, không chốt lời theo mục tiêu', () => {
  const a = (holdStop) => ({ brief: { levels: { stop: 20, target: 26, holdStop } }, holding: { avgCost: 21, pnlPct: 0.12 } });
  assert.deepEqual(holdLevels(a(17.85)), { stop: 17.85, target: null });
  assert.deepEqual(holdLevels(a(undefined)), { stop: 20, target: null });
  assert.equal(holdLevels({ brief: {} }), null);
});

test('Cảnh báo mã đang giữ: dưới −15%, còn ≤ 5% là chạm ngưỡng, sát sàn, rủi ro rơi tự do; mỗi loại một lần', () => {
  const lv = { stop: 22.8 };
  assert.deepEqual(holdingEvents({ close: 24, prevClose: 23.9, ...lv }), []); // bình thường
  const near = holdingEvents({ close: 23.1, prevClose: 24.4, ...lv }); // còn 1,3% là chạm ngưỡng: báo trước một lần
  assert.deepEqual(keys(near), ['near']);
  assert.match(near[0].text, /Còn 1,3% là chạm ngưỡng cảnh báo 22,8/);
  assert.deepEqual(holdingEvents({ close: 23.1, prevClose: 24.4, ...lv }, ['near']), []); // đã báo hôm nay
  assert.deepEqual(holdingEvents({ close: 24.2, prevClose: 25.5, ...lv }), []); // giảm 5%, còn cách ngưỡng 6%: không báo (nhiễu)
  assert.deepEqual(holdingEvents({ close: 26.2, prevClose: 25, ...lv }), []); // tăng mạnh: không báo
  const broke = holdingEvents({ close: 22.5, prevClose: 23.9, ...lv });
  assert.deepEqual(keys(broke), ['stop']);
  assert.match(broke[0].text, /Dưới ngưỡng cảnh báo 22,8.*xem lại/);
  assert.deepEqual(holdingEvents({ close: 22.5, prevClose: 23.9, ...lv }, keys(broke)), []); // đã báo
  const floor = holdingEvents({ close: 22.25, prevClose: 23.9, ...lv }, keys(broke)); // −6,9%
  assert.deepEqual(keys(floor), ['floor']);
  assert.match(floor[0].text, /Sát giá sàn/);
  const risk = holdingEvents({ close: 24, prevClose: 24, stop: 20, risk: 'Rơi tự do 5 phiên (−13%)' });
  assert.deepEqual(keys(risk), ['risk']);
  assert.match(risk[0].text, /Rơi tự do 5 phiên/);
});
