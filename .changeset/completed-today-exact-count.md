---
"@stoneforge/quarry": minor
---

Add `TaskFilter.closedAfter` — a completion-time filter — and make `GET /api/tasks/completed` report the exact match count.

`closedAfter` matches tasks whose completion timestamp (`closedAt`, set at the close transition and cleared on reopen, falling back to `updatedAt` for tasks closed through paths that don't record `closedAt`) falls on or after the given timestamp. Unlike `updatedAfter`, a task closed before the cutoff but edited later does not match. The filter compiles to SQL (`COALESCE(JSON_EXTRACT(data,'$.closedAt'), updated_at) >= ?`) so it applies before pagination.

`GET /api/tasks/completed` now maps its `after` query parameter to `closedAfter` (it previously filtered on `updatedAt` post-query, inside a single page — so it could return fewer than the true set for a date and `hasMore` ignored the date filter) and returns the full pagination envelope `{ items, total, offset, limit, hasMore }`, where `total` is the exact number of matching tasks across all pages. An invalid `after` now returns 400 instead of silently matching nothing. `PATCH /api/tasks/:id` records `closedAt` when a task transitions into `closed` and clears it on reopen, mirroring `updateTaskStatus`, so HTTP-closed tasks carry the canonical completion timestamp.

Together these fix the quarry-web dashboard "Completed Today" metric, whose hook used to call `.filter()` on the `GET /api/tasks` ListResult envelope (a TypeError that left the tile at 0) and now reads the server-side `total`. See the "Quarry Task List API Envelopes" workspace doc for the envelope contract.
