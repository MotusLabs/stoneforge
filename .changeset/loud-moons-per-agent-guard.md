---
"@stoneforge/smithy": minor
---

Add `dispatchDaemon.isAgentRateLimited(agent)`: the per-agent counterpart of `getRateLimitStatus().isPaused`, returning `{ accountKey, resetsAt }` for the account that would refuse a session for one specific agent, or undefined when it may spawn.

Since the paused state was scoped to "every enabled ephemeral worker's account is limited" (design D7), a partial limit no longer pauses dispatch — which let the HTTP session-start and session-resume guards (`apps/smithy-server` `POST /api/agents/:id/start` and `/resume`) spawn an agent whose own account was exhausted while other accounts were free: the session started and immediately hit the limit. Both guards now keep the global paused check and additionally refuse with 429 when the target agent's own account is limited, naming the account key and its reset time (`error.accountKey`, `error.resetsAt`) and deriving `Retry-After` from that account's reset rather than the global soonest reset. The fallback-chain rule is honoured through `resolveExecutableWithFallback`: an agent with an explicit `executablePath` is judged on its own account key alone, an agent served by the chain only when every chain entry is limited (reported against the chain entry that resets soonest).

`RateLimitTracker` gains `getLimit(executable)` so a caller can learn *when* one account resets, not just that it is limited. `workerTaskService.startWorkerOnTask()` doc comments now point direct callers at `isAgentRateLimited` instead of the global flag.
