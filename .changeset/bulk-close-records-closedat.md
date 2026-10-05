---
"@stoneforge/shared-routes": patch
---

`PATCH /api/tasks/bulk` now records `closedAt` when a task transitions into `closed` and clears it when transitioning out, mirroring `updateTaskStatus` and the single-task PATCH route. Previously bulk-closed tasks never got `closedAt`, so completion-date consumers (`TaskFilter.closedAfter`, `GET /api/tasks/completed?after=`) had to rely permanently on the `updatedAt` fallback — which miscounts a task closed earlier but edited later. The bookkeeping is applied to a per-task copy of the updates object so one task's `closedAt` can never leak onto another task later in the batch.
