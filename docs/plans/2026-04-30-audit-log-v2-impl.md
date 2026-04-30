# Justy Audit Log v2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Adicionar PostgreSQL como camada de persistência, captura em tempo real via Redis Keyspace Notifications, timestamps em todas as telas, correção da ordem das mensagens e dashboard de estatísticas por dia na tela inicial.

**Architecture:** O `server.js` é dividido em três módulos: `db.js` (PostgreSQL), `collector.js` (Redis Pub/Sub) e `server.js` (HTTP). Na startup o servidor sincroniza chaves existentes do Redis e inicia o subscriber para captura em tempo real. O frontend passa a consumir dados do Postgres via API.

**Tech Stack:** Node.js 20, `redis` npm ^5, `pg` npm (PostgreSQL client), PostgreSQL 15, HTML/CSS/JS vanilla

---

## Task 1: Instalar `pg` e criar `db.js`

**Files:**
- Modify: `package.json`
- Create: `db.js`

**Step 1: Instalar a dependência**

```bash
cd C:/Users/isacf/projetos/redis-stream-dashboard
npm install pg
```

Verificar que `package.json` agora tem `"pg"` em `dependencies`.

**Step 2: Criar `db.js`**

```js
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

module.exports = {
  pool,
  initDb,
  upsertConversation,
  insertMessage,
  getChannels,
  getConversations,
  getMessages,
  getDailyStats,
  getTodayStats
};
```

**Step 3: Commit**

```bash
git add package.json package-lock.json db.js
git commit -m "feat: add PostgreSQL client and db.js with schema + queries"
```

---

## Task 2: Criar `collector.js`

**Files:**
- Create: `collector.js`

**Step 1: Criar `collector.js`**

```js
const { createClient } = require("redis");
const { upsertConversation, insertMessage } = require("./db");

function parseKey(key) {
  const withoutPrefix = key.replace(/^chat:/, "");
  const lastColon = withoutPrefix.lastIndexOf(":");
  if (lastColon === -1) return { channel: withoutPrefix, id: "" };
  return {
    channel: withoutPrefix.slice(0, lastColon),
    id: withoutPrefix.slice(lastColon + 1)
  };
}

function parseMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      type: parsed.type || "unknown",
      content: parsed.data?.content || raw
    };
  } catch {
    return { type: "raw", content: raw };
  }
}

async function syncKey(redisData, key) {
  if (!key.startsWith("chat:")) return;
  const { channel, id } = parseKey(key);
  if (!id) return;

  await upsertConversation(id, channel, key);

  // Redis usa LPUSH: índice 0 = mais recente, último = mais antigo
  // Revertemos para que index 0 = mais antigo (ordem cronológica)
  const items = await redisData.lRange(key, 0, -1);
  const chronological = [...items].reverse();

  for (let i = 0; i < chronological.length; i++) {
    const { type, content } = parseMessage(chronological[i]);
    await insertMessage(id, i, type, content);
  }
}

async function startCollector(redisData, redisUrl) {
  // Habilitar keyspace notifications para eventos de List
  try {
    await redisData.configSet("notify-keyspace-events", "KEl");
    console.log("Collector: keyspace notifications enabled.");
  } catch (err) {
    console.warn("Collector: could not set keyspace notifications:", err.message);
  }

  const redisSub = createClient({ url: redisUrl });
  redisSub.on("error", (err) => console.error("Subscriber error:", err.message));
  await redisSub.connect();

  await redisSub.subscribe("__keyevent@0__:lpush", async (key) => {
    if (!key.startsWith("chat:")) return;
    try {
      await syncKey(redisData, key);
    } catch (err) {
      console.error("Collector: error syncing key", key, "-", err.message);
    }
  });

  console.log("Collector: listening for Redis keyspace events...");
  return redisSub;
}

module.exports = { syncKey, startCollector, parseKey };
```

**Step 2: Commit**

```bash
git add collector.js
git commit -m "feat: add Redis Pub/Sub collector with keyspace notifications"
```

---

## Task 3: Reescrever `server.js`

**Files:**
- Modify: `server.js` (reescrita completa)

**Step 1: Substituir `server.js`**

```js
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createClient } = require("redis");
const {
  initDb, getChannels, getConversations, getMessages,
  getDailyStats, getTodayStats
} = require("./db");
const { syncKey, startCollector } = require("./collector");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PUBLIC_DIR = path.join(__dirname, "public");

const redisData = createClient({ url: REDIS_URL });
redisData.on("error", (err) => console.error("Redis error:", err.message));

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };
  fs.readFile(filePath, (err, content) => {
    if (err) { sendJson(res, 404, { error: "not found" }); return; }
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain; charset=utf-8" });
    res.end(content);
  });
}

function serveStatic(pathname, res) {
  const norm = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, norm);
  if (!filePath.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: "forbidden" }); return; }
  sendFile(res, filePath);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    sendJson(res, 200, {
      status: redisData.isOpen ? "connected" : "connecting",
      redisUrl: REDIS_URL
    });
    return;
  }

  if (url.pathname === "/api/channels") {
    const rows = await getChannels();
    const channels = rows.map((r) => ({
      name: r.channel,
      conversations: Number(r.conversations),
      lastUpdated: r.last_updated
    }));
    sendJson(res, 200, { channels });
    return;
  }

  const convMatch = url.pathname.match(/^\/api\/channels\/(.+)\/conversations$/);
  if (convMatch) {
    const channel = decodeURIComponent(convMatch[1]);
    const rows = await getConversations(channel);
    const conversations = rows.map((r) => ({
      id: r.id,
      key: r.redis_key,
      messages: Number(r.message_count),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
    sendJson(res, 200, { channel, conversations });
    return;
  }

  if (url.pathname === "/api/messages") {
    const key = url.searchParams.get("key");
    if (!key || !key.startsWith("chat:")) {
      sendJson(res, 400, { error: "key param required (must start with chat:)" });
      return;
    }
    const rows = await getMessages(key);
    sendJson(res, 200, { key, messages: rows });
    return;
  }

  if (url.pathname === "/api/stats/daily") {
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get("from") || today;
    const to = url.searchParams.get("to") || today;

    const [dailyRows, todayRows] = await Promise.all([
      getDailyStats(from, to),
      getTodayStats()
    ]);

    const channelMap = {};

    for (const row of dailyRows) {
      if (!channelMap[row.channel]) {
        channelMap[row.channel] = { name: row.channel, today: 0, total: 0, days: [] };
      }
      channelMap[row.channel].total += Number(row.count);
      channelMap[row.channel].days.push({
        date: row.date,
        count: Number(row.count)
      });
    }

    for (const row of todayRows) {
      if (!channelMap[row.channel]) {
        channelMap[row.channel] = { name: row.channel, today: 0, total: 0, days: [] };
      }
      channelMap[row.channel].today = Number(row.count);
    }

    sendJson(res, 200, { channels: Object.values(channelMap) });
    return;
  }

  serveStatic(url.pathname, res);
}

async function start() {
  await redisData.connect();
  await initDb();

  console.log("Syncing existing Redis keys...");
  const existingKeys = await redisData.keys("chat:*");
  for (const key of existingKeys) {
    await syncKey(redisData, key);
  }
  console.log(`Synced ${existingKeys.length} existing keys.`);

  await startCollector(redisData, REDIS_URL);

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
  });
  server.listen(PORT, HOST, () => {
    console.log(`Justy Audit Log v2 running at http://${HOST}:${PORT}`);
  });
}

start().catch((err) => { console.error(err.message); process.exit(1); });
```

**Step 2: Testar localmente (se tiver Postgres disponível)**

```bash
set REDIS_URL=redis://default:12345@38.247.146.10:6373
set DATABASE_URL=postgresql://user:pass@localhost:5432/auditlog
npm start
```

Abrir `http://localhost:3000/api/channels` — deve retornar dados do Postgres.

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: rewrite server.js to use PostgreSQL via db.js and collector.js"
```

---

## Task 4: Reescrever `public/index.html`

**Files:**
- Modify: `public/index.html` (reescrita completa)

**Step 1: Substituir `public/index.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Justy Audit Log</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="app">
    <header class="app-header">
      <div class="header-left">
        <button id="btn-back" class="btn-back hidden">← Voltar</button>
        <h1 id="header-title">Justy Audit Log</h1>
      </div>
      <div class="header-right">
        <span id="status-dot" class="dot dot-loading"></span>
        <span id="status-label">conectando...</span>
        <button id="btn-refresh" class="btn-refresh">↻ Atualizar</button>
      </div>
    </header>

    <div id="dashboard" class="dashboard hidden"></div>
    <main id="view" class="view"></main>
  </div>

  <script>
    let currentView = "channels";
    let currentChannel = null;
    let currentKey = null;

    const view = document.getElementById("view");
    const dashboard = document.getElementById("dashboard");
    const headerTitle = document.getElementById("header-title");
    const btnBack = document.getElementById("btn-back");
    const btnRefresh = document.getElementById("btn-refresh");
    const statusDot = document.getElementById("status-dot");
    const statusLabel = document.getElementById("status-label");

    // --- Utilitários ---
    function truncate(str, n = 40) {
      return str && str.length > n ? str.slice(0, n) + "…" : str;
    }

    function formatDateTime(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      return d.toLocaleDateString("pt-BR") + " " +
        d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    function formatDateShort(iso) {
      if (!iso) return "-";
      const d = new Date(typeof iso === "string" && iso.length === 10 ? iso + "T12:00:00" : iso);
      return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    }

    function today() {
      return new Date().toISOString().slice(0, 10);
    }

    function setLoading() {
      view.innerHTML = '<div class="loading">Carregando...</div>';
    }

    // --- Health ---
    async function checkHealth() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        const ok = data.status === "connected";
        statusDot.className = "dot " + (ok ? "dot-ok" : "dot-error");
        statusLabel.textContent = ok ? "conectado" : data.status;
      } catch {
        statusDot.className = "dot dot-error";
        statusLabel.textContent = "erro";
      }
    }

    // --- Dashboard ---
    async function loadDashboard(from, to) {
      const f = from || today();
      const t = to || today();
      const res = await fetch(`/api/stats/daily?from=${f}&to=${t}`);
      const { channels } = await res.json();

      const todayCards = channels.map(ch => `
        <div class="today-card">
          <span class="today-card-label">${truncate(ch.name, 22)}</span>
          <span class="today-card-number">${ch.today}</span>
          <span class="today-card-sub">conversas hoje</span>
        </div>
      `).join("");

      const totalFilter = channels.reduce((s, ch) => s + ch.total, 0);
      const allDays = {};
      for (const ch of channels) {
        for (const d of ch.days) {
          allDays[d.date] = (allDays[d.date] || 0) + d.count;
        }
      }
      const dayBars = Object.entries(allDays).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => `
        <div class="day-bar">
          <span class="day-bar-count">${count}</span>
          <span class="day-bar-date">${formatDateShort(date)}</span>
        </div>
      `).join("");

      dashboard.innerHTML = `
        <div class="dash-today">
          <span class="dash-section-label">HOJE</span>
          <div class="today-cards">${todayCards}</div>
        </div>
        <div class="dash-filter">
          <span class="dash-section-label">FILTRO DE DATAS</span>
          <div class="filter-controls">
            <label>De <input type="date" id="filter-from" value="${f}" /></label>
            <label>Até <input type="date" id="filter-to" value="${t}" /></label>
            <button id="filter-apply" class="btn-filter">Filtrar</button>
          </div>
          ${totalFilter > 0 ? `
            <div class="filter-result">
              <span class="filter-total">Total: <strong>${totalFilter}</strong></span>
              <div class="day-bars">${dayBars}</div>
            </div>
          ` : '<div class="filter-empty">Nenhuma conversa no período.</div>'}
        </div>
      `;

      document.getElementById("filter-apply").addEventListener("click", () => {
        const f2 = document.getElementById("filter-from").value;
        const t2 = document.getElementById("filter-to").value;
        loadDashboard(f2, t2);
      });
    }

    // --- View: Canais ---
    async function showChannels() {
      currentView = "channels";
      currentChannel = null;
      currentKey = null;
      headerTitle.textContent = "Justy Audit Log";
      btnBack.classList.add("hidden");
      dashboard.classList.remove("hidden");
      setLoading();

      await loadDashboard();

      const res = await fetch("/api/channels");
      const { channels } = await res.json();

      if (!channels.length) {
        view.innerHTML = '<div class="empty">Nenhum canal encontrado.</div>';
        return;
      }

      view.innerHTML = channels.map(ch => `
        <div class="list-item" data-channel="${encodeURIComponent(ch.name)}">
          <div class="item-main">
            <span class="item-title">${ch.name}</span>
            <span class="item-meta">${ch.conversations} conversa${ch.conversations !== 1 ? "s" : ""} · última: ${formatDateTime(ch.lastUpdated)}</span>
          </div>
          <span class="item-arrow">›</span>
        </div>
      `).join("");

      view.querySelectorAll(".list-item").forEach(el => {
        el.addEventListener("click", () => {
          showConversations(decodeURIComponent(el.dataset.channel));
        });
      });
    }

    // --- View: Conversas ---
    async function showConversations(channel) {
      currentView = "conversations";
      currentChannel = channel;
      currentKey = null;
      headerTitle.textContent = truncate(channel, 50);
      btnBack.classList.remove("hidden");
      dashboard.classList.add("hidden");
      setLoading();

      const res = await fetch(`/api/channels/${encodeURIComponent(channel)}/conversations`);
      const { conversations } = await res.json();

      if (!conversations.length) {
        view.innerHTML = '<div class="empty">Nenhuma conversa encontrada.</div>';
        return;
      }

      view.innerHTML = conversations.map(conv => `
        <div class="list-item" data-key="${encodeURIComponent(conv.key)}">
          <div class="item-main">
            <span class="item-title item-mono">${truncate(conv.id, 36)}</span>
            <span class="item-meta">${conv.messages} mensagen${conv.messages !== 1 ? "s" : ""} · ${formatDateTime(conv.updatedAt)}</span>
          </div>
          <span class="item-arrow">›</span>
        </div>
      `).join("");

      view.querySelectorAll(".list-item").forEach(el => {
        el.addEventListener("click", () => {
          showMessages(decodeURIComponent(el.dataset.key));
        });
      });
    }

    // --- View: Mensagens ---
    async function showMessages(key) {
      currentView = "messages";
      currentKey = key;
      const shortId = key.split(":").pop();
      headerTitle.textContent = truncate(shortId, 36);
      btnBack.classList.remove("hidden");
      dashboard.classList.add("hidden");
      setLoading();

      const res = await fetch(`/api/messages?key=${encodeURIComponent(key)}`);
      const { messages } = await res.json();

      if (!messages.length) {
        view.innerHTML = '<div class="empty">Nenhuma mensagem nesta conversa.</div>';
        return;
      }

      view.innerHTML = '<div class="chat">' + messages.map(msg => `
        <div class="bubble bubble-${msg.type === "human" ? "human" : "ai"}">
          <div class="bubble-header">
            <span class="bubble-label">${msg.type === "human" ? "Humano" : "IA"}</span>
            <span class="bubble-time">${formatDateTime(msg.created_at)}</span>
          </div>
          <p class="bubble-content">${escapeHtml(msg.content)}</p>
        </div>
      `).join("") + '</div>';
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    // --- Navegação ---
    btnBack.addEventListener("click", () => {
      if (currentView === "messages") showConversations(currentChannel);
      else if (currentView === "conversations") showChannels();
    });

    btnRefresh.addEventListener("click", () => {
      if (currentView === "messages") showMessages(currentKey);
      else if (currentView === "conversations") showConversations(currentChannel);
      else showChannels();
    });

    // --- Init ---
    checkHealth();
    showChannels();
    setInterval(checkHealth, 15000);
  </script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add dashboard with today stats, date filter and timestamps"
```

---

## Task 5: Atualizar `public/styles.css`

**Files:**
- Modify: `public/styles.css` — adicionar estilos do dashboard ao final do arquivo existente

**Step 1: Adicionar ao final de `public/styles.css`**

```css
/* ── Dashboard ─────────────────────────────────── */
.dashboard {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
.dashboard.hidden { display: none; }

.dash-today,
.dash-filter {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 20px;
  backdrop-filter: blur(10px);
}

.dash-section-label {
  display: block;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--muted);
  margin-bottom: 14px;
}

/* Cards de hoje */
.today-cards {
  display: flex;
  gap: 12px;
}

.today-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--surface-strong, #fff);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 16px 20px;
  min-width: 110px;
  text-align: center;
}

.today-card-label {
  font-size: 0.78rem;
  color: var(--muted);
  margin-bottom: 8px;
  line-height: 1.3;
}

.today-card-number {
  font-size: 2.4rem;
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
}

.today-card-sub {
  font-size: 0.72rem;
  color: var(--muted);
  margin-top: 4px;
}

/* Filtro de datas */
.filter-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  font-size: 0.88rem;
  color: var(--muted);
}

.filter-controls input[type="date"] {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 0.88rem;
  color: var(--text);
  background: var(--surface-strong, #fff);
}

.btn-filter {
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
}
.btn-filter:hover { opacity: 0.88; }

.filter-result { margin-top: 4px; }
.filter-total { font-size: 0.9rem; color: var(--muted); display: block; margin-bottom: 10px; }
.filter-total strong { color: var(--text); }
.filter-empty { font-size: 0.88rem; color: var(--muted); }

/* Barras por dia */
.day-bars {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.day-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--surface-strong, #fff);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
  min-width: 48px;
}

.day-bar-count {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
}

.day-bar-date {
  font-size: 0.72rem;
  color: var(--muted);
  margin-top: 2px;
}

/* Timestamp nas mensagens */
.bubble-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.bubble-label { margin-bottom: 0; }

.bubble-time {
  font-size: 0.72rem;
  color: var(--muted);
  white-space: nowrap;
}

@media (max-width: 700px) {
  .dashboard { grid-template-columns: 1fr; }
  .today-cards { flex-wrap: wrap; }
}
```

**Step 2: Commit**

```bash
git add public/styles.css
git commit -m "style: add dashboard, today cards, date filter and message timestamp styles"
```

---

## Task 6: Configurar PostgreSQL no Easypanel e fazer deploy

**Não é código — são passos manuais.**

**Step 1: Criar serviço PostgreSQL no Easypanel**

1. No projeto `justy` no Easypanel → **+ Serviço → Postgres**
2. Nome: `postgres-audit`
3. Após criar, vá em **Connect** → copiar a connection string interna, ex:
   ```
   postgresql://postgres:SENHA@postgres-audit:5432/postgres
   ```

**Step 2: Adicionar variável de ambiente no serviço `web-redis-gazeta`**

1. Abrir o serviço `web-redis-gazeta` → **Environment**
2. Adicionar:
   ```
   DATABASE_URL=postgresql://postgres:SENHA@postgres-audit:5432/postgres
   ```

**Step 3: Push e redeploy**

```bash
git push origin main
```

No Easypanel → **Deploy** no serviço `web-redis-gazeta`.

**Step 4: Verificar nos logs**

Nos logs do serviço deve aparecer:
```
Database schema ready.
Syncing existing Redis keys...
Synced X existing keys.
Collector: keyspace notifications enabled.
Collector: listening for Redis keyspace events...
Justy Audit Log v2 running at http://0.0.0.0:3000
```

**Step 5: Verificar no browser**

- `/api/channels` → lista de canais com `lastUpdated`
- `/api/stats/daily?from=2026-04-01&to=2026-04-30` → stats por canal e dia
- Tela inicial → cards "hoje" por chatbot + filtro de datas
- Mensagens → ordem cronológica + timestamps
