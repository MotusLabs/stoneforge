/**
 * Stats Command Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { statsCommand } from './stats.js';
import { createCommand } from './crud.js';
import type { GlobalOptions } from '../types.js';
import { ExitCode } from '../types.js';

// ============================================================================
// Test Utilities
// ============================================================================

// Scratch workspace lives in the OS temp dir (NOT next to the sources) so an
// interrupted run — crash, CI timeout, Ctrl+C — can never leave a
// __test_stats_workspace__ artifact with a test database inside src/.
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

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  // Fresh isolated workspace per test, in the OS temp dir
  TEST_DIR = mkdtempSync(join(tmpdir(), 'stoneforge-stats-test-'));
  STONEFORGE_DIR = join(TEST_DIR, '.stoneforge');
  DB_PATH = join(STONEFORGE_DIR, 'stoneforge.db');
  mkdirSync(STONEFORGE_DIR, { recursive: true });
});

afterEach(() => {
  // Cleanup test workspace
  if (TEST_DIR && existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Stats Command Tests
// ============================================================================

describe('stats command', () => {
  test('shows statistics for empty database', async () => {
    // Initialize database by creating and then deleting a task
    const createOpts = createTestOptions({ title: 'Temp' } as GlobalOptions & { title: string });
    const createResult = await createCommand.handler(['task'], createOpts);
    expect(createResult.exitCode).toBe(ExitCode.SUCCESS);

    const options = createTestOptions();
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data).toBeDefined();
    expect(typeof result.data).toBe('object');
    expect(result.data).toHaveProperty('totalElements');
    expect(result.data).toHaveProperty('elementsByType');
    expect(result.data).toHaveProperty('totalDependencies');
    expect(result.data).toHaveProperty('databaseSize');
  });

  test('counts tasks correctly', async () => {
    // Create some tasks
    const createOpts = createTestOptions({ title: 'Task 1' } as GlobalOptions & { title: string });
    await createCommand.handler(['task'], createOpts);
    await createCommand.handler(['task'], { ...createOpts, title: 'Task 2' } as GlobalOptions & { title: string });
    await createCommand.handler(['task'], { ...createOpts, title: 'Task 3' } as GlobalOptions & { title: string });

    const options = createTestOptions();
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data.totalElements).toBeGreaterThanOrEqual(3);
    expect(result.data.elementsByType.task).toBe(3);
  });

  test('shows ready and blocked task counts', async () => {
    // Create a task
    const createOpts = createTestOptions({ title: 'Task' } as GlobalOptions & { title: string });
    await createCommand.handler(['task'], createOpts);

    const options = createTestOptions();
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data).toHaveProperty('readyTasks');
    expect(result.data).toHaveProperty('blockedTasks');
    // A new task should be ready (not blocked)
    expect(result.data.readyTasks).toBeGreaterThanOrEqual(1);
  });

  test('shows database size', async () => {
    // Initialize database
    const createOpts = createTestOptions({ title: 'Task' } as GlobalOptions & { title: string });
    await createCommand.handler(['task'], createOpts);

    const options = createTestOptions();
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data.databaseSize).toBeGreaterThan(0);
  });

  test('returns JSON in JSON mode', async () => {
    // Initialize database
    const createOpts = createTestOptions({ title: 'Task' } as GlobalOptions & { title: string });
    await createCommand.handler(['task'], createOpts);

    const options = createTestOptions({ json: true });
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.data).toBeDefined();
    expect(typeof result.data).toBe('object');
  });

  test('fails when database does not exist', async () => {
    // Point to non-existent database
    const nonExistentPath = join(TEST_DIR, 'nonexistent', 'test.db');
    const options = createTestOptions({ db: nonExistentPath });
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.error).toContain('No database found');
  });

  test('includes human-readable output message', async () => {
    // Initialize database
    const createOpts = createTestOptions({ title: 'Task' } as GlobalOptions & { title: string });
    await createCommand.handler(['task'], createOpts);

    const options = createTestOptions();
    const result = await statsCommand.handler([], options);

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.message).toContain('Workspace Statistics');
    expect(result.message).toContain('Elements:');
    expect(result.message).toContain('Tasks:');
    expect(result.message).toContain('Storage:');
  });
});

// ============================================================================
// Command Structure Tests
// ============================================================================

describe('stats command structure', () => {
  test('has correct name', () => {
    expect(statsCommand.name).toBe('stats');
  });

  test('has description', () => {
    expect(statsCommand.description).toBeDefined();
    expect(statsCommand.description.length).toBeGreaterThan(0);
  });

  test('has usage', () => {
    expect(statsCommand.usage).toBeDefined();
    expect(statsCommand.usage).toContain('stats');
  });

  test('has help text', () => {
    expect(statsCommand.help).toBeDefined();
    expect(statsCommand.help).toContain('statistics');
  });
});
