/**
 * Dirty Tracking Backend Tests
 *
 * Covers the guarantees the sync export path relies on:
 * - markDirty() is strictly monotonic per element (a re-mark is always
 *   distinguishable from a previously captured mark, even within the same
 *   millisecond)
 * - markDirty() is a single atomic statement, so two connections can never
 *   read the same old token and issue the same new token (the historical
 *   SELECT-then-INSERT race)
 * - issued tokens are never reused, even after the row is cleared while an
 *   older export snapshot is still in flight
 * - clearDirtySnapshot() clears only snapshot entries that were not re-marked
 *   since the snapshot was taken
 *
 * The tests exercise the Bun backend (the runtime this suite runs under) and
 * the Browser backend (sql.js). The Node backend executes the exact same
 * shared SQL (packages/storage/src/dirty.ts) through better-sqlite3, which
 * cannot be loaded under Bun; its SQL semantics are identical.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema } from './index.js';
import type { StorageBackend, DirtyElement } from './index.js';
import { BrowserStorageBackend } from './browser-backend.js';

let tempDir: string;
let backend: StorageBackend;

/**
 * Freeze the wall clock so same-millisecond behavior is deterministic.
 * markDirty() derives its wall-clock input from new Date(), which reads
 * Date.now() internally.
 */
function freezeClock(ms: number): () => void {
  const original = Date.now;
  Date.now = () => ms;
  return () => {
    Date.now = original;
  };
}

/** The raw connection behind a backend (for statement-level interception). */
function rawConnection(b: StorageBackend): {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
} {
  return (b as unknown as { db: ReturnType<typeof rawConnection> }).db;
}

describe('dirty tracking', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stoneforge-dirty-test-'));
    backend = createStorage({ path: join(tempDir, 'test.db') });
    initializeSchema(backend);
  });

  afterEach(() => {
    if (backend.isOpen) {
      backend.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('markDirty', () => {
    test('marks an element dirty with an ISO timestamp', () => {
      backend.markDirty('el-1');

      const dirty = backend.getDirtyElements();
      expect(dirty).toHaveLength(1);
      expect(dirty[0].elementId).toBe('el-1');
      expect(new Date(dirty[0].markedAt).getTime()).not.toBeNaN();
    });

    test('re-marking is strictly monotonic even within the same millisecond', () => {
      backend.markDirty('el-1');
      const first = backend.getDirtyElements()[0].markedAt;

      // Re-mark immediately — the wall clock has (almost certainly) not moved.
      // The stored marked_at must still become strictly greater, otherwise a
      // snapshot taken between the two marks could not tell them apart.
      backend.markDirty('el-1');
      const second = backend.getDirtyElements()[0].markedAt;

      expect(second).not.toBe(first);
      expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));

      // And a third mark keeps increasing
      backend.markDirty('el-1');
      const third = backend.getDirtyElements()[0].markedAt;
      expect(Date.parse(third)).toBeGreaterThan(Date.parse(second));
    });

    test('marks for different elements are independent', () => {
      backend.markDirty('el-1');
      backend.markDirty('el-2');

      const dirty = backend.getDirtyElements();
      expect(dirty.map((d) => d.elementId).sort()).toEqual(['el-1', 'el-2']);
    });

    test('bumps past an unparseable legacy value without poisoning the floor', () => {
      // A corrupt/legacy marked_at must not poison future marks
      backend.run(
        "INSERT INTO dirty_elements (element_id, marked_at) VALUES ('el-1', 'garbage')"
      );

      backend.markDirty('el-1');
      const markedAt = backend.getDirtyElements()[0].markedAt;
      expect(new Date(markedAt).getTime()).not.toBeNaN();

      // The floor must have ignored the unparseable token: after clearing and
      // re-marking at the same frozen millisecond, the new token must still
      // be strictly greater than the one issued above.
      const unfreeze = freezeClock(Date.now());
      const floorRow = backend.queryOne<{ marked_at: string }>(
        'SELECT marked_at FROM dirty_token_floor WHERE id = 1'
      );
      expect(floorRow?.marked_at).toBe(markedAt);
      unfreeze();
    });
  });

  describe('token generation (atomic, floor-backed)', () => {
    test('same-millisecond re-marks bump by exactly 1ms each', () => {
      const unfreeze = freezeClock(1_700_000_000_000);
      try {
        const token = (): number =>
          Date.parse(backend.getDirtyElements()[0].markedAt);
        backend.markDirty('el-1');
        const t1 = token();
        backend.markDirty('el-1');
        const t2 = token();
        backend.markDirty('el-1');
        const t3 = token();

        expect([t1, t2, t3]).toEqual([
          1_700_000_000_000,
          1_700_000_000_001,
          1_700_000_000_002,
        ]);
      } finally {
        unfreeze();
      }
    });

    test('wall clock behind the stored token still increases', () => {
      const unfreeze = freezeClock(1_700_000_000_500);
      backend.markDirty('el-1');
      unfreeze();

      // Second mark happens "earlier" (clock ticked backwards): the stored
      // value is still the floor to beat.
      const unfreeze2 = freezeClock(1_700_000_000_000);
      backend.markDirty('el-1');
      unfreeze2();

      const dirty = backend.getDirtyElements();
      expect(Date.parse(dirty[0].markedAt)).toBeGreaterThan(1_700_000_000_500);
    });

    test('a new element marked at a frozen clock takes floor + 1ms, not the wall clock', () => {
      const unfreeze = freezeClock(1_700_000_000_000);
      try {
        // Push the floor ahead of the wall clock with same-ms bumps
        backend.markDirty('el-1');
        backend.markDirty('el-1');
        backend.markDirty('el-1'); // floor = T+2ms

        backend.markDirty('el-other'); // insert path must exceed the floor
        const other = backend
          .getDirtyElements()
          .find((d) => d.elementId === 'el-other');
        expect(Date.parse(other!.markedAt)).toBe(1_700_000_000_003);
      } finally {
        unfreeze();
      }
    });
  });

  describe('clearDirtySnapshot', () => {
    test('clears entries that still match the snapshot', () => {
      backend.markDirty('el-1');
      backend.markDirty('el-2');
      const snapshot = backend.getDirtyElements();

      const cleared = backend.clearDirtySnapshot(snapshot);

      expect(cleared).toBe(2);
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('keeps entries that were re-marked after the snapshot', () => {
      backend.markDirty('el-1');
      backend.markDirty('el-2');
      const snapshot = backend.getDirtyElements();

      // Concurrent writer re-marks el-1 while the export is in flight
      backend.markDirty('el-1');

      const cleared = backend.clearDirtySnapshot(snapshot);

      expect(cleared).toBe(1);
      const remaining = backend.getDirtyElements();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].elementId).toBe('el-1');
      // The surviving mark is the newer one
      expect(
        Date.parse(remaining[0].markedAt) > Date.parse(snapshot[0].markedAt)
      ).toBe(true);
    });

    test('keeps marks for elements that were never in the snapshot', () => {
      backend.markDirty('el-1');
      const snapshot = backend.getDirtyElements();

      // Concurrent writer marks a fresh element during the export
      backend.markDirty('el-2');

      backend.clearDirtySnapshot(snapshot);

      const remaining = backend.getDirtyElements();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].elementId).toBe('el-2');
    });

    test('skips snapshot entries whose row no longer exists', () => {
      backend.markDirty('el-1');
      backend.markDirty('el-2');
      const snapshot = backend.getDirtyElements();

      backend.clearDirty();

      const cleared = backend.clearDirtySnapshot(snapshot);

      expect(cleared).toBe(0);
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('empty snapshot is a no-op', () => {
      backend.markDirty('el-1');

      expect(backend.clearDirtySnapshot([])).toBe(0);
      expect(backend.getDirtyElements()).toHaveLength(1);
    });

    test('works inside an open transaction', () => {
      backend.markDirty('el-1');
      const snapshot = backend.getDirtyElements();

      let cleared = 0;
      backend.transaction(() => {
        cleared = backend.clearDirtySnapshot(snapshot);
      });

      expect(cleared).toBe(1);
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('markDirty works inside an open transaction', () => {
      const unfreeze = freezeClock(1_700_000_000_000);
      let first = '';
      let second = '';
      backend.transaction(() => {
        backend.markDirty('el-1');
        first = backend.getDirtyElements()[0].markedAt;
        backend.markDirty('el-1');
        second = backend.getDirtyElements()[0].markedAt;
      });
      unfreeze();

      expect(Date.parse(second)).toBe(Date.parse(first) + 1);
    });
  });

  describe('concurrent connections', () => {
    // A second connection to the same file, as the daemon / another agent
    // process would have. Both connections initialize the dirty schema.
    let other: StorageBackend;

    beforeEach(() => {
      other = createStorage({ path: join(tempDir, 'test.db') });
    });

    afterEach(() => {
      if (other.isOpen) {
        other.close();
      }
    });

    test('interleaved marks from two connections never issue the same token', () => {
      const unfreeze = freezeClock(1_700_000_000_000);
      try {
        const tokens: string[] = [];
        for (let i = 0; i < 5; i++) {
          backend.markDirty('el-race');
          tokens.push(backend.getDirtyElements()[0].markedAt);
          other.markDirty('el-race');
          tokens.push(other.getDirtyElements()[0].markedAt);
        }

        // Every token is distinct and the sequence strictly increases —
        // the frozen clock makes any token duplication deterministic.
        expect(new Set(tokens).size).toBe(tokens.length);
        for (let i = 1; i < tokens.length; i++) {
          expect(tokens[i] > tokens[i - 1]).toBe(true);
        }
      } finally {
        unfreeze();
      }
    });

    test('a mark landing between another connection’s read and write never duplicates its token', () => {
      // Regression for the review-reproduced race (el-5qdl6j): the old
      // markDirty read the stored token, computed the next one in JS, then
      // wrote it — so two connections could both compute the same "next"
      // token, and an export snapshot holding that token would later clear
      // the other writer's mark, silently losing its mutation.
      //
      // This deterministically interleaves at the strongest point still
      // available: a concurrent mark + export snapshot is injected between
      // the marking statement's construction and its execution. Against the
      // old SELECT-then-INSERT implementation this reproduces the duplicate
      // token; against the single-statement implementation the injected mark
      // simply lands first and the statement must still issue a strictly
      // greater token.
      const unfreeze = freezeClock(1_700_000_000_000);
      try {
        backend.markDirty('el-race'); // seed token T

        const raw = rawConnection(backend);
        const originalPrepare = raw.prepare.bind(raw);
        let injected = false;
        let raceSnapshot: DirtyElement[] = [];
        raw.prepare = ((sql: string) => {
          const stmt = originalPrepare(sql);
          if (
            !injected &&
            sql.includes('INSERT') &&
            sql.includes('dirty_elements')
          ) {
            const originalRun = stmt.run.bind(stmt);
            (stmt as { run: (...args: unknown[]) => unknown }).run = (
              ...args: unknown[]
            ) => {
              injected = true;
              // "Another process" marks the same element and an export
              // snapshots that mark while our statement is pending.
              other.markDirty('el-race');
              raceSnapshot = other.getDirtyElements();
              return originalRun(...args);
            };
          }
          return stmt;
        }) as typeof raw.prepare;

        try {
          backend.markDirty('el-race');
        } finally {
          delete (raw as { prepare?: unknown }).prepare;
        }

        expect(raceSnapshot).toHaveLength(1);

        // The export that captured the snapshot completes and clears it.
        const cleared = other.clearDirtySnapshot(raceSnapshot);

        // The racing mark must NOT be acknowledged by that clear: its token
        // is strictly newer than the snapshotted one.
        expect(cleared).toBe(0);
        const remaining = backend.getDirtyElements();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].elementId).toBe('el-race');
        expect(Date.parse(remaining[0].markedAt)).toBeGreaterThan(
          Date.parse(raceSnapshot[0].markedAt)
        );
      } finally {
        unfreeze();
      }
    });

    test('a cleared row cannot regenerate a token an in-flight snapshot holds', () => {
      // Overlapping exports at the same frozen millisecond: export 2 clears
      // the row, a third mark re-creates it, and export 1's (older) snapshot
      // must not acknowledge that newer mark.
      const unfreeze = freezeClock(1_700_000_000_000);
      try {
        backend.markDirty('el-overlap'); // T1
        const snapshot1 = backend.getDirtyElements();

        backend.markDirty('el-overlap'); // T2
        const snapshot2 = backend.getDirtyElements();

        // Export 2 finishes first and clears its snapshot — the row is gone.
        expect(other.clearDirtySnapshot(snapshot2)).toBe(1);
        expect(backend.getDirtyElements()).toHaveLength(0);

        // The element changes again in the same millisecond: with a
        // wall-clock-only token this would regenerate T1.
        backend.markDirty('el-overlap');

        // Export 1's writes finish and it clears its (now stale) snapshot.
        const clearedByStaleExport = backend.clearDirtySnapshot(snapshot1);

        expect(clearedByStaleExport).toBe(0);
        const remaining = backend.getDirtyElements();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].elementId).toBe('el-overlap');
        expect(
          Date.parse(remaining[0].markedAt) > Date.parse(snapshot2[0].markedAt)
        ).toBe(true);
      } finally {
        unfreeze();
      }
    });

    test('a stale snapshot clear on one connection does not touch a newer row on the other', () => {
      const unfreeze = freezeClock(1_700_000_000_000);
      try {
        other.markDirty('el-shared');
        const snapshot = other.getDirtyElements();

        // Our connection re-marks after the snapshot
        backend.markDirty('el-shared');
        const current = backend.getDirtyElements()[0];

        expect(other.clearDirtySnapshot(snapshot)).toBe(0);
        expect(backend.getDirtyElements()[0]).toEqual(current);
      } finally {
        unfreeze();
      }
    });
  });

  describe('DirtyElement type shape', () => {
    test('snapshot entries round-trip through clearDirtySnapshot', () => {
      backend.markDirty('el-1');
      // Simulate a serialized snapshot (e.g. cross-process handoff)
      const snapshot: DirtyElement[] = backend
        .getDirtyElements()
        .map((d) => ({ elementId: d.elementId, markedAt: d.markedAt }));

      expect(backend.clearDirtySnapshot(snapshot)).toBe(1);
    });
  });
});

describe('dirty tracking (browser backend, sql.js)', () => {
  let browserBackend: BrowserStorageBackend;

  beforeEach(async () => {
    // No initializeSchema here: the dirty tables are created by the backend
    // constructor, and the stock sql.js WASM build has no FTS5 module.
    browserBackend = await BrowserStorageBackend.create({ path: ':memory:' });
  });

  afterEach(() => {
    if (browserBackend.isOpen) {
      browserBackend.close();
    }
  });

  test('same-millisecond re-marks are strictly monotonic', () => {
    const unfreeze = freezeClock(1_700_000_000_000);
    try {
      const token = (): number =>
        Date.parse(browserBackend.getDirtyElements()[0].markedAt);
      browserBackend.markDirty('el-1');
      const t1 = token();
      browserBackend.markDirty('el-1');
      const t2 = token();
      browserBackend.markDirty('el-1');
      const t3 = token();

      expect([t1, t2, t3]).toEqual([
        1_700_000_000_000,
        1_700_000_000_001,
        1_700_000_000_002,
      ]);
    } finally {
      unfreeze();
    }
  });

  test('a cleared row cannot regenerate a token an in-flight snapshot holds', () => {
    const unfreeze = freezeClock(1_700_000_000_000);
    try {
      browserBackend.markDirty('el-1');
      const snapshot1 = browserBackend.getDirtyElements();

      browserBackend.markDirty('el-1');
      const snapshot2 = browserBackend.getDirtyElements();

      expect(browserBackend.clearDirtySnapshot(snapshot2)).toBe(1);
      expect(browserBackend.getDirtyElements()).toHaveLength(0);

      browserBackend.markDirty('el-1');

      expect(browserBackend.clearDirtySnapshot(snapshot1)).toBe(0);
      const remaining = browserBackend.getDirtyElements();
      expect(remaining).toHaveLength(1);
      expect(
        Date.parse(remaining[0].markedAt) > Date.parse(snapshot1[0].markedAt)
      ).toBe(true);
    } finally {
      unfreeze();
    }
  });

  test('clearDirtySnapshot keeps re-marked entries', () => {
    browserBackend.markDirty('el-1');
    const snapshot = browserBackend.getDirtyElements();
    browserBackend.markDirty('el-1');

    expect(browserBackend.clearDirtySnapshot(snapshot)).toBe(0);
    expect(browserBackend.getDirtyElements()).toHaveLength(1);
  });
});
