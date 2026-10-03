---
"@stoneforge/quarry": patch
---

Fix `listPaginated()`/`list()` with a multi-tag `tags` filter (AND semantics): the SQL joined `t.tag IN (...)`, which proves only that ONE of the required tags is present, applied `LIMIT`/`OFFSET` to that too-wide set, and re-checked the AND in JavaScript afterwards. Pages came back short or empty (earlier pages consumed rows the post-filter then dropped), later pages held matches earlier pages skipped, and `total`/`hasMore` counted the too-wide set.

Each required tag now compiles to a correlated `EXISTS` subquery in SQL, evaluated before `LIMIT` and before the `COUNT` pass. Pages are full unless last, `total` and `hasMore` are exact, `list()`, `listPaginated()` and the count agree, and walking pages returns every match exactly once. The JavaScript post-filter is removed. A `tags`-only filter no longer joins or fans rows out — it needs no `DISTINCT`/`COUNT(DISTINCT e.id)` and keeps the ordering-index scan without temp b-trees. `tagsAny` keeps its join + `DISTINCT` shape, and combining `tags` with `tagsAny` now correctly ANDs the two conditions.
