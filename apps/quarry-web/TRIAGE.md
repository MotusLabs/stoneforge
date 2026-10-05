# quarry-web Browser Test Triage

Working ledger of Playwright spec health for `apps/quarry-web`. The Quarry Web
Reference (workspace doc `el-4iiz`, section 7a) points here; keep both in sync.

Run conventions:

- Repro: `cd apps/quarry-web && bunx playwright test tests/<spec>.spec.ts`
- Triage runs should use `--workers=1`. Under parallel workers the test server
  returns transient 500s and `page.goto` timeouts (known issue, task
  `el-37nk0u`); those failures are infra flake, not spec drift. Confirm any
  suspicious failure solo before diagnosing it as a spec/product defect.
- Before writing a new fix, check `git log --all --grep=<task-id>` — fixes for
  this suite have repeatedly landed on unmerged agent branches first.

## Removed task-flow page surface (legacy-content drift family)

The task-flow page was removed: the `/tasks` kanban view carries the
task-flow columns, `/dashboard/task-flow` is a legacy redirect to `/tasks`,
the sidebar exposes `nav-tasks` (no `nav-task-flow`), the command palette has
`command-item-nav-tasks` (no `command-item-nav-task-flow`), the settings
defaults offer only overview/dependencies/timeline lens cards (no
`default-dashboard-lens-task-flow`, no `-agents`), and the legacy
`'task-flow'` lens / `dashboard.lastVisited` values map to `/tasks` via
`DASHBOARD_LENS_ROUTES`. There is no `task-flow-page` or `breadcrumb-task-flow`
testid anywhere in `src/`.

Fix batches (each aligned specs to `nav-tasks` + `/tasks` + `tasks-page`):

| Task | Specs fixed |
|------|-------------|
| el-4hs7z1 | hello-world.spec.ts |
| el-4aaml1 | websocket.spec.ts, ready-tasks.spec.ts |
| el-en08h1 | command-palette.spec.ts, keyboard-shortcuts.spec.ts |
| el-47vk9f | task-flow.spec.ts, tb76-dashboard-sub-navigation.spec.ts, tb74-card-styling.spec.ts, tb119-accessibility.spec.ts, tb135-text-contrast.spec.ts, core-components.spec.ts, defaults-settings.spec.ts, tb75-sidebar-navigation-styling.spec.ts*, tb154-responsive-command-palette.spec.ts* |

\* tb75/tb154 were finished in an el-47vk9f follow-up commit (review
request), touching only the retired-navigation assertions: tb75
"breadcrumbs show hierarchy for nested routes" became "legacy task-flow URL
redirects to tasks with its breadcrumb" (redirect + `tasks-page` + single
`breadcrumb-tasks` crumb, `breadcrumb-task-flow` asserted absent); tb154
dropped the obsolete `command-item-nav-task-flow` visibility expectation
from "mobile command palette search works" (the `command-item-nav-tasks`
assertion already covered current behaviour).

No references to the removed surface remain: grep for
`task-flow-page|nav-task-flow|breadcrumb-task-flow|command-item-nav-task-flow`
across `tests/` is clean after the el-47vk9f follow-up (2026-10-05). The
unrelated failures in those two files are tracked below (el-bvt9v5).

## Known failing specs (other families, verified 2026-10-05)

Failures below reproduce with pristine master spec files, i.e. they are not
caused by any spec fix on an agent branch:

- `tests/tb75-sidebar-navigation-styling.spec.ts` (el-bvt9v5 scope; the
  task-flow test at :202 was fixed by el-47vk9f, shifting later lines +6)
  - :192 "breadcrumbs show current page", :220 "parent breadcrumb is
    clickable" — breadcrumb drift: `ROUTE_CONFIG` in `AppShell.tsx` defines
    no `parent` chains, so every route renders a single crumb (/dashboard
    redirects to /dashboard/overview and shows only `breadcrumb-overview`);
    these tests assert a two-level chain that no longer exists.
  - :390 "sidebar shows styled logo with gradient", :401 "collapsed sidebar
    shows smaller logo" — logo styling drift.
- `tests/tb154-responsive-command-palette.spec.ts`
  - :119 `command-item-nav-task-flow` was removed by el-47vk9f (review
    follow-up); "mobile command palette search works" now passes at
    `--workers=1`. :40 and :155 also passed in two full post-fix runs on
    this branch (2026-10-05) after the master merge — they did not
    reproduce, so re-verify before spending el-bvt9v5 effort on them.
- `tests/tb119-accessibility.spec.ts:61` "timeline page is accessible" —
  product a11y bugs on `/dashboard/timeline`: `button-name` (critical) on the
  `view-mode-list` / `view-mode-horizontal` toggle buttons (icon-only, no
  aria-label) and `scrollable-region-focusable` (serious) on
  `events-list`. Needs source fixes, not spec changes.
- `tests/tb135-text-contrast.spec.ts:116` "primary buttons use bg-blue-600
  for WCAG compliance" — buttons now use design tokens
  (`bg-[var(--color-primary)]`); the spec still asserts the literal Tailwind
  class. Decide the token contract, then assert computed color.
- `tests/kanban.spec.ts` "kanban board has status columns" (static finding,
  not yet run) — expects `kanban-column-in_progress` and
  `kanban-column-completed`, but `KanbanBoard.tsx` renders
  `kanban-column-open/in-progress/blocked` (3 columns, dashed ids).

## Fixed / green

All specs in the el-47vk9f batch pass at `--workers=1` (see that task's
commit for the per-file breakdown), including the follow-up tb75/tb154
task-flow assertions. tb154 is fully green (15/15). Exceptions, tracked
separately: tb119 timeline a11y, tb135 button token, and tb75's four
el-bvt9v5-owned failures (breadcrumb chain ×2, logo styling ×2).
