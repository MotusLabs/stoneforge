import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const testDbPath = resolve(projectRoot, '.stoneforge-test/stoneforge.db');
const testConfigPath = resolve(projectRoot, '.stoneforge-test/config.yaml');
const setupTestDbScript = resolve(__dirname, 'tests/setup-test-db.ts');

// Reserve four ports per worktree: Smithy API/web, then Quarry API/web.
// Hash collisions fail visibly because server reuse is disabled by default.
const portBase = 20000 + (createHash('sha256').update(projectRoot).digest().readUInt32BE(0) % 10000) * 4;
function testPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return Number(value);
}
const testApiPort = testPort('E2E_API_PORT', portBase);
const testWebPort = testPort('E2E_WEB_PORT', portBase + 1);
if (testApiPort === testWebPort) throw new Error('E2E_API_PORT and E2E_WEB_PORT must differ');
const reuseExistingServer = process.env.E2E_REUSE_SERVER === '1';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // 60s per test: even with the global-setup Vite warmup (tests/warm-vite.ts),
  // a fresh browser context's first navigation re-fetches the whole dev-mode
  // module graph through Vite, and when sibling suites saturate the pod those
  // loads can exceed the 30s default (observed as `page.goto: Test timeout`).
  // 60s absorbs the spike; the warmup keeps the typical first load at ~1-5s.
  timeout: 60_000,
  reporter: 'list',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${testWebPort}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // Run setup-test-db.ts first to ensure .stoneforge-test directory and DB exist
      // before the server starts. This fixes a race condition with globalSetup.
      command: `bun run ${setupTestDbScript} && STONEFORGE_DB_PATH=${testDbPath} DAEMON_AUTO_START=false PORT=${testApiPort} bun run ${resolve(projectRoot, 'apps/smithy-server/src/index.ts')}`,
      port: testApiPort,
      reuseExistingServer,
      env: {
        // Hermetic config discovery. Daemon-spawned agent sessions inherit
        // STONEFORGE_ROOT pointing at the main workspace, and
        // findStoneforgeDir() checks it BEFORE the cwd walk-up. Without this
        // override the test server reads the main workspace's config.yaml —
        // its workflow.preset makes GET /api/settings/workflow-preset return
        // a configured preset, so the AppShell onboarding tour auto-starts
        // and its fixed-inset backdrop intercepts clicks in unrelated tests.
        // Pin the root to this worktree so nothing outside it is consulted.
        STONEFORGE_ROOT: projectRoot,
        // Serve config from the test-owned .stoneforge-test/config.yaml
        // (written by setup-test-db.ts just before the server starts). It
        // mirrors the repo's tracked config but declares a workflow preset:
        // a configured preset keeps the app past its first-load gates, while
        // an unconfigured one renders the undismissable PresetSelectionModal
        // on /activity and blocks every click. Being gitignored and
        // regenerated per run, it also absorbs settings PUTs from tests
        // instead of dirtying the tracked config.
        STONEFORGE_CONFIG: testConfigPath,
      },
    },
    {
      command: `VITE_API_PORT=${testApiPort} bun run dev -- --port ${testWebPort} --strictPort`,
      port: testWebPort,
      reuseExistingServer,
    },
  ],
});
