const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PUBLIC_DIR = path.join(__dirname, "public");

const redis = createClient({ url: REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err.message));

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

// Extrai o nome do canal de uma chave "chat:{canal}:{uuid}"
// O canal pode conter ":" no nome, por isso pega tudo exceto o último segmento
function parseKey(key) {
  const withoutPrefix = key.replace(/^chat:/, "");
  const lastColon = withoutPrefix.lastIndexOf(":");
  if (lastColon === -1) return { channel: withoutPrefix, id: "" };
  return {
    channel: withoutPrefix.slice(0, lastColon),
    id: withoutPrefix.slice(lastColon + 1)
  };
}

async function scanAllChatKeys() {
  return redis.keys("chat:*");
}

async function getChannels() {
  const keys = await scanAllChatKeys();
  const channelMap = {};

  await Promise.all(keys.map(async (key) => {
    const { channel } = parseKey(key);
    const len = await redis.lLen(key).catch(() => 0);
    if (!channelMap[channel]) channelMap[channel] = { conversations: 0, messages: 0 };
    channelMap[channel].conversations += 1;
    channelMap[channel].messages += len;
  }));

  return Object.entries(channelMap)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getConversations(channel) {
  const keys = await scanAllChatKeys();
  const matching = keys.filter((k) => parseKey(k).channel === channel);

  const conversations = await Promise.all(matching.map(async (key) => {
    const { id } = parseKey(key);
    const len = await redis.lLen(key).catch(() => 0);
    const ttl = await redis.ttl(key).catch(() => -1);
    return { id, key, messages: len, ttl };
  }));

  return conversations.sort((a, b) => b.messages - a.messages);
}

async function getMessages(key) {
  const raw = await redis.lRange(key, 0, -1);
  return raw.map((item, index) => {
    try {
      const parsed = JSON.parse(item);
      return {
        index,
        type: parsed.type || "unknown",
        content: parsed.data?.content || item,
        raw: parsed
      };
    } catch {
      return { index, type: "raw", content: item, raw: null };
    }
  });
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { status: redis.isOpen ? "connected" : "connecting", redisUrl: REDIS_URL });
    return;
  }

  if (url.pathname === "/api/channels") {
    const channels = await getChannels();
    sendJson(res, 200, { channels });
    return;
  }

  // /api/channels/:channel/conversations — channel pode ter "/" codificado ou não
  const convMatch = url.pathname.match(/^\/api\/channels\/(.+)\/conversations$/);
  if (convMatch) {
    const channel = decodeURIComponent(convMatch[1]);
    const conversations = await getConversations(channel);
    sendJson(res, 200, { channel, conversations });
    return;
  }

  // /api/messages?key=chat:canal:uuid
  if (url.pathname === "/api/messages") {
    const key = url.searchParams.get("key");
    if (!key || !key.startsWith("chat:")) {
      sendJson(res, 400, { error: "key param required (must start with chat:)" });
      return;
    }
    const messages = await getMessages(key);
    sendJson(res, 200, { key, messages });
    return;
  }

  serveStatic(url.pathname, res);
}

async function start() {
  await redis.connect();
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => sendJson(res, 500, { error: err.message }));
  });
  server.listen(PORT, HOST, () => {
    console.log(`Justy Audit Log running at http://${HOST}:${PORT}`);
  });
}

start().catch((err) => { console.error(err.message); process.exit(1); });
