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

test('Cảnh báo mã đang giữ: cắt lỗ, chốt lời, biến động mạnh, mỗi loại một lần', () => {
  const lv = { stop: 22.8, target: 26 };
  assert.deepEqual(holdingEvents({ close: 24, prevClose: 23.9, ...lv }), []); // bình thường
  assert.deepEqual(keys(holdingEvents({ close: 23.1, prevClose: 23.5, ...lv })), ['nearStop']); // cách 1,3%
  const broke = holdingEvents({ close: 22.5, prevClose: 23.9, ...lv }); // −5,9%
  assert.match(broke[0].text, /Dưới ngưỡng cảnh báo 22,8.*xem lại/);
  assert.deepEqual(keys(broke), ['stop', 'nearStop', 'drop3', 'drop5']); // một tin cho mức nặng nhất
  assert.match(broke[1].text, /Giảm mạnh −5,9%/);
  // đã báo rồi thì không báo lại; giảm tiếp tới sát sàn thì báo mức mới
  assert.deepEqual(holdingEvents({ close: 22.5, prevClose: 23.9, ...lv }, keys(broke)), []);
  const floor = holdingEvents({ close: 22.25, prevClose: 23.9, ...lv }, keys(broke));
  assert.equal(floor.length, 1);
  assert.match(floor[0].text, /Sát giá sàn/);
  const up = holdingEvents({ close: 26.2, prevClose: 25, ...lv }); // +4,8% và chạm chốt lời
  assert.deepEqual(keys(up), ['target', 'rise4']);
});
