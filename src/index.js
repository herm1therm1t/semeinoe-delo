import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhookCallback } from 'grammy';
import { migrate } from './db.js';
import { createBot, ALLOWED_UPDATES } from './bot.js';
import { createApi } from './api.js';
import { startScheduler } from './scheduler.js';

const { BOT_TOKEN, WEBAPP_URL, PORT = 3000, WEBHOOK_SECRET } = process.env;
for (const [k, v] of Object.entries({ BOT_TOKEN, WEBAPP_URL, DATABASE_URL: process.env.DATABASE_URL })) {
  if (!v) { console.error(`Не задана переменная окружения ${k} (см. .env.example)`); process.exit(1); }
}

await migrate();
const bot = createBot(BOT_TOKEN, WEBAPP_URL);
await bot.init();
const app = express();
const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', createApi({ bot, botToken: BOT_TOKEN }));

// Вебхук, если задан WEBHOOK_SECRET, иначе long polling
if (WEBHOOK_SECRET) {
  app.post(`/tg/${WEBHOOK_SECRET}`, express.json(), webhookCallback(bot, 'express'));
}
app.use(express.static(webDir));

app.listen(PORT, async () => {
  console.log(`Сервер на порту ${PORT}`);
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: WEBAPP_URL } } }).catch(e => console.error('menu button', e.message));
  await bot.api.setMyCommands([{ command: 'start', description: 'Начать' }, { command: 'app', description: 'Открыть приложение' }]).catch(() => {});
  if (WEBHOOK_SECRET) {
    await bot.api.setWebhook(new URL(`/tg/${WEBHOOK_SECRET}`, WEBAPP_URL).href, { allowed_updates: ALLOWED_UPDATES });
  } else {
    await bot.api.deleteWebhook();
    bot.start({ allowed_updates: ALLOWED_UPDATES, onStart: me => console.log(`Бот @${me.username} запущен`) });
  }
  startScheduler(bot, WEBAPP_URL);
});
