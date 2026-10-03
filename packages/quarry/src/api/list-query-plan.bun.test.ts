/**
 * listPaginated query plan tests
 *
 * listPaginated used to emit `SELECT DISTINCT e.* ... ORDER BY <col> LIMIT ?`,
 * which SQLite plans as "SEARCH ... USING INDEX idx_elements_type | USE TEMP
 * B-TREE FOR DISTINCT | USE TEMP B-TREE FOR ORDER BY". Both temp b-trees are
 * built over the *entire* match set before LIMIT is applied, so a fixed page
 * still cost O(n) in table size.
 *
 * These tests pin the fix: no DISTINCT without a tag join, an ordering the
 * ordering indexes can serve directly, and no COUNT pass for callers that only
 * want items (list()).
 *
 * Ordering contract (clarified by the Director for this task — see decision
 * log el-2mnn98): every ordering now ends with an explicit rowid tiebreaker in
 * the SAME direction as orderDir (`ORDER BY <col> <dir>, rowid <dir>`). The
 * order of tied rows was never defined behavior before this change (it fell out
 * of whichever plan SQLite picked), so it is NOT reproduced; what must hold is:
 *  1. when sort keys differ, results/ordering/page membership match the old
 *     query exactly,
 *  2. the full unpaginated result set for any filter is identical (same rows),
 *  3. ties are broken by the explicit deterministic tiebreaker, so pagination
 *     is stable (no row skipped or repeated across pages).
 *
 * Multi-tag AND filters (el-4x5w6t): `tags: [a, b]` means elements with ALL of
 * the tags. The SQL used to join `t.tag IN (a, b)` — which proves only ONE tag
 * is present — then apply LIMIT/OFFSET to that too-wide set and re-check the
 * AND in JavaScript afterwards. Pages came back short or empty (the LIMIT had
 * already consumed rows that the post-filter then dropped), later pages held
 * matches the earlier ones skipped, and COUNT/hasMore counted the too-wide set.
 * The fix compiles each required tag to a correlated EXISTS in SQL, ahead of
 * LIMIT and COUNT; the multi-tag suite below pins full pages, exact totals and
 * lossless page walks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { QuarryAPIImpl, buildListQuery } from './quarry-api.js';
import { createStorage, initializeSchema, MIGRATIONS } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import type { ElementId, Element, Task } from '@stoneforge/core';

// ============================================================================
// Helpers
// ============================================================================

interface Fixture {
  id: string;
  type?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
  title?: string;
}

/**
 * Insert an element row directly so tests control created_at/updated_at
 * exactly (including ties, which the ordering tests depend on).
 */
function insertElement(backend: StorageBackend, fixture: Fixture): void {
  const type = fixture.type ?? 'task';
  const data = JSON.stringify({
    title: fixture.title ?? `Title ${fixture.id}`,
    status: 'open',
    metadata: {},
  });
  backend.run(
    `INSERT INTO elements (id, type, data, content_hash, created_at, updated_at, created_by, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.id,
      type,
      data,
      null,
      fixture.createdAt,
      fixture.updatedAt ?? fixture.createdAt,
      'user:plan-test',
      fixture.deletedAt ?? null,
    ]
  );
}

/** Millisecond timestamps counting up from a fixed base, so ties are explicit. */
function ts(ms: number): string {
  return new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
}

type ListFilter = Parameters<typeof buildListQuery>[0];

/** EXPLAIN QUERY PLAN detail lines for a built list query. */
function planFor(backend: StorageBackend, filter: ListFilter): string[] {
  const query = buildListQuery(filter);
  return backend
    .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql}`, [...query.params, query.limit, query.offset])
    .map((row) => row.detail);
}

/** True when the plan materializes a temp b-tree (for DISTINCT or ORDER BY). */
function usesTempBTree(details: string[]): boolean {
  return details.some((d) => d.includes('USE TEMP B-TREE'));
}

// ============================================================================
// Tests
// ============================================================================

describe('listPaginated query plan', () => {
  let backend: StorageBackend;
  let api: QuarryAPIImpl;

  beforeEach(() => {
    backend = createStorage({ path: ':memory:' });
    initializeSchema(backend);
    api = new QuarryAPIImpl(backend);

    // Enough rows that the planner has real scale to reason about
    for (let i = 0; i < 120; i++) {
      insertElement(backend, {
        id: `el-plan${String(i).padStart(4, '0')}`,
        createdAt: ts(i * 10),
        deletedAt: i % 30 === 29 ? ts(i * 10) : null,
      });
    }
    // A second type so single-type filters are genuinely selective
    for (let i = 0; i < 20; i++) {
      insertElement(backend, {
        id: `el-plandoc${String(i).padStart(4, '0')}`,
        type: 'document',
        createdAt: ts(i * 10),
      });
    }
  });

  afterEach(() => {
    if (backend.isOpen) {
      backend.close();
    }
  });

  describe('temp b-tree elimination', () => {
    it('reads a type-filtered page straight from the ordering index', () => {
      const details = planFor(backend, { type: 'task', limit: 50 });

      expect(usesTempBTree(details)).toBe(false);
      expect(details.join('\n')).toContain('idx_elements_type_created_at');
    });

    it('serves the no-type-filter default path from an index', () => {
      const details = planFor(backend, { limit: 50 });

      expect(usesTempBTree(details)).toBe(false);
      expect(details.join('\n')).toContain('idx_elements_deleted_at_created_at');
    });

    it('serves orderBy updated_at from the ordering index', () => {
      const details = planFor(backend, { type: 'task', orderBy: 'updated_at', limit: 50 });

      expect(usesTempBTree(details)).toBe(false);
      expect(details.join('\n')).toContain('idx_elements_type_updated_at');
    });

    it('serves orderBy updated_at with no type filter from the ordering index', () => {
      const details = planFor(backend, { orderBy: 'updated_at', limit: 50 });

      expect(usesTempBTree(details)).toBe(false);
      expect(details.join('\n')).toContain('idx_elements_deleted_at_updated_at');
    });

    it('serves a multi-type filter without sorting', () => {
      const details = planFor(backend, { type: ['task', 'document'], limit: 50 });

      expect(usesTempBTree(details)).toBe(false);
    });

    it('serves the unfiltered includeDeleted path from an index (both columns)', () => {
      // No type filter AND deleted rows included: no leading equality term at
      // all, so this falls back to the single-column timestamp indexes.
      const created = planFor(backend, { includeDeleted: true, limit: 50 });
      const updated = planFor(backend, { includeDeleted: true, orderBy: 'updated_at', limit: 50 });

      expect(usesTempBTree(created)).toBe(false);
      expect(created.join('\n')).toContain('idx_elements_created_at');
      expect(usesTempBTree(updated)).toBe(false);
      expect(updated.join('\n')).toContain('idx_elements_updated_at');
    });

    it('serves timestamp-range filters without sorting', () => {
      const createdRange = planFor(backend, {
        createdAfter: ts(300),
        createdBefore: ts(800),
        limit: 50,
      });
      const updatedRange = planFor(backend, {
        orderBy: 'updated_at',
        updatedAfter: ts(300),
        updatedBefore: ts(800),
        limit: 50,
      });
      const rangeWithType = planFor(backend, {
        type: 'task',
        createdAfter: ts(300),
        limit: 50,
      });
      const rangeIncludeDeleted = planFor(backend, {
        includeDeleted: true,
        orderBy: 'updated_at',
        updatedAfter: ts(300),
        limit: 50,
      });

      expect(usesTempBTree(createdRange)).toBe(false);
      expect(usesTempBTree(updatedRange)).toBe(false);
      expect(usesTempBTree(rangeWithType)).toBe(false);
      expect(usesTempBTree(rangeIncludeDeleted)).toBe(false);
    });

    it('serves every direction/column combination without sorting', () => {
      // One ordering index per column pair serves BOTH directions: the rowid
      // tiebreaker mirrors the query direction, so a forward scan satisfies
      // `col ASC, rowid ASC` and a backward scan of the same index satisfies
      // `col DESC, rowid DESC`.
      const combinations: Array<{ orderBy: string; orderDir: string }> = [
        { orderBy: 'created_at', orderDir: 'desc' },
        { orderBy: 'created_at', orderDir: 'asc' },
        { orderBy: 'updated_at', orderDir: 'desc' },
        { orderBy: 'updated_at', orderDir: 'asc' },
      ];

      for (const c of combinations) {
        const withType = planFor(backend, { type: 'task', orderBy: c.orderBy, orderDir: c.orderDir, limit: 50 });
        const noType = planFor(backend, { orderBy: c.orderBy, orderDir: c.orderDir, limit: 50 });
        const includeDeleted = planFor(backend, {
          includeDeleted: true,
          orderBy: c.orderBy,
          orderDir: c.orderDir,
          limit: 50,
        });

        expect(usesTempBTree(withType), `type-filtered ${c.orderBy} ${c.orderDir}`).toBe(false);
        expect(usesTempBTree(noType), `unfiltered ${c.orderBy} ${c.orderDir}`).toBe(false);
        expect(usesTempBTree(includeDeleted), `includeDeleted ${c.orderBy} ${c.orderDir}`).toBe(false);
      }
    });
  });

  describe('DISTINCT handling', () => {
    it('omits DISTINCT when there is no tag join (elements.id is unique)', () => {
      const query = buildListQuery({ type: 'task', limit: 50 });

      expect(query.hasTagJoin).toBe(false);
      expect(query.sql).toContain('SELECT e.*');
      expect(query.sql).not.toContain('DISTINCT');
    });

    it('keeps DISTINCT when a tag join can fan rows out', () => {
      const query = buildListQuery({ type: 'task', tagsAny: ['alpha'], limit: 50 });

      expect(query.hasTagJoin).toBe(true);
      expect(query.sql).toContain('SELECT DISTINCT e.*');
      expect(query.countSql).toContain('COUNT(DISTINCT e.id)');
    });

    it('counts with COUNT(*) when there is no tag join', () => {
      const query = buildListQuery({ type: 'task' });

      expect(query.countSql).toContain('COUNT(*)');
      expect(query.countSql).not.toContain('COUNT(DISTINCT');
    });

    it('states the same-direction rowid tiebreaker on every path', () => {
      // The tiebreaker applies to every ordering the same way — joined or not,
      // timestamp or JSON column — so pagination is deterministic everywhere.
      expect(buildListQuery({ type: 'task' }).sql).toContain('ORDER BY e.created_at DESC, e.rowid DESC');
      expect(buildListQuery({ type: 'task', orderDir: 'asc' }).sql).toContain(
        'ORDER BY e.created_at ASC, e.rowid ASC'
      );
      expect(buildListQuery({ type: 'task', orderBy: 'updated_at' }).sql).toContain(
        'ORDER BY e.updated_at DESC, e.rowid DESC'
      );
      expect(buildListQuery({ type: 'task', orderBy: 'title', orderDir: 'asc' }).sql).toContain(
        "ORDER BY JSON_EXTRACT(e.data, '$.title') ASC, e.rowid ASC"
      );
      expect(buildListQuery({ type: 'task', tagsAny: ['alpha'], orderDir: 'asc' }).sql).toContain(
        'ORDER BY e.created_at ASC, e.rowid ASC'
      );
    });
  });

  describe('COUNT pass', () => {
    /** Record every SQL statement the API issues. */
    function recordQueries(): string[] {
      const statements: string[] = [];
      const originalQueryOne = backend.queryOne.bind(backend);
      const originalQuery = backend.query.bind(backend);
      (backend as { queryOne: typeof backend.queryOne }).queryOne = ((sql: string, params?: unknown[]) => {
        statements.push(sql);
        return originalQueryOne(sql, params);
      }) as typeof backend.queryOne;
      (backend as { query: typeof backend.query }).query = ((sql: string, params?: unknown[]) => {
        statements.push(sql);
        return originalQuery(sql, params);
      }) as typeof backend.query;
      return statements;
    }

    it('list() does not run a COUNT query', async () => {
      const statements = recordQueries();
      const items = await api.list<Task>({ type: 'task', limit: 50 });

      expect(items.length).toBe(50);
      expect(statements.some((sql) => sql.includes('COUNT('))).toBe(false);
      // ...but the rows query still ran
      expect(statements.some((sql) => sql.includes('SELECT'))).toBe(true);
    });

    it('listPaginated() runs COUNT and reports exact totals', async () => {
      const statements = recordQueries();
      const result = await api.listPaginated<Task>({ type: 'task', limit: 50 });

      expect(statements.some((sql) => sql.includes('COUNT('))).toBe(true);
      // 120 tasks, every 30th (i % 30 === 29) soft-deleted -> 116 live
      expect(result.total).toBe(116);
      expect(result.hasMore).toBe(true);
    });

    it('listPaginated() reports hasMore=false on the last page', async () => {
      const result = await api.listPaginated<Task>({ type: 'task', limit: 50, offset: 100 });

      expect(result.items.length).toBe(16);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('results and ordering', () => {
    it('pages identical items in the same order as sorting the whole set', async () => {
      const paged: Task[] = [];
      let offset = 0;
      for (;;) {
        const page = await api.listPaginated<Task>({ type: 'task', limit: 30, offset });
        paged.push(...page.items);
        if (!page.hasMore) break;
        offset += 30;
      }

      const expected = await api.list<Task>({ type: 'task', orderBy: 'created_at', orderDir: 'desc' });
      expect(paged.map((t) => t.id)).toEqual(expected.map((t) => t.id));

      // Independent check: newest created_at first, deleted rows excluded
      const createdAt = paged.map((t) => t.createdAt);
      const sortedDesc = [...createdAt].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      expect(createdAt).toEqual(sortedDesc);
      expect(paged.length).toBe(116);
    });

    it('returns the same items for tag filters as before (SQL-side filtering)', async () => {
      for (let i = 0; i < 120; i++) {
        backend.run(`INSERT INTO tags (element_id, tag) VALUES (?, ?)`, [
          `el-plan${String(i).padStart(4, '0')}`,
          i % 2 === 0 ? 'alpha' : 'beta',
        ]);
      }

      const items = await api.list<Task>({ type: 'task', tags: ['alpha'], limit: 50 });
      expect(items.length).toBe(50);
      expect(items.every((t) => t.tags.includes('alpha'))).toBe(true);

      const anyTag = await api.list<Task>({ type: 'task', tagsAny: ['beta'], limit: 50 });
      expect(anyTag.every((t) => t.tags.includes('beta'))).toBe(true);
    });

    it('breaks timestamp ties with the same-direction rowid tiebreaker', async () => {
      const shared = ts(999_999);
      for (const id of ['el-tie-a', 'el-tie-b', 'el-tie-c']) {
        insertElement(backend, { id, createdAt: shared });
      }

      // Tied rows come back oldest-inserted-first for asc queries and
      // newest-inserted-first for desc queries. Tie order was never defined
      // before the ordering indexes landed (it depended on the plan), so this
      // is the NEW explicit contract, not a reproduction of the old behavior.
      const asc = await api.list<Task>({ type: 'task', limit: 1000, offset: 0, orderDir: 'asc' });
      const ascTies = asc.filter((t) => t.createdAt === shared).map((t) => t.id);
      expect(ascTies).toEqual(['el-tie-a', 'el-tie-b', 'el-tie-c']);

      const desc = await api.list<Task>({ type: 'task', limit: 1000, offset: 0, orderDir: 'desc' });
      const descTies = desc.filter((t) => t.createdAt === shared).map((t) => t.id);
      expect(descTies).toEqual(['el-tie-c', 'el-tie-b', 'el-tie-a']);
    });

    it('never skips or repeats rows sharing a timestamp across pages', async () => {
      // A block of same-timestamp rows larger than the page size, so a page
      // boundary falls inside the tie block in both directions.
      const shared = ts(999_999);
      const tieIds: string[] = [];
      for (let i = 0; i < 7; i++) {
        const id = `el-page-tie-${i}`;
        tieIds.push(id);
        insertElement(backend, { id, createdAt: shared });
      }

      for (const orderDir of ['asc', 'desc'] as const) {
        const paged: string[] = [];
        let offset = 0;
        for (;;) {
          const page = await api.listPaginated<Task>({ type: 'task', limit: 3, offset, orderDir });
          paged.push(...page.items.map((t) => t.id));
          if (!page.hasMore) break;
          offset += 3;
        }

        // The tie block survives pagination intact: same members, in the same
        // relative order as the one-shot query, nothing duplicated or dropped.
        const expected = [...tieIds];
        if (orderDir === 'desc') expected.reverse();
        expect(paged.filter((id) => tieIds.includes(id)), `orderDir=${orderDir}`).toEqual(expected);
        expect(new Set(paged).size).toBe(paged.length);
      }
    });

    it('still honors includeDeleted', async () => {
      const live = await api.listPaginated<Element>({ type: 'task', limit: 1000 });
      const withDeleted = await api.listPaginated<Element>({ type: 'task', includeDeleted: true, limit: 1000 });

      expect(live.total).toBe(116);
      expect(withDeleted.total).toBe(120);
    });
  });

  // --------------------------------------------------------------------------
  // Multi-tag AND filters (el-4x5w6t)
  //
  // `tags: [a, b]` must return elements with ALL of the tags, and the AND must
  // hold in SQL — before LIMIT/OFFSET and before COUNT. The old query joined
  // `t.tag IN (a, b)` (ANY of the tags), paginated that too-wide set, and only
  // then re-checked the AND in JavaScript, so pages came back short or empty
  // and total/hasMore counted the too-wide set.
  // --------------------------------------------------------------------------

  describe('multi-tag AND filter', () => {
    /**
     * Tag layout over the 120 seeded tasks (newest created_at last). The rows
     * visible to a 2-tag AND filter deliberately interleave: the ten AND
     * matches sit at the OLD end of created_at, most rows carry only 'alpha',
     * and a tail carries only 'beta'. Under the old ANY-match SQL + post-filter
     * this is the worst case: the first desc pages slice rows that the
     * post-filter then drops, so page 1 came back EMPTY despite ten matches.
     */
    const BOTH_TAGGED = Array.from({ length: 10 }, (_, i) => `el-plan${String(i).padStart(4, '0')}`);

    beforeEach(() => {
      for (let i = 0; i < 120; i++) {
        const tags: string[] =
          i < 10 ? ['alpha', 'beta'] : i < 110 ? ['alpha'] : ['beta'];
        for (const tag of tags) {
          backend.run(`INSERT INTO tags (element_id, tag) VALUES (?, ?)`, [
            `el-plan${String(i).padStart(4, '0')}`,
            tag,
          ]);
        }
      }
    });

    it('compiles each required tag to a correlated EXISTS ahead of LIMIT and COUNT', () => {
      const query = buildListQuery({ type: 'task', tags: ['alpha', 'beta'], limit: 7 });

      // One EXISTS per required tag, no tags join: rows cannot fan out, so no
      // DISTINCT and a plain COUNT(*) are correct.
      expect(query.sql.match(/EXISTS \(SELECT 1 FROM tags req/g)?.length).toBe(2);
      expect(query.sql).not.toContain('JOIN tags');
      expect(query.sql).toContain('SELECT e.*');
      expect(query.sql).not.toContain('DISTINCT');
      expect(query.hasTagJoin).toBe(false);
      expect(query.countSql).toContain('COUNT(*)');
      expect(query.countSql).not.toContain('COUNT(DISTINCT');
      expect(query.countSql).toContain('EXISTS');
      expect(query.params).toEqual(['task', 'alpha', 'beta']);
    });

    it('serves single- and multi-tag pages without temp b-trees', () => {
      // EXISTS correlates instead of fanning rows out, so tag pages keep the
      // ordering-index scan el-2wfmlz introduced (the pre-el-4x5w6t join form
      // needed a DISTINCT temp b-tree here).
      const single = planFor(backend, { type: 'task', tags: ['alpha'], limit: 50 });
      expect(usesTempBTree(single)).toBe(false);
      expect(single.join('\n')).toContain('idx_elements_type_created_at');

      const multi = planFor(backend, { type: 'task', tags: ['alpha', 'beta'], limit: 50 });
      expect(usesTempBTree(multi)).toBe(false);
      expect(multi.join('\n')).toContain('idx_elements_type_created_at');
    });

    it('returns full pages with exact total/hasMore when most rows match only one tag', async () => {
      const page1 = await api.listPaginated<Task>({ type: 'task', tags: ['alpha', 'beta'], limit: 7, offset: 0 });

      // The old behavior returned an EMPTY first page here: LIMIT consumed
      // seven 'beta'-only rows (newest) that the JS post-filter then dropped.
      expect(page1.items.length).toBe(7);
      expect(page1.items.every((t) => t.tags.includes('alpha') && t.tags.includes('beta'))).toBe(true);
      expect(page1.total).toBe(10);
      expect(page1.hasMore).toBe(true);

      const page2 = await api.listPaginated<Task>({ type: 'task', tags: ['alpha', 'beta'], limit: 7, offset: 7 });
      expect(page2.items.length).toBe(3);
      expect(page2.total).toBe(10);
      expect(page2.hasMore).toBe(false);

      // Offsets past the match set stay empty without inventing hasMore
      const past = await api.listPaginated<Task>({ type: 'task', tags: ['alpha', 'beta'], limit: 7, offset: 14 });
      expect(past.items).toEqual([]);
      expect(past.total).toBe(10);
      expect(past.hasMore).toBe(false);
    });

    it('walks every AND match across pages exactly once, in both directions', async () => {
      for (const orderDir of ['asc', 'desc'] as const) {
        const expected = [...BOTH_TAGGED];
        if (orderDir === 'desc') expected.reverse();

        const walked: string[] = [];
        const pageSizes: number[] = [];
        let offset = 0;
        for (;;) {
          const page = await api.listPaginated<Task>({
            type: 'task',
            tags: ['alpha', 'beta'],
            limit: 7,
            offset,
            orderDir,
          });
          pageSizes.push(page.items.length);
          walked.push(...page.items.map((t) => t.id));
          if (!page.hasMore) break;
          offset += 7;
        }

        // Every match exactly once — none skipped, none repeated — in the
        // deterministic order (created_at values are distinct in this fixture).
        expect(walked, `orderDir=${orderDir}`).toEqual(expected);
        expect(new Set(walked).size).toBe(walked.length);
        // All pages except the last are full
        expect(pageSizes[pageSizes.length - 1]).toBe(3);
        expect(pageSizes.slice(0, -1).every((n) => n === 7)).toBe(true);
      }
    });

    it('agrees between list(), listPaginated() items and COUNT', async () => {
      const oneShot = await api.list<Task>({ type: 'task', tags: ['alpha', 'beta'], limit: 1000 });
      const paged = await api.listPaginated<Task>({ type: 'task', tags: ['alpha', 'beta'], limit: 1000 });

      expect(oneShot.map((t) => t.id).sort()).toEqual([...BOTH_TAGGED].sort());
      expect(paged.items.map((t) => t.id).sort()).toEqual(oneShot.map((t) => t.id).sort());
      expect(paged.total).toBe(oneShot.length);

      // The COUNT pass itself counts the AND set, not the ANY set (120 rows
      // carry at least one of the two tags; only 10 carry both).
      const query = buildListQuery({ type: 'task', tags: ['alpha', 'beta'] });
      const countRow = backend.queryOne<{ count: number }>(query.countSql!, query.params);
      expect(countRow?.count).toBe(10);
    });

    it('requires three tags when three are given', async () => {
      backend.run(`INSERT INTO tags (element_id, tag) VALUES (?, ?)`, ['el-plan0000', 'gamma']);
      // Only el-plan0000 has all three
      const result = await api.listPaginated<Task>({
        type: 'task',
        tags: ['alpha', 'beta', 'gamma'],
        limit: 5,
      });

      expect(result.items.map((t) => t.id)).toEqual(['el-plan0000']);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it('returns an empty page (not a wrong-count page) when no element has all tags', async () => {
      const result = await api.listPaginated<Task>({
        type: 'task',
        tags: ['alpha', 'missing-tag'],
        limit: 7,
      });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('combines tags (AND) with tagsAny (OR) as an AND of the two conditions', async () => {
      backend.run(`INSERT INTO tags (element_id, tag) VALUES (?, ?)`, ['el-plan0000', 'gamma']);
      backend.run(`INSERT INTO tags (element_id, tag) VALUES (?, ?)`, ['el-plan0100', 'gamma']);

      // Must have alpha AND beta, and at least one of gamma/delta.
      // el-plan0000 (alpha, beta, gamma) matches; the other nine both-tagged
      // rows lack gamma/delta; el-plan0100 has gamma but only 'alpha'.
      const result = await api.listPaginated<Task>({
        type: 'task',
        tags: ['alpha', 'beta'],
        tagsAny: ['gamma', 'delta'],
        limit: 10,
      });

      expect(result.items.map((t) => t.id)).toEqual(['el-plan0000']);
      expect(result.total).toBe(1);
    });
  });
});

// ============================================================================
// Regression vs the pre-optimization query
// ============================================================================
//
// The original implementation ran `SELECT DISTINCT e.* ... ORDER BY <col> <dir>
// LIMIT ? OFFSET ?` against the pre-migration-13 index set (migrations 1-12).
//
// Per the Director's clarification of this task's ordering criterion, "results
// and ordering must stay identical" means:
//  1. when sort keys DIFFER, results, ordering and page membership match the
//     old query exactly — pinned by the distinct-key suite below, which runs
//     the old query against the old index set and the new query against the
//     current schema over fixtures with no duplicate sort keys, in both
//     directions and at every pagination boundary;
//  2. the full unpaginated result set for any filter is identical (same rows,
//     nothing missing or duplicated) — pinned by the tie suite, whose fixtures
//     deliberately collide timestamps within and across types;
//  3. ties are broken by the explicit `<col> <dir>, rowid <dir>` tiebreaker,
//     so the new order is deterministic and pagination is stable — pinned by
//     recomputing the expected order in JS and by walking pages.
//
// The old query's tie order is NOT asserted: it was never defined behavior and
// differed by path (a stable temp-b-tree sort fed by a rowid-ordered scan on
// type-filtered paths, a reversed index scan on unfiltered includeDeleted
// paths), which is exactly why reproducing it is not part of the contract.
describe('ordering regression vs the pre-optimization query', () => {
  /** Number of migrations that existed before the ordering indexes. */
  const PRE_ORDERING_INDEX_VERSION = 12;

  function makeBackend(migrationCount: number): StorageBackend {
    const backend = createStorage({ path: ':memory:' });
    backend.migrate([...MIGRATIONS].slice(0, migrationCount));
    return backend;
  }

  /**
   * Reconstruct the exact row query the API issued before this change:
   * DISTINCT (always), no explicit tiebreaker, ordering straight on the column.
   * Derived from buildListQuery's output so WHERE clauses, joins and bound
   * parameters are guaranteed to be identical between the two sides.
   */
  function oldQuery(filter: ListFilter): ReturnType<typeof buildListQuery> & { oldSql: string } {
    const query = buildListQuery(filter);
    const oldSql = query.sql
      .replace('SELECT e.*', 'SELECT DISTINCT e.*')
      .replace(/ORDER BY (.+) (ASC|DESC), e\.rowid (?:ASC|DESC)/, 'ORDER BY $1 $2');
    if (oldSql === query.sql) throw new Error('oldQuery transform failed');
    return { ...query, oldSql };
  }

  function runIds(backend: StorageBackend, sql: string, params: unknown[]): string[] {
    return backend.query<{ id: string }>(sql, params).map((r) => r.id);
  }

  // --------------------------------------------------------------------------
  // Suite A: distinct sort keys — results must match the old query exactly
  // --------------------------------------------------------------------------

  /**
   * Every row has a unique created_at, a unique updated_at and a unique title,
   * so no ordering in this suite has ties and old/new sequences must be
   * byte-identical (criterion 1), including page membership.
   */
  const DISTINCT_KEY_FIXTURES: Fixture[] = [
    { id: 'd-a', type: 'task', createdAt: ts(10), updatedAt: ts(310) },
    { id: 'd-b', type: 'task', createdAt: ts(20), updatedAt: ts(290) },
    { id: 'd-c', type: 'message', createdAt: ts(30), updatedAt: ts(280) },
    { id: 'd-d', type: 'document', createdAt: ts(40), updatedAt: ts(270) },
    { id: 'd-e', type: 'task', createdAt: ts(50), updatedAt: ts(260), deletedAt: ts(90) },
    { id: 'd-f', type: 'message', createdAt: ts(60), updatedAt: ts(250) },
    { id: 'd-g', type: 'task', createdAt: ts(70), updatedAt: ts(240) },
    { id: 'd-h', type: 'document', createdAt: ts(80), updatedAt: ts(230) },
    { id: 'd-i', type: 'task', createdAt: ts(90), updatedAt: ts(220) },
    { id: 'd-j', type: 'message', createdAt: ts(100), updatedAt: ts(210), deletedAt: ts(140) },
    { id: 'd-k', type: 'task', createdAt: ts(110), updatedAt: ts(200) },
    { id: 'd-l', type: 'document', createdAt: ts(120), updatedAt: ts(190) },
    { id: 'd-m', type: 'task', createdAt: ts(130), updatedAt: ts(180) },
    { id: 'd-n', type: 'message', createdAt: ts(140), updatedAt: ts(170) },
  ];

  /** Filter shapes compared old-vs-new; mirrors buildWhereClause output. */
  const COMPARISON_CASES: Array<{ name: string; filter: Record<string, unknown> }> = [
    { name: 'single type', filter: { type: 'task' } },
    { name: 'single type, includeDeleted', filter: { type: 'task', includeDeleted: true } },
    { name: 'no type filter', filter: {} },
    { name: 'no type filter, includeDeleted', filter: { includeDeleted: true } },
    { name: 'multi type', filter: { type: ['task', 'message'] } },
    { name: 'multi type, includeDeleted', filter: { type: ['task', 'message'], includeDeleted: true } },
    { name: 'createdBy', filter: { type: 'task', createdBy: 'user:plan-test' } },
    {
      name: 'created range',
      filter: { createdAfter: ts(35), createdBefore: ts(115) },
    },
    {
      name: 'updated range',
      filter: { updatedAfter: ts(195), updatedBefore: ts(285) },
    },
    {
      name: 'type + created range',
      filter: { type: 'task', createdAfter: ts(35), createdBefore: ts(115) },
    },
    {
      name: 'includeDeleted + updated range',
      filter: { includeDeleted: true, updatedAfter: ts(195), updatedBefore: ts(285) },
    },
  ];

  describe('distinct sort keys: identical pages in both directions at every boundary', () => {
    let oldBackend: StorageBackend;
    let newBackend: StorageBackend;

    beforeEach(() => {
      oldBackend = makeBackend(PRE_ORDERING_INDEX_VERSION);
      newBackend = makeBackend(MIGRATIONS.length);
      for (const f of DISTINCT_KEY_FIXTURES) {
        insertElement(oldBackend, f);
        insertElement(newBackend, f);
      }
    });

    afterEach(() => {
      if (oldBackend.isOpen) oldBackend.close();
      if (newBackend.isOpen) newBackend.close();
    });

    for (const c of COMPARISON_CASES) {
      for (const orderBy of ['created_at', 'updated_at', 'title'] as const) {
        for (const orderDir of ['asc', 'desc'] as const) {
          it(`old === new: ${c.name} / ${orderBy} ${orderDir}`, () => {
            const n = DISTINCT_KEY_FIXTURES.length;
            for (let offset = 0; offset <= n + 1; offset++) {
              for (const limit of [1, 2, 3, n + 5]) {
                const query = oldQuery({ ...c.filter, orderBy, orderDir, limit, offset } as ListFilter);

                const oldIds = runIds(oldBackend, query.oldSql, [...query.params, limit, offset]);
                const newIds = runIds(newBackend, query.sql, [...query.params, limit, offset]);

                expect(
                  newIds,
                  `${c.name} / ${orderBy} ${orderDir} limit=${limit} offset=${offset} — old produced ${JSON.stringify(oldIds)}`
                ).toEqual(oldIds);
              }
            }
          });
        }
      }
    }
  });

  // --------------------------------------------------------------------------
  // Suite B: ties everywhere — same row set, same key order, deterministic
  // --------------------------------------------------------------------------

  interface TieFixture {
    id: string;
    type: string;
    createdMs: number;
    updatedMs: number;
    deleted?: boolean;
    createdBy?: string;
    tags?: string[];
  }

  /**
   * Ties everywhere: several rows share created_at within a type, across
   * types, and at the very edges of the set. updated_at is a different
   * permutation so ordering by it exercises a genuinely different sequence.
   */
  const TIE_FIXTURES: TieFixture[] = [
    { id: 'tie-a', type: 'task', createdMs: 100, updatedMs: 100, tags: ['alpha'] },
    { id: 'tie-b', type: 'task', createdMs: 100, updatedMs: 400 },
    { id: 'tie-c', type: 'task', createdMs: 100, updatedMs: 100, tags: ['alpha', 'beta'] },
    { id: 'tie-d', type: 'message', createdMs: 100, updatedMs: 100 },
    { id: 'tie-e', type: 'task', createdMs: 200, updatedMs: 200, tags: ['alpha'] },
    { id: 'tie-f', type: 'message', createdMs: 100, updatedMs: 300 },
    { id: 'tie-g', type: 'task', createdMs: 200, updatedMs: 100 },
    { id: 'tie-h', type: 'document', createdMs: 50, updatedMs: 50 },
    { id: 'tie-i', type: 'task', createdMs: 300, updatedMs: 300, tags: ['alpha'] },
    { id: 'tie-j', type: 'document', createdMs: 100, updatedMs: 100 },
    { id: 'tie-k', type: 'task', createdMs: 100, updatedMs: 100, deleted: true, tags: ['alpha'] },
    { id: 'tie-l', type: 'message', createdMs: 50, updatedMs: 50, createdBy: 'someone-else' },
  ];

  /** Filter shapes for the tie suite, with a JS mirror for expected rows. */
  const TIE_CASES: Array<{
    name: string;
    filter: Record<string, unknown>;
    matches: (f: TieFixture) => boolean;
  }> = [
    { name: 'single type', filter: { type: 'task' }, matches: (f) => f.type === 'task' && !f.deleted },
    { name: 'single type, includeDeleted', filter: { type: 'task', includeDeleted: true }, matches: (f) => f.type === 'task' },
    { name: 'no type filter', filter: {}, matches: (f) => !f.deleted },
    { name: 'no type filter, includeDeleted', filter: { includeDeleted: true }, matches: () => true },
    {
      name: 'multi type',
      filter: { type: ['task', 'message'] },
      matches: (f) => (f.type === 'task' || f.type === 'message') && !f.deleted,
    },
    {
      name: 'createdBy',
      filter: { type: 'task', createdBy: 'user:plan-test' },
      matches: (f) => f.type === 'task' && !f.deleted && !f.createdBy,
    },
    {
      name: 'created range',
      filter: { createdAfter: ts(100), createdBefore: ts(250) },
      matches: (f) => !f.deleted && f.createdMs >= 100 && f.createdMs < 250,
    },
    {
      name: 'updated range',
      filter: { updatedAfter: ts(100), updatedBefore: ts(250) },
      matches: (f) => !f.deleted && f.updatedMs >= 100 && f.updatedMs < 250,
    },
    {
      name: 'tag filter',
      filter: { type: 'task', tags: ['alpha'] },
      matches: (f) => f.type === 'task' && !f.deleted && (f.tags ?? []).includes('alpha'),
    },
  ];

  describe('ties: same row set and key order, explicit deterministic tiebreaker', () => {
    let oldBackend: StorageBackend;
    let newBackend: StorageBackend;
    /** rowid (insertion) order of the fixtures, as SQLite sees them. */
    let insertIndex: Map<string, number>;

    beforeEach(() => {
      oldBackend = makeBackend(PRE_ORDERING_INDEX_VERSION);
      newBackend = makeBackend(MIGRATIONS.length);
      for (const be of [oldBackend, newBackend]) {
        for (const f of TIE_FIXTURES) {
          insertElement(be, {
            id: f.id,
            type: f.type,
            createdAt: ts(f.createdMs),
            updatedAt: ts(f.updatedMs),
            deletedAt: f.deleted ? ts(f.createdMs) : null,
          });
          if (f.createdBy) {
            be.run(`UPDATE elements SET created_by = ? WHERE id = ?`, [f.createdBy, f.id]);
          }
          for (const tag of f.tags ?? []) {
            be.run(`INSERT INTO tags (element_id, tag) VALUES (?, ?)`, [f.id, tag]);
          }
        }
      }
      insertIndex = new Map(
        newBackend.query<{ id: string }>(`SELECT id FROM elements ORDER BY rowid`).map((r, i) => [r.id, i])
      );
    });

    afterEach(() => {
      if (oldBackend.isOpen) oldBackend.close();
      if (newBackend.isOpen) newBackend.close();
    });

    /** The expected sequence under the new contract: (sort key, rowid) both in orderDir. */
    function expectedNewOrder(
      testCase: (typeof TIE_CASES)[number],
      orderBy: 'created_at' | 'updated_at',
      orderDir: 'asc' | 'desc'
    ): string[] {
      const sign = orderDir === 'asc' ? 1 : -1;
      const key = (f: TieFixture) => ts(orderBy === 'created_at' ? f.createdMs : f.updatedMs);
      return TIE_FIXTURES.filter(testCase.matches)
        .map((f) => ({ id: f.id, key: key(f), row: insertIndex.get(f.id) ?? -1 }))
        .sort((a, b) => {
          const byKey = (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * sign;
          if (byKey !== 0) return byKey;
          return (a.row - b.row) * sign;
        })
        .map((r) => r.id);
    }

    for (const c of TIE_CASES) {
      for (const orderBy of ['created_at', 'updated_at'] as const) {
        for (const orderDir of ['asc', 'desc'] as const) {
          it(`same set and key order: ${c.name} / ${orderBy} ${orderDir}`, () => {
            const filter = { ...c.filter, orderBy, orderDir, limit: TIE_FIXTURES.length + 5 } as ListFilter;
            const query = oldQuery(filter);

            const oldIds = runIds(oldBackend, query.oldSql, [...query.params, query.limit, 0]);
            const newIds = runIds(newBackend, query.sql, [...query.params, query.limit, 0]);

            // Criterion 2: same rows, nothing missing or duplicated.
            expect(newIds.length, 'full result length').toBe(oldIds.length);
            expect([...newIds].sort(), 'full result row set').toEqual([...oldIds].sort());
            expect(new Set(newIds).size).toBe(newIds.length);

            // The sort-KEY sequence is identical — ordering itself did not
            // change, only the arrangement within tied keys.
            const keyOf = (id: string) => {
              const f = TIE_FIXTURES.find((x) => x.id === id)!;
              return ts(orderBy === 'created_at' ? f.createdMs : f.updatedMs);
            };
            expect(newIds.map(keyOf), 'sort-key sequence').toEqual(oldIds.map(keyOf));

            // Criterion 3: the new order is exactly (sort key, rowid) in the
            // query's direction.
            expect(newIds, 'explicit tiebreaker order').toEqual(expectedNewOrder(c, orderBy, orderDir));

            // Criterion 3, page stability: page boundaries never skip or repeat
            // a tied row — walking pages reproduces the one-shot sequence.
            const PAGE = 3;
            const walked: string[] = [];
            for (let offset = 0; ; offset += PAGE) {
              const page = buildListQuery({ ...filter, limit: PAGE, offset } as ListFilter);
              const ids = runIds(newBackend, page.sql, [...page.params, page.limit, page.offset]);
              walked.push(...ids);
              if (ids.length < PAGE) break;
            }
            expect(walked, 'page walk equals one-shot sequence').toEqual(newIds);

            // Per-page sort-key sequence also matches the old query at every
            // boundary (page membership can differ only within tied keys).
            for (let offset = 0; offset <= TIE_FIXTURES.length + 1; offset++) {
              for (const limit of [1, 2, 3]) {
                const q = oldQuery({ ...filter, limit, offset } as ListFilter);
                const oldPage = runIds(oldBackend, q.oldSql, [...q.params, limit, offset]);
                const newPage = runIds(newBackend, q.sql, [...q.params, limit, offset]);
                expect(newPage.map(keyOf), `page keys limit=${limit} offset=${offset}`).toEqual(oldPage.map(keyOf));
              }
            }
          });
        }
      }
    }

    it('breaks ties in a JSON (non-timestamp) ordering the same way', () => {
      // Non-timestamp orderings always sort in a temp b-tree, but the explicit
      // tiebreaker still applies: three tasks sharing a title come back in
      // rowid order for asc and reversed for desc.
      const be = makeBackend(MIGRATIONS.length);
      try {
        const shared = 'Same title';
        for (const id of ['json-a', 'json-b', 'json-c']) {
          insertElement(be, { id, createdAt: ts(500), title: shared });
        }
        for (let i = 0; i < 5; i++) {
          insertElement(be, { id: `json-x${i}`, createdAt: ts(600 + i), title: `Other ${i}` });
        }

        for (const orderDir of ['asc', 'desc'] as const) {
          const query = buildListQuery({ type: 'task', orderBy: 'title', orderDir, limit: 20 });
          const ids = runIds(be, query.sql, [...query.params, query.limit, query.offset]);
          const ties = ids.filter((id) => ['json-a', 'json-b', 'json-c'].includes(id));
          expect(ties, `orderDir=${orderDir}`).toEqual(
            orderDir === 'asc' ? ['json-a', 'json-b', 'json-c'] : ['json-c', 'json-b', 'json-a']
          );
        }
      } finally {
        be.close();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Guards: prove the old side of the comparison is the real pre-change query
  // --------------------------------------------------------------------------

  describe('comparison guards (no tautology)', () => {
    it('the old query on the old schema runs the old materializing plan', () => {
      const oldBackend = makeBackend(PRE_ORDERING_INDEX_VERSION);
      try {
        const details = oldBackend
          .query<{ detail: string }>(
            `EXPLAIN QUERY PLAN SELECT DISTINCT e.* FROM elements e WHERE e.type = 'task' AND e.deleted_at IS NULL ORDER BY e.created_at ASC LIMIT 10 OFFSET 0`
          )
          .map((r) => r.detail);

        expect(details.join('\n')).toContain('USE TEMP B-TREE FOR DISTINCT');
        expect(details.join('\n')).toContain('USE TEMP B-TREE FOR ORDER BY');
      } finally {
        oldBackend.close();
      }
    });

    it('the old query on the old schema serves unfiltered includeDeleted by index scan', () => {
      // The exact path from review: ORDER BY created_at DESC with no filter at
      // all was satisfied by a backward scan of idx_elements_created_at, so its
      // tie order was already rowid DESC there — not the rowid ASC the old
      // type-filtered sorter produced. Tie order was plan-dependent; that is
      // why the clarified contract pins a deterministic tiebreaker instead.
      const oldBackend = makeBackend(PRE_ORDERING_INDEX_VERSION);
      try {
        const details = oldBackend
          .query<{ detail: string }>(
            `EXPLAIN QUERY PLAN SELECT DISTINCT e.* FROM elements e WHERE 1=1 ORDER BY e.created_at DESC LIMIT 10 OFFSET 0`
          )
          .map((r) => r.detail)
          .join('\n');

        expect(details).toContain('SCAN e USING INDEX idx_elements_created_at');
        expect(details).toContain('USE TEMP B-TREE FOR DISTINCT');
        expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY');
      } finally {
        oldBackend.close();
      }
    });

    it('new default paths use no temp b-tree while old ones do', () => {
      const oldBackend = makeBackend(PRE_ORDERING_INDEX_VERSION);
      const newBackend = makeBackend(MIGRATIONS.length);
      try {
        const oldSql = `SELECT DISTINCT e.* FROM elements e WHERE e.type = 'task' AND e.deleted_at IS NULL ORDER BY e.created_at ASC LIMIT 10 OFFSET 0`;
        const oldDetails = oldBackend
          .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${oldSql}`)
          .map((r) => r.detail);

        const newQuery = buildListQuery({ type: 'task', orderDir: 'asc' });
        const newDetails = newBackend
          .query<{ detail: string }>(`EXPLAIN QUERY PLAN ${newQuery.sql}`, [
            ...newQuery.params,
            newQuery.limit,
            newQuery.offset,
          ])
          .map((r) => r.detail);

        expect(usesTempBTree(oldDetails)).toBe(true);
        expect(usesTempBTree(newDetails)).toBe(false);
      } finally {
        oldBackend.close();
        newBackend.close();
      }
    });
  });
});
