---
"@stoneforge/shared-routes": patch
---

Fix transient 500/409 failures on element-creating routes under parallel clients (el-37nk0u). The plan, document, message, library, and channel route factories called core element factories (`createPlan`, `createTask`, `createDocument`, `createMessage`, `createLibrary`, `createGroupChannel`, `createDirectChannel`) without `api.getIdGeneratorConfig()`, so generated IDs were fixed 4-char base36 hashes with no collision check. Once a database accumulated enough elements (birthday bound at 36⁴ ≈ 1.7M), INSERTs hit UNIQUE violations that surfaced as 500 INTERNAL_ERROR — or, on POST /api/plans, as a misleading 409 "Task is already in another plan". All factory calls in shared routes now pass `api.getIdGeneratorConfig()`, which selects the adaptive hash length from the element count and retries generation on collision. `QuarryLikeAPI` gains the `getIdGeneratorConfig()` member.
