---
"@stoneforge/smithy-server": patch
---

Construct the operation-log service at startup and inject it into the dispatch daemon, merge-steward service and session manager, and construct the settings service the daemon already accepted. Previously neither `settingsService` nor `operationLog` was passed to `createDispatchDaemon()` from this app, so every operation-log write in the daemon was a no-op (`sf log` returned nothing) and fallback-chain/rate-limit account resolution ran without workspace settings.
