/**
 * Integration tests for the task collection endpoints' response envelopes
 * and the completed-tasks date filter / count contract (el-119bz5).
 *
 * GET /api/tasks returns a ListResult envelope — { items, total, offset,
 * limit, hasMore } — NOT a bare array. The dashboard's useCompletedTodayCount
 * hook used to call .filter() directly on that envelope (TypeError → the
 * "Completed Today" metric was permanently 0), so these tests pin the envelope
 * shape against a seeded dataset larger than one page.
 *
 * GET /api/tasks/completed filters on the COMPLETION timestamp — closedAt,
 * falling back to updated_at for tasks closed through paths that don't record
 * closedAt — applied in SQL before pagination, and reports the exact match
 * count across all pages in `total`. The tests below assert:
 * - a task closed yesterday but edited today does NOT match after=today
 *   (the old updatedAt-based filter counted it),
 * - legacy closed tasks without closedAt still count via the fallback,
 * - soft-deleted (tombstoned) closed tasks never count,
 * - walking pages with hasMore/offset sums to exactly `total`,
 * - PATCH /api/tasks/:id records closedAt on close and clears it on reopen.
 *
 * The app is created inside a temporary directory (in-memory database) to
 * keep the tests hermetic; the dataset is seeded once in beforeAll because
 * the event broadcaster is process-wide (same pattern as the playbook-routes
 * suite).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuarryApp } from './index.js';
import type { QuarryApp } from './index.js';
import { createTask } from '@stoneforge/core';
import type { Task, EntityId, Element } from '@stoneforge/core';

let originalCwd: string;
let tempRoot: string;
let quarryApp: QuarryApp;

const CREATOR = 'el-0000' as EntityId;

// ---------------------------------------------------------------------------
// Seeded dataset (sizes chosen to exceed every default page size involved:
// /api/tasks/completed defaults to 20, /api/tasks to 50)
// ---------------------------------------------------------------------------

const CLOSED_TODAY = 25;                      // closedAt + updatedAt today
const TOUCHED_TODAY_CLOSED_YESTERDAY = 3;     // closedAt yesterday, updatedAt today — must NOT count today
const LEGACY_CLOSED_TODAY = 2;                // no closedAt, updatedAt today — counts via fallback
const LEGACY_CLOSED_YESTERDAY = 1;            // no closedAt, updatedAt yesterday
const CLOSED_YESTERDAY = 30;                  // closedAt + updatedAt yesterday
const CLOSED_LAST_WEEK = 4;                   // closedAt + updatedAt 8 days ago
const OPEN_TODAY = 2;                         // not closed — never counts

const TOTAL_CLOSED = CLOSED_TODAY + TOUCHED_TODAY_CLOSED_YESTERDAY + LEGACY_CLOSED_TODAY
  + LEGACY_CLOSED_YESTERDAY + CLOSED_YESTERDAY + CLOSED_LAST_WEEK; // 65
const EXPECTED_COMPLETED_TODAY = CLOSED_TODAY + LEGACY_CLOSED_TODAY; // 27

let todayStart: Date;
let todayStartIso: string;
let yesterdayStartIso: string;
let lastWeekStartIso: string;

let touchedTodayClosedYesterdayIds: string[] = [];
let openTaskIds: string[] = [];
let deletedTodayId: string;

/** Local-calendar timestamp at hour h, minute m on the same day as `base`. */
function atLocal(base: Date, dayOffset: number, h: number, m: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d.toISOString();
}

/** Create and persist one task with fully controlled timestamps. */
async function seedTask(
  title: string,
  opts: { status: string; closedAt?: string; updatedAt: string }
): Promise<Task> {
  const task = await createTask({ title, createdBy: CREATOR });
  const shaped = {
    ...task,
    status: opts.status,
    updatedAt: opts.updatedAt,
    ...(opts.closedAt !== undefined ? { closedAt: opts.closedAt } : {}),
  } as Task;
  return quarryApp.api.create(shaped as unknown as Element & Record<string, unknown>);
}

beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = mkdtempSync(join(tmpdir(), 'sf-task-list-routes-'));
  process.chdir(tempRoot);
  quarryApp = createQuarryApp({ dbPath: ':memory:' });
  await quarryApp.ready;

  const now = new Date();
  todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  todayStartIso = todayStart.toISOString();
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStartIso = yesterdayStart.toISOString();
  const lastWeekStart = new Date(todayStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 8);
  lastWeekStartIso = lastWeekStart.toISOString();

  const TODAY_NOON = atLocal(now, 0, 12, 0);
  const TODAY_LATER = atLocal(now, 0, 14, 0);
  const YESTERDAY_NOON = atLocal(now, -1, 12, 0);
  const LAST_WEEK = atLocal(now, -8, 12, 0);

  // Closed today, canonical shape (closedAt recorded at close time)
  for (let i = 0; i < CLOSED_TODAY; i++) {
    await seedTask(`closed today #${i}`, {
      status: 'closed', closedAt: TODAY_NOON, updatedAt: TODAY_NOON,
    });
  }

  // Closed yesterday but touched today — the updatedAt-based filter counted
  // these as "completed today"; the completion-time filter must not.
  for (let i = 0; i < TOUCHED_TODAY_CLOSED_YESTERDAY; i++) {
    const t = await seedTask(`closed yesterday touched today #${i}`, {
      status: 'closed', closedAt: YESTERDAY_NOON, updatedAt: TODAY_LATER,
    });
    touchedTodayClosedYesterdayIds.push(t.id);
  }

  // Legacy closed tasks (no closedAt) — count via the updatedAt fallback
  for (let i = 0; i < LEGACY_CLOSED_TODAY; i++) {
    await seedTask(`legacy closed today #${i}`, {
      status: 'closed', updatedAt: TODAY_LATER,
    });
  }
  await seedTask('legacy closed yesterday', {
    status: 'closed', updatedAt: YESTERDAY_NOON,
  });

  for (let i = 0; i < CLOSED_YESTERDAY; i++) {
    await seedTask(`closed yesterday #${i}`, {
      status: 'closed', closedAt: YESTERDAY_NOON, updatedAt: YESTERDAY_NOON,
    });
  }
  for (let i = 0; i < CLOSED_LAST_WEEK; i++) {
    await seedTask(`closed last week #${i}`, {
      status: 'closed', closedAt: LAST_WEEK, updatedAt: LAST_WEEK,
    });
  }

  for (let i = 0; i < OPEN_TODAY; i++) {
    const t = await seedTask(`open touched today #${i}`, {
      status: 'open', updatedAt: TODAY_LATER,
    });
    openTaskIds.push(t.id);
  }

  // Closed today, then soft-deleted — never counts as completed
  const deleted = await seedTask('closed today then deleted', {
    status: 'closed', closedAt: TODAY_NOON, updatedAt: TODAY_NOON,
  });
  deletedTodayId = deleted.id;
  await quarryApp.api.delete(deletedTodayId);
});

afterAll(async () => {
  await quarryApp.stop();
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(path: string): Promise<Response> {
  return quarryApp.app.request(path, { method: 'GET' });
}

function patch(path: string, body: unknown): Promise<Response> {
  return quarryApp.app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface CompletedEnvelope {
  items: Array<{ id: string; status: string; closedAt?: string; updatedAt: string }>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/** Completion timestamp under the documented rule: closedAt ?? updatedAt. */
function completionTimestamp(t: { closedAt?: string; updatedAt: string }): string {
  return t.closedAt ?? t.updatedAt;
}

// ===========================================================================
// GET /api/tasks — ListResult envelope
// ===========================================================================

describe('GET /api/tasks envelope', () => {
  test('returns a ListResult envelope, not a bare array', async () => {
    const res = await get('/api/tasks');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;

    // The exact trap this suite exists to prevent: calling array methods on
    // the envelope. It must be an object with an items array.
    expect(Array.isArray(json)).toBe(false);
    expect(Array.isArray(json.items)).toBe(true);
    expect(typeof json.total).toBe('number');
    expect(typeof json.offset).toBe('number');
    expect(typeof json.limit).toBe('number');
    expect(typeof json.hasMore).toBe('boolean');
  });

  test('total is the exact match count even when items is one page of many', async () => {
    // Seeded dataset: 65 closed + 2 open = 67 live tasks, default page 50.
    const res = await get('/api/tasks');
    const json = await res.json() as { items: unknown[]; total: number; offset: number; limit: number; hasMore: boolean };

    expect(json.items.length).toBe(50);
    expect(json.total).toBe(TOTAL_CLOSED + OPEN_TODAY);
    expect(json.offset).toBe(0);
    expect(json.limit).toBe(50);
    expect(json.hasMore).toBe(true);

    // A client that needs ALL tasks must page (or read total): the first
    // page alone under-reports by the tail.
    const allRes = await get('/api/tasks?limit=10000');
    const allJson = await allRes.json() as { items: unknown[]; total: number; hasMore: boolean };
    expect(allJson.items.length).toBe(TOTAL_CLOSED + OPEN_TODAY);
    expect(allJson.hasMore).toBe(false);
  });
});

// ===========================================================================
// GET /api/tasks/completed — envelope + exact count
// ===========================================================================

describe('GET /api/tasks/completed', () => {
  test('returns { items, total, offset, limit, hasMore } with exact total', async () => {
    const res = await get('/api/tasks/completed');
    expect(res.status).toBe(200);
    const json = await res.json() as CompletedEnvelope;

    expect(Array.isArray(json.items)).toBe(true);
    // Default page is 20; the seeded dataset has 65 closed tasks.
    expect(json.items.length).toBe(20);
    expect(json.total).toBe(TOTAL_CLOSED);
    expect(json.hasMore).toBe(true);
    expect(json.offset).toBe(0);
    expect(json.limit).toBe(20);
    for (const t of json.items) {
      expect(t.status).toBe('closed');
    }
  });

  test('after=todayStart reports the exact completed-today count across all pages', async () => {
    const res = await get(`/api/tasks/completed?after=${encodeURIComponent(todayStartIso)}&limit=1`);
    expect(res.status).toBe(200);
    const json = await res.json() as CompletedEnvelope;

    // The number a dashboard "Completed Today" tile reads: exact even though
    // the page holds a single item.
    expect(json.total).toBe(EXPECTED_COMPLETED_TODAY);
    expect(json.items.length).toBe(1);
    expect(json.hasMore).toBe(true);
  });

  test('after filters on the completion timestamp, not the last edit', async () => {
    const res = await get(`/api/tasks/completed?after=${encodeURIComponent(todayStartIso)}&limit=10000`);
    expect(res.status).toBe(200);
    const json = await res.json() as CompletedEnvelope;

    expect(json.total).toBe(EXPECTED_COMPLETED_TODAY);
    expect(json.items.length).toBe(EXPECTED_COMPLETED_TODAY);
    expect(json.hasMore).toBe(false);

    const ids = new Set(json.items.map((t) => t.id));

    // Every returned task's completion timestamp is inside today
    for (const t of json.items) {
      expect(completionTimestamp(t) >= todayStartIso).toBe(true);
    }

    // Closed yesterday but edited today: NOT completed today
    for (const id of touchedTodayClosedYesterdayIds) {
      expect(ids.has(id)).toBe(false);
    }

    // Open tasks touched today and the soft-deleted task: never counted
    for (const id of openTaskIds) {
      expect(ids.has(id)).toBe(false);
    }
    expect(ids.has(deletedTodayId)).toBe(false);
  });

  test('after=yesterdayStart includes yesterday completions but not last week', async () => {
    const res = await get(`/api/tasks/completed?after=${encodeURIComponent(yesterdayStartIso)}&limit=1`);
    const json = await res.json() as CompletedEnvelope;

    expect(json.total).toBe(TOTAL_CLOSED - CLOSED_LAST_WEEK);

    const lastWeekRes = await get(`/api/tasks/completed?after=${encodeURIComponent(lastWeekStartIso)}&limit=1`);
    const lastWeekJson = await lastWeekRes.json() as CompletedEnvelope;
    expect(lastWeekJson.total).toBe(TOTAL_CLOSED);
  });

  test('walking pages with offset sums to exactly total', async () => {
    const seen: string[] = [];
    let offset = 0;
    let hasMore = true;
    let pages = 0;

    while (hasMore) {
      const res = await get(`/api/tasks/completed?after=${encodeURIComponent(todayStartIso)}&limit=10&offset=${offset}`);
      expect(res.status).toBe(200);
      const json = await res.json() as CompletedEnvelope;
      seen.push(...json.items.map((t) => t.id));
      hasMore = json.hasMore;
      offset += json.items.length;
      pages += 1;
      expect(pages).toBeLessThan(20); // guard against an infinite walk
    }

    expect(seen.length).toBe(EXPECTED_COMPLETED_TODAY);
    expect(new Set(seen).size).toBe(EXPECTED_COMPLETED_TODAY); // no dupes across pages
  });

  test('rejects a non-ISO after parameter with 400', async () => {
    const res = await get('/api/tasks/completed?after=not-a-date');
    expect(res.status).toBe(400);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });
});

// ===========================================================================
// PATCH /api/tasks/:id — closedAt bookkeeping (runs last: mutates the seed)
// ===========================================================================

describe('PATCH /api/tasks/:id closedAt bookkeeping', () => {
  test('closing via PATCH records closedAt and the task counts as completed today', async () => {
    const target = openTaskIds[0];
    const res = await patch(`/api/tasks/${target}`, { status: 'closed' });
    expect(res.status).toBe(200);
    const updated = await res.json() as Task & { closedAt?: string };
    expect(updated.status).toBe('closed');
    expect(typeof updated.closedAt).toBe('string');

    const listRes = await get(`/api/tasks/completed?after=${encodeURIComponent(todayStartIso)}&limit=10000`);
    const list = await listRes.json() as CompletedEnvelope;
    const occurrences = list.items.filter((t) => t.id === target).length;
    expect(occurrences).toBe(1);
    expect(list.total).toBe(EXPECTED_COMPLETED_TODAY + 1);
  });

  test('editing a closed task does not move its completion timestamp', async () => {
    const target = openTaskIds[0]; // closed by the previous test
    const beforeRes = await get(`/api/tasks/${target}`);
    const before = await beforeRes.json() as Task & { closedAt?: string };

    const res = await patch(`/api/tasks/${target}`, { title: 'retitled after close' });
    expect(res.status).toBe(200);
    const after = await res.json() as Task & { closedAt?: string };
    expect(after.closedAt).toBe(before.closedAt);
    expect(after.updatedAt >= (before.updatedAt as string)).toBe(true);

    // Still counted exactly once
    const listRes = await get(`/api/tasks/completed?after=${encodeURIComponent(todayStartIso)}&limit=10000`);
    const list = await listRes.json() as CompletedEnvelope;
    expect(list.items.filter((t) => t.id === target).length).toBe(1);
  });

  test('reopening clears closedAt and the task no longer counts', async () => {
    const target = openTaskIds[0];
    const res = await patch(`/api/tasks/${target}`, { status: 'open' });
    expect(res.status).toBe(200);
    const after = await res.json() as Task & { closedAt?: string };
    expect(after.closedAt).toBeUndefined();

    const listRes = await get(`/api/tasks/completed?after=${encodeURIComponent(todayStartIso)}&limit=10000`);
    const list = await listRes.json() as CompletedEnvelope;
    expect(list.items.some((t) => t.id === target)).toBe(false);
    expect(list.total).toBe(EXPECTED_COMPLETED_TODAY);
  });
});

// ===========================================================================
// PATCH /api/tasks/bulk — closedAt bookkeeping (shared-routes handler)
// ===========================================================================

describe('PATCH /api/tasks/bulk closedAt bookkeeping', () => {
  test('bulk close records closedAt per task and never leaks it across the batch', async () => {
    const now = new Date();
    const todayNoon = atLocal(now, 0, 12, 0);
    const yesterdayNoon = atLocal(now, -1, 12, 0);

    // One task that bulk-close transitions into closed, one that was already
    // closed yesterday with its own closedAt. Sending status:'closed' for both
    // must set closedAt on the first and leave the second's untouched — the
    // per-task copy matters because the handler loops with one updates object.
    const toClose = await seedTask('bulk close target', { status: 'open', updatedAt: todayNoon });
    const alreadyClosed = await seedTask('bulk already closed', {
      status: 'closed', closedAt: yesterdayNoon, updatedAt: yesterdayNoon,
    });

    const res = await patch('/api/tasks/bulk', {
      ids: [toClose.id, alreadyClosed.id],
      updates: { status: 'closed' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { updated: number; failed: number };
    expect(json.updated).toBe(2);
    expect(json.failed).toBe(0);

    const closedA = await (await get(`/api/tasks/${toClose.id}`)).json() as Task & { closedAt?: string };
    expect(closedA.status).toBe('closed');
    expect(typeof closedA.closedAt).toBe('string');

    const closedB = await (await get(`/api/tasks/${alreadyClosed.id}`)).json() as Task & { closedAt?: string };
    expect(closedB.closedAt).toBe(yesterdayNoon); // not overwritten by the batch
  });
});
