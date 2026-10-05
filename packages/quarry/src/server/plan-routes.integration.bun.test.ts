/**
 * Integration test for the shared-routes plan route factory
 * (`createPlanRoutes`) wired to a real QuarryAPI + InboxService.
 *
 * Lives in @stoneforge/quarry for the same cycle-avoidance reason as the
 * document-routes suite: shared-routes must not depend on quarry.
 *
 * The concurrent-creation regression test pins the fix for el-37nk0u:
 * transient 500/409 responses from POST /api/plans under parallel clients.
 * Root cause: the route called element factories (createPlan, createTask)
 * WITHOUT api.getIdGeneratorConfig(), so IDs were fixed 4-char base36
 * hashes with no collision check. Once the database accumulated enough
 * elements (birthday bound at 36^4 ≈ 1.7M), INSERTs hit UNIQUE violations
 * that surfaced as 500s (or a misleading 409 "Task is already in another
 * plan"). Passing the config makes generation use the adaptive hash length
 * and retry on collisions.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import { createQuarryAPI, InboxService } from '@stoneforge/quarry';
import type { QuarryAPI } from '@stoneforge/quarry';
import { createPlanRoutes } from '@stoneforge/shared-routes';

let backend: StorageBackend;
let api: QuarryAPI;
let app: ReturnType<typeof createPlanRoutes>;

beforeEach(() => {
  backend = createStorage({ path: ':memory:' });
  initializeSchema(backend);
  api = createQuarryAPI(backend);
  const inboxService = new InboxService(backend);
  inboxService.initSchema();
  app = createPlanRoutes({ api, inboxService, storageBackend: backend });
});

afterEach(() => {
  if (backend.isOpen) backend.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seeds `count` minimal task rows directly via SQL.
 *
 * Bulk-inserting raw rows (instead of api.create) keeps the test fast while
 * still driving the element count that IdLengthCache.observe() reads — the
 * count selects the adaptive ID hash length (length 5 once ≥ 500 elements).
 */
function seedElements(count: number): void {
  backend.transaction((tx) => {
    for (let i = 0; i < count; i++) {
      tx.run(
        `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
         VALUES (?, 'task', ?, ?, ?, 'el-0000')`,
        [
          `el-seed${i}`,
          JSON.stringify({ title: `seed ${i}`, status: 'open', priority: 3 }),
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ]
      );
    }
  });
}

function postPlan(title: string): Promise<Response> {
  return app.request('/api/plans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      createdBy: 'el-0000',
      status: 'draft',
      initialTask: { title: `initial task for ${title}` },
    }),
  });
}

// ---------------------------------------------------------------------------
// POST /api/plans — happy path
// ---------------------------------------------------------------------------

describe('POST /api/plans', () => {
  test('creates a plan with an initial task and returns 201', async () => {
    const res = await postPlan('simple plan');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { type: string; title: string; initialTask: { id: string } };
    expect(body.type).toBe('plan');
    expect(body.title).toBe('simple plan');
    expect(body.initialTask.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// el-37nk0u regression: concurrent plan creation on a populated database
// ---------------------------------------------------------------------------

describe('POST /api/plans under concurrency (el-37nk0u)', () => {
  test('concurrent creates on a populated DB all succeed with collision-checked adaptive-length IDs', async () => {
    // ≥500 elements puts the adaptive ID length at 5 (LENGTH_THRESHOLDS in
    // @stoneforge/core). Without getIdGeneratorConfig() the factories always
    // generated 4-char IDs regardless of element count, and every create
    // risked an unchecked UNIQUE collision.
    seedElements(600);

    const CONCURRENT = 32;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => postPlan(`parallel plan ${i}`))
    );

    const bodies = await Promise.all(responses.map((r) => r.json()));

    // Every concurrent create must succeed — no 500s (UNIQUE violation) and
    // no 409s (the misleading "Task is already in another plan" mapping).
    for (let i = 0; i < CONCURRENT; i++) {
      expect(responses[i].status).toBe(201);
    }

    // IDs must come from the adaptive config: hash length ≥ 5 at this
    // element count (fixed 4 pre-fix), and all plan IDs unique.
    const planIds = bodies.map((b) => (b as { id: string }).id);
    for (const id of planIds) {
      expect(id).toMatch(/^el-[0-9a-z]{5,8}$/);
    }
    expect(new Set(planIds).size).toBe(CONCURRENT);

    // The initial tasks created inside the same route must also be unique.
    const taskIds = bodies.map((b) => (b as { initialTask: { id: string } }).initialTask.id);
    expect(new Set(taskIds).size).toBe(CONCURRENT);
    for (const id of taskIds) {
      expect(id).toMatch(/^el-[0-9a-z]{5,8}$/);
    }
  });

  test('GET /api/plans lists everything created by the concurrent storm', async () => {
    seedElements(600);

    const CONCURRENT = 16;
    await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) => postPlan(`listed plan ${i}`))
    );

    const res = await app.request('/api/plans');
    expect(res.ok).toBe(true);
    const plans = (await res.json()) as Array<{ id: string; title: string }>;
    const titles = new Set(plans.map((p) => p.title));
    for (let i = 0; i < CONCURRENT; i++) {
      expect(titles.has(`listed plan ${i}`)).toBe(true);
    }
  });
});
