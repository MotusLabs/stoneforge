# Browser tests

Install Node.js (18 or later), pnpm 8.15.5, and Bun and put them on PATH.
pnpm is the workspace's only dependency installer; Bun runs the TypeScript API
servers and Bun tests. No global tsx or Playwright installation is needed.
On Linux, native modules (including node-pty and better-sqlite3) may require
`python3`, `make`, and `g++` before installation.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @stoneforge/smithy-web test:e2e
# Run the Quarry suite separately:
pnpm --filter @stoneforge/quarry-web test:e2e
```

Both apps provide `test:e2e:setup`, which idempotently runs
`playwright install chromium --only-shell`. `test:e2e` runs setup and then the
Playwright suite, forwarding test arguments. Global setup builds core, storage,
shared-routes, and quarry when their built entry points are absent, before
importing them under Node. Prebuilt dist directories are unnecessary.

For exact test-file matches (Playwright accepts regular expressions):

```bash
CI=1 pnpm --filter @stoneforge/smithy-web test:e2e '(^|/)scaffold.spec.ts$' --workers=1
CI=1 pnpm --filter @stoneforge/quarry-web test:e2e '(^|/)dashboard.spec.ts$' --workers=1
```

Equivalent commands use `bun run --cwd apps/smithy-web test:e2e` or
`bun run --cwd apps/quarry-web test:e2e`.

Chromium also requires OS libraries. On minimal Linux systems, install them with
`pnpm --filter @stoneforge/smithy-web exec playwright install-deps chromium`
(which may require administrator privileges). Headed tests and `test:ui` require
full Chromium: `pnpm --filter @stoneforge/smithy-web exec playwright install chromium`.

Smithy uses API/web ports 3458/5175; Quarry uses 3459/5176. Both use the repository's
`.stoneforge-test/` directory, so run the apps sequentially. `CI=1` prevents reuse
of existing test servers. Set `PLAYWRIGHT_BROWSERS_PATH` to an empty directory to
verify a fresh browser download. Smithy's `test:unit` runs Vitest without a browser.
