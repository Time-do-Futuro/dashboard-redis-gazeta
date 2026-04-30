# Design: Justy Audit Log v2 — PostgreSQL + Timestamps + Dashboard

**Data:** 2026-04-30
**Status:** Aprovado

---

## Objetivo

Evoluir o dashboard de auditoria para persistir conversas e mensagens em PostgreSQL com timestamps reais, capturados via Redis Keyspace Notifications em tempo real. Adicionar dashboard de estatísticas por dia e filtro de datas na tela inicial.

---

## Melhorias incluídas

1. **Banco de dados PostgreSQL** — persistência permanente (independente do TTL do Redis)
2. **Timestamps reais** — gravados no momento exato em que a API detecta a mensagem via Pub/Sub
3. **Ordem das mensagens corrigida** — `ORDER BY index ASC` (mais antigo primeiro)
4. **Dashboard na tela inicial** — cards "hoje" por chatbot + filtro de datas
5. **Datas nas conversas e mensagens** — exibidas em todas as telas

---

## Arquitetura

```
Chatbot
  │ LPUSH chat:canal:uuid
  ▼
Redis ──────────────────────────────────────────┐
  │                                             │
  │ Keyspace Notification                       │ Sync na startup
  │ (__keyevent@0__:lpush)                      │
  ▼                                             ▼
API Node.js (server.js)
  ├── redisData   → leitura das listas
  ├── redisSub    → subscriber Pub/Sub (conexão dedicada)
  └── pg          → PostgreSQL
  │
  ▼
PostgreSQL (serviço no Easypanel)
  │
  ▼
Frontend (lê apenas do Postgres via API)
```

**Variáveis de ambiente adicionadas:**
```
DATABASE_URL=postgresql://user:pass@postgres-service:5432/auditlog
```

---

## Schema PostgreSQL

```sql
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  channel     TEXT NOT NULL,
  redis_key   TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE messages (
  id              SERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  index           INTEGER NOT NULL,
  type            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, index)
);

CREATE INDEX idx_conversations_channel ON conversations(channel);
CREATE INDEX idx_conversations_created ON conversations(created_at);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

---

## Lógica do coletor

### Startup (sync inicial)
```
redis.keys("chat:*")
  → para cada chave:
      UPSERT conversations ON CONFLICT DO NOTHING
      LRANGE 0 -1 → INSERT messages ON CONFLICT DO NOTHING
```

### Tempo real (Pub/Sub)
```
CONFIG SET notify-keyspace-events KEl
SUBSCRIBE __keyevent@0__:lpush

Ao receber evento para chave chat:*:
  → LINDEX key 0  (elemento mais recente)
  → UPSERT conversations (atualiza updated_at)
  → INSERT INTO messages ON CONFLICT DO NOTHING
```

---

## API

### Endpoints que mudam

| Rota | Mudança |
|---|---|
| `GET /api/channels` | Lê do Postgres, inclui `updated_at` |
| `GET /api/channels/:channel/conversations` | Lê do Postgres, ordem `updated_at DESC` |
| `GET /api/messages?key=` | Lê do Postgres, ordem `index ASC` (corrige inversão) |

### Endpoint novo

```
GET /api/stats/daily?from=2026-04-01&to=2026-04-30
```

Resposta:
```json
{
  "channels": [
    {
      "name": "GAZETA - Chatbot Litoral",
      "today": 19,
      "total": 9,
      "days": [
        { "date": "2026-04-28", "count": 6 },
        { "date": "2026-04-29", "count": 2 },
        { "date": "2026-04-30", "count": 1 }
      ]
    },
    {
      "name": "GAZETA - Chatbot con...",
      "today": 4,
      "total": 3,
      "days": [...]
    }
  ]
}
```

---

## UI

### Tela inicial (canais)

```
┌─────────────────────────────────────────────────┐
│  Justy Audit Log                    🟢 conectado │
├─────────────────────────────────────────────────┤
│  HOJE                                           │
│  ┌───────────────────┐  ┌───────────────────┐  │
│  │ GAZETA - Litoral  │  │  GAZETA - Chatbot  │  │
│  │        19         │  │         4          │  │
│  │    conversas      │  │    conversas       │  │
│  └───────────────────┘  └───────────────────┘  │
├─────────────────────────────────────────────────┤
│  FILTRO DE DATAS                                │
│  De [01/04] Até [30/04]  →  Total: 9           │
│  [ 6 · 28/4 ][ 2 · 29/4 ][ 1 · 30/4 ]         │
├─────────────────────────────────────────────────┤
│  GAZETA - Chatbot Litoral  · última: 14h32  >   │
│  GAZETA - Chatbot con...   · última: 09h15  >   │
└─────────────────────────────────────────────────┘
```

### Tela de conversas
- Exibe `updated_at` formatado: `30/04/2026 14h32`

### Tela de mensagens
- Ordem: mais antigo primeiro (`index ASC`)
- Cada mensagem exibe: `[HUMANO] · 30/04/2026 14h32`

---

## Fora de escopo

- Autenticação
- Múltiplos ambientes (dev/prod)
- Paginação
- WebSocket/streaming
