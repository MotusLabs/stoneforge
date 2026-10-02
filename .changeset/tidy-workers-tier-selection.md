---
"@stoneforge/smithy": minor
---

Order idle ephemeral workers by dispatch preference before tasks are offered, so operators can drain cheap subscriptions before expensive ones. Workers are ranked by `(tier ?? ∞, lastDispatchedAt ?? -∞, id)`: ascending tier (1 = most preferred, untiered last), then least-recently-dispatched first within a tier so several accounts in the same tier share the load, then agent ID. The daemon records `lastDispatchedAt` on the worker's agent metadata after each successful spawn, so the ordering survives daemon and server restarts. Only ephemeral workers are ranked — persistent workers, stewards and directors ignore a tier value. A worker whose account key is rate-limited is skipped and the task is offered to the next worker in rank order, including lower tiers, within the same cycle. Workspaces that set no tiers keep today's behaviour apart from the new deterministic ordering; ordering is exported as `compareWorkersByDispatchPreference`.
