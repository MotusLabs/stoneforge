/**
 * Integration test for the createQuarryApp startup/shutdown lifecycle.
 *
 * createQuarryApp fires the auto-export initial export and the event
 * broadcaster's startup without awaiting them. A caller that stops/closes
 * the app immediately (the pattern of test fixtures) used to race that
 * startup: late-started async work kept running against a closed database
 * and a removed temp directory, logging 'Database is closed' and ENOENT
 * export-path errors during teardown.
 *
 * These tests pin the fixed contract:
 * - `await app.ready` waits for full service startup
 * - `await app.stop()` settles/cancels all in-flight startup so no async
 *   work outlives teardown — even when called before `ready` resolves
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuarryApp } from './index.js';
import type { QuarryApp } from './index.js';

// ============================================================================
// Test Setup
// ============================================================================

let tempDir: string;
let previousCwd: string;

/** Captured console output lines, scanned for teardown noise. */
let captured: string[];
let originalError: typeof console.error;
let originalLog: typeof console.log;

function startCapturingConsole(): void {
  captured = [];
  originalError = console.error;
  originalLog = console.log;
  const record = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  console.error = record as typeof console.error;
  console.log = record as typeof console.log;
}

function stopCapturingConsole(): void {
  console.error = originalError;
  console.log = originalLog;
}

/**
 * Assert no teardown noise escaped: the exact symptoms of the
 * startup/shutdown race were 'Database is closed' errors and ENOENT
 * export-path logs after stop().
 */
function expectNoTeardownNoise(): void {
  const noise = captured.filter(
    (line) => line.includes('Database is closed') || line.includes('ENOENT')
  );
  expect(noise).toEqual([]);
}

/** Wait for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * createQuarryApp resolves PROJECT_ROOT (default db dir, sync output dir,
 * uploads dir) from process.cwd(), so run inside a temp directory to keep
 * every file the app touches inside the disposable test sandbox.
 */
function createAppInTempDir(): QuarryApp {
  return createQuarryApp({ dbPath: join(tempDir, 'stoneforge.db') });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'stoneforge-app-lifecycle-'));
  previousCwd = process.cwd();
  process.chdir(tempDir);
  startCapturingConsole();
});

afterEach(() => {
  stopCapturingConsole();
  process.chdir(previousCwd);
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Test Suite
// ============================================================================

describe('createQuarryApp lifecycle', () => {
  test('immediate stop() resolves cleanly with no teardown noise', async () => {
    const app = createAppInTempDir();

    // Stop WITHOUT awaiting ready — the exact race that used to leak
    // 'Database is closed' errors and ENOENT export logs.
    await app.stop();

    expect(app.storageBackend.isOpen).toBe(false);
    expectNoTeardownNoise();

    // Wait past a few service poll intervals after the temp dir machinery is
    // done: no late-started async work may surface anything.
    await sleep(60);
    expectNoTeardownNoise();
  });

  test('immediate stop() then removing the temp dir produces no late errors', async () => {
    const app = createAppInTempDir();
    await app.stop();

    // Teardown order used by test fixtures: stop, then remove the sandbox.
    rmSync(tempDir, { recursive: true, force: true });

    await sleep(60);
    expectNoTeardownNoise();
  });

  test('ready() awaits full service startup and the app serves requests', async () => {
    const app = createAppInTempDir();

    await app.ready;

    // Initial full export has settled — the JSONL output exists
    expect(existsSync(join(tempDir, '.stoneforge', 'sync', 'elements.jsonl'))).toBe(true);

    // App is fully usable
    const res = await app.app.request('/api/health');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('ok');

    await app.stop();
    expect(app.storageBackend.isOpen).toBe(false);
    expectNoTeardownNoise();
  });

  test('stop() is idempotent', async () => {
    const app = createAppInTempDir();

    await app.stop();
    await app.stop(); // must not throw or log errors

    expect(app.storageBackend.isOpen).toBe(false);
    expectNoTeardownNoise();
  });

  test('concurrent stop() calls all wait for the same teardown', async () => {
    const app = createAppInTempDir();

    // Both calls must resolve only after teardown fully drained — a caller
    // that removes the temp dir after its own await must not race the other.
    await Promise.all([app.stop(), app.stop()]);

    expect(app.storageBackend.isOpen).toBe(false);
    expectNoTeardownNoise();
  });

  test('sequential create→stop cycles get a fresh broadcaster singleton', async () => {
    const appA = createAppInTempDir();
    await appA.stop();

    // A second app in the same process must not inherit A's stopped
    // broadcaster (bound to A's closed database).
    const appB = createAppInTempDir();
    expect(appB.broadcaster).not.toBe(appA.broadcaster);

    await appB.ready;
    await appB.stop();

    expect(appA.storageBackend.isOpen).toBe(false);
    expect(appB.storageBackend.isOpen).toBe(false);
    expectNoTeardownNoise();
  });
});
