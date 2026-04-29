const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const STREAM_KEY = process.env.REDIS_STREAM_KEY || "messages:events";
const MAX_RESULTS = Number(process.env.REDIS_DASHBOARD_LIMIT || 50);
const PUBLIC_DIR = path.join(__dirname, "public");

const redis = createClient({ url: REDIS_URL });

redis.on("error", (error) => {
  console.error("Redis error:", error.message);
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(response, 404, { error: "File not found" });
      return;
    }

    response.writeHead(200, {
      "Content-Type": typeMap[ext] || "text/plain; charset=utf-8"
    });
    response.end(content);
  });
}

function normalizeEntry(entry) {
  const fields = entry.message || {};
  return {
    id: entry.id,
    event: fields.event || fields.type || "unknown",
    source: fields.source || "n/a",
    payload: fields.payload || fields.message || JSON.stringify(fields),
    createdAt: fields.createdAt || fields.timestamp || null,
    raw: fields
  };
}

async function readMessages(limit) {
  const count = Math.max(1, Math.min(limit || MAX_RESULTS, 200));
  const entries = await redis.xRevRange(STREAM_KEY, "+", "-", { COUNT: count });
  return entries.map(normalizeEntry);
}

async function readStats(messages) {
  const streamLength = await redis.xLen(STREAM_KEY).catch(() => 0);
  const lastMessage = messages[0] || null;
  const eventsByType = messages.reduce((accumulator, item) => {
    accumulator[item.event] = (accumulator[item.event] || 0) + 1;
    return accumulator;
  }, {});

  return {
    streamKey: STREAM_KEY,
    streamLength,
    lastMessageId: lastMessage ? lastMessage.id : null,
    visibleMessages: messages.length,
    eventsByType
  };
}

function serveStatic(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, normalizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  sendFile(response, filePath);
}

async function requestHandler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      status: redis.isOpen ? "connected" : "connecting",
      redisUrl: REDIS_URL,
      streamKey: STREAM_KEY
    });
    return;
  }

  if (url.pathname === "/api/messages") {
    try {
      const limit = Number(url.searchParams.get("limit") || MAX_RESULTS);
      const messages = await readMessages(limit);
      sendJson(response, 200, { messages });
    } catch (error) {
      sendJson(response, 500, {
        error: "Failed to load messages",
        details: error.message
      });
    }
    return;
  }

  if (url.pathname === "/api/stats") {
    try {
      const messages = await readMessages(MAX_RESULTS);
      const stats = await readStats(messages);
      sendJson(response, 200, stats);
    } catch (error) {
      sendJson(response, 500, {
        error: "Failed to load stats",
        details: error.message
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/publish-demo") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", async () => {
      try {
        const input = body ? JSON.parse(body) : {};
        const event = input.event || "demo.message";
        const source = input.source || "dashboard";
        const payload = input.payload || "Mensagem de teste publicada pelo dashboard";
        const createdAt = new Date().toISOString();

        const id = await redis.xAdd(STREAM_KEY, "*", {
          event,
          source,
          payload,
          createdAt
        });

        sendJson(response, 201, { ok: true, id });
      } catch (error) {
        sendJson(response, 500, {
          error: "Failed to publish demo message",
          details: error.message
        });
      }
    });
    return;
  }

  serveStatic(url.pathname, response);
}

async function start() {
  await redis.connect();

  const server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      sendJson(response, 500, {
        error: "Unexpected server error",
        details: error.message
      });
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Dashboard running at http://${HOST}:${PORT}`);
    console.log(`Redis stream: ${STREAM_KEY}`);
  });
}

start().catch((error) => {
  console.error("Unable to start server:", error.message);
  process.exit(1);
});
