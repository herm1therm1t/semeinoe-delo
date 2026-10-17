import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData } from '../src/auth.js';

const TOKEN = '123:abc';
function sign(fields) {
  const dc = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dc).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('принимает корректную подпись', () => {
  const now = Date.now();
  const init = sign({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 42, first_name: 'Т' }) });
  assert.equal(verifyInitData(init, TOKEN, now).id, 42);
});

test('отклоняет подделку и чужой токен', () => {
  const now = Date.now();
  const init = sign({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 42 }) });
  assert.equal(verifyInitData(init.replace('42', '43'), TOKEN, now), null);
  assert.equal(verifyInitData(init, '999:zzz', now), null);
  assert.equal(verifyInitData('', TOKEN, now), null);
});

test('отклоняет устаревшие данные', () => {
  const now = Date.now();
  const init = sign({ auth_date: String(Math.floor(now / 1000) - 2 * 86400), user: JSON.stringify({ id: 42 }) });
  assert.equal(verifyInitData(init, TOKEN, now), null);
});
