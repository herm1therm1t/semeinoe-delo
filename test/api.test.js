// Интеграционный тест: нужен Postgres в DATABASE_URL, иначе пропускается.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const skip = !process.env.DATABASE_URL && 'нет DATABASE_URL';
process.env.DEV_USER_ID ||= '777';
const USER = Number(process.env.DEV_USER_ID);
const CHANNEL = -100500;

let server, base, db, sent = [];
const fakeBot = {
  api: new Proxy({}, {
    get: (_t, method) => async (chatId, payload) => {
      sent.push({ method, chatId, payload });
      if (method === 'getChatMemberCount') return 1234;
      return { message_id: sent.length };
    },
  }),
};

before(async () => {
  if (skip) return;
  db = await import('../src/db.js');
  await db.migrate();
  await db.q('DELETE FROM users WHERE id=$1', [USER]);
  for (const t of ['channels', 'tg_events', 'tg_followers']) await db.q(`DELETE FROM ${t} WHERE ${t === 'channels' ? 'id' : 'channel_id'}=$1`, [CHANNEL]);
  const { createApi } = await import('../src/api.js');
  const app = express().use('/api', createApi({ bot: fakeBot, botToken: 'test' }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(async () => { server?.close(); await db?.pool.end(); });

const call = async (path, opts = {}) => {
  const r = await fetch(base + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Timezone': 'Europe/Moscow' },
    body: opts.body && JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json() };
};

test('посты: создание, валидация, публикация по расписанию', { skip }, async () => {
  const me = await call('/me');
  assert.equal(me.body.user.id, USER);
  assert.equal(me.body.user.tz, 'Europe/Moscow');

  const bad = await call('/posts', { method: 'POST', body: { title: '', nets: [] } });
  assert.equal(bad.status, 400);

  const future = new Date(Date.now() + 3600e3).toISOString();
  const created = await call('/posts', { method: 'POST', body: { title: 'Анонс', text: 'Привет', nets: ['tg', 'ig'], scheduled_at: future, remind_min: 15 } });
  assert.equal(created.status, 200);

  const list = await call(`/posts?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400e3).toISOString())}`);
  assert.equal(list.body.length, 1);

  // подключаем канал и делаем пост «просроченным» на минуту
  await db.q('INSERT INTO channels (id, user_id, title) VALUES ($1,$2,$3)', [CHANNEL, USER, 'Тест']);
  await db.q(`UPDATE posts SET scheduled_at = now() - interval '1 minute' WHERE id=$1`, [created.body.id]);
  const { createScheduler } = await import('../src/scheduler.js');
  sent = [];
  await createScheduler(fakeBot, 'https://example.com').tick();

  const toChannel = sent.find(s => s.method === 'sendMessage' && s.chatId === CHANNEL);
  assert.equal(toChannel.payload, 'Привет');
  assert.ok(sent.some(s => s.chatId === USER && /Instagram/.test(s.payload)), 'напоминание выложить в Instagram вручную');
  const { rows: [p] } = await db.q('SELECT status, channel_msg FROM posts WHERE id=$1', [created.body.id]);
  assert.equal(p.status, 'planned_manual');
  assert.ok(p.channel_msg);
});

test('напоминание приходит один раз', { skip }, async () => {
  const at = new Date(Date.now() + 10 * 60e3).toISOString();
  await call('/posts', { method: 'POST', body: { title: 'Рилс', nets: ['tg'], scheduled_at: at, remind_min: 15 } });
  const { createScheduler } = await import('../src/scheduler.js');
  const s = createScheduler(fakeBot, 'https://example.com');
  sent = [];
  await s.tick();
  await s.tick();
  assert.equal(sent.filter(x => x.chatId === USER && /⏰/.test(x.payload)).length, 1);
});

test('статистика Telegram считает подписки и отписки', { skip }, async () => {
  await db.q(`INSERT INTO tg_events (channel_id, kind) VALUES ($1,'join'),($1,'join'),($1,'leave')`, [CHANNEL]);
  const { body } = await call('/stats?net=tg');
  assert.equal(body.connected, true);
  assert.equal(body.followers, 1234);
  const today = body.days.at(-1);
  assert.equal(today.gain, 2);
  assert.equal(today.lost, 1);
  const ig = await call('/stats?net=ig');
  assert.equal(ig.body.connected, false);
});
