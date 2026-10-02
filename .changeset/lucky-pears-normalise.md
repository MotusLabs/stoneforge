---
"@stoneforge/smithy": minor
---

Introduce a per-account rate-limit key. Rate limits are now tracked by normalised account key (`utils/account-key.ts`): a bare command name is resolved on `PATH` to its absolute path (cached per process), so `claude-glm` and `/usr/local/bin/claude-glm` address the same limit for `markLimited`, `isLimited` and fallback-chain lookups, and session `rate_limited` events are normalised before being forwarded to the trackers. `resolveAccountKey(agent, settingsService)` derives the key from an agent's effective executable (agent `executablePath` → `agentDefaults.defaultExecutablePaths[provider]` → provider default binary, `claude-code` → `claude`). Status payloads therefore list limits under the resolved absolute path instead of the raw command name.
