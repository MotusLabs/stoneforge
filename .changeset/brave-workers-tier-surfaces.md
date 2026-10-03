---
"@stoneforge/smithy": minor
---

Expose the worker dispatch tier to operators: `sf agent register --tier <n>`, a new `sf agent set-tier <id> <n|none>` subcommand and a TIER column in `sf agent list`; `tier` accepted (and validated, `null` clears) on `POST/PATCH /api/agents` and returned in agent payloads; and a tier input in the smithy-web create/edit dialogs with a "Tier N" badge on agent cards. Invalid values are rejected with a validation error and leave the agent unchanged; tiers apply to worker agents only.
