# Browser tests

Ensure Bun, Node.js, and pnpm are on PATH before installing dependencies. Node.js
is also needed during installation to build the native SQLite dependency used by
Playwright's test-data setup. From the repository root, install workspace
dependencies with `pnpm install --frozen-lockfile`, then run:

```bash
bun run --cwd apps/smithy-web test:e2e
# Or the Quarry browser suite:
bun run --cwd apps/quarry-web test:e2e
```

pnpm uses `pnpm-workspace.yaml` to install each app's local Playwright and Vite
dependencies. Bun is the runtime and test runner, not the dependency installer.
Global Playwright or tsx installations and prebuilt `dist/` directories are unnecessary.

Each command idempotently installs the matching Playwright Chromium headless shell,
builds workspace packages needed by the Node-based global setup hooks when absent, and
runs the suite. Bun runs the TypeScript API servers directly; no global `tsx` is
needed. Node.js and pnpm (the repository's package manager, used by Turbo builds)
must also be available. Linux installs also need `python3`, `make`, and `g++`
for the native `node-pty` dependency. Install these system prerequisites before
running pnpm.
On Linux, Chromium requires its system libraries; on a minimal OS install these
with `bun run --cwd apps/smithy-web test:e2e:setup --with-deps`
(requires permission to install OS packages).

To install full Chromium (including headed mode for `test:ui`), run
`bun run --cwd apps/smithy-web test:e2e:setup`
(or use `apps/quarry-web`). Repeated setup reuses the browser cache.
Arguments pass through to Playwright, for example:

```bash
bun run --cwd apps/smithy-web test:e2e scaffold.spec.ts --workers=1
```

Both apps derive default ports from a stable SHA-256 hash of the absolute
repository root: `20000 + (hashUInt32 % 10000) * 4`. Smithy uses offsets 0/1
for API/web; Quarry uses offsets 2/3. Different worktrees normally get different
ports, so browser suites in separate worktrees can run concurrently. Hash
collisions or occupied ports fail visibly; Vite uses `--strictPort`.

- `E2E_API_PORT` overrides the API port (integer 1–65535).
- `E2E_WEB_PORT` overrides the web port (integer 1–65535, different from API).
- `E2E_REUSE_SERVER=1` explicitly allows reusing existing servers. By default,
  Playwright starts its own servers and refuses occupied ports, including outside CI.
  With reuse enabled, you are responsible for ensuring both servers belong to
  this worktree and that Vite proxies to the selected API port.

The Vite server receives `VITE_API_PORT` from the selected API port automatically.
Each suite uses `.stoneforge-test/` in its repository root, so run the two apps
sequentially within one worktree (their databases are shared). Use separate
worktrees for concurrent runs. For explicit ports:

```bash
E2E_API_PORT=41000 E2E_WEB_PORT=41001 bun run --cwd apps/smithy-web test:e2e scaffold.spec.ts --workers=1
```
`test:ui` opens the Playwright UI after the full Chromium setup. `test:unit` in
Smithy runs Vitest and does not need Chromium.

To verify prerequisites in a fresh checkout, run the Smithy scaffold tests first:

```bash
pnpm install --frozen-lockfile
CI=1 bun run --cwd apps/smithy-web test:e2e scaffold.spec.ts --workers=1
```

Playwright starts its own API and Vite servers by default. `CI=1` also enables
CI retries and a single worker. To verify the browser download too,
set `PLAYWRIGHT_BROWSERS_PATH` to an empty directory for the test command.

## Vite dev-server warmup (first-navigation timeouts)

Both apps statically import every route component in `src/router.tsx`, so the
first `page.goto()` of a run fetches the entire unbundled module graph through
Vite's on-demand transform pipeline. Under the default worker count (half the
CPUs) every worker hits that cold first transform at the same moment; the
single Vite process serializes the transforms and the `load` event can exceed
Playwright's default 30s navigation timeout. Four recorded flakes share this
signature — an initial `page.goto` timing out under parallel load and passing
on isolated retry: `playbooks.spec.ts:193`, `workspaces.spec.ts:755`/`:873`,
`helpers/create-workflow-modal.ts:339` (`goto('/dashboard')`), and
`onboarding.spec.ts:521` (task el-1pjuwe).

To keep that from recurring, each app's `tests/global-setup.ts` calls
`warmViteDevServer()` from `tests/warm-vite.ts` after seeding test data.
It scans `tests/` for every `page.goto('/…')` literal (helpers included) and
loads each route once in a throwaway Chromium page before any worker spawns,
populating Vite's in-memory transform cache. A cold full-graph warmup takes
roughly 25–35s on this hardware; every worker navigation afterwards is a
warm-cache load measured in seconds.

Consequences for writing specs:

- Navigate with `page.goto('/route')` against the configured `baseURL`. Routes
  reached that way are warmed automatically, including routes added by future
  specs — the list is discovered from the specs, not maintained by hand.
- Do not reach for per-test retries or inflated per-test navigation timeouts
  to paper over a slow first navigation; report a warmup gap instead (for
  example a route built from a template literal, which the scanner cannot see).
- `E2E_SKIP_WARMUP=1` disables the warmup for A/B comparisons and
  emergencies. With it set, cold-cache first navigations under parallel load
  can time out again — that is the old behavior, not a bug in your test.

This applies identically to `apps/quarry-web` (same helper, same global-setup
call). The convention is also recorded in the Test Runner Convention document
(el-50x1).
