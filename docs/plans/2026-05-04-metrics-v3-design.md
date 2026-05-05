# Metrics v3 — Dashboard Enhancement Design

**Date:** 2026-05-04  
**Project:** Fluxos Rede Gazeta Audit Log  
**Status:** Approved

---

## Goal

Enrich the dashboard home screen with more visible volume metrics and an hour × day-of-week heatmap. All new metrics follow the existing date filter. A global view (all channels combined) sits above the existing per-channel filter panel.

---

## Layout

### Top panel — Global (all channels, follows date filter)

Three large number cards:
- **Total de conversas** — total conversations in the selected period
- **Total de mensagens** — total messages across all conversations
- **Média msgs/conversa** — average messages per conversation

Below the cards: an **hour × day-of-week heatmap** (7 columns × 24 rows). Cells are colored in purple intensity — darker = more activity. Hovering a cell shows the exact count.

### Bottom panel — Filtered (existing, unchanged structure)

- Date range + channel select controls
- "Hoje" cards per channel (existing)
- Day bars (existing)
- Same 3 volume cards as the top panel, but scoped to the selected channel

---

## Backend

### New endpoint: `GET /api/stats/summary`

**Query params:** `from` (date), `to` (date), `channel` (optional, URL-encoded name)

**Response:**
```json
{
  "total_conversations": 142,
  "total_messages": 1830,
  "avg_messages_per_conv": 12.9,
  "heatmap": [
    { "dow": 1, "hour": 14, "count": 23 }
  ]
}
```

- `dow`: 0 = Sunday … 6 = Saturday
- `hour`: 0–23
- When `channel` is omitted → aggregates all channels
- Only days/hours with count > 0 are returned (sparse array)

**SQL sketch:**
```sql
-- Volume metrics
SELECT
  COUNT(DISTINCT c.id)          AS total_conversations,
  COUNT(m.id)                   AS total_messages,
  ROUND(COUNT(m.id)::numeric /
    NULLIF(COUNT(DISTINCT c.id), 0), 1) AS avg_messages_per_conv
FROM conversations c
LEFT JOIN messages m ON m.conversation_id = c.id
WHERE DATE(c.created_at) BETWEEN $1 AND $2
  AND ($3::text IS NULL OR c.channel = $3);

-- Heatmap (based on message timestamps for accuracy)
SELECT
  EXTRACT(DOW  FROM m.created_at)::int AS dow,
  EXTRACT(HOUR FROM m.created_at)::int AS hour,
  COUNT(*)                             AS count
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE DATE(m.created_at) BETWEEN $1 AND $2
  AND ($3::text IS NULL OR c.channel = $3)
GROUP BY dow, hour;
```

---

## Frontend

### Two calls on filter apply

```
GET /api/stats/summary?from=F&to=T           → global panel
GET /api/stats/summary?from=F&to=T&channel=X → filtered panel
```

Both calls are made in parallel with `Promise.all`.

### Volume cards

Reuse the existing `.today-card` style with larger numbers. Three cards side by side.

### Heatmap

Pure CSS grid: 25 columns (label + 24 hours) × 8 rows (label + 7 days).  
Cell color: CSS custom property driven by data-intensity (0–4 buckets based on relative max).  
Hover tooltip shows exact count via `title` attribute.

---

## Out of scope

- No chart library (keep zero dependencies on frontend)
- No per-message heatmap drill-down
- No export / CSV
- Dropdown bug fix (deferred per user decision)
