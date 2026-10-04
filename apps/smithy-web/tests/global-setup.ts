/**
 * Playwright globalSetup for test data seeding.
 *
 * Note: The .stoneforge-test directory and database schema are created by
 * setup-test-db.ts which runs before the webServer starts. This ensures
 * the DB exists before the server needs it.
 *
 * globalSetup focuses on seeding test data (e.g., the operator entity).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageAsync, initializeSchema } from '@stoneforge/storage';
import { createQuarryAPI } from '@stoneforge/quarry';
import { ElementType, createTimestamp, EntityTypeValue } from '@stoneforge/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STONEFORGE_DIR = resolve(PROJECT_ROOT, '.stoneforge-test');
const TEST_DB_PATH = resolve(TEST_STONEFORGE_DIR, 'stoneforge.db');

/**
 * Block until the Playwright headless-shell build this suite spawns is fully
 * provisioned in the shared browsers directory. After a pod restart the build
 * is absent (the browsers directory lives on the container overlay) and the
 * first run must re-install it; without this gate a suite can spawn the
 * browser while another process is still extracting it and die with ETXTBSY
 * or V8 snapshot errors before any test executes. See
 * scripts/ensure-playwright-browsers.mjs and runbook doc el-2423ix.
 */
function ensureBrowsers(): void {
  const result = spawnSync(
    process.execPath,
    [resolve(PROJECT_ROOT, 'scripts/ensure-playwright-browsers.mjs'), '--only-shell'],
    { cwd: resolve(PROJECT_ROOT, 'apps/smithy-web'), encoding: 'utf8', timeout: 20 * 60_000 }
  );
  if (result.status !== 0) {
    throw new Error(
      `Browser provisioning failed (exit ${result.status}):\n${result.stderr || result.error}`
    );
  }
}

export default async function globalSetup() {
  ensureBrowsers();

  // Ensure directory exists (may already be created by setup-test-db.ts)
  mkdirSync(TEST_STONEFORGE_DIR, { recursive: true });

  // Connect to the database (schema may already be initialized by setup-test-db.ts)
  const backend = await createStorageAsync({ path: TEST_DB_PATH, create: true });
  initializeSchema(backend);
  const api = createQuarryAPI(backend);

  // Create default operator entity (same as `sf init`)
  // Use try-catch in case it already exists from a previous run
  const now = createTimestamp();
  try {
    await api.create({
      id: 'el-0000',
      type: ElementType.ENTITY,
      createdAt: now,
      updatedAt: now,
      createdBy: 'el-0000',
      tags: [],
      metadata: {},
      name: 'operator',
      entityType: EntityTypeValue.HUMAN,
    });
  } catch (error) {
    // Ignore if already exists - this can happen if reusing test DB
    const existing = await api.get('el-0000');
    if (!existing) {
      throw error;
    }
  }
}
