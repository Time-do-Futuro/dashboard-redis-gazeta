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
