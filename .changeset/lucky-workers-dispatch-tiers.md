---
"@stoneforge/smithy": minor
---

Add dispatch-tier data model fields for worker dispatch tiers: optional `tier` and `lastDispatchedAt` on agent metadata (with `isValidAgentTier()` validation for positive integers), and an optional `executable` account key on task session history entries. Purely additive; no behaviour changes yet.
