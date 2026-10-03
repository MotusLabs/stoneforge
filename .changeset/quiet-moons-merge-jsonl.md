---
"@stoneforge/quarry": patch
---

Fix incremental JSONL export destroying `elements.jsonl` (data loss in the source of truth).

`SyncService.export()` / `exportSync()` with `full: false` selected only the dirty elements and then replaced the whole `elements.jsonl`, so the first `AutoExportService` tick after a server start (which begins with a full export) rewrote the file with just the dirty subset — or emptied it entirely once dirty tracking was clear. In the main checkout this took `.stoneforge/sync/elements.jsonl` from 4,691 lines down to 1; a commit of the sync directory would have recorded the loss in git.

Incremental export now **merges**: the existing file is read, each dirty element replaces its own line (keyed by `id`, tombstones included) or is appended, every other line is copied through byte-for-byte (so a git diff shows only real changes), the result is re-sorted into the standard export order, and both files are written atomically (temp file + flush + rename, still terminating nonempty content with exactly one newline as earlier versions did, so re-exports diff cleanly against existing files). If `elements.jsonl` is missing or unreadable the incremental export falls back to a full export, reported as `fallbackToFull: true` on the result. Ephemeral elements are excluded from the merge the same way a full export excludes them. `ExportResult.elementsExported` now counts the lines written (the merged total) rather than the dirty count. Dependencies are unchanged: they were already written as a complete snapshot.

New `mergeElementLines()` in `packages/quarry/src/sync/incremental.ts` carries the merge logic; regression tests cover merge/tombstone/fallback/sort-order in `service.bun.test.ts`, the pure merge in `incremental.bun.test.ts`, and two-ticks-keep-all-elements in `auto-export.bun.test.ts`.
