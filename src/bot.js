import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { q, upsertUser } from './db.js';
import { isAllowed } from './auth.js';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member', 'chat_member', 'message_reaction_count'];
const CAPTION_LIMIT = 1024;

export function createBot(token, webAppUrl) {
  const bot = new Bot(token);
  const openApp = () => new InlineKeyboard().webApp('Открыть «Семейное дело»', webAppUrl);

  bot.command('start', async ctx => {
    if (!isAllowed(ctx.from.id)) return ctx.reply('Это приложение личное. Доступа нет.');
    await upsertUser(ctx.from);
    await ctx.reply(
      'Добро пожаловать в семью.\n\n' +
        'Здесь ты планируешь посты на неделю, а я напоминаю и публикую в канал.\n' +
        'Чтобы подключить Telegram-канал, добавь меня в него администратором с правом публикации.',
      { reply_markup: openApp() }
    );
  });

  bot.command('app', ctx => ctx.reply('Открывай:', { reply_markup: openApp() }));

  // Бота добавили в канал или убрали из него
  bot.on('my_chat_member', async ctx => {
    const { chat, new_chat_member: m, from } = ctx.myChatMember;
    if (chat.type !== 'channel') return;
    if (m.status === 'administrator' && m.can_post_messages && isAllowed(from.id)) {
      await upsertUser(from);
      await q(
        `INSERT INTO channels (id, user_id, title, username) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET user_id=$2, title=$3, username=$4`,
        [chat.id, from.id, chat.title, chat.username || null]
      );
      await snapshotFollowers(bot, chat.id).catch(() => {});
      await bot.api.sendMessage(from.id, `Канал «${chat.title}» подключён. Буду публиковать туда посты из расписания и собирать статистику.`).catch(() => {});
    } else if (['left', 'kicked', 'member'].includes(m.status)) {
      const { rows } = await q('DELETE FROM channels WHERE id=$1 RETURNING user_id', [chat.id]);
      if (rows[0]) await bot.api.sendMessage(rows[0].user_id, `Канал «${chat.title}» отключён: у меня больше нет прав публикации.`).catch(() => {});
    }
  });

  // Подписки и отписки в канале (приходят, только если бот администратор)
  bot.on('chat_member', async ctx => {
    const { chat, old_chat_member: o, new_chat_member: n } = ctx.chatMember;
    if (chat.type !== 'channel') return;
    const wasIn = ['member', 'administrator', 'creator', 'restricted'].includes(o.status);
    const isIn = ['member', 'administrator', 'creator', 'restricted'].includes(n.status);
    if (wasIn === isIn) return;
    await q('INSERT INTO tg_events (channel_id, kind) VALUES ($1,$2)', [chat.id, isIn ? 'join' : 'leave']);
  });

  // Анонимные реакции на посты канала
  bot.on('message_reaction_count', async ctx => {
    const { chat, message_id, reactions } = ctx.messageReactionCount;
    const total = reactions.reduce((s, r) => s + r.total_count, 0);
    await q(
      `INSERT INTO tg_reactions (channel_id, message_id, total) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id, message_id) DO UPDATE SET total=$3, updated_at=now()`,
      [chat.id, message_id, total]
    );
  });

  bot.callbackQuery(/^done:(\d+)$/, async ctx => {
    await q(`UPDATE posts SET status='published', published_at=now() WHERE id=$1 AND user_id=$2`, [ctx.match[1], ctx.from.id]);
    await ctx.answerCallbackQuery({ text: 'Отмечено как опубликованное' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.catch(err => console.error('bot error', err.error));
  return bot;
}

export async function snapshotFollowers(bot, channelId) {
  const count = await bot.api.getChatMemberCount(channelId);
  await q(
    `INSERT INTO tg_followers (channel_id, day, count) VALUES ($1, CURRENT_DATE, $2)
     ON CONFLICT (channel_id, day) DO UPDATE SET count=$2`,
    [channelId, count]
  );
  return count;
}

// Загружаем файл пользователю в личку, чтобы получить file_id и потом публиковать без своего хранилища
export async function storeFile(bot, userId, { buffer, originalname, mimetype }) {
  const input = new InputFile(buffer, originalname);
  const opts = { caption: `📎 ${originalname}`, disable_notification: true };
  let msg, kind;
  if (mimetype?.startsWith('image/') && !mimetype.includes('gif')) {
    msg = await bot.api.sendPhoto(userId, input, opts);
    kind = 'photo';
  } else if (mimetype?.startsWith('video/')) {
    msg = await bot.api.sendVideo(userId, input, opts);
    kind = 'video';
  } else if (mimetype?.startsWith('audio/')) {
    msg = await bot.api.sendAudio(userId, input, opts);
    kind = 'audio';
  } else {
    msg = await bot.api.sendDocument(userId, input, opts);
    kind = 'document';
  }
  const file_id =
    kind === 'photo' ? msg.photo.at(-1).file_id : (msg.video || msg.audio || msg.document).file_id;
  return { file_id, kind, name: originalname };
}

// Отправка поста (текст + файлы) в любой чат. Возвращает id первого сообщения.
export async function sendPost(bot, chatId, post, extra = {}) {
  const text = post.text?.trim() || post.title;
  const files = post.files || [];
  const send = {
    photo: (id, o) => bot.api.sendPhoto(chatId, id, o),
    video: (id, o) => bot.api.sendVideo(chatId, id, o),
    audio: (id, o) => bot.api.sendAudio(chatId, id, o),
    document: (id, o) => bot.api.sendDocument(chatId, id, o),
  };
  if (!files.length) return (await bot.api.sendMessage(chatId, text, extra)).message_id;

  const fitsCaption = text.length <= CAPTION_LIMIT;
  const visual = files.filter(f => f.kind === 'photo' || f.kind === 'video');
  let first;
  if (files.length === 1) {
    const f = files[0];
    first = (await send[f.kind](f.file_id, { ...(fitsCaption ? { caption: text } : {}), ...extra })).message_id;
  } else if (visual.length === files.length && files.length <= 10) {
    const media = files.map((f, i) => ({ type: f.kind, media: f.file_id, ...(i === 0 && fitsCaption ? { caption: text } : {}) }));
    first = (await bot.api.sendMediaGroup(chatId, media))[0].message_id;
  } else {
    for (const f of files) {
      const m = await send[f.kind](f.file_id, {});
      first ??= m.message_id;
    }
    await bot.api.sendMessage(chatId, text, extra);
    return first;
  }
  if (!fitsCaption) await bot.api.sendMessage(chatId, text, extra);
  return first;
}
