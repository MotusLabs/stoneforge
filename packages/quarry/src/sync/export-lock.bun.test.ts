/**
 * Sync Export Write Lock Tests
 *
 * The lock serializes JSONL export writers against critical sections that
 * manipulate the live files (the merge steward's snapshot dance). These
 * tests pin the mutex semantics the dance depends on: same-directory
 * serialization in acquisition order, no poisoning after a failure, and —
 * the load-bearing property — that SyncService.export actually takes the
 * lock, so a holder is excluded from in-flight exports.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyncExportLock } from './export-lock.js';
import { SyncService, createSyncService } from './service.js';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import type { Element, ElementId, EntityId } from '@stoneforge/core';
import { ElementType, createTimestamp } from '@stoneforge/core';

function testElement(id: string): Element {
  return {
    id: `el-${id}` as ElementId,
    type: ElementType.TASK,
    createdAt: createTimestamp(),
    updatedAt: createTimestamp(),
    createdBy: 'el-system1' as EntityId,
    tags: [],
    metadata: {},
    title: `Task ${id}`,
    status: 'open',
    priority: 3,
    complexity: 3,
    taskType: 'task',
  } as Element;
}

function insertElement(backend: StorageBackend, element: Element): void {
  const { id, type, createdAt, updatedAt, createdBy, tags, ...data } = element;
  backend.run(
    `INSERT INTO elements (id, type, data, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, type, JSON.stringify(data), createdAt, updatedAt, createdBy]
  );
  for (const tag of tags) {
    backend.run('INSERT INTO tags (element_id, tag) VALUES (?, ?)', [id, tag]);
  }
}

describe('withSyncExportLock', () => {
  test('serializes same-directory critical sections in acquisition order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-export-lock-test-'));
    try {
      const order: number[] = [];
      const gated = <T,>(n: number, gate: () => Promise<void>, work: () => T) =>
        withSyncExportLock(dir, async () => {
          await gate();
          order.push(n);
          return work();
        });

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });

      const first = gated(1, () => firstGate, () => 'first');
      const second = gated(2, () => secondGate, () => 'second');

      // First holder is parked; second must not have started.
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual([]);

      releaseFirst();
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual([1]); // second still queued behind its own gate

      releaseSecond();
      expect(await second).toBe('second');
      expect(await first).toBe('first');
      expect(order).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runs critical sections for different directories in parallel', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'sf-export-lock-test-'));
    const dirB = mkdtempSync(join(tmpdir(), 'sf-export-lock-test-'));
    try {
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });

      const a = withSyncExportLock(dirA, async () => {
        await gateA;
        return 'a';
      });
      const b = withSyncExportLock(dirB, async () => 'b');

      // B completes although A is still parked — no cross-directory blocking.
      await expect(b).resolves.toBe('b');
      releaseA();
      await expect(a).resolves.toBe('a');
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('a failed critical section propagates its error without poisoning later waiters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-export-lock-test-'));
    try {
      const boom = withSyncExportLock(dir, async () => {
        throw new Error('boom');
      });
      await expect(boom).rejects.toThrow('boom');

      // The chain must still hand the lock to the next waiter.
      await expect(withSyncExportLock(dir, async () => 'recovered')).resolves.toBe('recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('SyncService.export takes the lock: it cannot write while a holder keeps it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-export-lock-test-'));
    const dbPath = join(dir, 'test.db');
    const outputDir = join(dir, 'sync');
    const backend = createStorage({ path: dbPath });
    try {
      initializeSchema(backend);
      insertElement(backend, testElement('locked1'));
      const syncService = createSyncService(backend);

      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
      const holder = withSyncExportLock(outputDir, async () => {
        await holderGate;
      });

      let exportDone = false;
      const pendingExport = syncService
        .export({ outputDir, full: true })
        .then((result) => {
          exportDone = true;
          return result;
        });

      // The export must be stuck behind the holder...
      await new Promise((r) => setTimeout(r, 30));
      expect(exportDone).toBe(false);

      // ...and complete only once the holder releases.
      releaseHolder();
      await holder;
      const result = await pendingExport;
      expect(result.elementsExported).toBe(1);
      const content = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');
      expect(content).toContain('el-locked1');
    } finally {
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
