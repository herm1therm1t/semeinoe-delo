import express from 'express';
import multer from 'multer';
import { z } from 'zod/v4';
import { q, upsertUser } from './db.js';
import { requireTelegram } from './auth.js';
import { storeFile } from './bot.js';
import { expandTopic, draftPost, recommendations, ClaudeRefusal } from './claude.js';

const Net = z.enum(['tg', 'ig', 'yt', 'tt']);
const FileRef = z.object({ file_id: z.string(), kind: z.enum(['photo', 'video', 'audio', 'document']), name: z.string() });
const PostBody = z.object({
  title: z.string().trim().min(1).max(300),
  text: z.string().max(4096).default(''),
  nets: z.array(Net).min(1),
  scheduled_at: z.iso.datetime({ offset: true }),
  remind_min: z.number().int().min(0).max(10080).nullable(),
  files: z.array(FileRef).max(10).default([]),
});
const IdeaBody = z.object({
  title: z.string().trim().min(1).max(300),
  nets: z.array(Net).default([]),
  status: z.string().max(40).default('идея'),
  plan: z.any().optional(),
});
const RemindBody = z.object({
  daily: z.boolean(), dailyTime: z.string().regex(/^\d\d:\d\d$/), def: z.number().int().nullable(),
  empty: z.boolean(), weekly: z.boolean(),
});

const wrap = fn => (req, res, next) =>
  fn(req, res, next).catch(e => {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Неверные данные', details: e.issues });
    if (e instanceof ClaudeRefusal) return res.status(422).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Что-то пошло не так' });
  });

export function createApi({ bot, botToken }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 10 } });
  r.use(express.json({ limit: '1mb' }));
  r.use(requireTelegram(botToken));
  r.use(wrap(async (req, res, next) => {
    req.user = await upsertUser(req.tgUser, req.get('X-Timezone'));
    next();
  }));
  const uid = req => req.user.id;

  r.get('/me', wrap(async (req, res) => {
    const { rows: channels } = await q('SELECT id, title, username FROM channels WHERE user_id=$1', [uid(req)]);
    res.json({ user: { id: req.user.id, first_name: req.user.first_name, tz: req.user.tz }, remind: req.user.remind, channels });
  }));

  r.put('/remind', wrap(async (req, res) => {
    const body = RemindBody.parse(req.body);
    await q('UPDATE users SET remind=$2 WHERE id=$1', [uid(req), body]);
    res.json(body);
  }));

  // ---- идеи
  r.get('/ideas', wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM ideas WHERE user_id=$1 ORDER BY created_at DESC', [uid(req)]);
    res.json(rows);
  }));
  r.post('/ideas', wrap(async (req, res) => {
    const b = IdeaBody.parse(req.body);
    const { rows } = await q('INSERT INTO ideas (user_id, title, nets, status, plan) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [uid(req), b.title, b.nets, b.status, b.plan ?? null]);
    res.json(rows[0]);
  }));
  r.delete('/ideas/:id', wrap(async (req, res) => {
    await q('DELETE FROM ideas WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));

  // ---- посты
  r.get('/posts', wrap(async (req, res) => {
    const { from, to } = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
    const { rows } = await q('SELECT * FROM posts WHERE user_id=$1 AND scheduled_at >= $2 AND scheduled_at < $3 ORDER BY scheduled_at',
      [uid(req), from, to]);
    res.json(rows);
  }));
  r.post('/posts', wrap(async (req, res) => {
    const b = PostBody.parse(req.body);
    const { rows } = await q(
      `INSERT INTO posts (user_id, title, text, nets, scheduled_at, remind_min, files) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [uid(req), b.title, b.text, b.nets, b.scheduled_at, b.remind_min, JSON.stringify(b.files)]
    );
    res.json(rows[0]);
  }));
  r.put('/posts/:id', wrap(async (req, res) => {
    const b = PostBody.parse(req.body);
    // перенос в будущее снова ставит пост в очередь и сбрасывает напоминание
    const { rows } = await q(
      `UPDATE posts SET title=$3, text=$4, nets=$5, scheduled_at=$6, remind_min=$7, files=$8,
         reminded = CASE WHEN scheduled_at <> $6::timestamptz OR remind_min IS DISTINCT FROM $7 THEN false ELSE reminded END,
         status = CASE WHEN status IN ('failed','planned_manual') AND $6::timestamptz > now() THEN 'planned' ELSE status END,
         error = NULL
       WHERE id=$1 AND user_id=$2 AND status <> 'publishing' RETURNING *`,
      [req.params.id, uid(req), b.title, b.text, b.nets, b.scheduled_at, b.remind_min, JSON.stringify(b.files)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Пост не найден или уже публикуется' });
    res.json(rows[0]);
  }));
  r.delete('/posts/:id', wrap(async (req, res) => {
    await q(`DELETE FROM posts WHERE id=$1 AND user_id=$2 AND status <> 'publishing'`, [req.params.id, uid(req)]);
    res.json({ ok: true });
  }));

  r.post('/files', upload.array('files', 10), wrap(async (req, res) => {
    const out = [];
    for (const f of req.files || []) out.push(await storeFile(bot, uid(req), f));
    res.json(out);
  }));

  // Материалы из поиска: Telegram сам скачивает их по ссылке
  r.post('/files/url', wrap(async (req, res) => {
    const { items } = z.object({
      items: z.array(z.object({ url: z.url().refine(u => /^https:\/\/([a-z0-9-]+\.)*pexels\.com\//.test(u), 'только Pexels'), kind: z.enum(['photo', 'video']) })).max(10),
    }).parse(req.body);
    const out = [];
    for (const it of items) {
      const opts = { disable_notification: true, caption: '📎 из поиска' };
      const msg = it.kind === 'video' ? await bot.api.sendVideo(uid(req), it.url, opts) : await bot.api.sendPhoto(uid(req), it.url, opts);
      out.push({ file_id: it.kind === 'video' ? msg.video.file_id : msg.photo.at(-1).file_id, kind: it.kind, name: `${it.kind === 'video' ? 'видео' : 'фото'} Pexels` });
    }
    res.json(out);
  }));

  // ---- Claude
  r.post('/claude/expand', wrap(async (req, res) => {
    const { topic, nets } = z.object({ topic: z.string().trim().min(2).max(500), nets: z.array(Net).min(1) }).parse(req.body);
    res.json(await expandTopic(topic, nets));
  }));
  r.post('/claude/draft', wrap(async (req, res) => {
    const b = z.object({ title: z.string().trim().min(1).max(300), text: z.string().max(4096).default(''), nets: z.array(Net).default([]) }).parse(req.body);
    res.json(await draftPost(b));
  }));

  // ---- статистика
  r.get('/stats', wrap(async (req, res) => {
    const net = Net.parse(req.query.net);
    if (net !== 'tg') return res.json({ net, connected: false });
    res.json(await tgStats(uid(req), req.user.tz));
  }));
  r.get('/recs', wrap(async (req, res) => {
    const net = Net.parse(req.query.net);
    if (net !== 'tg') return res.json({ net, items: [] });
    const { rows } = await q(`SELECT data FROM recs_cache WHERE user_id=$1 AND net=$2 AND created_at > now() - interval '1 day'`, [uid(req), net]);
    if (rows[0]) return res.json(rows[0].data);
    const stats = await tgStats(uid(req), req.user.tz);
    if (!stats.connected) return res.json({ net, items: [] });
    const data = await recommendations(net, stats);
    await q(`INSERT INTO recs_cache (user_id, net, data) VALUES ($1,$2,$3)
             ON CONFLICT (user_id, net) DO UPDATE SET data=$3, created_at=now()`, [uid(req), net, data]);
    res.json(data);
  }));

  // ---- поиск материалов (Pexels, бесплатный ключ)
  r.get('/materials', wrap(async (req, res) => {
    const { query, type } = z.object({ query: z.string().trim().min(1).max(100), type: z.enum(['photo', 'video']).default('photo') }).parse(req.query);
    if (!process.env.PEXELS_API_KEY) return res.json({ configured: false, items: [] });
    const url = type === 'video'
      ? `https://api.pexels.com/videos/search?per_page=12&query=${encodeURIComponent(query)}`
      : `https://api.pexels.com/v1/search?per_page=12&query=${encodeURIComponent(query)}`;
    const r2 = await fetch(url, { headers: { Authorization: process.env.PEXELS_API_KEY } });
    if (!r2.ok) return res.status(502).json({ error: 'Поиск материалов недоступен' });
    const j = await r2.json();
    const items = type === 'video'
      ? j.videos.map(v => ({ id: v.id, thumb: v.image, url: v.video_files.find(f => f.quality === 'hd')?.link || v.video_files[0]?.link, author: v.user?.name }))
      : j.photos.map(p => ({ id: p.id, thumb: p.src.medium, url: p.src.large2x, author: p.photographer }));
    res.json({ configured: true, items });
  }));

  return r;
}

export async function tgStats(userId, tz) {
  const { rows: chans } = await q('SELECT id, title FROM channels WHERE user_id=$1', [userId]);
  if (!chans.length) return { net: 'tg', connected: false };
  const ids = chans.map(c => c.id);
  const { rows: days } = await q(
    `WITH d AS (SELECT generate_series((now() AT TIME ZONE $2)::date - 6, (now() AT TIME ZONE $2)::date, '1 day')::date AS day)
     SELECT to_char(d.day,'YYYY-MM-DD') AS day,
       (SELECT count(*) FROM tg_events e WHERE e.channel_id = ANY($1) AND e.kind='join'  AND (e.at AT TIME ZONE $2)::date = d.day)::int AS gain,
       (SELECT count(*) FROM tg_events e WHERE e.channel_id = ANY($1) AND e.kind='leave' AND (e.at AT TIME ZONE $2)::date = d.day)::int AS lost,
       (SELECT COALESCE(sum(r.total),0) FROM posts p JOIN tg_reactions r ON r.message_id=p.channel_msg AND r.channel_id = ANY($1)
          WHERE p.user_id=$3 AND (p.published_at AT TIME ZONE $2)::date = d.day)::int AS react
     FROM d ORDER BY d.day`,
    [ids, tz, userId]
  );
  const { rows: [f] } = await q(
    `SELECT COALESCE(sum(count),0)::int AS followers FROM (
       SELECT DISTINCT ON (channel_id) count FROM tg_followers WHERE channel_id = ANY($1) ORDER BY channel_id, day DESC) x`, [ids]);
  const { rows: top } = await q(
    `SELECT p.title, r.total AS reactions, to_char(p.published_at AT TIME ZONE $3, 'Dy HH24:MI') AS at
     FROM posts p JOIN tg_reactions r ON r.message_id=p.channel_msg AND r.channel_id = ANY($1)
     WHERE p.user_id=$2 AND p.published_at > now() - interval '30 days' ORDER BY r.total DESC LIMIT 3`,
    [ids, userId, tz]
  );
  return { net: 'tg', connected: true, channels: chans.map(c => c.title), followers: f.followers, days, top };
}
