# Browser tests (Quarry)

The full workspace browser-test guide — prerequisites, port scheme, and the
Vite dev-server warmup that keeps first navigations inside the test budget —
lives in [`apps/smithy-web/TESTING.md`](../smithy-web/TESTING.md) and applies
identically to this app: same Playwright setup, same `tests/warm-vite.ts`
helper, same `timeout: 60_000`. This file records what is specific to Quarry.

## Running

```bash
bun run --cwd apps/quarry-web test:e2e                 # setup + full suite
bun run --cwd apps/quarry-web test tests/playbooks.spec.ts --repeat-each=3
```

Quarry's ports are offsets 2/3 of the worktree's hashed port base
(Smithy takes 0/1), so one app never collides with the other — but both apps
share the worktree's `.stoneforge-test/` database, so **run the two apps'
suites sequentially within one worktree** (concurrent cross-app runs corrupt
each other's seeded state). Use a separate worktree for true concurrency.

## Global setup seeds

`tests/global-setup.ts` seeds more than the operator entity:

- **Playbook fixtures** (`e2e-release-flow`, `e2e-required-vars`,
  `e2e-empty-steps`) are written into `apps/quarry-server/.stoneforge/playbooks/`
  for the playbook/workflow specs and removed by the global teardown. Only ever
  reference these fixture names in specs; do not assume other playbooks exist.
- **Messaging fixtures** (participant `el-0001`, one seeded channel with a
  message, one empty channel) exist so messaging specs do not depend on
  channels left behind by whichever spec ran first.

If a run is interrupted (killed web server, restarted pod), clear
`.stoneforge-test/` before the next run: the leftover operator makes
`globalSetup` fail with `ConflictError: Entity with name "operator" already
exists`. A clean completion removes the directory itself.

## Vite warmup and navigation timeouts

The `page.goto` route warmup (`tests/warm-vite.ts`, called from
`tests/global-setup.ts`) matters more for Quarry than Smithy — six of the
seven recorded navigation-timeout incidents were Quarry specs (`playbooks`,
`tb82-task-search` `/tasks`, tb129/tb130 `/documents`,
`tb121-plans-must-have-tasks` `/plans`, plus the
`helpers/create-workflow-modal.ts` `/dashboard` goto). Conventions for spec
authors, the two-layer fix, and how to verify navigation-flake fixes are
documented in the Test Runner Convention (`sf show el-50x1`, "Playwright
Browser Tests" section) and in `apps/smithy-web/TESTING.md`.

Notable Quarry-specific wrinkle: the tb129/tb130 specs navigate via
`` page.goto(`${APP_URL}/documents`) `` — the warmup scanner strips a leading
`${APP_URL}`/`${BASE_URL}` interpolation, so that form is warmed too. Do not
"simplify" specs back to plain literals for the warmup's sake, and do not add
per-spec `beforeAll` warmups (they relocate the flake to the next spec file
that touches the route; see the `plans.spec.ts` history, el-1pjuwe).
