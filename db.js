const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      channel     TEXT NOT NULL,
      redis_key   TEXT NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      index           INTEGER NOT NULL,
      type            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(conversation_id, index)
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
    CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  `);
  console.log("Database schema ready.");
}

async function upsertConversation(id, channel, redisKey) {
  await pool.query(
    `INSERT INTO conversations (id, channel, redis_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
    [id, channel, redisKey]
  );
}

async function insertMessage(conversationId, index, type, content) {
  await pool.query(
    `INSERT INTO messages (conversation_id, index, type, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (conversation_id, index) DO NOTHING`,
    [conversationId, index, type, content]
  );
}

async function getChannels() {
  const result = await pool.query(`
    SELECT
      channel,
      COUNT(*) AS conversations,
      MAX(updated_at) AS last_updated
    FROM conversations
    GROUP BY channel
    ORDER BY channel
  `);
  return result.rows;
}

async function getConversations(channel) {
  const result = await pool.query(
    `SELECT
       c.id,
       c.redis_key,
       c.created_at,
       c.updated_at,
       COUNT(m.id) AS message_count
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.channel = $1
     GROUP BY c.id, c.redis_key, c.created_at, c.updated_at
     ORDER BY c.updated_at DESC`,
    [channel]
  );
  return result.rows;
}

async function getMessages(redisKey) {
  const conv = await pool.query(
    "SELECT id FROM conversations WHERE redis_key = $1",
    [redisKey]
  );
  if (!conv.rows.length) return [];
  const result = await pool.query(
    `SELECT index, type, content, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY index ASC`,
    [conv.rows[0].id]
  );
  return result.rows;
}

async function getDailyStats(from, to) {
  const result = await pool.query(
    `SELECT
       channel,
       DATE(created_at AT TIME ZONE 'America/Sao_Paulo') AS date,
       COUNT(*) AS count
     FROM conversations
     WHERE created_at >= $1::date
       AND created_at <  $2::date + INTERVAL '1 day'
     GROUP BY channel, date
     ORDER BY channel, date`,
    [from, to]
  );
  return result.rows;
}

async function getTodayStats() {
  const result = await pool.query(`
    SELECT channel, COUNT(*) AS count
    FROM conversations
    WHERE created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY channel
  `);
  return result.rows;
}

async function getSummaryStats(from, to, channel) {
  const ch = channel || null;

  // Volume metrics: total conversations, messages, average
  const volRes = await pool.query(
    `SELECT
       COUNT(DISTINCT c.id)::int                                         AS total_conversations,
       COUNT(m.id)::int                                                  AS total_messages,
       ROUND(COUNT(m.id)::numeric / NULLIF(COUNT(DISTINCT c.id), 0), 1) AS avg_messages_per_conv
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.created_at >= $1::date
       AND c.created_at <  $2::date + INTERVAL '1 day'
       AND ($3::text IS NULL OR c.channel = $3)`,
    [from, to, ch]
  );

  // Heatmap: message counts grouped by day-of-week and hour (Sao Paulo TZ)
  const heatRes = await pool.query(
    `SELECT
       EXTRACT(DOW  FROM m.created_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow,
       EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour,
       COUNT(*)::int AS count
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.created_at >= $1::date
       AND m.created_at <  $2::date + INTERVAL '1 day'
       AND ($3::text IS NULL OR c.channel = $3)
     GROUP BY dow, hour
     ORDER BY dow, hour`,
    [from, to, ch]
  );

  const vol = volRes.rows[0];
  return {
    total_conversations: vol.total_conversations || 0,
    total_messages:      vol.total_messages      || 0,
    avg_messages_per_conv: Number(vol.avg_messages_per_conv) || 0,
    heatmap: heatRes.rows   // [{ dow: 0-6, hour: 0-23, count: N }]
  };
}

module.exports = {
  pool,
  initDb,
  upsertConversation,
  insertMessage,
  getChannels,
  getConversations,
  getMessages,
  getDailyStats,
  getTodayStats,
  getSummaryStats
};
