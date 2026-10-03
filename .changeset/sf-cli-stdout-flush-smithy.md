---
'@stoneforge/smithy': patch
---

Use the shared graceful exit helper in `test-orchestration` instead of `process.exit()`, so large piped test reports are no longer truncated at the 64KB pipe buffer, and exit codes are preserved on success, failure and `--help`.
