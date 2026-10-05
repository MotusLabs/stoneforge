/**
 * Sync Service Integration Tests
 *
 * Tests the full export/import functionality with a real storage backend.
 */

import { createBackendTracker } from '../testing/storage-test-utils.js';
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncService, createSyncService } from './service.js';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import type { Element, ElementId, EntityId, Timestamp, Dependency } from '@stoneforge/core';
import { ElementType, createTimestamp, DependencyType } from '@stoneforge/core';
import { parseElements } from './serialization.js';

const backends = createBackendTracker();

// ============================================================================
// Test Setup
// ============================================================================

let tempDir: string;
let backend: StorageBackend;
let service: SyncService;

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'stoneforge-sync-test-'));
}

function createTestElement(overrides: Partial<Element> & Record<string, unknown> = {}): Element {
  return {
    id: `el-${Math.random().toString(36).substring(2, 8)}` as ElementId,
    type: ElementType.TASK,
    createdAt: createTimestamp(),
    updatedAt: createTimestamp(),
    createdBy: 'el-system1' as EntityId,
    tags: [],
    metadata: {},
    title: 'Test Task',
    status: 'open',
    priority: 3,
    complexity: 3,
    taskType: 'task',
    ...overrides,
  } as Element;
}

function createTestEntity(overrides: Partial<Element> & Record<string, unknown> = {}): Element {
  return {
    id: `el-${Math.random().toString(36).substring(2, 8)}` as ElementId,
    type: ElementType.ENTITY,
    createdAt: createTimestamp(),
    updatedAt: createTimestamp(),
    createdBy: 'el-system1' as EntityId,
    tags: [],
    metadata: {},
    name: 'Test Entity',
    entityType: 'human',
    isActive: true,
    ...overrides,
  } as Element;
}

function createTestDependency(
  blockedId: ElementId,
  blockerId: ElementId,
  type: DependencyType = DependencyType.BLOCKS
): Dependency {
  return {
    blockedId,
    blockerId,
    type,
    createdAt: createTimestamp(),
    createdBy: 'el-system1' as EntityId,
    metadata: {},
  };
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

function insertDependency(backend: StorageBackend, dep: Dependency): void {
  backend.run(
    `INSERT INTO dependencies (blocked_id, blocker_id, type, created_at, created_by, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      dep.blockedId,
      dep.blockerId,
      dep.type,
      dep.createdAt,
      dep.createdBy,
      Object.keys(dep.metadata).length > 0 ? JSON.stringify(dep.metadata) : null,
    ]
  );
}

/**
 * Soft-delete an element the way QuarryAPI.deleteElement() does: the
 * tombstone fields (`status: 'tombstone'`, `deletedAt`, `deleteReason`) are
 * written into the `data` payload and the `deleted_at` column is set. Also
 * marks the element dirty for the incremental export path.
 */
function softDeleteElement(backend: StorageBackend, element: Element, deletedAt: string): void {
  const {
    id,
    type: _type,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdBy: _createdBy,
    tags: _tags,
    ...data
  } = element;
  backend.run(
    'UPDATE elements SET data = ?, deleted_at = ?, updated_at = ? WHERE id = ?',
    [
      JSON.stringify({ ...data, status: 'tombstone', deletedAt, deleteReason: 'test' }),
      deletedAt,
      deletedAt,
      id,
    ]
  );
  backend.markDirty(id);
}

/**
 * Update an element's type-specific payload the way QuarryAPI mutations do:
 * patch the `data` payload, bump `updated_at`, and mark the element dirty.
 */
function updateElementPayload(
  backend: StorageBackend,
  id: string,
  patch: Record<string, unknown>
): void {
  const row = backend.queryOne<{ data: string }>('SELECT data FROM elements WHERE id = ?', [id]);
  const data = JSON.parse(row?.data ?? '{}');
  backend.run('UPDATE elements SET data = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify({ ...data, ...patch }),
    createTimestamp(),
    id,
  ]);
  backend.markDirty(id);
}

/** Read the parsed elements of an exported elements.jsonl, keyed by id. */
function readExportedElements(path: string): Map<string, Record<string, unknown>> {
  const { elements } = parseElements(readFileSync(path, 'utf-8'));
  return new Map(
    elements.map((el) => [el.id as string, el as unknown as Record<string, unknown>])
  );
}

function getElementCount(backend: StorageBackend): number {
  const row = backend.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM elements');
  return row?.count ?? 0;
}

function getDependencyCount(backend: StorageBackend): number {
  const row = backend.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM dependencies');
  return row?.count ?? 0;
}

function createTestBackend(path: string): StorageBackend {
  const backend = backends.track(createStorage({ path }));
  initializeSchema(backend);
  return backend;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('SyncService', () => {
  beforeEach(() => {
    tempDir = createTempDir();
    backend = createTestBackend(join(tempDir, 'test.db'));
    service = createSyncService(backend);
  });

  afterEach(() => {
    backends.closeAll();
    if (backend.isOpen) {
      backend.close();
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Export Tests
  // --------------------------------------------------------------------------

  describe('export', () => {
    test('exports empty database', async () => {
      const outputDir = join(tempDir, 'export');

      const result = await service.export({
        outputDir,
        full: true,
      });

      expect(result.elementsExported).toBe(0);
      expect(result.dependenciesExported).toBe(0);
      expect(result.incremental).toBe(false);
      expect(existsSync(result.elementsFile)).toBe(true);
      expect(existsSync(result.dependenciesFile)).toBe(true);
    });

    test('exports elements to JSONL file', async () => {
      // Insert test data
      const entity = createTestEntity({ id: 'el-entity1' as ElementId });
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, entity);
      insertElement(backend, task);

      const outputDir = join(tempDir, 'export');

      const result = await service.export({
        outputDir,
        full: true,
      });

      expect(result.elementsExported).toBe(2);

      // Verify file content
      const content = readFileSync(result.elementsFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      // First element should be entity (priority order)
      const firstElement = JSON.parse(lines[0]);
      expect(firstElement.type).toBe('entity');
    });

    test('exports dependencies to JSONL file', async () => {
      // Insert test data
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const dep = createTestDependency(task1.id, task2.id);
      insertDependency(backend, dep);

      const outputDir = join(tempDir, 'export');

      const result = await service.export({
        outputDir,
        full: true,
      });

      expect(result.dependenciesExported).toBe(1);

      // Verify file content
      const content = readFileSync(result.dependenciesFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.blockedId).toBe('el-task1');
      expect(parsed.blockerId).toBe('el-task2');
    });

    test('terminates nonempty files with a single newline (async export)', async () => {
      // Empty export (before any data exists): files exist but contain
      // nothing — not even a newline
      const empty = await service.export({ outputDir: join(tempDir, 'empty'), full: true });
      expect(readFileSync(empty.elementsFile, 'utf-8')).toBe('');
      expect(readFileSync(empty.dependenciesFile, 'utf-8')).toBe('');

      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);
      insertDependency(backend, createTestDependency(task1.id, task2.id));

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      // Nonempty files end with exactly one newline: `wc -l` then reports the
      // element count exactly, and re-exports show no spurious last-line diff
      // against files written by earlier versions
      const fullElements = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');
      expect(fullElements.endsWith('\n')).toBe(true);
      expect(fullElements.endsWith('\n\n')).toBe(false);
      expect(fullElements.split('\n')).toHaveLength(3); // 2 element lines + trailing ''

      const fullDeps = readFileSync(join(outputDir, 'dependencies.jsonl'), 'utf-8');
      expect(fullDeps.endsWith('\n')).toBe(true);
      expect(fullDeps.endsWith('\n\n')).toBe(false);

      // The incremental merge path keeps the same convention
      backend.markDirty('el-task1');
      await service.export({ outputDir, full: false });
      const merged = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');
      expect(merged.endsWith('\n')).toBe(true);
      expect(merged.endsWith('\n\n')).toBe(false);
      expect(merged.split('\n')).toHaveLength(3);
    });

    test('incremental export merges dirty elements into the existing file', async () => {
      // Insert test data
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      const task3 = createTestElement({ id: 'el-task3' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);
      insertElement(backend, task3);

      const outputDir = join(tempDir, 'export');

      // Full export first — establishes the baseline file
      await service.export({ outputDir, full: true });

      // Modify task2 and mark only task2 as dirty (mirrors how QuarryAPI updates
      // an element: the type-specific payload lives in the `data` column)
      const updatedTitle = 'Updated Title';
      const { id: _id, type: _t, createdAt: _c, updatedAt: _u, createdBy: _by, tags: _tg, ...taskData } = task2;
      backend.run('UPDATE elements SET data = ? WHERE id = ?', [
        JSON.stringify({ ...taskData, title: updatedTitle }),
        'el-task2',
      ]);
      backend.markDirty('el-task2');

      const result = await service.export({
        outputDir,
        full: false, // Incremental
      });

      expect(result.incremental).toBe(true);
      expect(result.fallbackToFull).toBeFalsy();
      // The file keeps every element, not just the dirty one
      expect(result.elementsExported).toBe(3);

      // Verify file content: all 3 elements present, task2 updated
      const { elements } = parseElements(readFileSync(result.elementsFile, 'utf-8'));
      expect(elements).toHaveLength(3);
      const ids = elements.map((el) => el.id).sort();
      expect(ids).toEqual(['el-task1', 'el-task2', 'el-task3']);

      const modified = elements.find((el) => el.id === 'el-task2');
      expect((modified as unknown as { title: string }).title).toBe(updatedTitle);

      // Verify dirty tracking was cleared
      const dirty = backend.getDirtyElements();
      expect(dirty).toHaveLength(0);
    });

    test('incremental export writes a tombstone for a deleted element', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      // Soft delete task1 (tombstone), mirroring QuarryAPI.deleteElement(): the
      // tombstone is recorded in both the `data` payload and `deleted_at`
      const now = createTimestamp();
      const { id: _id, type: _t, createdAt: _c, updatedAt: _u, createdBy: _by, tags: _tg, ...taskData } = task1;
      backend.run(
        'UPDATE elements SET data = ?, deleted_at = ?, updated_at = ? WHERE id = ?',
        [
          JSON.stringify({
            ...taskData,
            status: 'tombstone',
            deletedAt: now,
            deleteReason: 'test',
          }),
          now,
          now,
          'el-task1',
        ]
      );
      backend.markDirty('el-task1');

      const result = await service.export({ outputDir, full: false });

      expect(result.incremental).toBe(true);
      expect(result.elementsExported).toBe(2);

      const { elements } = parseElements(readFileSync(result.elementsFile, 'utf-8'));
      expect(elements).toHaveLength(2);

      const tombstone = elements.find((el) => el.id === 'el-task1');
      expect(tombstone).toBeDefined();
      expect((tombstone as unknown as { deletedAt?: string }).deletedAt).toBe(now);

      // The live element is untouched
      expect(elements.find((el) => el.id === 'el-task2')).toBeDefined();
    });

    test('incremental export with a missing file falls back to a full export', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');

      // No prior export — there is no existing file to merge into
      backend.markDirty('el-task1');

      const result = await service.export({ outputDir, full: false });

      expect(result.incremental).toBe(true);
      expect(result.fallbackToFull).toBe(true);
      // Full export of both elements, not just the dirty one
      expect(result.elementsExported).toBe(2);

      const { elements } = parseElements(readFileSync(result.elementsFile, 'utf-8'));
      expect(elements).toHaveLength(2);

      // Dirty tracking was cleared by the fallback full export
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('incremental export keeps elements when the file exists but nothing is dirty', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task1);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      const before = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');

      // No dirty elements — incremental export must be a no-op for content
      const result = await service.export({ outputDir, full: false });

      expect(result.incremental).toBe(true);
      expect(result.elementsExported).toBe(1);
      expect(readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8')).toBe(before);
    });

    test('incremental export keeps export sort order', async () => {
      // Insert a task first, then an entity — the entity must sort first
      const task = createTestElement({ id: 'el-task9' as ElementId });
      const entity = createTestEntity({ id: 'el-ent1' as ElementId });
      insertElement(backend, task);
      insertElement(backend, entity);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      // Add a new entity and export incrementally — it must land before the task
      const entity2 = createTestEntity({ id: 'el-ent2' as ElementId });
      insertElement(backend, entity2);
      backend.markDirty('el-ent2');

      await service.export({ outputDir, full: false });

      const { elements } = parseElements(readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8'));
      expect(elements.map((el) => el.id)).toEqual(['el-ent1', 'el-ent2', 'el-task9']);
    });

    test('uses custom file names', async () => {
      const outputDir = join(tempDir, 'export');

      const result = await service.export({
        outputDir,
        full: true,
        elementsFile: 'custom-elements.jsonl',
        dependenciesFile: 'custom-deps.jsonl',
      });

      expect(result.elementsFile).toContain('custom-elements.jsonl');
      expect(result.dependenciesFile).toContain('custom-deps.jsonl');
    });
  });

  describe('exportSync', () => {
    test('exports synchronously', () => {
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const outputDir = join(tempDir, 'export');

      const result = service.exportSync({
        outputDir,
        full: true,
      });

      expect(result.elementsExported).toBe(1);
      expect(existsSync(result.elementsFile)).toBe(true);
    });

    test('terminates nonempty files with a single newline (sync export)', () => {
      // Empty export (before any data exists): files exist but contain
      // nothing — not even a newline
      const empty = service.exportSync({ outputDir: join(tempDir, 'empty'), full: true });
      expect(readFileSync(empty.elementsFile, 'utf-8')).toBe('');
      expect(readFileSync(empty.dependenciesFile, 'utf-8')).toBe('');

      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);
      insertDependency(backend, createTestDependency(task1.id, task2.id));

      const outputDir = join(tempDir, 'export');
      service.exportSync({ outputDir, full: true });

      const fullElements = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');
      expect(fullElements.endsWith('\n')).toBe(true);
      expect(fullElements.endsWith('\n\n')).toBe(false);
      expect(fullElements.split('\n')).toHaveLength(3); // 2 element lines + trailing ''

      const fullDeps = readFileSync(join(outputDir, 'dependencies.jsonl'), 'utf-8');
      expect(fullDeps.endsWith('\n')).toBe(true);
      expect(fullDeps.endsWith('\n\n')).toBe(false);

      // The incremental merge path keeps the same convention
      backend.markDirty('el-task2');
      service.exportSync({ outputDir, full: false });
      const merged = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');
      expect(merged.endsWith('\n')).toBe(true);
      expect(merged.endsWith('\n\n')).toBe(false);
      expect(merged.split('\n')).toHaveLength(3);
    });

    test('incremental exportSync merges instead of overwriting', () => {
      // This is the `sf export` (CLI) path — it must not clobber the file either
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');
      service.exportSync({ outputDir, full: true });

      backend.markDirty('el-task2');
      const result = service.exportSync({ outputDir, full: false });

      expect(result.incremental).toBe(true);
      expect(result.elementsExported).toBe(2);

      const { elements } = parseElements(readFileSync(result.elementsFile, 'utf-8'));
      expect(elements).toHaveLength(2);
    });

    test('incremental exportSync falls back to full when the file is missing', () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task1);

      const outputDir = join(tempDir, 'export');
      backend.markDirty('el-task1');

      const result = service.exportSync({ outputDir, full: false });

      expect(result.fallbackToFull).toBe(true);
      expect(result.elementsExported).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Dirty Tracking Across Export Writes
  //
  // The export path reads the dirty set, awaits its file writes, and only then
  // acknowledges the dirty marks. Anything mutated while those writes are in
  // flight (other agents, the dispatch daemon) must keep its dirty mark and go
  // out in the next incremental export.
  // --------------------------------------------------------------------------

  describe('dirty tracking across export writes', () => {
    test('mutations landing during the awaited writes stay dirty and export next time', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      const task3 = createTestElement({ id: 'el-task3' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);
      insertElement(backend, task3);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      // task1 changes (and becomes dirty) before the export starts
      updateElementPayload(backend, 'el-task1', { title: 'task1 v2' });

      // Stub the atomic write so a concurrent writer mutates the DB between
      // the export's reads and its dirty-clear
      const serviceAny = service as unknown as {
        writeAtomic: (filePath: string, content: string) => Promise<void>;
      };
      const originalWriteAtomic = serviceAny.writeAtomic.bind(service);
      let concurrentWritesDone = false;
      serviceAny.writeAtomic = async (filePath: string, content: string) => {
        if (!concurrentWritesDone) {
          concurrentWritesDone = true;
          // Another writer re-marks an already-dirty element — possibly in the
          // same millisecond as the pre-export mark
          updateElementPayload(backend, 'el-task1', { title: 'task1 v3' });
          // ... and marks a previously clean element
          updateElementPayload(backend, 'el-task2', { title: 'task2 concurrent' });
        }
        return originalWriteAtomic(filePath, content);
      };

      try {
        const result = await service.export({ outputDir, full: false });
        expect(result.incremental).toBe(true);
      } finally {
        serviceAny.writeAtomic = originalWriteAtomic;
      }

      // Both concurrent mutations stay dirty; el-task3 was never dirty
      const dirtyIds = backend
        .getDirtyElements()
        .map((d) => d.elementId as string)
        .sort();
      expect(dirtyIds).toEqual(['el-task1', 'el-task2']);

      // The file holds the content read *before* the writes — the concurrent
      // changes are not in it yet
      let byId = readExportedElements(join(outputDir, 'elements.jsonl'));
      expect(byId.get('el-task1')?.title).toBe('task1 v2');
      expect(byId.get('el-task2')?.title).toBe('Test Task');
      expect(byId.get('el-task3')?.title).toBe('Test Task');

      // The next incremental export ships both concurrent mutations
      const second = await service.export({ outputDir, full: false });
      expect(second.incremental).toBe(true);
      byId = readExportedElements(second.elementsFile);
      expect(byId.get('el-task1')?.title).toBe('task1 v3');
      expect(byId.get('el-task2')?.title).toBe('task2 concurrent');
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('mutations landing during a fallback-to-full export stay dirty', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');
      // No prior export — the incremental export below falls back to full

      backend.markDirty('el-task1');

      const serviceAny = service as unknown as {
        writeAtomic: (filePath: string, content: string) => Promise<void>;
      };
      const originalWriteAtomic = serviceAny.writeAtomic.bind(service);
      let concurrentWritesDone = false;
      serviceAny.writeAtomic = async (filePath: string, content: string) => {
        if (!concurrentWritesDone) {
          concurrentWritesDone = true;
          updateElementPayload(backend, 'el-task2', { title: 'task2 concurrent' });
        }
        return originalWriteAtomic(filePath, content);
      };

      try {
        const result = await service.export({ outputDir, full: false });
        expect(result.fallbackToFull).toBe(true);
      } finally {
        serviceAny.writeAtomic = originalWriteAtomic;
      }

      // The mark made during the write survived the fallback export
      const dirtyIds = backend
        .getDirtyElements()
        .map((d) => d.elementId as string)
        .sort();
      expect(dirtyIds).toEqual(['el-task2']);

      const second = await service.export({ outputDir, full: false });
      const byId = readExportedElements(second.elementsFile);
      expect(byId.get('el-task2')?.title).toBe('task2 concurrent');
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('elements skipped during serialization stay dirty and are retried', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      // task1 exports normally; task2 fails validation (bad updated_at) and
      // must keep its dirty mark so it is retried
      updateElementPayload(backend, 'el-task1', { title: 'task1 v2' });
      backend.run("UPDATE elements SET updated_at = 'not-a-timestamp' WHERE id = ?", [
        'el-task2',
      ]);
      backend.markDirty('el-task2');

      const result = await service.export({ outputDir, full: false });
      expect(result.incremental).toBe(true);

      const dirtyIds = backend
        .getDirtyElements()
        .map((d) => d.elementId as string)
        .sort();
      expect(dirtyIds).toEqual(['el-task2']);

      // task1's change went out and its line was updated; task2's existing
      // line survives untouched
      const byId = readExportedElements(result.elementsFile);
      expect(byId.get('el-task1')?.title).toBe('task1 v2');
      expect(byId.get('el-task2')?.title).toBe('Test Task');

      // Repairing the element lets the next export ship it and clear its mark
      backend.run('UPDATE elements SET updated_at = ? WHERE id = ?', [
        createTimestamp(),
        'el-task2',
      ]);
      const second = await service.export({ outputDir, full: false });
      const byId2 = readExportedElements(second.elementsFile);
      expect(byId2.get('el-task2')?.title).toBe('Test Task');
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('full export does not acknowledge dirty tracking', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task1);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      backend.markDirty('el-task1');
      await service.export({ outputDir, full: true });

      // Only incremental (and fallback) exports clear dirty marks
      expect(backend.getDirtyElements()).toHaveLength(1);

      // ...and the incremental export afterwards clears it
      await service.export({ outputDir, full: false });
      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('incremental exportSync clears dirty marks for the elements it exported', () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');
      service.exportSync({ outputDir, full: true });

      backend.markDirty('el-task1');
      backend.markDirty('el-task2');
      service.exportSync({ outputDir, full: false });

      expect(backend.getDirtyElements()).toHaveLength(0);
    });

    test('a mark created after exportSync finished stays dirty for the next export', () => {
      // Simulates another process mutating between this export's reads and
      // its clear: the mark is not part of the snapshot it acknowledged
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task1);

      const outputDir = join(tempDir, 'export');
      service.exportSync({ outputDir, full: true });

      backend.markDirty('el-task1');
      service.exportSync({ outputDir, full: false });
      expect(backend.getDirtyElements()).toHaveLength(0);

      // A mark that appears after the export completes must survive a later
      // export's snapshot clear only if it was re-marked — here it simply is
      // not in the next snapshot until it is exported
      backend.markDirty('el-task1');
      const snapshot = backend.getDirtyElements();

      // Re-mark before the "export" acknowledges — the older mark is cleared,
      // the newer one survives
      backend.markDirty('el-task1');
      backend.clearDirtySnapshot(snapshot);

      const dirty = backend.getDirtyElements();
      expect(dirty).toHaveLength(1);
      expect(dirty[0].elementId).toBe('el-task1');
    });

    test('overlapping exports: a stale snapshot never acknowledges a re-created mark', async () => {
      // The overlapping-export hazard the token floor closes: export 1 is in
      // flight holding snapshot token T1; while its writes are awaited, the
      // element is re-marked (T2), a second export runs to completion and
      // clears T2, and the element is marked again — at the same frozen
      // millisecond, so a wall-clock-only token would regenerate exactly T1.
      // Export 1's clear must then match nothing and the newest mark must
      // survive to be exported next time.
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task1);

      const outputDir = join(tempDir, 'export');
      await service.export({ outputDir, full: true });

      const originalNow = Date.now;
      Date.now = () => 1_700_000_000_000;

      const serviceAny = service as unknown as {
        writeAtomic: (filePath: string, content: string) => Promise<void>;
        exportUnlocked: (options: { outputDir: string; full: boolean }) => Promise<unknown>;
      };
      const originalWriteAtomic = serviceAny.writeAtomic.bind(service);
      let injected = false;
      serviceAny.writeAtomic = async (filePath: string, content: string) => {
        if (!injected) {
          injected = true;
          // Re-mark while export 1 is writing (token T2)
          updateElementPayload(backend, 'el-task1', { title: 'task1 v3' });
          // A complete second export runs, snapshots T2 and clears it —
          // the dirty row is deleted. It must go through the lock-free
          // exportUnlocked core: the outer export holds the sync-export
          // write lock (same-process exports are serialized by it now), and
          // the overlap this test reconstructs is the cross-process one.
          await serviceAny.exportUnlocked({ outputDir, full: false });
          expect(backend.getDirtyElements()).toHaveLength(0);
          // The element changes again in the same frozen millisecond: the
          // re-created row must not receive a token export 1 still holds
          updateElementPayload(backend, 'el-task1', { title: 'task1 v4' });
        }
        return originalWriteAtomic(filePath, content);
      };

      try {
        updateElementPayload(backend, 'el-task1', { title: 'task1 v2' });
        const first = await service.export({ outputDir, full: false });
        expect(first.incremental).toBe(true);
      } finally {
        serviceAny.writeAtomic = originalWriteAtomic;
        Date.now = originalNow;
      }

      // The newest mark survived export 1's stale snapshot clear
      const dirty = backend.getDirtyElements();
      expect(dirty).toHaveLength(1);
      expect(dirty[0].elementId).toBe('el-task1');

      // ...and the next incremental export ships the newest content
      const third = await service.export({ outputDir, full: false });
      const byId = readExportedElements(third.elementsFile);
      expect(byId.get('el-task1')?.title).toBe('task1 v4');
      expect(backend.getDirtyElements()).toHaveLength(0);
    });
  });

  describe('exportToString', () => {
    test('returns JSONL strings', () => {
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const result = service.exportToString();

      expect(result.elements).toContain('el-task1');
      expect(typeof result.elements).toBe('string');
    });

    test('includes dependencies when requested', () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const dep = createTestDependency(task1.id, task2.id);
      insertDependency(backend, dep);

      const result = service.exportToString({ includeDependencies: true });

      expect(result.dependencies).toContain('el-task1');
      expect(result.dependencies).toContain('el-task2');
    });

    test('includes tombstones for soft-deleted elements', () => {
      // exportToString backs the HTTP sync pull/push/exchange endpoints and
      // QuarryAPI.export() — other replicas rely on it to learn about
      // deletions, so it must not drop tombstones either
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const deletedAt = createTimestamp();
      softDeleteElement(backend, task1, deletedAt);

      const result = service.exportToString();

      const { elements } = parseElements(result.elements);
      expect(elements).toHaveLength(2);

      const tombstone = elements.find((el) => el.id === 'el-task1') as unknown as {
        deletedAt?: string;
        status?: string;
      };
      expect(tombstone).toBeDefined();
      expect(tombstone.deletedAt).toBe(deletedAt);
      expect(tombstone.status).toBe('tombstone');

      expect(elements.find((el) => el.id === 'el-task2')).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Tombstone Export Tests
  // --------------------------------------------------------------------------

  describe('tombstone export', () => {
    test('full export after a delete still contains the tombstone', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');

      // Baseline export while both elements are live
      await service.export({ outputDir, full: true });

      // Soft delete task1 (tombstone), mirroring QuarryAPI.deleteElement()
      const deletedAt = createTimestamp();
      softDeleteElement(backend, task1, deletedAt);

      // A full export rewrites the file from the complete element set — it
      // must keep the tombstone instead of erasing the deletion
      const result = await service.export({ outputDir, full: true });

      expect(result.elementsExported).toBe(2);

      const { elements } = parseElements(readFileSync(result.elementsFile, 'utf-8'));
      expect(elements).toHaveLength(2);

      const tombstone = elements.find((el) => el.id === 'el-task1') as unknown as {
        deletedAt?: string;
        status?: string;
      };
      expect(tombstone).toBeDefined();
      expect(tombstone.deletedAt).toBe(deletedAt);
      expect(tombstone.status).toBe('tombstone');

      // The live element is still exported normally
      expect(elements.find((el) => el.id === 'el-task2')).toBeDefined();
    });

    test('importing a full export with a tombstone into a fresh DB keeps the element deleted', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const exportDir = join(tempDir, 'export');
      await service.export({ outputDir: exportDir, full: true });

      const deletedAt = createTimestamp();
      softDeleteElement(backend, task1, deletedAt);

      // The exported file now carries the tombstone
      await service.export({ outputDir: exportDir, full: true });

      // Import into a fresh database (a new clone pulling the source of truth)
      const freshBackend = createTestBackend(join(tempDir, 'fresh.db'));
      const freshService = createSyncService(freshBackend);

      const importResult = await freshService.import({ inputDir: exportDir });

      expect(importResult.errors).toHaveLength(0);
      expect(importResult.elementsImported).toBe(2);

      // The deleted element stays deleted: row present, deleted_at set
      const deletedRow = freshBackend.queryOne<{ deleted_at: string | null; data: string }>(
        'SELECT deleted_at, data FROM elements WHERE id = ?',
        ['el-task1']
      );
      expect(deletedRow).toBeDefined();
      expect(deletedRow?.deleted_at).toBe(deletedAt);
      expect(JSON.parse(deletedRow?.data ?? '{}').status).toBe('tombstone');

      // The live element is imported live
      const liveRow = freshBackend.queryOne<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM elements WHERE id = ?',
        ['el-task2']
      );
      expect(liveRow?.deleted_at).toBeNull();

      freshBackend.close();
    });

    test('importing a tombstone over a live local element keeps it deleted', async () => {
      // Local clone still has the element live
      const task1 = createTestElement({ id: 'el-task1' as ElementId, title: 'Shared Task' });
      insertElement(backend, task1);

      // Remote clone deleted it and exported the tombstone
      const remoteBackend = createTestBackend(join(tempDir, 'remote.db'));
      const remoteTask = createTestElement({ id: 'el-task1' as ElementId, title: 'Shared Task' });
      insertElement(remoteBackend, remoteTask);
      const deletedAt = createTimestamp();
      softDeleteElement(remoteBackend, remoteTask, deletedAt);

      const exportDir = join(tempDir, 'remote-export');
      createSyncService(remoteBackend).exportSync({ outputDir: exportDir, full: true });
      remoteBackend.close();

      const result = await service.import({ inputDir: exportDir });

      expect(result.elementsImported).toBe(1);

      // Fresh tombstone wins on merge — the element must stay deleted locally
      const row = backend.queryOne<{ deleted_at: string | null; data: string }>(
        'SELECT deleted_at, data FROM elements WHERE id = ?',
        ['el-task1']
      );
      expect(row?.deleted_at).toBe(deletedAt);
      expect(JSON.parse(row?.data ?? '{}').status).toBe('tombstone');
    });

    test('full and incremental exports produce consistent tombstones', async () => {
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);

      const outputDir = join(tempDir, 'export');

      // Baseline full export while both elements are live
      await service.export({ outputDir, full: true });

      const deletedAt = createTimestamp();
      softDeleteElement(backend, task1, deletedAt);

      // Incremental export carries the dirty tombstone into the file
      const incremental = await service.export({ outputDir, full: false });
      expect(incremental.incremental).toBe(true);
      expect(incremental.elementsExported).toBe(2);
      const incrementalContent = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');

      // A full export of the same state must produce the same file — the two
      // paths serialize tombstones identically, so the tombstone recorded by
      // the incremental export survives a full re-export byte-for-byte
      const full = await service.export({ outputDir, full: true });
      expect(full.elementsExported).toBe(2);
      const fullContent = readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8');

      expect(fullContent).toBe(incrementalContent);

      // An incremental export with nothing dirty must not change the file
      const idle = await service.export({ outputDir, full: false });
      expect(idle.incremental).toBe(true);
      expect(idle.elementsExported).toBe(2);
      expect(readFileSync(join(outputDir, 'elements.jsonl'), 'utf-8')).toBe(fullContent);

      // The tombstone is present and correct in the final file
      const { elements } = parseElements(fullContent);
      expect(elements).toHaveLength(2);
      const tombstone = elements.find((el) => el.id === 'el-task1') as unknown as {
        deletedAt?: string;
      };
      expect(tombstone?.deletedAt).toBe(deletedAt);
      expect(elements.find((el) => el.id === 'el-task2')).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Import Tests
  // --------------------------------------------------------------------------

  describe('import', () => {
    test('imports elements from JSONL files', async () => {
      // Create export first
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const exportDir = join(tempDir, 'export');
      await service.export({ outputDir: exportDir, full: true });

      // Clear database
      backend.run('DELETE FROM elements');
      backend.run('DELETE FROM tags');
      expect(getElementCount(backend)).toBe(0);

      // Import
      const result = await service.import({ inputDir: exportDir });

      expect(result.elementsImported).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(getElementCount(backend)).toBe(1);
    });

    test('imports dependencies from JSONL files', async () => {
      // Create export with dependency
      const task1 = createTestElement({ id: 'el-task1' as ElementId });
      const task2 = createTestElement({ id: 'el-task2' as ElementId });
      insertElement(backend, task1);
      insertElement(backend, task2);
      insertDependency(backend, createTestDependency(task1.id, task2.id));

      const exportDir = join(tempDir, 'export');
      await service.export({ outputDir: exportDir, full: true });

      // Clear database
      backend.run('DELETE FROM dependencies');
      backend.run('DELETE FROM elements');
      backend.run('DELETE FROM tags');

      // Import
      const result = await service.import({ inputDir: exportDir });

      expect(result.elementsImported).toBe(2);
      expect(result.dependenciesImported).toBe(1);
      expect(getDependencyCount(backend)).toBe(1);
    });

    test('dry run does not modify database', async () => {
      // Create export
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const exportDir = join(tempDir, 'export');
      await service.export({ outputDir: exportDir, full: true });

      // Clear database
      backend.run('DELETE FROM elements');
      backend.run('DELETE FROM tags');

      // Import with dry run
      const result = await service.import({ inputDir: exportDir, dryRun: true });

      expect(result.elementsImported).toBe(1);
      expect(getElementCount(backend)).toBe(0); // Should not have imported
    });

    test('handles missing files gracefully', async () => {
      const inputDir = join(tempDir, 'nonexistent');
      mkdtempSync(inputDir);

      const result = await service.import({ inputDir });

      expect(result.elementsImported).toBe(0);
      expect(result.dependenciesImported).toBe(0);
    });
  });

  describe('importSync', () => {
    test('imports synchronously', () => {
      // Create export
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const exportDir = join(tempDir, 'export');
      service.exportSync({ outputDir: exportDir, full: true });

      // Clear and import
      backend.run('DELETE FROM elements');
      backend.run('DELETE FROM tags');

      const result = service.importSync({ inputDir: exportDir });

      expect(result.elementsImported).toBe(1);
      expect(getElementCount(backend)).toBe(1);
    });
  });

  describe('importFromStrings', () => {
    test('imports from JSONL strings', () => {
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const exported = service.exportToString();

      // Clear database
      backend.run('DELETE FROM elements');
      backend.run('DELETE FROM tags');

      const result = service.importFromStrings(exported.elements, exported.dependencies ?? '');

      expect(result.elementsImported).toBe(1);
      expect(getElementCount(backend)).toBe(1);
    });

    test('handles empty strings', () => {
      const result = service.importFromStrings('', '');

      expect(result.elementsImported).toBe(0);
      expect(result.dependenciesImported).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Merge Behavior Tests
  // --------------------------------------------------------------------------

  describe('merge behavior', () => {
    test('skips identical elements', () => {
      const task = createTestElement({ id: 'el-task1' as ElementId });
      insertElement(backend, task);

      const exported = service.exportToString();

      // Import the same data again
      const result = service.importFromStrings(exported.elements, '');

      expect(result.elementsImported).toBe(0);
      expect(result.elementsSkipped).toBe(1);
    });

    test('updates elements when remote is newer', () => {
      // Insert old version
      const oldTask = createTestElement({
        id: 'el-task1' as ElementId,
        title: 'Old Title',
        updatedAt: '2025-01-20T10:00:00.000Z' as Timestamp,
      });
      insertElement(backend, oldTask);

      // Create newer version in JSONL
      const newTask = createTestElement({
        id: 'el-task1' as ElementId,
        title: 'New Title',
        updatedAt: '2025-01-22T10:00:00.000Z' as Timestamp,
      });

      // Use export/parse to get proper JSONL
      const tempBackend = createTestBackend(join(tempDir, 'temp-export.db'));
      insertElement(tempBackend, newTask);
      const tempService = createSyncService(tempBackend);
      const exported = tempService.exportToString();
      tempBackend.close();

      // Import newer version
      const result = service.importFromStrings(exported.elements, '');

      expect(result.elementsImported).toBe(1);
      expect(result.conflicts).toHaveLength(1);
    });

    test('merges tags from both versions', () => {
      // Insert local with tags
      const localTask = createTestElement({
        id: 'el-task1' as ElementId,
        tags: ['local-tag'],
        updatedAt: '2025-01-20T10:00:00.000Z' as Timestamp,
      });
      insertElement(backend, localTask);

      // Create remote with different tags
      const remoteTask = createTestElement({
        id: 'el-task1' as ElementId,
        tags: ['remote-tag'],
        updatedAt: '2025-01-22T10:00:00.000Z' as Timestamp,
      });

      const tempBackend = createTestBackend(join(tempDir, 'temp-export2.db'));
      insertElement(tempBackend, remoteTask);
      const tempService = createSyncService(tempBackend);
      const exported = tempService.exportToString();
      tempBackend.close();

      // Import
      service.importFromStrings(exported.elements, '');

      // Check merged tags
      const tagRows = backend.query<{ tag: string }>('SELECT tag FROM tags WHERE element_id = ?', [
        'el-task1',
      ]);
      const tags = tagRows.map((r) => r.tag);

      expect(tags).toContain('local-tag');
      expect(tags).toContain('remote-tag');
    });

    test('force option overwrites local changes', () => {
      // Insert local version
      const localTask = createTestElement({
        id: 'el-task1' as ElementId,
        title: 'Local Title',
        updatedAt: '2025-01-22T10:00:00.000Z' as Timestamp, // Newer
      });
      insertElement(backend, localTask);

      // Create older remote version
      const remoteTask = createTestElement({
        id: 'el-task1' as ElementId,
        title: 'Remote Title',
        updatedAt: '2025-01-20T10:00:00.000Z' as Timestamp, // Older
      });

      const tempBackend = createTestBackend(join(tempDir, 'temp-export3.db'));
      insertElement(tempBackend, remoteTask);
      const tempService = createSyncService(tempBackend);
      const exported = tempService.exportToString();
      tempBackend.close();

      // Import with force
      const result = service.importFromStrings(exported.elements, '', { force: true });

      expect(result.elementsImported).toBe(1);

      // Verify remote version was applied
      const row = backend.queryOne<{ data: string }>('SELECT data FROM elements WHERE id = ?', [
        'el-task1',
      ]);
      const data = JSON.parse(row?.data ?? '{}');
      expect(data.title).toBe('Remote Title');
    });
  });

  // --------------------------------------------------------------------------
  // Round-Trip Tests
  // --------------------------------------------------------------------------

  describe('round-trip', () => {
    test('export and import preserves all data', async () => {
      // Insert various elements
      const entity = createTestEntity({
        id: 'el-entity1' as ElementId,
        name: 'Test User',
      });
      const task1 = createTestElement({
        id: 'el-task1' as ElementId,
        title: 'Task 1',
        tags: ['tag1', 'tag2'],
        metadata: { key: 'value' },
      });
      const task2 = createTestElement({
        id: 'el-task2' as ElementId,
        title: 'Task 2',
      });
      insertElement(backend, entity);
      insertElement(backend, task1);
      insertElement(backend, task2);

      // Add dependency
      insertDependency(backend, createTestDependency(task1.id, task2.id));

      // Export
      const exportDir = join(tempDir, 'export');
      const exportResult = await service.export({ outputDir: exportDir, full: true });

      // Verify exported files exist
      expect(existsSync(exportResult.elementsFile)).toBe(true);
      expect(existsSync(exportResult.dependenciesFile)).toBe(true);

      // Create new database and import
      const newDbPath = join(tempDir, 'new.db');
      const newBackend = createTestBackend(newDbPath);
      const newService = createSyncService(newBackend);

      const importResult = await newService.import({ inputDir: exportDir });

      expect(importResult.elementsImported).toBe(3);
      expect(importResult.dependenciesImported).toBe(1);
      expect(importResult.errors).toHaveLength(0);

      // Verify data integrity
      expect(getElementCount(newBackend)).toBe(3);
      expect(getDependencyCount(newBackend)).toBe(1);

      // Verify entity
      const entityRow = newBackend.queryOne<{ data: string; type: string }>(
        'SELECT data, type FROM elements WHERE id = ?',
        ['el-entity1']
      );
      expect(entityRow?.type).toBe('entity');
      expect(JSON.parse(entityRow?.data ?? '{}').name).toBe('Test User');

      // Verify task with tags and metadata
      const taskRow = newBackend.queryOne<{ data: string }>(
        'SELECT data FROM elements WHERE id = ?',
        ['el-task1']
      );
      const taskData = JSON.parse(taskRow?.data ?? '{}');
      expect(taskData.title).toBe('Task 1');
      expect(taskData.metadata).toEqual({ key: 'value' });

      // Verify tags
      const tagRows = newBackend.query<{ tag: string }>(
        'SELECT tag FROM tags WHERE element_id = ?',
        ['el-task1']
      );
      expect(tagRows.map((r) => r.tag).sort()).toEqual(['tag1', 'tag2']);

      // Verify dependency
      const depRow = newBackend.queryOne<{ blocked_id: string; blocker_id: string }>(
        'SELECT blocked_id, blocker_id FROM dependencies'
      );
      expect(depRow?.blocked_id).toBe('el-task1');
      expect(depRow?.blocker_id).toBe('el-task2');

      newBackend.close();
    });

    test('multiple export/import cycles are stable', async () => {
      // Insert data
      const task = createTestElement({
        id: 'el-task1' as ElementId,
        title: 'Stable Task',
        tags: ['stable'],
      });
      insertElement(backend, task);

      const exportDir = join(tempDir, 'export');

      // First export
      await service.export({ outputDir: exportDir, full: true });
      const content1 = readFileSync(join(exportDir, 'elements.jsonl'), 'utf-8');

      // Import back
      backend.run('DELETE FROM elements');
      backend.run('DELETE FROM tags');
      await service.import({ inputDir: exportDir });

      // Second export
      await service.export({ outputDir: exportDir, full: true });
      const content2 = readFileSync(join(exportDir, 'elements.jsonl'), 'utf-8');

      // Content should be identical (excluding timestamps in createdAt/updatedAt)
      const parsed1 = parseElements(content1).elements;
      const parsed2 = parseElements(content2).elements;

      expect(parsed1.length).toBe(parsed2.length);
      expect(parsed1[0].id).toBe(parsed2[0].id);
      expect(parsed1[0].tags).toEqual(parsed2[0].tags);
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling Tests
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    test('reports parse errors in elements', () => {
      const badContent = `{"invalid": "element"}
{"also": "invalid"}`;

      const result = service.importFromStrings(badContent, '');

      expect(result.elementsImported).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].file).toBe('elements');
    });

    test('reports parse errors in dependencies', () => {
      const elementsContent = '';
      const badDepsContent = `{"invalid": "dependency"}`;

      const result = service.importFromStrings(elementsContent, badDepsContent);

      expect(result.dependenciesImported).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].file).toBe('dependencies');
    });

    test('continues importing valid elements despite errors', () => {
      // Create one valid element
      const task = createTestElement({ id: 'el-task1' as ElementId });
      const tempBackend = createTestBackend(join(tempDir, 'temp.db'));
      insertElement(tempBackend, task);
      const exported = createSyncService(tempBackend).exportToString();
      tempBackend.close();

      // Add invalid content
      const mixedContent = `${exported.elements}
{"invalid": "element"}`;

      const result = service.importFromStrings(mixedContent, '');

      expect(result.elementsImported).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });
});
