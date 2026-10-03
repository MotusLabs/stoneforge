import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STONEFORGE_DIR = resolve(PROJECT_ROOT, '.stoneforge-test');
const TEST_DB_PATH = resolve(TEST_STONEFORGE_DIR, 'stoneforge.db');

export default async function globalSetup() {
  // Playwright loads this hook under Node, which resolves workspace exports to dist.
  // Build before importing them so a fresh pnpm checkout needs no prebuilt output.
  const packages = ['core', 'storage', 'shared-routes', 'quarry'];
  if (packages.some((name) => !existsSync(resolve(PROJECT_ROOT, 'packages', name, 'dist/index.js')))) {
    execFileSync('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@stoneforge/quarry...', '--force'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
  }
  const { createStorage, initializeSchema } = await import('@stoneforge/storage');
  const { createQuarryAPI } = await import('@stoneforge/quarry');
  const { ElementType, createTimestamp, EntityTypeValue } = await import('@stoneforge/core');
  mkdirSync(TEST_STONEFORGE_DIR, { recursive: true });

  const backend = createStorage({ path: TEST_DB_PATH, create: true });
  initializeSchema(backend);
  const api = createQuarryAPI(backend);

  // Create default operator entity (same as `sf init`)
  const now = createTimestamp();
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
}
