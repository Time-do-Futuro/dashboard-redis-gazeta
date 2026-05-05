# Metrics v3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add volume metric cards (conversations, messages, avg msgs/conv) and an hour × day-of-week heatmap to the dashboard, with a global panel (all channels) and a per-channel filtered panel.

**Architecture:** New `getSummaryStats` DB function feeds a new `/api/stats/summary` endpoint. Frontend calls it twice in parallel (global + filtered) and renders metric cards + a pure-CSS heatmap grid. Dashboard layout changes from a 2-column grid to a flex-column with the global panel on top.

**Tech Stack:** Node.js, PostgreSQL (pg), vanilla JS, CSS Grid

---

## Task 1: `getSummaryStats` in db.js

**Files:**
- Modify: `db.js` (add function + export)

**Step 1: Add the function after `getTodayStats`**

Open `db.js`. After the `getTodayStats` function (line ~121), add:

```js
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
```

**Step 2: Export the new function**

Change the `module.exports` block at the bottom of `db.js` from:

```js
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

To:

```js
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
```

**Step 3: Verify syntax**

```bash
node -e "const db = require('./db'); console.log(typeof db.getSummaryStats)"
```
Expected output: `function`

**Step 4: Commit**

```bash
git add db.js
git commit -m "feat: add getSummaryStats with volume metrics and heatmap query"
```

---

## Task 2: `/api/stats/summary` endpoint in server.js

**Files:**
- Modify: `server.js` (import + new route)

**Step 1: Add `getSummaryStats` to the import at the top of server.js**

Change line 6–9 from:

```js
const {
  initDb, getChannels, getConversations, getMessages,
  getDailyStats, getTodayStats
} = require("./db");
```

To:

```js
const {
  initDb, getChannels, getConversations, getMessages,
  getDailyStats, getTodayStats, getSummaryStats
} = require("./db");
```

**Step 2: Add the route handler inside `async function handler(req, res)`**

Add this block immediately after the `/api/stats/daily` block (before the final `serveStatic` call):

```js
  if (url.pathname === "/api/stats/summary") {
    const todayStr = new Date().toISOString().slice(0, 10);
    const from    = url.searchParams.get("from")    || todayStr;
    const to      = url.searchParams.get("to")      || todayStr;
    const channel = url.searchParams.get("channel") || null;
    const summary = await getSummaryStats(from, to, channel);
    sendJson(res, 200, summary);
    return;
  }
```

**Step 3: Verify the server starts**

```bash
node server.js
```
Expected: `Fluxos Rede Gazeta Audit Log running at http://0.0.0.0:3000`  
No errors. Stop with Ctrl+C.

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat: add /api/stats/summary endpoint"
```

---

## Task 3: CSS — metric cards + heatmap

**Files:**
- Modify: `public/styles.css`

**Step 1: Change `.dashboard` from grid to flex-column**

Find and replace the `.dashboard` rule:

```css
/* OLD */
.dashboard {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 16px;
  margin-bottom: 16px;
}
```

Replace with:

```css
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 16px;
}

/* The existing today + filter row keeps its 2-column grid */
.dash-row2 {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 16px;
}
```

**Step 2: Add `.dash-global` panel style**

After `.dash-today, .dash-filter { ... }` block, add:

```css
.dash-global {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow);
}
```

**Step 3: Add metric card styles**

After the `.today-card-sub` rule, add:

```css
/* ── Metric cards (volume numbers) ──────────────────── */
.metric-cards {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.metric-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: linear-gradient(145deg, var(--accent-light), #f5f3ff);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  padding: 16px 24px;
  min-width: 140px;
  text-align: center;
  transition: transform 0.15s, box-shadow 0.15s;
}
.metric-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.metric-label {
  font-size: 0.74rem;
  color: var(--muted);
  margin-bottom: 6px;
  font-weight: 500;
}

.metric-number {
  font-size: 2.4rem;
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
  letter-spacing: -0.04em;
}
```

**Step 4: Add heatmap styles**

After the `.metric-number` rule, add:

```css
/* ── Heatmap ─────────────────────────────────────────── */
.heatmap-wrap {
  overflow-x: auto;
}

.heatmap {
  display: grid;
  grid-template-columns: 36px repeat(24, minmax(20px, 1fr));
  gap: 3px;
  min-width: 560px;
}

.heatmap-hour-label,
.heatmap-day-label {
  font-size: 0.62rem;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
}

.heatmap-corner { /* empty top-left cell */ }

.heatmap-cell {
  aspect-ratio: 1;
  border-radius: 3px;
  background: #ede9fe33;
  cursor: default;
  transition: transform 0.1s;
}
.heatmap-cell:hover { transform: scale(1.3); z-index: 1; }

/* Intensity levels — 0 = empty, 4 = maximum */
.heatmap-cell[data-i="0"] { background: rgba(109, 40, 217, 0.06); }
.heatmap-cell[data-i="1"] { background: rgba(109, 40, 217, 0.20); }
.heatmap-cell[data-i="2"] { background: rgba(109, 40, 217, 0.45); }
.heatmap-cell[data-i="3"] { background: rgba(109, 40, 217, 0.70); }
.heatmap-cell[data-i="4"] { background: rgba(109, 40, 217, 0.92); }
```

**Step 5: Update responsive rule**

Find the `@media (max-width: 700px)` block and add `.dash-row2`:

```css
@media (max-width: 700px) {
  .dashboard { grid-template-columns: 1fr; }   /* keep, harmless now */
  .dash-row2 { grid-template-columns: 1fr; }
  .today-cards { flex-wrap: wrap; }
  .metric-cards { flex-wrap: wrap; }
  .bubble { max-width: 92%; }
  .app-header h1 { font-size: 0.86rem; }
  .chat { padding: 16px; }
}
```

**Step 6: Commit**

```bash
git add public/styles.css
git commit -m "feat: add metric card and heatmap CSS styles"
```

---

## Task 4: Frontend JS — `loadDashboard` rewrite

**Files:**
- Modify: `public/index.html` (the inline `<script>` block)

**Step 1: Add helper functions before `loadDashboard`**

Add these two functions right before `async function loadDashboard(...)`:

```js
function buildMetricCards(summary) {
  return `
    <div class="metric-cards">
      <div class="metric-card">
        <span class="metric-label">Conversas</span>
        <span class="metric-number">${summary.total_conversations}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Mensagens</span>
        <span class="metric-number">${summary.total_messages}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Média msgs/conv</span>
        <span class="metric-number">${summary.avg_messages_per_conv}</span>
      </div>
    </div>`;
}

function buildHeatmap(heatmapData) {
  const DAYS  = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const grid  = {};
  let maxCount = 0;

  for (const { dow, hour, count } of heatmapData) {
    if (!grid[dow]) grid[dow] = {};
    grid[dow][hour] = count;
    if (count > maxCount) maxCount = count;
  }

  function intensity(count) {
    if (!count || maxCount === 0) return 0;
    const r = count / maxCount;
    if (r < 0.25) return 1;
    if (r < 0.5)  return 2;
    if (r < 0.75) return 3;
    return 4;
  }

  // Header row: corner + hour labels 0–23
  let html = '<div class="heatmap">';
  html += '<div class="heatmap-corner"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="heatmap-hour-label">${h}</div>`;
  }

  // Data rows: day label + 24 cells
  for (let d = 0; d < 7; d++) {
    html += `<div class="heatmap-day-label">${DAYS[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const count = (grid[d] && grid[d][h]) || 0;
      const i = intensity(count);
      html += `<div class="heatmap-cell" data-i="${i}" title="${DAYS[d]} ${h}h: ${count} msgs"></div>`;
    }
  }

  html += '</div>';
  return html;
}
```

**Step 2: Rewrite `loadDashboard`**

Replace the entire `async function loadDashboard(from, to, selectedChannel) { ... }` with:

```js
async function loadDashboard(from, to, selectedChannel) {
  const f = from || today();
  const t = to   || today();
  const chParam = selectedChannel ? `&channel=${encodeURIComponent(selectedChannel)}` : "";

  // Fetch all three data sources in parallel
  const [statsRes, globalSummaryRes, filteredSummaryRes] = await Promise.all([
    fetch(`/api/stats/daily?from=${f}&to=${t}`),
    fetch(`/api/stats/summary?from=${f}&to=${t}`),
    fetch(`/api/stats/summary?from=${f}&to=${t}${chParam}`)
  ]);

  const { channels: allChannels }  = await statsRes.json();
  const globalSummary              = await globalSummaryRes.json();
  const filteredSummary            = await filteredSummaryRes.json();

  // ── Today cards (always all channels) ──
  const todayCards = allChannels.map(ch => `
    <div class="today-card">
      <span class="today-card-label">${truncate(ch.name, 22)}</span>
      <span class="today-card-number">${ch.today}</span>
      <span class="today-card-sub">conversas hoje</span>
    </div>
  `).join("");

  // ── Channel dropdown ──
  const channelOptions = [
    `<option value="">Todos os chats</option>`,
    ...allChannels.map(ch =>
      `<option value="${encodeURIComponent(ch.name)}" ${selectedChannel === ch.name ? "selected" : ""}>${ch.name}</option>`
    )
  ].join("");

  // ── Day bars (filtered by channel) ──
  const filtered = selectedChannel
    ? allChannels.filter(ch => ch.name === selectedChannel)
    : allChannels;

  const totalFilter = filtered.reduce((s, ch) => s + ch.total, 0);
  const allDays = {};
  for (const ch of filtered) {
    for (const d of ch.days) {
      allDays[d.date] = (allDays[d.date] || 0) + d.count;
    }
  }
  const dayBars = Object.entries(allDays)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => `
      <div class="day-bar">
        <span class="day-bar-count">${count}</span>
        <span class="day-bar-date">${formatDateShort(date)}</span>
      </div>
    `).join("");

  // ── Render ──
  dashboard.innerHTML = `
    <!-- Global panel: all channels, follows date filter -->
    <div class="dash-global">
      <span class="dash-section-label">PERÍODO SELECIONADO — TODOS OS CHATS</span>
      ${buildMetricCards(globalSummary)}
      <span class="dash-section-label">HORÁRIOS DE MAIOR ATIVIDADE</span>
      <div class="heatmap-wrap">${buildHeatmap(globalSummary.heatmap)}</div>
    </div>

    <!-- Bottom row: today cards + filter panel -->
    <div class="dash-row2">
      <div class="dash-today">
        <span class="dash-section-label">HOJE</span>
        <div class="today-cards">${todayCards || '<span style="color:var(--muted);font-size:.9rem">Nenhuma conversa hoje.</span>'}</div>
      </div>

      <div class="dash-filter">
        <span class="dash-section-label">FILTRO DE DATAS</span>
        <div class="filter-controls">
          <label>Chat <select id="filter-channel" class="filter-select">${channelOptions}</select></label>
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

        <div style="margin-top:16px">
          <span class="dash-section-label">${selectedChannel ? truncate(selectedChannel, 30) : "TODOS OS CHATS"} — MÉTRICAS DO PERÍODO</span>
          ${buildMetricCards(filteredSummary)}
        </div>
      </div>
    </div>
  `;

  document.getElementById("filter-apply").addEventListener("click", () => {
    const f2 = document.getElementById("filter-from").value;
    const t2 = document.getElementById("filter-to").value;
    const ch = document.getElementById("filter-channel").value;
    loadDashboard(f2, t2, ch ? decodeURIComponent(ch) : null);
  });
}
```

**Step 3: Verify in browser**

Start the server:
```bash
node server.js
```
Open `http://localhost:3000`. Expected:
- Dashboard shows a "PERÍODO SELECIONADO" panel with 3 large number cards
- Below that, a heatmap grid (7 rows × 24 cols) with purple intensity cells
- Existing today cards and filter panel still visible below
- Selecting a date range and clicking Filtrar updates all panels

**Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat: add metric cards and heatmap to dashboard"
```

---

## Task 5: Push and deploy

```bash
git push origin main
```

Then in Easypanel: trigger redeploy on `web-redis-gazeta` service (or wait for auto-deploy if configured).

Verify on the live URL that:
- [ ] 3 metric cards appear at top of dashboard
- [ ] Heatmap renders with purple intensity cells
- [ ] Hovering a heatmap cell shows tooltip with count
- [ ] Filtering by date range updates metrics and heatmap
- [ ] Filtering by channel updates only the bottom metric cards (global panel stays all-channels)
- [ ] Mobile layout stacks all panels vertically
