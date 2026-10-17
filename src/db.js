import pg from 'pg';

// Telegram id и счётчики помещаются в Number, а строки в JSON только мешают
pg.types.setTypeParser(20, v => Number(v));

const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl });

export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          BIGINT PRIMARY KEY,              -- Telegram user id
  first_name  TEXT,
  tz          TEXT NOT NULL DEFAULT 'Europe/Moscow',
  remind      JSONB NOT NULL DEFAULT '{"daily":true,"dailyTime":"10:00","def":15,"empty":true,"weekly":true}',
  last_daily  DATE,
  last_empty  DATE,
  last_weekly DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id        BIGINT PRIMARY KEY,                -- Telegram chat id канала
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title     TEXT,
  username  TEXT,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ideas (
  id         SERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  nets       TEXT[] NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'идея',
  plan       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posts (
  id           SERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  title        TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  nets         TEXT[] NOT NULL DEFAULT '{}',
  remind_min   INT,                             -- NULL = без напоминания
  files        JSONB NOT NULL DEFAULT '[]',     -- [{file_id, kind, name}]
  status       TEXT NOT NULL DEFAULT 'planned', -- planned | published | failed
  reminded     BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  channel_msg  BIGINT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_user_time ON posts(user_id, scheduled_at);

-- События канала для статистики Telegram: подписки, отписки, реакции
CREATE TABLE IF NOT EXISTS tg_events (
  id         BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL,
  kind       TEXT NOT NULL,                     -- join | leave
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_events_ch_at ON tg_events(channel_id, at);

CREATE TABLE IF NOT EXISTS tg_reactions (
  channel_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  total      INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

CREATE TABLE IF NOT EXISTS tg_followers (
  channel_id BIGINT NOT NULL,
  day        DATE NOT NULL,
  count      INT NOT NULL,
  PRIMARY KEY (channel_id, day)
);

CREATE TABLE IF NOT EXISTS recs_cache (
  user_id    BIGINT NOT NULL,
  net        TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, net)
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}

export async function upsertUser(u, tz) {
  const { rows } = await q(
    `INSERT INTO users (id, first_name, tz) VALUES ($1, $2, COALESCE($3, 'Europe/Moscow'))
     ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, tz = COALESCE($3, users.tz)
     RETURNING *`,
    [u.id, u.first_name || null, tz || null]
  );
  return rows[0];
}
