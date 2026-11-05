import test from 'node:test';
import assert from 'node:assert/strict';
import { dbSyncDue } from '../src/db.js';

// giờ VN → Date UTC
const at = (d, hm) => new Date(`${d}T${hm}:00+07:00`);

test('Database lưu mỗi ngày một lần sau 16:30, máy bật muộn thì lưu bù', () => {
  assert.equal(dbSyncDue(at('2026-11-05', '10:00'), null), null); // trong phiên: không lưu
  assert.equal(dbSyncDue(at('2026-11-05', '16:29'), null), null);
  assert.equal(dbSyncDue(at('2026-11-05', '16:30'), null), '2026-11-05');
  assert.equal(dbSyncDue(at('2026-11-05', '20:04'), '2026-11-05'), null); // đã lưu hôm nay
  assert.equal(dbSyncDue(at('2026-11-05', '20:04'), '2026-11-04'), '2026-11-05'); // bật máy tối: lưu bù
  assert.equal(dbSyncDue(at('2026-11-06', '09:00'), '2026-11-05'), null);
});
