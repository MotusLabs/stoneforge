/**
 * Query API Performance Tests
 *
 * Performance benchmarks for the QuarryAPI query operations.
 * These tests measure execution time and ensure operations complete
 * within acceptable thresholds for various dataset sizes.
 *
 * Load-sensitive assertions (single-op thresholds and scaling ratios)
 * measure CPU time via process.cpuUsage() rather than wall clock — wall
 * clock on a shared or concurrently-loaded machine measures the load, not
 * the code (see measureCpu below and el-50x1, el-1ao326).
 *
 * Benchmark categories:
 * - CRUD operations (create, get, list, update, delete)
 * - Task queries (ready, blocked)
 * - Dependency operations
 * - Search operations
 * - Pagination performance
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { QuarryAPIImpl } from './quarry-api.js';
import { createStorage, initializeSchema } from '@stoneforge/storage';
import type { StorageBackend } from '@stoneforge/storage';
import type { Element, EntityId, ElementId, Task, Document } from '@stoneforge/core';
import { createTask, Priority, TaskStatus, createDocument, ContentType, DependencyType } from '@stoneforge/core';
import type { TaskFilter } from './types.js';

// ============================================================================
// Test Configuration
// ============================================================================

/**
 * Performance thresholds in milliseconds
 * These are conservative thresholds that should pass on most systems
 */
const THRESHOLDS = {
  // Single operation thresholds
  singleCreate: 50,
  singleGet: 10,
  singleUpdate: 50,
  singleDelete: 50,

  // Batch operation thresholds (per item average)
  batchCreatePerItem: 15,
  batchGetPerItem: 5,

  // Query thresholds for 100 items
  listAll: 100,
  listFiltered: 100,
  listPaginated: 50,

  // Task-specific query thresholds for 100 items
  ready: 150,
  blocked: 150,

  // Dependency thresholds
  addDependency: 50,
  getDependencyTree: 200,

  // Search thresholds for 100 items
  search: 200,
};

/**
 * Test dataset sizes
 * Note: DEFAULT_PAGE_SIZE in the API is 50, so tests expecting exact counts
 * should use small or pageSize datasets to avoid pagination issues.
 */
const DATASET_SIZES = {
  small: 10,
  pageSize: 50, // Matches DEFAULT_PAGE_SIZE to avoid pagination issues
  medium: 100,
  large: 200, // Reduced from 500 for faster test runs
};

// ============================================================================
// Test Helpers
// ============================================================================

const mockEntityId = 'user:perf-test' as EntityId;

/**
 * Helper to cast element for api.create()
 */
function toCreateInput<T extends Element>(element: T): Parameters<QuarryAPIImpl['create']>[0] {
  return element as unknown as Parameters<QuarryAPIImpl['create']>[0];
}

/**
 * Create a test task element with unique ID
 * Generates a unique element ID to avoid hash collisions
 */
async function createTestTask(
  overrides: Partial<Parameters<typeof createTask>[0]> = {}
): Promise<Task> {
  // Generate a unique ID directly to avoid hash collision issues
  const uniqueId = `el-${crypto.randomUUID().replace(/-/g, '').substring(0, 8)}` as ElementId;
  return createTask({
    id: uniqueId,
    title: `PerfTest-${uniqueId}`,
    createdBy: mockEntityId,
    tags: ['perf-test'],
    ...overrides,
  });
}

/**
 * Create a test document element with unique content
 * Uses UUID for guaranteed uniqueness
 */
async function createTestDocument(
  overrides: Partial<Parameters<typeof createDocument>[0]> = {}
): Promise<Document> {
  const uniqueId = crypto.randomUUID();
  return createDocument({
    contentType: ContentType.MARKDOWN,
    content: `# Document ${uniqueId}\n\nThis is a test document for performance testing.`,
    createdBy: mockEntityId,
    tags: ['perf-test'],
    ...overrides,
  });
}

/**
 * Measure execution time of an async function
 */
async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}

/**
 * Measure per-call duration of an async function, avoiding sub-millisecond samples.
 *
 * Repeats the call inside a single timed block until the sample is at least
 * `minMs` milliseconds (or `maxBatch` calls), then returns the per-call average.
 * Sub-millisecond timings are dominated by timer resolution and scheduler noise,
 * which makes ratio assertions flaky under full-suite load.
 */
async function measurePerCall(
  fn: () => Promise<unknown>,
  minMs = 1,
  maxBatch = 64
): Promise<number> {
  let batch = 1;
  for (;;) {
    const { duration } = await measureTime(async () => {
      for (let i = 0; i < batch; i++) {
        await fn();
      }
    });
    if (duration >= minMs || batch >= maxBatch) {
      return duration / batch;
    }
    batch *= 2;
  }
}

/**
 * Measure CPU time (user + system, ms) consumed by an async block.
 *
 * Used instead of wall clock for assertions that must hold while the machine
 * is loaded (a concurrent `bun run build`, CI neighbors, k8s CPU quotas).
 * Wall clock for small operations is dominated by descheduling: a ~0.25ms
 * addDependency has been observed at 260ms and a flat per-item cost at 6x
 * ratio purely from scheduler stalls (el-1ao326). CPU time ignores stalls
 * and throttling, so it tracks the code's intrinsic cost — what performance
 * assertions actually intend to measure.
 *
 * Two rules still apply (see the Test Runner Convention doc, el-50x1):
 * - Batch enough calls into one sample that the CPU delta is far above
 *   clock granularity (~tens of µs); a single sub-millisecond call is not
 *   a measurable CPU sample either.
 * - Take the min of several samples: GC and JIT warmup run on-CPU and
 *   inflate individual samples.
 */
async function measureCpu<T>(fn: () => Promise<T>): Promise<number> {
  const startCpu = process.cpuUsage();
  await fn();
  const delta = process.cpuUsage(startCpu);
  return (delta.user + delta.system) / 1000;
}

/**
 * Per-call CPU cost of `fn`: runs `batch` calls inside one CPU-timed block
 * and divides. `fn` must be safe to call `batch` times (use distinct inputs
 * for mutating operations like addDependency).
 */
async function measureCpuPerCall(fn: () => Promise<unknown>, batch: number): Promise<number> {
  const cpu = await measureCpu(async () => {
    for (let i = 0; i < batch; i++) {
      await fn();
    }
  });
  return cpu / batch;
}

/**
 * Create multiple tasks in batch with unique IDs
 */
async function createTaskBatch(
  api: QuarryAPIImpl,
  count: number,
  overrides: Partial<Parameters<typeof createTask>[0]> = {}
): Promise<Task[]> {
  const tasks: Task[] = [];
  for (let i = 0; i < count; i++) {
    const task = await createTestTask(overrides);
    const created = await api.create(toCreateInput(task));
    tasks.push(created as Task);
  }
  return tasks;
}

// ============================================================================
// Performance Tests
// ============================================================================

describe('Query API Performance', () => {
  let backend: StorageBackend;
  let api: QuarryAPIImpl;

  beforeEach(() => {
    backend = createStorage({ path: ':memory:' });
    initializeSchema(backend);
    api = new QuarryAPIImpl(backend);
  });

  afterEach(() => {
    if (backend.isOpen) {
      backend.close();
    }
  });

  // ==========================================================================
  // Single Operation Performance
  // ==========================================================================

  describe('Single Operation Performance', () => {
    it('should create a single task within threshold', async () => {
      const task = await createTestTask();
      const { duration } = await measureTime(() => api.create(toCreateInput(task)));

      expect(duration).toBeLessThan(THRESHOLDS.singleCreate);
    });

    it('should get a single element within threshold', async () => {
      const task = await createTestTask();
      const created = await api.create(toCreateInput(task));

      const { duration } = await measureTime(() => api.get(created.id));

      expect(duration).toBeLessThan(THRESHOLDS.singleGet);
    });

    it('should update a single element within threshold', async () => {
      const task = await createTestTask();
      const created = await api.create(toCreateInput(task));

      const { duration } = await measureTime(() =>
        api.update<Task>(created.id, { title: 'Updated Title' })
      );

      expect(duration).toBeLessThan(THRESHOLDS.singleUpdate);
    });

    it('should delete a single element within threshold', async () => {
      const task = await createTestTask();
      const created = await api.create(toCreateInput(task));

      const { duration } = await measureTime(() => api.delete(created.id));

      expect(duration).toBeLessThan(THRESHOLDS.singleDelete);
    });
  });

  // ==========================================================================
  // Batch Create Performance
  // ==========================================================================

  describe('Batch Create Performance', () => {
    it('should create small batch of tasks efficiently', async () => {
      const count = DATASET_SIZES.small;
      const { duration } = await measureTime(async () => {
        await createTaskBatch(api, count);
      });

      const perItem = duration / count;
      expect(perItem).toBeLessThan(THRESHOLDS.batchCreatePerItem);
    });

    it('should create medium batch of tasks efficiently', async () => {
      const count = DATASET_SIZES.medium;
      const { duration } = await measureTime(async () => {
        await createTaskBatch(api, count);
      });

      const perItem = duration / count;
      expect(perItem).toBeLessThan(THRESHOLDS.batchCreatePerItem);
    });

    it('should create large batch of tasks with reasonable performance', async () => {
      const count = DATASET_SIZES.large;
      const { duration } = await measureTime(async () => {
        await createTaskBatch(api, count);
      });

      // For large batches, allow 2x the per-item threshold
      const perItem = duration / count;
      expect(perItem).toBeLessThan(THRESHOLDS.batchCreatePerItem * 2);
    });
  });

  // ==========================================================================
  // List Query Performance
  // ==========================================================================

  describe('List Query Performance', () => {
    beforeEach(async () => {
      // Pre-populate with medium dataset
      await createTaskBatch(api, DATASET_SIZES.medium);
    });

    it('should list all elements within threshold', async () => {
      const { result, duration } = await measureTime(() =>
        api.list<Task>({ type: 'task', limit: DATASET_SIZES.medium })
      );

      expect(result.length).toBe(DATASET_SIZES.medium);
      expect(duration).toBeLessThan(THRESHOLDS.listAll);
    });

    it('should list with status filter within threshold', async () => {
      const { duration } = await measureTime(() =>
        api.list<Task>({ type: 'task', status: TaskStatus.OPEN } as TaskFilter)
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });

    it('should list with priority filter within threshold', async () => {
      const { duration } = await measureTime(() =>
        api.list<Task>({ type: 'task', priority: Priority.MEDIUM } as TaskFilter)
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });

    it('should list with tag filter within threshold', async () => {
      const { duration } = await measureTime(() =>
        api.list<Task>({ type: 'task', tags: ['batch-5'] })
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });

    it('should list with pagination within threshold', async () => {
      const { result, duration } = await measureTime(() =>
        api.listPaginated<Task>({ type: 'task', limit: 20, offset: 0 })
      );

      expect(result.items.length).toBe(20);
      expect(duration).toBeLessThan(THRESHOLDS.listPaginated);
    });

    it('should handle multiple pages efficiently', async () => {
      const pageSize = 20;
      const totalPages = Math.ceil(DATASET_SIZES.medium / pageSize);
      const durations: number[] = [];

      for (let page = 0; page < totalPages; page++) {
        const { duration } = await measureTime(() =>
          api.listPaginated<Task>({
            type: 'task',
            limit: pageSize,
            offset: page * pageSize,
          })
        );
        durations.push(duration);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avgDuration).toBeLessThan(THRESHOLDS.listPaginated);
    });

    it('should sort by created_at within threshold', async () => {
      const { duration } = await measureTime(() =>
        api.list<Task>({ type: 'task', orderBy: 'created_at', orderDir: 'desc' })
      );

      expect(duration).toBeLessThan(THRESHOLDS.listFiltered);
    });
  });

  // ==========================================================================
  // Ready/Blocked Query Performance
  // ==========================================================================

  describe('Ready/Blocked Query Performance', () => {
    it('should query ready tasks with no dependencies within threshold', async () => {
      // Use pageSize to stay within default API limits
      await createTaskBatch(api, DATASET_SIZES.pageSize);

      const { result, duration } = await measureTime(() => api.ready());

      expect(result.length).toBe(DATASET_SIZES.pageSize);
      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });

    it('should query ready tasks with filters within threshold', async () => {
      await createTaskBatch(api, DATASET_SIZES.pageSize);

      const { duration } = await measureTime(() =>
        api.ready({ priority: Priority.MEDIUM })
      );

      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });

    it('should query blocked tasks within threshold', async () => {
      // Create tasks with dependencies - use pageSize to stay within limits
      const tasks = await createTaskBatch(api, DATASET_SIZES.pageSize);

      // Block half the tasks
      for (let i = 0; i < DATASET_SIZES.pageSize / 2; i++) {
        const blockerIdx = i * 2;
        const blockedIdx = i * 2 + 1;
        if (blockedIdx < tasks.length) {
          await api.addDependency({
            blockerId: tasks[blockedIdx].id,
            blockedId: tasks[blockerIdx].id,
            type: DependencyType.BLOCKS,
          });
        }
      }

      const { result, duration } = await measureTime(() => api.blocked());

      expect(result.length).toBe(DATASET_SIZES.pageSize / 2);
      expect(duration).toBeLessThan(THRESHOLDS.blocked);
    });

    it('should handle ready query with complex dependency graph', async () => {
      const tasks = await createTaskBatch(api, DATASET_SIZES.pageSize);

      // Create a chain of dependencies: task[0] <- task[1] <- task[2] <- ... <- task[9]
      for (let i = 0; i < 10; i++) {
        if (i > 0) {
          await api.addDependency({
            blockerId: tasks[i].id,
            blockedId: tasks[i - 1].id,
            type: DependencyType.BLOCKS,
          });
        }
      }

      const { duration } = await measureTime(() => api.ready());

      // Should still complete within threshold even with chain
      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });

    it('should handle ready query by assignee within threshold', async () => {
      // Create tasks with different assignees - use pageSize to stay within limits
      for (let i = 0; i < DATASET_SIZES.pageSize; i++) {
        const task = await createTestTask({
          assignee: `user:agent-${i % 10}` as EntityId,
        });
        await api.create(toCreateInput(task));
      }

      const { result, duration } = await measureTime(() =>
        api.ready({ assignee: 'user:agent-0' as EntityId })
      );

      // 10% of tasks should be assigned to agent-0
      expect(result.length).toBe(DATASET_SIZES.pageSize / 10);
      expect(duration).toBeLessThan(THRESHOLDS.ready);
    });
  });

  // ==========================================================================
  // Dependency Operation Performance
  // ==========================================================================

  describe('Dependency Operation Performance', () => {
    it('should add dependency within threshold', async () => {
      // What this asserts: one addDependency call (dependency row insert +
      // dirty mark) costs far less than THRESHOLDS.addDependency — 50ms is
      // ~200x its intrinsic ~0.25ms of CPU.
      //
      // Why the old version flaked (el-1ao326): it timed a SINGLE call and
      // asserted its wall clock. Under a concurrent root build a ~0.25ms op
      // measured 57.9ms purely from descheduling (an intermediate
      // batch-until->=1ms attempt was also defeated: a single stalled call
      // is itself ">= 1ms", so the floor admits exactly the bad sample it
      // was meant to exclude). Wall clock here measures the machine's load,
      // not the code.
      //
      // Fix: measure CPU time (process.cpuUsage), which ignores stalls and
      // throttling, over a batch of DISTINCT dependency pairs (distinct
      // because addDependency mutates — duplicates are rejected), and take
      // the min of 3 batches to shed GC/JIT noise. The fixed-count loop
      // shape is separately covered by "should add multiple dependencies
      // efficiently" below.
      const BATCH = 64; // ~15ms CPU per sample, far above clock granularity
      const RUNS = 3;
      const pairPool = await createTaskBatch(api, BATCH * RUNS * 2 + 2);
      // Warmup (JIT + statement preparation) on the LAST pair so it cannot
      // collide with a measured pair.
      await api.addDependency({
        blockerId: pairPool[pairPool.length - 1].id,
        blockedId: pairPool[pairPool.length - 2].id,
        type: DependencyType.BLOCKS,
      });

      let call = 0;
      const samples: number[] = [];
      for (let r = 0; r < RUNS; r++) {
        samples.push(
          await measureCpuPerCall(() => {
            const i = call++;
            return api.addDependency({
              blockerId: pairPool[i * 2 + 1].id,
              blockedId: pairPool[i * 2].id,
              type: DependencyType.BLOCKS,
            });
          }, BATCH)
        );
      }

      expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.addDependency);
    });

    it('should add multiple dependencies efficiently', async () => {
      const count = DATASET_SIZES.small;
      const tasks = await createTaskBatch(api, count * 2);

      const { duration } = await measureTime(async () => {
        for (let i = 0; i < count; i++) {
          await api.addDependency({
            blockerId: tasks[i * 2 + 1].id,
            blockedId: tasks[i * 2].id,
            type: DependencyType.BLOCKS,
          });
        }
      });

      const perDep = duration / count;
      expect(perDep).toBeLessThan(THRESHOLDS.addDependency);
    });

    it('should get dependency tree within threshold', async () => {
      // Create a tree structure
      const tasks = await createTaskBatch(api, 20);

      // Create tree: 0 is root, 1-3 depend on 0, 4-12 depend on 1-3
      for (let i = 1; i <= 3; i++) {
        await api.addDependency({
          blockerId: tasks[i].id,
          blockedId: tasks[0].id,
          type: DependencyType.BLOCKS,
        });
      }
      for (let i = 4; i <= 12; i++) {
        await api.addDependency({
          blockerId: tasks[i].id,
          blockedId: tasks[Math.floor((i - 1) / 3)].id,
          type: DependencyType.BLOCKS,
        });
      }

      const { result, duration } = await measureTime(() =>
        api.getDependencyTree(tasks[0].id)
      );

      expect(result.root.element.id).toBe(tasks[0].id);
      expect(duration).toBeLessThan(THRESHOLDS.getDependencyTree);
    });

    it('should get dependencies and dependents within threshold', async () => {
      const tasks = await createTaskBatch(api, 20);

      // Create hub-and-spoke: tasks 1-19 all blocked by task 0
      for (let i = 1; i < 20; i++) {
        await api.addDependency({
          blockedId: tasks[i].id,
          blockerId: tasks[0].id,
          type: DependencyType.BLOCKS,
        });
      }

      const { result: deps, duration: depsTime } = await measureTime(() =>
        api.getDependencies(tasks[1].id)
      );

      const { result: dependents, duration: dependentsTime } = await measureTime(() =>
        api.getDependents(tasks[0].id)
      );

      expect(deps.length).toBe(1);
      expect(dependents.length).toBe(19);
      expect(depsTime).toBeLessThan(50);
      expect(dependentsTime).toBeLessThan(100);
    });
  });

  // ==========================================================================
  // Search Performance
  // ==========================================================================

  describe('Search Performance', () => {
    // Use unique keyword per test run to avoid collisions with parallel tests
    const uniqueSearchKeyword = `SearchPerf${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;

    beforeEach(async () => {
      // Pre-populate with documents for search testing
      // Use explicit unique IDs to avoid hash collisions that can occur
      // when many documents are created in quick succession
      for (let i = 0; i < DATASET_SIZES.medium; i++) {
        // Use unique keyword instead of generic 'Important' to avoid collisions
        const keyword = i % 2 === 0 ? uniqueSearchKeyword : 'RegularDoc';
        const uniqueId = crypto.randomUUID();
        // Generate explicit unique ID to avoid hash collision issues
        const docId = `el-${crypto.randomUUID().replace(/-/g, '').substring(0, 8)}` as ElementId;
        const doc = await createDocument({
          contentType: ContentType.MARKDOWN,
          content: `# ${keyword} Document ${uniqueId}\n\nThis is a ${keyword.toLowerCase()} test document for performance testing.`,
          createdBy: mockEntityId,
        });
        // Override the hash-generated ID with our explicit unique ID
        (doc as unknown as { id: ElementId }).id = docId;
        await api.create(toCreateInput(doc));
      }
    });

    it('should search by content keyword within threshold', async () => {
      const { result, duration } = await measureTime(() =>
        api.search(uniqueSearchKeyword)
      );

      // Half the documents have the unique keyword in content
      expect(result.length).toBe(DATASET_SIZES.medium / 2);
      expect(duration).toBeLessThan(THRESHOLDS.search);
    });

    it('should search by content within threshold', async () => {
      const { duration } = await measureTime(() =>
        api.search('performance testing')
      );

      expect(duration).toBeLessThan(THRESHOLDS.search);
    });

    it('should search with type filter within threshold', async () => {
      // Add some tasks too
      await createTaskBatch(api, 20);

      const { duration } = await measureTime(() =>
        api.search('Document', { type: 'document' })
      );

      expect(duration).toBeLessThan(THRESHOLDS.search);
    });
  });

  // ==========================================================================
  // Scaling Performance
  // ==========================================================================

  describe('Scaling Performance', () => {
    it('should maintain consistent per-item performance as dataset grows', async () => {
      // What this asserts: per-item create cost is flat in dataset size
      // (SQLite B-tree insert is O(log n); measured CPU ratio ~0.8-0.95
      // across these sizes — fixed per-batch cost amortizes, so the small
      // size is usually the most expensive per item).
      //
      // Why the old version flaked (el-1ao326): it compared WALL-CLOCK
      // per-item times from one batch per size, sizes [10, 50, 100]. The
      // size-10 denominator was a ~1ms sample, so scheduler noise under a
      // concurrent build produced ratios up to 6.2 despite flat underlying
      // cost — and wall-clock per-item keeps drifting with machine load even
      // at larger sizes. Wall clock measures the load, not the scaling.
      //
      // Fix: measure CPU time (process.cpuUsage — immune to descheduling
      // and CPU-quota throttling), MIN of 3 fresh-database runs per size to
      // shed GC/JIT noise.
      //
      // Bound: flat cost measures ~0.8-0.95 in CPU. If inserts were O(table
      // size), creating S tasks would cost ~(S+1)/2 per item, giving a ratio
      // of (200+1)/(50+1) ~= 3.9 over 50 -> 200. Asserting < 2 catches that
      // quadratic signature with headroom on both sides.
      const sizes = [50, 100, 200];
      const RUNS_PER_SIZE = 3;
      const perItemTimes: number[] = [];

      for (const size of sizes) {
        const runs: number[] = [];
        for (let r = 0; r < RUNS_PER_SIZE; r++) {
          // Fresh database for each run
          if (backend.isOpen) {
            backend.close();
          }
          backend = createStorage({ path: ':memory:' });
          initializeSchema(backend);
          api = new QuarryAPIImpl(backend);

          // Create batch
          const cpuMs = await measureCpu(async () => {
            await createTaskBatch(api, size);
          });
          runs.push(cpuMs / size);
        }
        perItemTimes.push(Math.min(...runs));
      }

      const ratio = perItemTimes[perItemTimes.length - 1] / perItemTimes[0];
      expect(ratio).toBeLessThan(2);
    });

    it('should maintain list performance as dataset grows', async () => {
      // What this asserts: a FIXED page (limit: 50) costs the same regardless
      // of table size. This became true when listPaginated's default path
      // stopped materializing the match set: DISTINCT is only emitted for tag
      // joins, the ordering indexes on (type, ...) and (deleted_at, ...) let
      // SQLite read a page straight from the index with LIMIT applied first
      // (the ORDER BY ends with an explicit rowid tiebreaker in the query's
      // direction, so a forward or backward scan of one index serves asc and
      // desc pages), and list() skips the COUNT pass entirely
      // (list-query-plan.bun.test.ts pins the query plan and the tie order).
      //
      // Before that fix the plan was "SEARCH e USING INDEX idx_elements_type |
      // USE TEMP B-TREE FOR DISTINCT | USE TEMP B-TREE FOR ORDER BY", so even a
      // fixed page was O(n) in table size and any ratio assertion sat on the
      // linear edge (see el-2htt05, which had to assert linear growth instead).
      const sizes = [100, 250, 500];
      const PAGE_SIZE = 50;
      const listTimes: number[] = [];
      const RUNS_PER_SIZE = 5;

      for (const size of sizes) {
        // Fresh database for each size
        if (backend.isOpen) {
          backend.close();
        }
        backend = createStorage({ path: ':memory:' });
        initializeSchema(backend);
        api = new QuarryAPIImpl(backend);

        await createTaskBatch(api, size);

        // Warmup run to avoid cold-start variance
        await api.list<Task>({ type: 'task', limit: PAGE_SIZE });

        // Median of several runs. Each run batches calls inside the timed block
        // until the sample is ≥1ms so we never compare sub-millisecond timings.
        const runs: number[] = [];
        for (let r = 0; r < RUNS_PER_SIZE; r++) {
          runs.push(
            await measurePerCall(() => api.list<Task>({ type: 'task', limit: PAGE_SIZE }))
          );
        }
        runs.sort((a, b) => a - b);
        listTimes.push(runs[Math.floor(runs.length / 2)]);
      }

      // A page read from the ordering index should not care about table size at
      // all (measured ratio ~1). 2x headroom for scheduler noise, far below the
      // 5x the table grew — a regression back to temp-b-tree materialization
      // pushes the ratio toward sizeRatio and fails this.
      const ratio = listTimes[listTimes.length - 1] / listTimes[0];
      const sizeRatio = sizes[sizes.length - 1] / sizes[0];
      expect(ratio).toBeLessThan(sizeRatio * 0.4);
    });

    it('should maintain ready query performance as dependencies grow', async () => {
      // What this asserts: ready() does not get dramatically more expensive
      // as the dependency table grows. True behavior is nearly flat with a
      // slight rise (measured CPU ratio ~1.0-1.2 from 0 to 50 deps) — each
      // BLOCKS pair also removes a task from the ready set, which partly
      // offsets the bigger dependency table — while a per-dependency scan
      // per task (O(deps x tasks)) would blow far past the bound at 50 deps.
      //
      // Why the old version flaked (el-1ao326): it compared two single-shot
      // WALL-CLOCK timings. The 0-dep baseline was ~1-2ms (less on a warm
      // cache), so the ratio's denominator was scheduler noise — 11.6 was
      // observed during a concurrent root build.
      //
      // Fix: measure CPU time (process.cpuUsage — immune to descheduling),
      // 8 calls per sample (~15ms CPU, above clock granularity; ready() is
      // a read, so repetition is safe), MIN of 5 samples after a warmup to
      // shed GC/JIT noise.
      const tasks = await createTaskBatch(api, 100);
      const timesWithDeps: number[] = [];

      // Measure with increasing number of dependencies
      const depCounts = [0, 10, 25, 50];
      const BATCH = 8;
      const RUNS = 5;

      for (let i = 0; i < depCounts.length; i++) {
        const depCount = depCounts[i];
        const prevDepCount = i > 0 ? depCounts[i - 1] : 0;

        // Add new dependencies
        for (let j = prevDepCount; j < depCount && j * 2 + 1 < tasks.length; j++) {
          await api.addDependency({
            blockerId: tasks[j * 2 + 1].id,
            blockedId: tasks[j * 2].id,
            type: DependencyType.BLOCKS,
          });
        }

        // Warmup, then min of batched CPU-time per-call samples
        await api.ready();
        const runs: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          runs.push(await measureCpuPerCall(() => api.ready(), BATCH));
        }
        timesWithDeps.push(Math.min(...runs));
      }

      // Flat cost measured (~1.0-1.2 in CPU). 4x headroom absorbs residual
      // measurement noise while still sitting far below a dependency-count-
      // driven regression (which at 50 deps vs 0 would exceed 4x by a wide
      // margin). Do not tighten without re-measuring under load.
      const ratio = timesWithDeps[timesWithDeps.length - 1] / timesWithDeps[0];
      expect(ratio).toBeLessThan(4);
    });
  });

  // ==========================================================================
  // Combined Operation Performance
  // ==========================================================================

  describe('Combined Operation Performance', () => {
    it('should handle create-update-query cycle efficiently', async () => {
      const iterations = 20;
      const { duration } = await measureTime(async () => {
        for (let i = 0; i < iterations; i++) {
          const task = await createTestTask();
          const created = await api.create(toCreateInput(task));
          await api.update<Task>(created.id, {
            status: TaskStatus.IN_PROGRESS,
            title: `Updated Task ${i}`,
          });
          await api.ready();
        }
      });

      const perIteration = duration / iterations;
      // Each iteration should complete in reasonable time
      expect(perIteration).toBeLessThan(100);
    });

    it('should handle concurrent-like operations efficiently', async () => {
      // Simulate multiple operations that might happen in rapid succession
      const tasks = await createTaskBatch(api, 50);

      const { duration } = await measureTime(async () => {
        // Mix of operations
        await api.list<Task>({ type: 'task' });
        await api.ready();
        await api.get(tasks[0].id);
        await api.update<Task>(tasks[0].id, { status: TaskStatus.IN_PROGRESS });
        await api.ready();
        await api.blocked();
        await api.search('Test');
        await api.getDependencies(tasks[0].id);
      });

      // All operations should complete quickly
      expect(duration).toBeLessThan(500);
    });
  });

  // ==========================================================================
  // Stats Performance
  // ==========================================================================

  describe('Stats Performance', () => {
    it('should compute stats within threshold', async () => {
      // Create diverse dataset
      await createTaskBatch(api, DATASET_SIZES.medium);
      for (let i = 0; i < 20; i++) {
        const doc = await createTestDocument();
        await api.create(toCreateInput(doc));
      }

      const { result, duration } = await measureTime(() => api.stats());

      expect(result.elementsByType.task).toBe(DATASET_SIZES.medium);
      expect(result.elementsByType.document).toBe(20);
      expect(duration).toBeLessThan(200);
    });
  });
});

// ============================================================================
// Benchmark Summary Helper
// ============================================================================

describe('Performance Benchmark Summary', () => {
  let backend: StorageBackend;
  let api: QuarryAPIImpl;

  beforeAll(() => {
    backend = createStorage({ path: ':memory:' });
    initializeSchema(backend);
    api = new QuarryAPIImpl(backend);
  });

  afterAll(() => {
    if (backend.isOpen) {
      backend.close();
    }
  });

  it('should run comprehensive benchmark and log results', async () => {
    const results: Record<string, number> = {};

    // Create baseline dataset
    const tasks = await createTaskBatch(api, 100);

    // Measure key operations
    const { duration: listDuration } = await measureTime(() =>
      api.list<Task>({ type: 'task' })
    );
    results['list (100 items)'] = listDuration;

    const { duration: readyDuration } = await measureTime(() => api.ready());
    results['ready (100 items)'] = readyDuration;

    const { duration: searchDuration } = await measureTime(() =>
      api.search('Performance')
    );
    results['search (100 items)'] = searchDuration;

    const { duration: getDuration } = await measureTime(() =>
      api.get(tasks[0].id)
    );
    results['get (single)'] = getDuration;

    // Add some dependencies
    for (let i = 0; i < 25; i++) {
      await api.addDependency({
        blockerId: tasks[i * 2 + 1].id,
        blockedId: tasks[i * 2].id,
        type: DependencyType.BLOCKS,
      });
    }

    const { duration: blockedDuration } = await measureTime(() => api.blocked());
    results['blocked (25 blocked)'] = blockedDuration;

    const { duration: treeDuration } = await measureTime(() =>
      api.getDependencyTree(tasks[0].id)
    );
    results['getDependencyTree'] = treeDuration;

    const { duration: statsDuration } = await measureTime(() => api.stats());
    results['stats'] = statsDuration;

    // Log benchmark summary
    console.log('\n=== Performance Benchmark Summary ===');
    for (const [op, time] of Object.entries(results)) {
      console.log(`${op}: ${time.toFixed(2)}ms`);
    }
    console.log('=====================================\n');

    // Basic sanity checks - all operations should complete
    expect(Object.values(results).every((t) => t > 0)).toBe(true);
  });
});
