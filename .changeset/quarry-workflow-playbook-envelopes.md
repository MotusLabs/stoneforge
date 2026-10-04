---
"@stoneforge/quarry": patch
---

Fix the Workflows page being unable to render server workflows: the Quarry server now returns the envelope response shapes the shared `@stoneforge/ui` workflow hooks expect, and implements the playbook instantiate endpoint those hooks call.

The server previously returned bare arrays/objects while `useWorkflows`, `useWorkflow`, `useWorkflowTasks` and `usePlaybooks` read `data.workflows` / `data.workflow` / `data.tasks` / `data.playbooks`, so the Active tab was always empty, selecting a workflow always fell through to the not-found state, and the Create Workflow modal's playbook picker was always empty. The modal also instantiates via `POST /api/playbooks/:id/instantiate`, which the server did not serve at all.

- `GET /api/workflows` returns `{ workflows, total }` and supports the virtual `active`/`terminal` statuses plus `playbookId` filtering
- `GET /api/workflows/:id` returns `{ workflow }` (the `hydrate.progress` variant nests the same way)
- `GET /api/workflows/:id/tasks` returns `{ tasks, total, progress, dependencies }` with numeric progress metrics computed over the full task set and inter-task `blocks` dependencies
- `POST /api/workflows`, `PATCH /api/workflows/:id`, `POST /api/workflows/:id/promote` return `{ workflow }`; `DELETE` returns `{ success: true, ... }`
- New `POST /api/workflows/:id/start` and `/cancel` transitions (used by the workflow card actions) with `startedAt`/`finishedAt` handling and status guards
- `GET /api/playbooks` returns `{ playbooks, total }` with fully loaded playbooks (invalid files are skipped instead of failing the listing) and `GET /api/playbooks/:name` returns `{ playbook }` — this also fixes the missing `await` on `createPlaybook()` that made the detail endpoint serialize an empty object
- New `POST /api/playbooks/:name/instantiate` shared with the existing inline-playbook route, resolving `extends` inheritance through a file-based playbook loader; instantiating an inline playbook without a `variables` array no longer 500s

File-based playbooks are addressed by playbook name (exposed as `id`), since they are discovered from disk rather than stored as elements.
