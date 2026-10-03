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
