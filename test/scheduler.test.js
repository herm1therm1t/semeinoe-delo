import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localParts } from '../src/scheduler.js';

test('локальные дата и время по часовому поясу', () => {
  const d = new Date('2026-10-17T21:30:00Z');
  assert.deepEqual(localParts('Europe/Moscow', d), { date: '2026-10-18', time: '00:30', weekday: 'Sun' });
  assert.deepEqual(localParts('America/New_York', d), { date: '2026-10-17', time: '17:30', weekday: 'Sat' });
});
