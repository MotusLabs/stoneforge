---
'@stoneforge/quarry': patch
---

Fix piped `sf` output being truncated at 64KB: the CLI recorded `process.exit()` right after running a command, which killed the process before Node flushed the asynchronous stdout pipe buffer. `sf show <id> --json | jq` received invalid JSON and piped read-modify-writes could silently corrupt documents. Commands now exit through `exitGracefully()` (new in `@stoneforge/quarry/cli`): the exit code is recorded, stdout/stderr are drained and the process ends naturally, with an unref'd fallback timer that still guarantees prompt termination when an open handle keeps the event loop alive. Under Bun the CLI exits hard instead, because Bun flushes console output on `process.exit()` and loses it on a natural exit — and merely accessing `process.stdout` there breaks flushing. Piping into `head` no longer crashes with EPIPE. Exit codes are unchanged.
