import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const testDbPath = resolve(projectRoot, '.stoneforge-test/stoneforge.db');

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
const testApiPort = testPort('E2E_API_PORT', portBase + 2);
const testWebPort = testPort('E2E_WEB_PORT', portBase + 3);
if (testApiPort === testWebPort) throw new Error('E2E_API_PORT and E2E_WEB_PORT must differ');
const reuseExistingServer = process.env.E2E_REUSE_SERVER === '1';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
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
      command: `STONEFORGE_DB_PATH=${testDbPath} PORT=${testApiPort} bun run src/index.ts`,
      cwd: resolve(__dirname, '../quarry-server'),
      port: testApiPort,
      reuseExistingServer,
      env: {
        // Hermetic config discovery. Daemon-spawned agent sessions inherit
        // STONEFORGE_ROOT pointing at the main workspace, and
        // findStoneforgeDir() checks it BEFORE the cwd walk-up — so without
        // this override the test server reads the main workspace's config.yaml
        // instead of this repo's own tracked .stoneforge/config.yaml (sync
        // settings, workflow preset, merge/agent settings all leak in). Pin
        // the root to this worktree. Playbook fixtures are unaffected: the
        // Quarry server discovers playbooks from its cwd
        // (apps/quarry-server/.stoneforge/playbooks), not STONEFORGE_ROOT.
        STONEFORGE_ROOT: projectRoot,
      },
    },
    {
      command: `VITE_API_PORT=${testApiPort} bun run dev -- --port ${testWebPort} --strictPort`,
      port: testWebPort,
      reuseExistingServer,
    },
  ],
});
