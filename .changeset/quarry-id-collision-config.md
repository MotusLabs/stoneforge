---
"@stoneforge/quarry": patch
---

Close the remaining element-ID generation gaps that could produce transient UNIQUE-violation failures on populated databases (same class as the shared-routes fix for el-37nk0u): `api.openDirectChannel` and the `sf plan create`, `sf channel create`, `sf message send` (DM channel creation), `sf playbook create`, and `sf init` (agent entities and channels) commands now pass the collision-checking, adaptive-length `getIdGeneratorConfig()` to their element factories. Adds a regression test (`plan-routes.integration.bun.test.ts`) that creates plans concurrently against a populated database and asserts collision-checked adaptive-length IDs.
