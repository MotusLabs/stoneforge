---
'@stoneforge/smithy': patch
---

Enforce the per-agent rate-limit guard in the live server's session routes: `POST /api/agents/:id/start` and `POST /api/agents/:id/resume` (`packages/smithy/src/server/routes/sessions.ts`) now refuse with 429 — carrying `Retry-After`, and `accountKey`/`resetsAt` for the agent's own account — when dispatch is globally paused (manual sleep or every enabled account limited) or when the target agent's own account is limited, instead of reporting a started session that immediately hits the limit. This guard had previously been implemented and tested only in the unused legacy `apps/smithy-server/src/routes/` copy, so it never reached the running server; that duplicate tree is now deleted (the thin `apps/smithy-server/src/index.ts` wrapper starting `@stoneforge/smithy/server` is kept) and the rate-limit tests live beside the live routes in `packages/smithy/src/server/routes/sessions-ratelimit.test.ts`.
