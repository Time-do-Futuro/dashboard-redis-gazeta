const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createClient } = require("redis");
const {
  initDb, getChannels, getConversations, getMessages,
  getDailyStats, getTodayStats, getSummaryStats
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

  if (url.pathname === "/api/stats/summary") {
    const todayStr = new Date().toISOString().slice(0, 10);
    const from    = url.searchParams.get("from")    || todayStr;
    const to      = url.searchParams.get("to")      || todayStr;
    const channel = url.searchParams.get("channel") ?? null;
    const summary = await getSummaryStats(from, to, channel);
    sendJson(res, 200, summary);
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
    console.log(`Fluxos Rede Gazeta Audit Log running at http://${HOST}:${PORT}`);
  });
}

start().catch((err) => { console.error(err.message); process.exit(1); });
