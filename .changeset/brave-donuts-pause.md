---
"@stoneforge/smithy": minor
---

Pause dispatch only when **every** enabled ephemeral worker's account is rate-limited (worker dispatch tiers, design D7). Previously any limit (or a fully limited `fallbackChain`) paused the whole daemon, so one exhausted tier stopped dispatch even while cheaper or more expensive accounts still had quota.

`isDispatchPaused()` now derives the pause from the agent list and the rate-limit tracker: it walks enabled ephemeral workers, resolves each one's account key with `resolveAccountKey`, and reports paused only when every such key is limited. Busy/idle state is ignored (a busy worker on an unlimited account still counts), disabled workers are excluded, and with no enabled ephemeral workers dispatch is not reported as paused. `getRateLimitStatus()` keeps its shape and is now async — it lists the limited account keys with their reset times whether or not dispatch is paused, and reports `isPaused` under the new definition. The global rate-limit sleep timer arms only under that full pause, so a single limited tier no longer stalls the poll.

The smithy-web rate-limit banner keys off `status.rateLimit.isPaused` and therefore stays hidden for a partial limit and appears when every account is limited. HTTP callers of `getRateLimitStatus()` (`/api/daemon/status`, diagnostics, session-start guard) must `await` it.
