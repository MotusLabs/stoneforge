---
"@stoneforge/quarry": patch
---

Fix export clearing dirty tracking for elements mutated while the export was writing (lost changes never reached JSONL).

`SyncService.export()` (and the sync path `exportSync()`) read the dirty elements, then `await`ed the atomic writes of `elements.jsonl` and `dependencies.jsonl`, and only then called `backend.clearDirty()` — which clears **all** dirty tracking. Any element mutated by another writer while those writes were in flight (other agents and the dispatch daemon write constantly) had its dirty mark erased even though the new content was never exported, so the change never reached the JSONL source of truth.

Non-full exports now snapshot the dirty set (`elementId` + `marked_at`) **before** reading any element data, and after the writes succeed acknowledge the export via `backend.clearDirtySnapshot()`: a row is cleared only when it was not re-marked since the snapshot. Elements marked during the writes are either absent from the snapshot or carry a strictly newer `marked_at` (markDirty is monotonic per element), so they stay dirty and go out in the next incremental export. Elements that failed serialization are excluded from the clear and are retried; ephemeral elements filtered out of the export are acknowledged (they are never exportable and would otherwise leave a permanent phantom backlog). Full exports still do not touch dirty tracking, and the incremental fallback-to-full path gets the same protection.

Regression tests in `service.bun.test.ts` (`dirty tracking across export writes`) stub the atomic write to mutate the database between the export's reads and its clear, and assert the concurrently changed elements stay dirty and ship in the next incremental export; the fallback-to-full and skipped-element-retry paths are covered too.
