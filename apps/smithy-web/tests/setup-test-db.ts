/**
 * Pre-server setup script for Playwright tests.
 *
 * This script runs BEFORE the orchestrator-server starts to ensure the
 * .stoneforge-test directory and database exist. This fixes a race condition
 * where Playwright may start webServer processes before globalSetup runs.
 *
 * globalSetup still handles seeding test data (e.g., the operator entity).
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage, initializeSchema } from '@stoneforge/storage';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STONEFORGE_DIR = resolve(PROJECT_ROOT, '.stoneforge-test');
const TEST_DB_PATH = resolve(TEST_STONEFORGE_DIR, 'stoneforge.db');
const TEST_CONFIG_PATH = resolve(TEST_STONEFORGE_DIR, 'config.yaml');

// Create directory if it doesn't exist
mkdirSync(TEST_STONEFORGE_DIR, { recursive: true });

// Test workspace configuration. Mirrors the repo's tracked
// .stoneforge/config.yaml (so the server sees the same sync/identity settings
// an interactive run would) plus a CONFIGURED workflow preset. The preset is
// required: with no preset, the first-load PresetSelectionModal on /activity
// is a hard, undismissable overlay that blocks every click in the app; with a
// preset, the only remaining first-run gate is the onboarding tour, which
// tests dismiss via the stoneforge:onboarding-complete localStorage key.
// Regenerated on every run so the server never inherits stale mutations
// (e.g. a workflow-preset PUT from a previous run).
writeFileSync(TEST_CONFIG_PATH, `# E2E test workspace configuration (regenerated each run by setup-test-db.ts)
actor: el-1k0b
database: stoneforge.db
sync:
  auto_export: true
  export_debounce: 1000
  elements_file: elements.jsonl
  dependencies_file: dependencies.jsonl
playbooks:
  paths:
    - playbooks
identity:
  mode: soft
workflow:
  preset: auto
`, 'utf8');
console.log('[setup-test-db] Test config written to:', TEST_CONFIG_PATH);

// Initialize DB schema if it doesn't exist
if (!existsSync(TEST_DB_PATH)) {
  try {
    const backend = createStorage({ path: TEST_DB_PATH, create: true });
    initializeSchema(backend);
    backend.close();
  } catch (error) {
    // If we get an error, another process may have already created it
    // This is fine - the DB is now ready
    if (!existsSync(TEST_DB_PATH)) {
      throw error;
    }
  }
}

console.log('[setup-test-db] Test database ready at:', TEST_DB_PATH);
