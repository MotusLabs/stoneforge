import { readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYBOOK_FIXTURES, PLAYBOOK_FIXTURE_DIR } from './global-setup';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STONEFORGE_DIR = resolve(PROJECT_ROOT, '.stoneforge-test');

export default async function globalTeardown() {
  try {
    rmSync(TEST_STONEFORGE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  // Remove only the playbook fixtures created by the setup: the directory may
  // be shared with a dev server run from apps/quarry-server
  try {
    const fixtureNames = new Set(Object.keys(PLAYBOOK_FIXTURES));
    for (const entry of readdirSync(PLAYBOOK_FIXTURE_DIR)) {
      if (fixtureNames.has(entry)) {
        rmSync(resolve(PLAYBOOK_FIXTURE_DIR, entry), { force: true });
      }
    }
  } catch {
    // Directory does not exist — nothing to clean up
  }
}
