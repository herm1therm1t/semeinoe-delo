import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const NET_NAMES = { tg: 'Telegram-канал', ig: 'Instagram', yt: 'YouTube', tt: 'TikTok' };

const SYSTEM = `Ты контент-продюсер автора, который ведёт Telegram-канал, Instagram, YouTube и TikTok.
Пиши по-русски, живо и конкретно, без канцелярита и без хэштег-спама. Учитывай формат каждой площадки.`;

export class ClaudeRefusal extends Error {}

async function ask(prompt, schema) {
  if (!process.env.ANTHROPIC_API_KEY) throw new ClaudeRefusal('Claude не подключён: добавь ANTHROPIC_API_KEY в переменные хостинга');
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(schema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') throw new ClaudeRefusal('Claude отказался отвечать на этот запрос');
  if (!res.parsed_output) throw new Error('Claude вернул ответ не в том формате');
  return res.parsed_output;
}

const Expansion = z.object({
  angle: z.string().describe('Угол подачи в одно предложение'),
  hook: z.string().describe('Первая фраза или первые 2 секунды ролика'),
  plan: z.array(z.string()).describe('3-6 пунктов структуры поста'),
  per_net: z.array(z.object({
    net: z.enum(['tg', 'ig', 'yt', 'tt']),
    format: z.string().describe('Формат и длина для площадки'),
    draft: z.string().describe('Готовый черновик текста или сценария для площадки'),
  })),
  material_queries: z.array(z.string()).describe('2-4 коротких поисковых запроса на английском для стоковых фото и видео'),
});

export function expandTopic(topic, nets) {
  const list = nets.map(n => `${n} (${NET_NAMES[n]})`).join(', ');
  return ask(
    `Тема: «${topic}».\nПлощадки: ${list}.\nРазверни тему: угол подачи, хук, план и черновик под каждую площадку из списка.`,
    Expansion
  );
}

const Draft = z.object({ text: z.string() });

export function draftPost({ title, text, nets }) {
  const where = (nets || []).map(n => NET_NAMES[n]).join(', ') || 'Telegram-канал';
  return ask(
    `Напиши пост для: ${where}.\nТема: «${title}».\n` +
      (text ? `Что уже написано (дополни и улучши, сохрани смысл):\n${text}\n` : '') +
      'Верни только готовый текст поста.',
    Draft
  );
}

const Recs = z.object({
  items: z.array(z.object({ title: z.string(), detail: z.string() })).describe('3 рекомендации'),
});

export function recommendations(net, summary) {
  return ask(
    `Площадка: ${NET_NAMES[net]}.\nДанные за последние недели (JSON):\n${JSON.stringify(summary)}\n` +
      'Дай 3 конкретные рекомендации по постингу: что заходит, когда постить, что убрать. ' +
      'Опирайся только на эти данные; если данных мало, так и скажи и предложи, что проверить.',
    Recs
  );
}
