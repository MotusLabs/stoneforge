---
"@stoneforge/smithy": patch
---

Fix `ClaudeAgentProvider.listModels()` spawning phantom agent sessions. The probe used `sdkQuery({ prompt: '' })` to reach `supportedModels()`; an empty string prompt is delivered as a real user turn, so a full Claude session started in the caller's cwd (a worker worktree during `apps/smithy-server` tests, or the smithy-server cwd when the UI opens a model picker) and could run for minutes after `close()`. Those sessions looked like a second worker spawn overlapping the live one.

The probe now uses streaming input that yields no user message (initialize handshake only), aborts the CLI process in `finally`, and runs from `os.tmpdir()` so a leaked session cannot impersonate a worker.
