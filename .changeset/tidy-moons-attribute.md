---
"@stoneforge/smithy": minor
---

Attribute provider rate limits to the account that produced them. Session-history entries now record the normalised account key (`executable`) the session runs on, including any fallback-chain override. `handleRateLimitDetected` marks the whole fallback chain only when the normalised reported key is itself a chain entry — a limit on a wrapper outside the chain (e.g. `claude-glm`) marks only that account, so workers on other accounts stay dispatchable. The rapid/silent-exit heuristic and the orphan-recovery rapid-exit pattern mark the recorded session accounts instead of a hard-coded `'claude'` or the whole chain, falling back to the assignee's account key for session-history entries that predate the field.
