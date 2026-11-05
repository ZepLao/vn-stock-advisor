import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthMessages, autotradeCheck } from '../src/health.js';

test('healthMessages: báo một lần khi lỗi, một lần khi ổn lại, không lặp', () => {
  const down = { db: { ok: false, label: 'Database', detail: 'không kết nối được' } };
  const a = healthMessages(down, {});
  assert.equal(a.messages.length, 1);
  assert.match(a.messages[0], /Database/);
  const b = healthMessages(down, a.state);
  assert.equal(b.messages.length, 0, 'vẫn lỗi thì không báo lại');
  const c = healthMessages({ db: { ok: true, label: 'Database' } }, b.state);
  assert.match(c.messages[0], /hoạt động lại/);
  assert.equal(healthMessages({ x: { ok: null, label: 'X' } }, {}).messages.length, 0, 'không áp dụng thì bỏ qua');
});

test('autotradeCheck: chỉ xét ngày có phiên, sau 15:30 giờ Việt Nam', () => {
  const at = (h, m) => new Date(Date.UTC(2026, 10, 5, h - 7, m)); // giờ Việt Nam
  const base = { lastIndexDate: '2026-11-05', opened: true };
  assert.equal(autotradeCheck({ ...base, now: at(15, 0), lastProcessed: '2026-11-04' }).ok, null); // chưa tới giờ
  assert.equal(autotradeCheck({ ...base, now: at(16, 0), lastProcessed: '2026-11-05' }).ok, true);
  assert.equal(autotradeCheck({ ...base, now: at(16, 0), lastProcessed: '2026-11-04' }).ok, false);
  assert.equal(autotradeCheck({ ...base, lastIndexDate: '2026-11-04', now: at(16, 0), lastProcessed: '2026-11-04' }).ok, null); // hôm nay không có phiên
  assert.equal(autotradeCheck({ ...base, opened: false, now: at(16, 0), lastProcessed: null }).ok, null);
});
