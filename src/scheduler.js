import { InlineKeyboard } from 'grammy';
import { q } from './db.js';
import { sendPost, snapshotFollowers } from './bot.js';

const NET = { tg: 'Telegram', ig: 'Instagram', yt: 'YouTube', tt: 'TikTok' };
const MISSED_AFTER_MIN = 120; // если сервер лежал дольше, не публикуем задним числом
const TICK_MS = 30_000;

export function localParts(tz, d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(d).map(x => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

const fmtTime = (d, tz) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
const nets = arr => arr.map(n => NET[n]).join(', ');

export function createScheduler(bot, webAppUrl) {
  const appKb = () => new InlineKeyboard().webApp('Открыть расписание', webAppUrl);
  let running = false;

  async function publishDue() {
    const { rows } = await q(
      `UPDATE posts p SET status='publishing'
       FROM users u WHERE u.id=p.user_id AND p.status='planned' AND p.scheduled_at <= now()
       RETURNING p.*, u.tz`
    );
    for (const post of rows) {
      const late = (Date.now() - new Date(post.scheduled_at)) / 60000;
      if (late > MISSED_AFTER_MIN) {
        await q(`UPDATE posts SET status='failed', error='пропущен: сервер был недоступен' WHERE id=$1`, [post.id]);
        await bot.api.sendMessage(post.user_id, `Пост «${post.title}» пропущен: в ${fmtTime(new Date(post.scheduled_at), post.tz)} я был недоступен. Перенеси его в расписании.`, { reply_markup: appKb() }).catch(() => {});
        continue;
      }
      const errors = [];
      let msgId = null;
      if (post.nets.includes('tg')) {
        const { rows: chans } = await q('SELECT id FROM channels WHERE user_id=$1', [post.user_id]);
        if (!chans.length) errors.push('Telegram-канал не подключён');
        for (const c of chans) {
          try { msgId ??= await sendPost(bot, c.id, post); } catch (e) { errors.push(`канал: ${e.description || e.message}`); }
        }
      }
      const manual = post.nets.filter(n => n !== 'tg');
      if (manual.length) {
        // Остальные площадки пока без API: присылаем готовый пост в личку, чтобы выложить вручную
        await bot.api.sendMessage(post.user_id, `🎬 Пора выложить в ${nets(manual)}: «${post.title}». Текст и материалы ниже.`).catch(() => {});
        await sendPost(bot, post.user_id, post, {
          reply_markup: new InlineKeyboard().text('Выложил ✅', `done:${post.id}`),
        }).catch(e => errors.push(`личка: ${e.description || e.message}`));
      }
      const ok = !errors.length;
      await q(
        `UPDATE posts SET status=$2, published_at=CASE WHEN $3 THEN now() END, channel_msg=$4, error=$5 WHERE id=$1`,
        [post.id, ok ? (manual.length ? 'planned_manual' : 'published') : 'failed', ok, msgId, ok ? null : errors.join('; ')]
      );
      if (!ok) await bot.api.sendMessage(post.user_id, `Не получилось опубликовать «${post.title}»: ${errors.join('; ')}.`, { reply_markup: appKb() }).catch(() => {});
    }
  }

  async function remindDue() {
    const { rows } = await q(
      `UPDATE posts p SET reminded=true FROM users u
       WHERE u.id=p.user_id AND p.status='planned' AND NOT p.reminded AND p.remind_min IS NOT NULL
         AND p.remind_min > 0 AND p.scheduled_at - make_interval(mins => p.remind_min) <= now()
         AND p.scheduled_at > now()
       RETURNING p.*, u.tz`
    );
    for (const p of rows) {
      const auto = p.nets.includes('tg') ? 'В Telegram опубликую сам.' : 'Пришлю готовый текст, когда придёт время.';
      await bot.api.sendMessage(
        p.user_id,
        `⏰ В ${fmtTime(new Date(p.scheduled_at), p.tz)}: «${p.title}» (${nets(p.nets)}).\n${auto}`,
        { reply_markup: appKb() }
      ).catch(() => {});
    }
  }

  async function digests() {
    const { rows: users } = await q('SELECT * FROM users');
    for (const u of users) {
      const r = u.remind || {};
      const now = localParts(u.tz);
      const lastDaily = u.last_daily && u.last_daily.toISOString().slice(0, 10);

      if (r.daily && now.time >= (r.dailyTime || '10:00') && lastDaily !== now.date) {
        await q('UPDATE users SET last_daily=$2 WHERE id=$1', [u.id, now.date]);
        const { rows: today } = await q(
          `SELECT * FROM posts WHERE user_id=$1 AND (scheduled_at AT TIME ZONE $2)::date = $3::date ORDER BY scheduled_at`,
          [u.id, u.tz, now.date]
        );
        const body = today.length
          ? today.map(p => `• ${fmtTime(new Date(p.scheduled_at), u.tz)} ${p.title} (${nets(p.nets)})`).join('\n')
          : 'На сегодня постов нет. Самое время накидать тему.';
        await bot.api.sendMessage(u.id, `☕ План на сегодня:\n${body}`, { reply_markup: appKb() }).catch(() => {});
      }

      const lastEmpty = u.last_empty && u.last_empty.toISOString().slice(0, 10);
      if (r.empty && now.time >= '20:00' && lastEmpty !== now.date) {
        await q('UPDATE users SET last_empty=$2 WHERE id=$1', [u.id, now.date]);
        const { rows: [{ n }] } = await q(
          `SELECT count(*)::int n FROM posts WHERE user_id=$1 AND (scheduled_at AT TIME ZONE $2)::date = $3::date + 1`,
          [u.id, u.tz, now.date]
        );
        if (!n) await bot.api.sendMessage(u.id, 'На завтра ничего не запланировано. Набросаем пару тем?', { reply_markup: appKb() }).catch(() => {});
      }

      const lastWeekly = u.last_weekly && u.last_weekly.toISOString().slice(0, 10);
      if (r.weekly && now.weekday === 'Sun' && now.time >= '19:00' && lastWeekly !== now.date) {
        await q('UPDATE users SET last_weekly=$2 WHERE id=$1', [u.id, now.date]);
        const { rows: [s] } = await q(
          `SELECT count(*) FILTER (WHERE status='published')::int done, count(*)::int total
           FROM posts WHERE user_id=$1 AND scheduled_at > now() - interval '7 days' AND scheduled_at <= now()`,
          [u.id]
        );
        const { rows: [ev] } = await q(
          `SELECT count(*) FILTER (WHERE kind='join')::int joined, count(*) FILTER (WHERE kind='leave')::int left_
           FROM tg_events e JOIN channels c ON c.id=e.channel_id WHERE c.user_id=$1 AND e.at > now() - interval '7 days'`,
          [u.id]
        );
        await bot.api.sendMessage(
          u.id,
          `📒 Итоги недели\nОпубликовано: ${s.done} из ${s.total}\nTelegram: +${ev.joined} / −${ev.left_} подписчиков\nПодробности и советы во вкладке «Цифры».`,
          { reply_markup: appKb() }
        ).catch(() => {});
      }
    }
  }

  async function followers() {
    const { rows } = await q(
      `SELECT c.id FROM channels c WHERE NOT EXISTS (SELECT 1 FROM tg_followers f WHERE f.channel_id=c.id AND f.day=CURRENT_DATE)`
    );
    for (const c of rows) await snapshotFollowers(bot, c.id).catch(e => console.error('followers', e.message));
  }

  async function tick() {
    if (running) return;
    running = true;
    for (const step of [publishDue, remindDue, digests, followers]) {
      try { await step(); } catch (e) { console.error(step.name, e); }
    }
    running = false;
  }

  return { tick };
}

export async function startScheduler(bot, webAppUrl) {
  // посты, зависшие в 'publishing' после рестарта, возвращаем в очередь
  await q(`UPDATE posts SET status='planned' WHERE status='publishing'`).catch(() => {});
  const { tick } = createScheduler(bot, webAppUrl);
  tick();
  return setInterval(tick, TICK_MS);
}
