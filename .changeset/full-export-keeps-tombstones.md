---
"@stoneforge/quarry": patch
---

Full JSONL exports no longer drop soft-deleted elements. `SyncService.getAllElements()` filtered `deleted_at IS NULL`, so every full export (`sf export --full`, the auto-export startup full export, the incremental fallback-to-full path, and `exportToString()` behind `QuarryAPI.export()` and the HTTP sync pull/push/exchange endpoints) rewrote `elements.jsonl` without tombstones that earlier incremental exports had recorded — erasing deletions from the git-tracked source of truth and letting deleted elements resurrect in clones that import the file. Both export paths now serialize soft-deleted rows in the same tombstone form the incremental path and importer already use (`status: "tombstone"` + `deletedAt`), so export → import round-trips deletions and a fresh tombstone still wins over a live element on merge. Ephemeral filtering is unchanged. `sf sync status` and other display counts still report live elements only.
