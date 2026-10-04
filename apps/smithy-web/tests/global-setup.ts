/**
 * Playwright globalSetup for test data seeding and Vite warmup.
 *
 * Note: The .stoneforge-test directory and database schema are created by
 * setup-test-db.ts which runs before the webServer starts. This ensures
 * the DB exists before the server needs it.
 *
 * globalSetup focuses on seeding test data (e.g., the operator entity) and
 * warming the Vite dev server so parallel workers do not race the first
 * on-demand transform of the route module graph (see tests/warm-vite.ts).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';
import { createStorageAsync, initializeSchema } from '@stoneforge/storage';
import { createQuarryAPI } from '@stoneforge/quarry';
import { ElementType, createTimestamp, EntityTypeValue } from '@stoneforge/core';
import { warmViteDevServer } from './warm-vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STONEFORGE_DIR = resolve(PROJECT_ROOT, '.stoneforge-test');
const TEST_DB_PATH = resolve(TEST_STONEFORGE_DIR, 'stoneforge.db');

export default async function globalSetup(config: FullConfig) {
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

  // Warm the Vite dev server's transform cache before workers spawn, so the
  // first parallel page.goto() per worker is not racing the cold first
  // transform of the route module graph (30s navigation-timeout flake family).
  const baseURL =
    config.projects.map((p) => p.use?.baseURL).find((u): u is string => !!u) ??
    config.use?.baseURL;
  if (!baseURL) {
    throw new Error('globalSetup: no project defines use.baseURL; cannot warm Vite dev server');
  }
  await warmViteDevServer(baseURL, __dirname);
}
