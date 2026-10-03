/**
 * Admin Commands Tests - doctor and migrate
 */

import { createBackendTracker } from '../../testing/storage-test-utils.js';
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { doctorCommand, migrateCommand } from './admin.js';
import { createCommand } from './crud.js';
import { initCommand } from './init.js';
import type { GlobalOptions } from '../types.js';
import { ExitCode } from '../types.js';
import { createStorage, initializeSchema, CURRENT_SCHEMA_VERSION } from '@stoneforge/storage';

const backends = createBackendTracker();

// ============================================================================
// Test Utilities
// ============================================================================

// Scratch workspace lives in the OS temp dir (NOT next to the sources) so an
// interrupted run — crash, CI timeout, Ctrl+C — can never leave a
// __test_admin_workspace__ artifact with a test database inside src/.
let TEST_DIR: string;
let STONEFORGE_DIR: string;
let DB_PATH: string;

function createTestOptions(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    db: DB_PATH,
    actor: 'test-user',
    json: false,
    quiet: false,
    verbose: false,
    help: false,
    version: false,
    ...overrides,
  };
}

/**
 * Healthy empty runtime diagnostics payload matching smithy-server's
 * GET /api/health/diagnostics response shape.
 */
function createHealthyRuntimeDiagnostics() {
  return {
    timestamp: new Date().toISOString(),
    rateLimits: { isPaused: false, limits: [] },
    stuckTasks: [],
    mergeQueue: {
      awaitingMergeCount: 0,
      stuckInTestingCount: 0,
      stuckInMergingCount: 0,
      stuckTasks: [],
    },
    errorRate: { lastHourCount: 0, lastDayCount: 0 },
    agentPool: {
      totalAgents: 0,
      idleAgents: 0,
      busyAgents: 0,
      utilizationPercent: 0,
      sessions: [],
    },
  };
}

// ============================================================================
// Runtime diagnostics fetch mock
//
// doctor queries smithy-server GET /api/health/diagnostics on every run.
// Tests must not hit a live orchestrator — a real server with stuck tasks
// would push an ERROR diagnostic and fail otherwise-healthy DB assertions.
// ============================================================================

let originalFetch: typeof globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;
let runtimeDiagnosticsImpl: () => Promise<Response>;

function setupFetchMock() {
  originalFetch = globalThis.fetch;
  mockFetch = mock((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/health/diagnostics')) {
      return runtimeDiagnosticsImpl();
    }
    return Promise.reject(new Error(`Unexpected fetch in test: ${url}`));
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // Default: healthy orchestrator with nothing to report
  setRuntimeDiagnostics(createHealthyRuntimeDiagnostics());
}

function restoreFetchMock() {
  globalThis.fetch = originalFetch;
}

function setRuntimeDiagnostics(body: unknown, status = 200) {
  runtimeDiagnosticsImpl = () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
}

function setRuntimeDiagnosticsUnavailable() {
  runtimeDiagnosticsImpl = () =>
    Promise.reject(new Error('fetch failed: connection refused'));
}

function setRuntimeDiagnosticsHttpError(status: number) {
  runtimeDiagnosticsImpl = () =>
    Promise.resolve(new Response('not found', { status }));
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  // Fresh isolated workspace per test, in the OS temp dir
  TEST_DIR = mkdtempSync(join(tmpdir(), 'stoneforge-admin-test-'));
  STONEFORGE_DIR = join(TEST_DIR, '.stoneforge');
  DB_PATH = join(STONEFORGE_DIR, 'stoneforge.db');
  mkdirSync(STONEFORGE_DIR, { recursive: true });
  setupFetchMock();
});

afterEach(() => {
  backends.closeAll();
  restoreFetchMock();
  // Cleanup test workspace
  if (TEST_DIR && existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Doctor Command Tests
// ============================================================================

describe('doctor command', () => {
  test('reports error when no workspace exists', async () => {
    // Use a path that doesn't exist
    const options = createTestOptions({ db: undefined });
    // Change cwd temporarily by using a nonexistent .stoneforge
    rmSync(STONEFORGE_DIR, { recursive: true });

    // Point to a nonexistent database with --db
    const result = await doctorCommand.handler([], {
      ...options,
      db: join(TEST_DIR, 'nonexistent', 'test.db'),
    });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.data).toHaveProperty('healthy', false);
    expect(result.data.diagnostics).toBeInstanceOf(Array);
  });

  test('reports healthy for initialized database', async () => {
    // Initialize database with schema
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data).toHaveProperty('healthy', true);
    expect(result.message).toContain('System is healthy');
  });

  test('checks workspace exists', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const workspaceDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'workspace'
    );
    expect(workspaceDiag).toBeDefined();
    expect(workspaceDiag.status).toBe('ok');
  });

  test('checks database exists', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const dbDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'database'
    );
    expect(dbDiag).toBeDefined();
    expect(dbDiag.status).toBe('ok');
  });

  test('checks database connection', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const connDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'connection'
    );
    expect(connDiag).toBeDefined();
    expect(connDiag.status).toBe('ok');
  });

  test('checks schema version', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const schemaDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'schema_version'
    );
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag.status).toBe('ok');
    expect(schemaDiag.message).toContain('up to date');
  });

  test('reports warning for outdated schema', async () => {
    // Create database with older schema version
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    // Initialize schema but then set an older version
    initializeSchema(backend);
    backend.setSchemaVersion(1);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const schemaDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'schema_version'
    );
    expect(schemaDiag).toBeDefined();
    expect(schemaDiag.status).toBe('warning');
    expect(schemaDiag.message).toContain('behind');
  });

  test('checks schema tables', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const tablesDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'schema_tables'
    );
    expect(tablesDiag).toBeDefined();
    expect(tablesDiag.status).toBe('ok');
    expect(tablesDiag.message).toContain('expected tables');
  });

  test('checks database integrity', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const integrityDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'integrity'
    );
    expect(integrityDiag).toBeDefined();
    expect(integrityDiag.status).toBe('ok');
    expect(integrityDiag.message).toContain('passed');
  });

  test('checks foreign key integrity', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const fkDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'foreign_keys'
    );
    expect(fkDiag).toBeDefined();
    expect(fkDiag.status).toBe('ok');
  });

  test('checks blocked cache - reports ok when empty and no blocked tasks', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const cacheDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'blocked_cache'
    );
    expect(cacheDiag).toBeDefined();
    expect(cacheDiag.status).toBe('ok');
  });

  test('checks blocked cache - reports warning when tasks have blocked status but no cache entry', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create a task with status='blocked' but no blocked_cache entry
    // This simulates the state after an import without cache rebuild
    const taskId = 'el-test1';
    const taskData = {
      title: 'Test blocked task',
      status: 'blocked',
      priority: 2,
    };
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [taskId, JSON.stringify(taskData)]
    );

    // Verify blocked_cache is empty
    const cacheCount = backend.query<{ count: number }>('SELECT COUNT(*) as count FROM blocked_cache');
    expect(cacheCount[0].count).toBe(0);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const cacheDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'blocked_cache'
    );
    expect(cacheDiag).toBeDefined();
    expect(cacheDiag.status).toBe('warning');
    expect(cacheDiag.message).toContain('inconsistent');
    expect(cacheDiag.message).toContain('blocked tasks missing from cache');
    expect(cacheDiag.details.missingCacheCount).toBe(1);
  });

  test('checks blocked cache - reports ok when tasks have blocked status with matching cache entry', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create a blocker task (open)
    const blockerId = 'el-blocker';
    const blockerData = {
      title: 'Blocker task',
      status: 'open',
      priority: 2,
    };
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [blockerId, JSON.stringify(blockerData)]
    );

    // Create a blocked task with matching cache entry
    const blockedId = 'el-blocked';
    const blockedData = {
      title: 'Blocked task',
      status: 'blocked',
      priority: 2,
    };
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [blockedId, JSON.stringify(blockedData)]
    );

    // Add blocked_cache entry
    backend.run(
      `INSERT INTO blocked_cache (element_id, blocked_by, reason) VALUES (?, ?, ?)`,
      [blockedId, blockerId, 'Blocked by test']
    );

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const cacheDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'blocked_cache'
    );
    expect(cacheDiag).toBeDefined();
    expect(cacheDiag.status).toBe('ok');
    expect(cacheDiag.message).toBe('Blocked cache is consistent');
  });

  test('checks blocked cache - reports warning for orphaned cache entries', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create an element so we can insert cache entry (FK constraint)
    const taskId = 'el-orphan';
    const taskData = {
      title: 'Test task',
      status: 'open',
      priority: 2,
    };
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [taskId, JSON.stringify(taskData)]
    );

    // Add blocked_cache entry
    backend.run(
      `INSERT INTO blocked_cache (element_id, blocked_by, reason) VALUES (?, ?, ?)`,
      [taskId, 'el-nonexistent', 'Orphan test']
    );

    // Now delete the element to create an orphan (FK cascade should clean this up,
    // but let's verify the check works by disabling FK temporarily)
    backend.run('PRAGMA foreign_keys = OFF');
    backend.run('DELETE FROM elements WHERE id = ?', [taskId]);
    backend.run('PRAGMA foreign_keys = ON');

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const cacheDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'blocked_cache'
    );
    expect(cacheDiag).toBeDefined();
    expect(cacheDiag.status).toBe('warning');
    expect(cacheDiag.message).toContain('orphaned cache entries');
  });

  test('reports storage stats', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    const storageDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'storage'
    );
    expect(storageDiag).toBeDefined();
    expect(storageDiag.status).toBe('ok');
    expect(storageDiag.message).toMatch(/Database size:/);
  });

  test('verbose mode shows details', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions({ verbose: true });
    const result = await doctorCommand.handler([], options);

    // Verbose output should include details
    expect(result.message).toBeDefined();
    // The detailed info about file size should be there
    expect(result.message).toContain('fileSize');
  });

  test('returns summary counts', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    expect(result.data.summary).toBeDefined();
    expect(result.data.summary).toHaveProperty('ok');
    expect(result.data.summary).toHaveProperty('warning');
    expect(result.data.summary).toHaveProperty('error');
    expect(result.data.summary.ok).toBeGreaterThan(0);
  });
});

// ============================================================================
// Runtime Diagnostics Tests (smithy-server /api/health/diagnostics)
// ============================================================================

describe('doctor runtime diagnostics', () => {
  test('includes runtime checks when smithy-server is available', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const result = await doctorCommand.handler([], createTestOptions());

    const names = (result.data.diagnostics as Array<{ name: string }>).map((d) => d.name);
    expect(names).toContain('rate_limits');
    expect(names).toContain('stuck_tasks');
    expect(names).toContain('merge_queue');
    expect(names).toContain('error_rate');
    expect(names).toContain('agent_pool');
    // Healthy runtime must not fail the overall doctor run
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data.healthy).toBe(true);
  });

  test('reports error exit when runtime reports stuck tasks', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    setRuntimeDiagnostics({
      ...createHealthyRuntimeDiagnostics(),
      stuckTasks: [
        {
          taskId: 'el-stuck1',
          title: 'Stuck task',
          status: 'in_progress',
          assignee: 'el-agent1',
          resumeCount: 3,
          mergeStatus: 'pending',
        },
      ],
    });

    const result = await doctorCommand.handler([], createTestOptions());

    // Stuck tasks are a runtime ERROR (per diagnostics spec) and fail the run,
    // even when the database itself is healthy.
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.data.healthy).toBe(false);

    const stuckDiag = (result.data.diagnostics as Array<{ name: string; status: string; message: string }>).find(
      (d) => d.name === 'stuck_tasks'
    );
    expect(stuckDiag).toBeDefined();
    expect(stuckDiag!.status).toBe('error');
    expect(stuckDiag!.message).toContain('el-stuck1');
  });

  test('reports warning for rate limits without failing the run', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    setRuntimeDiagnostics({
      ...createHealthyRuntimeDiagnostics(),
      rateLimits: {
        isPaused: true,
        limits: [{ executable: 'claude', resetsAt: '2026-01-01T00:00:00.000Z' }],
        soonestReset: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await doctorCommand.handler([], createTestOptions());

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const limitDiag = (result.data.diagnostics as Array<{ name: string; status: string }>).find(
      (d) => d.name === 'rate_limits'
    );
    expect(limitDiag).toBeDefined();
    expect(limitDiag!.status).toBe('warning');
  });

  test('skips runtime checks gracefully when smithy-server is unavailable', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    setRuntimeDiagnosticsUnavailable();

    const result = await doctorCommand.handler([], createTestOptions());

    // Unavailable orchestrator is a warning, not an error — DB health still passes
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data.healthy).toBe(true);

    const runtimeDiag = (result.data.diagnostics as Array<{ name: string; status: string; message: string }>).find(
      (d) => d.name === 'runtime'
    );
    expect(runtimeDiag).toBeDefined();
    expect(runtimeDiag!.status).toBe('warning');
    expect(runtimeDiag!.message).toContain('not available');
  });

  test('reports warning when diagnostics endpoint returns HTTP error', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    setRuntimeDiagnosticsHttpError(404);

    const result = await doctorCommand.handler([], createTestOptions());

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const runtimeDiag = (result.data.diagnostics as Array<{ name: string; status: string; message: string }>).find(
      (d) => d.name === 'runtime'
    );
    expect(runtimeDiag).toBeDefined();
    expect(runtimeDiag!.status).toBe('warning');
    expect(runtimeDiag!.message).toContain('404');
  });

  test('elevated error rate is a warning and high error rate is an error', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    setRuntimeDiagnostics({
      ...createHealthyRuntimeDiagnostics(),
      errorRate: { lastHourCount: 10, lastDayCount: 20 },
    });

    const elevated = await doctorCommand.handler([], createTestOptions());
    expect(elevated.exitCode).toBe(ExitCode.SUCCESS);
    const elevatedDiag = (elevated.data.diagnostics as Array<{ name: string; status: string }>).find(
      (d) => d.name === 'error_rate'
    );
    expect(elevatedDiag!.status).toBe('warning');

    setRuntimeDiagnostics({
      ...createHealthyRuntimeDiagnostics(),
      errorRate: { lastHourCount: 25, lastDayCount: 40 },
    });

    const high = await doctorCommand.handler([], createTestOptions());
    expect(high.exitCode).toBe(ExitCode.GENERAL_ERROR);
    const highDiag = (high.data.diagnostics as Array<{ name: string; status: string }>).find(
      (d) => d.name === 'error_rate'
    );
    expect(highDiag!.status).toBe('error');
  });
});

// ============================================================================
// Migrate Command Tests
// ============================================================================

describe('migrate command', () => {
  test('reports when already up to date', async () => {
    // Initialize database with full schema
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await migrateCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.message).toContain('up to date');
    expect(result.data.migrationsApplied).toHaveLength(0);
  });

  test('fails when no database exists', async () => {
    const nonExistentPath = join(TEST_DIR, 'nonexistent', 'test.db');
    const options = createTestOptions({ db: nonExistentPath });
    const result = await migrateCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    // Error message depends on whether path is inaccessible
    expect(result.error).toBeDefined();
  });

  test('dry-run shows pending migrations without applying', async () => {
    // Create a database with schema version 1 (one behind current)
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);
    backend.setSchemaVersion(1);

    const options = createTestOptions({ dryRun: true } as GlobalOptions & { dryRun: boolean });
    const result = await migrateCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.message).toContain('dry run');
    expect((result.data as { pendingMigrations: unknown[] }).pendingMigrations).toBeDefined();
    expect((result.data as { pendingMigrations: unknown[] }).pendingMigrations.length).toBeGreaterThan(0);

    // Verify schema version didn't change
    const backend2 = backends.track(createStorage({ path: DB_PATH, create: true }));
    expect(backend2.getSchemaVersion()).toBe(1);
  });

  test('applies pending migrations', async () => {
    // Create a database with no schema
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    backend.setSchemaVersion(0);

    const options = createTestOptions();
    const result = await migrateCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.message).toContain('Migration complete');
    expect(result.data.previousVersion).toBe(0);
    expect(result.data.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.data.migrationsApplied.length).toBeGreaterThan(0);
  });

  test('shows migration descriptions', async () => {
    // Create a database with no schema
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    backend.setSchemaVersion(0);

    const options = createTestOptions();
    const result = await migrateCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);

    // Each migration should have a version and description
    for (const migration of result.data.migrationsApplied) {
      expect(migration).toHaveProperty('version');
      expect(migration).toHaveProperty('description');
      expect(typeof migration.version).toBe('number');
      expect(typeof migration.description).toBe('string');
    }
  });

  test('reports version numbers', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const options = createTestOptions();
    const result = await migrateCommand.handler([], options);

    expect(result.data.previousVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.data.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

// ============================================================================
// Command Structure Tests
// ============================================================================

describe('doctor command structure', () => {
  test('has correct name', () => {
    expect(doctorCommand.name).toBe('doctor');
  });

  test('has description', () => {
    expect(doctorCommand.description).toBeDefined();
    expect(doctorCommand.description.length).toBeGreaterThan(0);
  });

  test('has usage', () => {
    expect(doctorCommand.usage).toBeDefined();
    expect(doctorCommand.usage).toContain('doctor');
  });

  test('has help text', () => {
    expect(doctorCommand.help).toBeDefined();
    expect(doctorCommand.help).toContain('health');
  });
});

describe('migrate command structure', () => {
  test('has correct name', () => {
    expect(migrateCommand.name).toBe('migrate');
  });

  test('has description', () => {
    expect(migrateCommand.description).toBeDefined();
    expect(migrateCommand.description.length).toBeGreaterThan(0);
  });

  test('has usage', () => {
    expect(migrateCommand.usage).toBeDefined();
    expect(migrateCommand.usage).toContain('migrate');
  });

  test('has help text', () => {
    expect(migrateCommand.help).toBeDefined();
    expect(migrateCommand.help).toContain('migration');
  });

  test('has --dry-run option', () => {
    expect(migrateCommand.options).toBeDefined();
    const dryRunOption = migrateCommand.options!.find((o) => o.name === 'dry-run');
    expect(dryRunOption).toBeDefined();
  });
});

// ============================================================================
// Doctor --fix Tests
// ============================================================================

describe('doctor --fix', () => {
  test('fixes orphaned blocked_cache entries', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create an element, add it to blocked_cache, then delete element with FK off
    const taskId = 'el-orphan-fix';
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [taskId, JSON.stringify({ title: 'Test', status: 'open', priority: 2 })]
    );
    backend.run(
      `INSERT INTO blocked_cache (element_id, blocked_by, reason) VALUES (?, ?, ?)`,
      [taskId, 'el-parent', 'Blocked by parent']
    );

    // Delete element with FK off to create orphan
    backend.run('PRAGMA foreign_keys = OFF');
    backend.run('DELETE FROM elements WHERE id = ?', [taskId]);
    backend.run('PRAGMA foreign_keys = ON');

    // Verify orphan exists
    const fkBefore = backend.query('PRAGMA foreign_key_check(blocked_cache)');
    expect(fkBefore.length).toBe(1);

    // Run doctor --fix
    const result = await doctorCommand.handler([], createTestOptions({ fix: true }));

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data.repairsApplied).toBeDefined();
    expect(result.data.repairsApplied.length).toBeGreaterThan(0);

    // Verify fix was applied
    const fkAfter = backend.query('PRAGMA foreign_key_check(blocked_cache)');
    expect(fkAfter.length).toBe(0);
  });

  test('fixes orphaned comment entries', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create a document element
    const docId = 'el-doc1';
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'document', ?, datetime('now'), datetime('now'), 'test')`,
      [docId, JSON.stringify({ title: 'Test doc', status: 'active' })]
    );

    // Create an author element, then delete it
    const authorId = 'el-author1';
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'entity', ?, datetime('now'), datetime('now'), 'test')`,
      [authorId, JSON.stringify({ name: 'Author' })]
    );

    // Create a comment referencing both
    backend.run(
      `INSERT INTO comments (id, document_id, author_id, content, anchor, created_at, updated_at)
       VALUES (?, ?, ?, 'Test comment', 'test anchor', datetime('now'), datetime('now'))`,
      ['cmt-test1', docId, authorId]
    );

    // Delete author with FK off to create orphan
    backend.run('PRAGMA foreign_keys = OFF');
    backend.run('DELETE FROM elements WHERE id = ?', [authorId]);
    backend.run('PRAGMA foreign_keys = ON');

    // Verify FK violation exists
    const fkBefore = backend.query('PRAGMA foreign_key_check(comments)');
    expect(fkBefore.length).toBe(1);

    // Run doctor --fix
    const result = await doctorCommand.handler([], createTestOptions({ fix: true }));

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data.repairsApplied).toBeDefined();

    // Verify fix
    const fkAfter = backend.query('PRAGMA foreign_key_check(comments)');
    expect(fkAfter.length).toBe(0);
  });

  test('rebuilds blocked cache after fix', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create a blocker and blocked task with a dependency
    const blockerId = 'el-blocker2';
    const blockedId = 'el-blocked2';

    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [blockerId, JSON.stringify({ title: 'Blocker', status: 'open', priority: 2 })]
    );
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [blockedId, JSON.stringify({ title: 'Blocked', status: 'open', priority: 2 })]
    );

    // Add blocks dependency
    backend.run(
      `INSERT INTO dependencies (blocked_id, blocker_id, type, created_at, created_by)
       VALUES (?, ?, 'blocks', datetime('now'), 'test')`,
      [blockedId, blockerId]
    );

    // Run doctor --fix (should rebuild cache and find the blocked task)
    const result = await doctorCommand.handler([], createTestOptions({ fix: true }));

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const rebuildRepair = result.data.repairsApplied?.find(
      (r: { name: string }) => r.name === 'rebuild_blocked_cache'
    );
    expect(rebuildRepair).toBeDefined();
    expect(rebuildRepair.rowsAffected).toBeGreaterThanOrEqual(1);

    // Verify the blocked task is now in the cache
    const cacheEntries = backend.query<{ element_id: string }>(
      'SELECT element_id FROM blocked_cache WHERE element_id = ?',
      [blockedId]
    );
    expect(cacheEntries.length).toBe(1);
  });

  test('reports no repairs when database is clean', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    const result = await doctorCommand.handler([], createTestOptions({ fix: true }));

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    // repairsApplied should contain the cache rebuild (which processes 0 elements)
    // but no FK fixes since there are no violations
    const fkRepairs = result.data.repairsApplied?.filter(
      (r: { name: string }) => r.name.startsWith('fix_fk_')
    ) ?? [];
    expect(fkRepairs.length).toBe(0);
  });

  test('updates diagnostics after fix', async () => {
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);

    // Create orphaned blocked_cache entry
    const taskId = 'el-diag-update';
    backend.run(
      `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
       VALUES (?, 'task', ?, datetime('now'), datetime('now'), 'test')`,
      [taskId, JSON.stringify({ title: 'Test', status: 'open', priority: 2 })]
    );
    backend.run(
      `INSERT INTO blocked_cache (element_id, blocked_by, reason) VALUES (?, ?, ?)`,
      [taskId, 'el-parent2', 'Blocked']
    );
    backend.run('PRAGMA foreign_keys = OFF');
    backend.run('DELETE FROM elements WHERE id = ?', [taskId]);
    backend.run('PRAGMA foreign_keys = ON');

    const result = await doctorCommand.handler([], createTestOptions({ fix: true }));

    // After fix, the FK diagnostic should show ok
    const fkDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'foreign_keys'
    );
    expect(fkDiag).toBeDefined();
    expect(fkDiag.status).toBe('ok');
    expect(fkDiag.message).toContain('fixed');

    // After fix, the blocked cache diagnostic should show ok
    const cacheDiag = result.data.diagnostics.find(
      (d: { name: string }) => d.name === 'blocked_cache'
    );
    expect(cacheDiag).toBeDefined();
    expect(cacheDiag.status).toBe('ok');
  });

  test('has --fix option defined', () => {
    expect(doctorCommand.options).toBeDefined();
    const fixOption = doctorCommand.options!.find((o) => o.name === 'fix');
    expect(fixOption).toBeDefined();
    expect(fixOption!.hasValue).toBe(false);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('admin commands integration', () => {
  test('doctor reports warning when schema is outdated', async () => {
    // Create database with old schema version
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    initializeSchema(backend);
    backend.setSchemaVersion(1);

    const options = createTestOptions();
    const result = await doctorCommand.handler([], options);

    // Should report as warning (not error, since tables are present)
    expect(result.message).toContain('behind');
    expect((result.data as { summary: { warning: number } }).summary.warning).toBeGreaterThan(0);
  });

  test('migrate fixes schema issues reported by doctor', async () => {
    // Create database with no schema
    const backend = backends.track(createStorage({ path: DB_PATH, create: true }));
    backend.setSchemaVersion(0);

    // First doctor should report problems
    const doctorBefore = await doctorCommand.handler([], createTestOptions());
    expect(doctorBefore.exitCode).toBe(ExitCode.GENERAL_ERROR);

    // Run migrate
    const migrateResult = await migrateCommand.handler([], createTestOptions());
    expect(migrateResult.exitCode).toBe(ExitCode.SUCCESS);

    // Now doctor should be happy
    const doctorAfter = await doctorCommand.handler([], createTestOptions());
    expect(doctorAfter.exitCode).toBe(ExitCode.SUCCESS);
    expect(doctorAfter.data.healthy).toBe(true);
  });
});
