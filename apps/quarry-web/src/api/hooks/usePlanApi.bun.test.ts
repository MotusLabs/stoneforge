/**
 * Unit tests for fetchAvailableTasks (the queryFn behind useAvailableTasks).
 *
 * Regression (el-3etj44): the hook used to call `.filter()` directly on the
 * parsed GET /api/tasks response — but that endpoint returns the ListResult
 * envelope `{ items, total, offset, limit, hasMore }`, never a bare array, so
 * the hook threw a TypeError and the plan task picker never showed any tasks.
 *
 * Every fixture below is the REAL response shape (an envelope, multi-page
 * where noted), never a hand-rolled bare array — a bare-array mock would pass
 * against the broken code and prove nothing.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { fetchAvailableTasks } from './usePlanApi';
import type { TaskType } from '../../routes/plans/types';

/** Build a minimal task element (only the fields the hook reads). */
function task(id: string, title: string): TaskType {
  return {
    id,
    type: 'task',
    title,
    status: 'open',
    priority: 3,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    createdBy: 'test',
    tags: [],
  } as TaskType;
}

/** One page of GET /api/tasks in the exact ListResult shape the server sends. */
function tasksPage(items: TaskType[], hasMore: boolean, offset: number, limit: number) {
  return {
    items,
    total: offset + items.length + (hasMore ? 1 : 0),
    offset,
    limit,
    hasMore,
  };
}

/** Bare Task[] — the documented shape of GET /api/plans/:id/tasks. */
function planTasksResponse(tasks: TaskType[]) {
  return { ok: true, json: async () => tasks } as Response;
}

const originalFetch = globalThis.fetch;
const fetchCalls: string[] = [];

/** Route fetch: envelope pages for /api/tasks (served in order), bare array for /api/plans/:id/tasks. */
function stubFetch(options: {
  pages: ReturnType<typeof tasksPage>[];
  planTasks?: TaskType[];
}) {
  fetchCalls.length = 0;
  let tasksPageCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    if (url.startsWith('/api/tasks')) {
      // Pages are consumed in walk order; the last page repeats if the walk
      // (incorrectly) keeps asking for more.
      const page = options.pages[Math.min(tasksPageCount, options.pages.length - 1)];
      tasksPageCount++;
      return { ok: true, json: async () => page } as Response;
    }
    if (url.includes('/tasks') && url.includes('/api/plans/')) {
      return planTasksResponse(options.planTasks ?? []);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchAvailableTasks', () => {
  test('unwraps the ListResult envelope and excludes tasks already in the plan', async () => {
    // This exact fixture threw TypeError under the old code (.filter on the
    // envelope object) — the test fails on the broken hook, not just passes
    // on the fixed one.
    const inPlan = task('el-t1', 'Already in plan');
    const free1 = task('el-t2', 'Free task one');
    const free2 = task('el-t3', 'Free task two');

    stubFetch({
      pages: [tasksPage([inPlan, free1, free2], false, 0, 500)],
      planTasks: [inPlan],
    });

    const available = await fetchAvailableTasks('el-plan1', '');

    expect(available.map(t => t.id)).toEqual(['el-t2', 'el-t3']);
    expect(fetchCalls).toContain('/api/plans/el-plan1/tasks');
  });

  test('walks every page until hasMore is false', async () => {
    // Two pages: page 2 exists only because hasMore=true on page 1 — a
    // single-page fetch would silently miss el-p2-*.
    const page1 = [task('el-p1-a', 'Page one A'), task('el-p1-b', 'Page one B')];
    const page2 = [task('el-p2-a', 'Page two A'), task('el-p2-b', 'Page two B')];

    stubFetch({
      pages: [
        tasksPage(page1, true, 0, 500),
        tasksPage(page2, false, 2, 500),
      ],
    });

    const available = await fetchAvailableTasks('el-plan2', '');

    expect(available.map(t => t.id)).toEqual(['el-p1-a', 'el-p1-b', 'el-p2-a', 'el-p2-b']);
    // The second request must continue where page 1 ended.
    expect(fetchCalls[1]).toBe('/api/tasks?limit=500&offset=2');
  });

  test('filters by title or ID substring, case-insensitively', async () => {
    const byTitle = task('el-s1', 'Refactor the Widget loader');
    const byId = task('el-widget-9', 'Unrelated title');
    const neither = task('el-s3', 'Something else');

    stubFetch({
      pages: [tasksPage([byTitle, byId, neither], false, 0, 500)],
    });

    const available = await fetchAvailableTasks('el-plan3', 'WIDGET');

    expect(available.map(t => t.id)).toEqual(['el-s1', 'el-widget-9']);
  });

  test('caps the result list at 50 picker rows', async () => {
    const many = Array.from({ length: 60 }, (_, i) => task(`el-c${i}`, `Capped task ${i}`));
    stubFetch({ pages: [tasksPage(many, false, 0, 500)] });

    const available = await fetchAvailableTasks('el-plan4', '');

    expect(available).toHaveLength(50);
    expect(available[0].id).toBe('el-c0');
    expect(available[49].id).toBe('el-c49');
  });

  test('fails loudly when the envelope has no items array — never returns an empty list', async () => {
    // A missing `items` means the contract changed. Returning [] here would
    // render an empty picker that looks like "no available tasks" (el-49ra:
    // do not convert a loud failure into a silently wrong list).
    fetchCalls.length = 0;
    globalThis.fetch = (async () => {
      return { ok: true, json: async () => ({ total: 7, offset: 0, limit: 500, hasMore: false }) } as Response;
    }) as unknown as typeof fetch;

    expect(fetchAvailableTasks('el-plan5', '')).rejects.toThrow(
      'GET /api/tasks did not return the { items, ... } ListResult envelope'
    );
  });

  test('rejects on a non-ok tasks response', async () => {
    fetchCalls.length = 0;
    globalThis.fetch = (async () => {
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    expect(fetchAvailableTasks('el-plan6', '')).rejects.toThrow('Failed to fetch tasks');
  });

  test('returns [] immediately when no plan is selected', async () => {
    stubFetch({ pages: [tasksPage([], false, 0, 500)] });

    expect(await fetchAvailableTasks(null, '')).toEqual([]);
    expect(fetchCalls).toHaveLength(0);
  });
});
