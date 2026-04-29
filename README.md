# Redis Stream Dashboard

Projeto simples em `Node.js` para mostrar mensagens de um `Redis Stream` em uma interface web.

## O que este projeto faz

- conecta em um Redis
- lê mensagens do stream `messages:events` por padrão
- mostra status, quantidade de itens e últimos eventos
- atualiza a tela automaticamente a cada 5 segundos
- permite publicar uma mensagem de teste pela interface

## Quando usar

Esse modelo é melhor quando as suas mensagens estão em `Redis Streams`.

Se hoje você usa apenas `Pub/Sub`, o ideal é persistir os eventos também em um stream para conseguir:

- histórico
- dashboard
- auditoria
- reprocessamento

## Como rodar

1. Instale as dependências:

```bash
npm install
```

2. Configure as variáveis, se quiser:

```bash
set REDIS_URL=redis://127.0.0.1:6379
set REDIS_STREAM_KEY=messages:events
set PORT=3000
```

3. Suba o projeto:

```bash
npm start
```

4. Abra no navegador:

```text
http://localhost:3000
```

## Como publicar mensagens no Redis

Exemplo no `redis-cli`:

```bash
XADD messages:events * event order.created source api payload "{\"orderId\":123,\"status\":\"created\"}" createdAt "2026-04-29T12:00:00.000Z"
```

Outro exemplo:

```bash
XADD messages:events * event payment.approved source worker payload "{\"paymentId\":999,\"amount\":150.75}" createdAt "2026-04-29T12:05:00.000Z"
```

## Endpoints

- `GET /api/health`
- `GET /api/messages?limit=50`
- `GET /api/stats`
- `POST /api/publish-demo`

## Estrutura

```text
.
|-- package.json
|-- server.js
|-- public
|   |-- index.html
|   `-- styles.css
`-- README.md
```

## Próximos passos possíveis

- adicionar filtro por tipo de evento
- mostrar payload expandido em modal
- usar `WebSocket` em vez de polling
- separar mensagens com erro
- criar autenticação para ambiente produtivo
