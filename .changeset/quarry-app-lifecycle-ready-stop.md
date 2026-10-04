---
"@stoneforge/quarry": minor
---

Fix a startup/shutdown race in `createQuarryApp`: the WebSocket broadcaster and JSONL auto-export services were started without awaiting their startup, so a `stop()`/teardown that raced that startup left late-started async work running against a closed database and removed output directories — surfacing as `Database is closed` errors and ENOENT export-path logs during test teardown.

`createQuarryApp()` now returns `ready` and `stop()` alongside the existing fields. `ready` is a promise that resolves once the auto-export initial full export and the broadcaster's initialization have settled (never rejects — failures are logged). `stop()` awaits any in-flight startup and export ticks, stops both services, releases the broadcaster singleton, and closes the database; it is idempotent and concurrent calls share one teardown. Await `stop()` before disposing shared resources (e.g. removing temp directories in integration tests) — it is safe to call immediately after `createQuarryApp`, even before `ready` settles. `AutoExportService.stop()` is now async and drains in-flight startup/ticks the same way.
