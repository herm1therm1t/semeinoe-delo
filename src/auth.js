import crypto from 'node:crypto';

const MAX_AGE_SEC = 24 * 3600;

// Проверка подписи initData из Telegram Mini App:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken, now = Date.now()) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > MAX_AGE_SEC) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

const allowed = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean).map(Number);

export const isAllowed = id => !allowed.length || allowed.includes(Number(id));

// Express middleware: кладёт Telegram-пользователя в req.tgUser
export function requireTelegram(botToken) {
  return (req, res, next) => {
    let user = verifyInitData(req.get('X-Telegram-Init-Data'), botToken);
    if (!user && process.env.DEV_USER_ID && process.env.NODE_ENV !== 'production') {
      user = { id: Number(process.env.DEV_USER_ID), first_name: 'Dev' };
    }
    if (!user) return res.status(401).json({ error: 'Открой приложение из Telegram' });
    if (!isAllowed(user.id)) return res.status(403).json({ error: 'Нет доступа' });
    req.tgUser = user;
    next();
  };
}
