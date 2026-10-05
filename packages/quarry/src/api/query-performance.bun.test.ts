/**
 * Query API Performance Tests
 *
 * Performance benchmarks for the QuarryAPI query operations.
 * These tests measure execution time and ensure operations complete
 * within acceptable thresholds for various dataset sizes.
 *
 * Since el-19vmmo EVERY timing assertion in this file measures CPU time
 * via process.cpuUsage() (see measureCpu below) — wall clock on a shared
 * or concurrently-loaded machine measures the load, not the code (see
 * el-50x1 "Wall-Clock vs CPU Time", el-1ao326, el-19vmmo). The only
 * wall-clock timings left are in the log-only Benchmark Summary at the
 * bottom, which asserts nothing about time.
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
 * Performance thresholds in milliseconds.
 *
 * All assertions comparing against these measure CPU time (process.cpuUsage),
 * which is immune to descheduling and CPU-quota throttling. Each threshold is
 * annotated with the measured CPU cost it bounds (min-of-samples, unloaded
 * 16-core dev box, 2026-10-05, dataset sizes matching the asserting test) so
 * the headroom is explicit. The values are the original wall-clock numbers,
 * deliberately unchanged: CPU time <= wall clock, so keeping every number
 * makes each assertion strictly TIGHTER than its wall-clock version — these
 * tests guard against order-of-magnitude regressions, not fine tuning, and
 * no bound was moved to make a conversion pass (el-50x1: never raise a
 * threshold without a written reason).
 */
const THRESHOLDS = {
  // Single operation thresholds.
  // Measured CPU/call: create ~0.09ms, update ~0.09ms, delete ~0.12ms.
  singleCreate: 50, // ~550x headroom
  singleUpdate: 50, // ~550x headroom
  singleDelete: 50, // ~420x headroom
  // singleGet is deliberately 5x tighter than its siblings, and the asymmetry
  // is real, not an oversight (el-19vmmo review): a get is a single indexed
  // row read with no write path — no dirty mark, no content hash, no export
  // scheduling — and measures ~0.01ms CPU/call vs ~0.09ms for update, so it
  // is genuinely ~7-8x cheaper than the ops next to it. 10ms therefore leaves
  // ~800x headroom, MORE than singleUpdate's 50ms (~550x); the bound is not
  // the fragile one. What made it flake historically was measuring WALL clock:
  // any >10ms descheduling ate the entire budget, and >10ms stalls are routine
  // under a concurrent build. On CPU time 10ms is comfortable, so the value is
  // kept with this evidence rather than aligned to 50.
  singleGet: 10,

  // Batch operation thresholds (per item average).
  // Measured CPU/item for create: ~0.09ms.
  batchCreatePerItem: 15, // ~170x headroom
  batchGetPerItem: 5, // pre-existing; no current test asserts against it

  // Query thresholds for 100 items.
  // Measured CPU/call over a 100-task table: list(100) ~0.15ms, status/
  // priority/tag-filtered list ~0.18ms, sorted list ~0.15ms, 20-item page
  // ~0.06ms.
  listAll: 100, // ~650x headroom
  listFiltered: 100, // ~550x headroom
  listPaginated: 50, // ~850x headroom

  // Task-specific query thresholds for ~50-100 items.
  // Measured CPU/call: ready ~0.9ms (grows with table size; see the
  // ready-scaling test), blocked ~0.12ms.
  ready: 150, // ~170x headroom at 50 tasks
  blocked: 150, // ~1200x headroom

  // Dependency thresholds.
  // Measured CPU/call: addDependency ~0.19ms, getDependencyTree (13-node
  // tree) ~0.22ms, getDependencies ~0.005ms, getDependents (19 dependents)
  // ~0.014ms. getDependencies/getDependents were inline literals (50/100) at
  // the assertions until el-19vmmo lifted them here so the file has one
  // threshold style.
  addDependency: 50, // ~250x headroom
  getDependencyTree: 200, // ~900x headroom
  getDependencies: 50, // ~10000x headroom — cheapest op in the file
  getDependents: 100, // ~7000x headroom

  // Search thresholds for 100 documents.
  // Measured CPU/call: unique-keyword FTS match ~0.4ms, generic phrase
  // ~0.6ms.
  search: 200, // ~330x headroom

  // Combined-operation thresholds (lifted from inline literals by el-19vmmo:
  // one threshold style for the whole file).
  // Measured CPU/iteration (create + update + ready) ~1-2ms; the whole
  // 8-op mixed sequence ~3ms.
  combinedCyclePerIteration: 100, // ~50-100x headroom
  mixedOperationBatch: 500, // ~150x headroom for the whole 8-op sequence

  // Stats over ~120 elements. Measured CPU/call ~1.6ms.
  stats: 200, // ~120x headroom
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
    // What these assert: one CRUD call costs far less than its threshold —
    // each op's intrinsic cost is sub-millisecond of CPU against 10-50ms
    // thresholds (~50-500x headroom).
    //
    // Why the old versions flaked (el-1ao326 pattern, extended in el-19vmmo):
    // each test timed a SINGLE call and asserted its wall clock. Under a
    // sustained concurrent root build, pure descheduling measured a ~0.25ms
    // update at 60.7ms, a delete at 85.2ms and even a ~0.07ms get at ~94ms —
    // the assertions measured the machine's load, not the code.
    //
    // Fix: measure CPU time (process.cpuUsage — immune to descheduling and
    // CPU-quota throttling) over fixed batches of DISTINCT inputs for the
    // mutating ops (create/update/delete: duplicates are rejected by the API
    // or could hit no-op fast paths; delete consumes its input, so each
    // sample slices a fresh range of elements), taking the min of 3 samples
    // to shed GC/JIT noise. Rules documented in el-50x1 "Wall-Clock vs CPU
    // Time".
    const BATCH = 32; // ~5-30ms CPU per sample, far above clock granularity
    const RUNS = 3;

    it(
      'should create a single task within threshold',
      async () => {
        // Warmup (JIT + statement preparation) outside the measured samples
        await api.create(toCreateInput(await createTestTask()));

        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          samples.push(
            await measureCpuPerCall(async () => {
              // createTestTask generates a unique id per call — distinct inputs
              return api.create(toCreateInput(await createTestTask()));
            }, BATCH)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.singleCreate);
      },
      30_000
    );

    it(
      'should get a single element within threshold',
      async () => {
        const created = await api.create(toCreateInput(await createTestTask()));
        await api.get(created.id); // warmup

        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          // Read-only op: repeating the same call is safe
          samples.push(await measureCpuPerCall(() => api.get(created.id), BATCH));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.singleGet);
      },
      30_000
    );

    it(
      'should update a single element within threshold',
      async () => {
        const tasks = await createTaskBatch(api, BATCH);
        // Warmup on the first element
        await api.update<Task>(tasks[0].id, { title: 'Warmup Title' });

        let n = 0;
        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          samples.push(
            await measureCpuPerCall(() => {
              // Distinct element AND distinct value per call — a repeated
              // identical write could hit a no-op fast path
              const task = tasks[n % BATCH];
              const value = `Updated Title ${n}`;
              n++;
              return api.update<Task>(task.id, { title: value });
            }, BATCH)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.singleUpdate);
      },
      30_000
    );

    it(
      'should delete a single element within threshold',
      async () => {
        // Delete consumes its input: one fresh element per call across ALL
        // samples (batch 32 × 3 runs + 1 warmup), no reuse
        const tasks = await createTaskBatch(api, BATCH * RUNS + 1);
        await api.delete(tasks[0].id); // warmup

        let n = 1;
        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          samples.push(
            await measureCpuPerCall(() => {
              const task = tasks[n];
              n++;
              return api.delete(task.id);
            }, BATCH)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.singleDelete);
      },
      30_000
    );
  });

  // ==========================================================================
  // Batch Create Performance
  // ==========================================================================

  describe('Batch Create Performance', () => {
    // CPU-time conversion (el-19vmmo): these previously timed one batch on
    // wall clock and divided by count. The small batch (10 items against a
    // 15ms/item bound) had a total stall budget of only 150ms — one mid-batch
    // descheduling event under a sustained build crossed it, the same
    // single-shot defect class as the single-op tests above. Each sample is
    // now the CPU time of a whole fresh batch (createTaskBatch generates a
    // unique id per item, so every call in every sample is a distinct
    // input); min over several samples sheds GC/JIT noise. Samples later in
    // the run insert into a larger table, which is the O(log n) insert cost
    // the scaling test below pins separately.
    it(
      'should create small batch of tasks efficiently',
      async () => {
        const count = DATASET_SIZES.small;
        await api.create(toCreateInput(await createTestTask())); // warmup

        // 10 creates ≈ 0.9ms CPU per sample — the thinnest sample in this
        // file, so take the min of 5 runs.
        const samples: number[] = [];
        for (let r = 0; r < 5; r++) {
          const cpu = await measureCpu(async () => {
            await createTaskBatch(api, count);
          });
          samples.push(cpu / count);
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.batchCreatePerItem);
      },
      30_000
    );

    it(
      'should create medium batch of tasks efficiently',
      async () => {
        const count = DATASET_SIZES.medium;
        await api.create(toCreateInput(await createTestTask())); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          const cpu = await measureCpu(async () => {
            await createTaskBatch(api, count);
          });
          samples.push(cpu / count);
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.batchCreatePerItem);
      },
      30_000
    );

    it(
      'should create large batch of tasks with reasonable performance',
      async () => {
        const count = DATASET_SIZES.large;
        await api.create(toCreateInput(await createTestTask())); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          const cpu = await measureCpu(async () => {
            await createTaskBatch(api, count);
          });
          samples.push(cpu / count);
        }

        // For large batches, allow 2x the per-item threshold (unchanged bound)
        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.batchCreatePerItem * 2);
      },
      30_000
    );
  });

  // ==========================================================================
  // List Query Performance
  // ==========================================================================

  describe('List Query Performance', () => {
    beforeEach(async () => {
      // Pre-populate with medium dataset
      await createTaskBatch(api, DATASET_SIZES.medium);
    });

    // CPU-time conversion (el-19vmmo): these were single-shot WALL-CLOCK
    // timings of one list call — exactly the shape that failed for
    // listPaginated (188ms wall for a ~0.2ms-of-CPU page read under a
    // sustained build). All list variants are reads, so each sample repeats
    // the same call 32 times (~3-6ms CPU per sample); min of 3 samples
    // sheds GC/JIT noise. Result-shape assertions moved onto the warmup
    // call so behaviour is still pinned.
    it(
      'should list all elements within threshold',
      async () => {
        const warm = await api.list<Task>({ type: 'task', limit: DATASET_SIZES.medium });
        expect(warm.length).toBe(DATASET_SIZES.medium);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(
              () => api.list<Task>({ type: 'task', limit: DATASET_SIZES.medium }),
              32
            )
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.listAll);
      },
      30_000
    );

    it(
      'should list with status filter within threshold',
      async () => {
        await api.list<Task>({ type: 'task', status: TaskStatus.OPEN } as TaskFilter); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(
              () => api.list<Task>({ type: 'task', status: TaskStatus.OPEN } as TaskFilter),
              32
            )
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.listFiltered);
      },
      30_000
    );

    it(
      'should list with priority filter within threshold',
      async () => {
        await api.list<Task>({ type: 'task', priority: Priority.MEDIUM } as TaskFilter); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(
              () => api.list<Task>({ type: 'task', priority: Priority.MEDIUM } as TaskFilter),
              32
            )
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.listFiltered);
      },
      30_000
    );

    it(
      'should list with tag filter within threshold',
      async () => {
        await api.list<Task>({ type: 'task', tags: ['batch-5'] }); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(() => api.list<Task>({ type: 'task', tags: ['batch-5'] }), 32)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.listFiltered);
      },
      30_000
    );

    it(
      'should list with pagination within threshold',
      async () => {
        // CPU-time measurement (el-19vmmo): a single wall-clock listPaginated
        // call measured 188ms under a sustained concurrent build for a page
        // read that costs a fraction of a ms of CPU — the threshold was
        // asserting machine load, not the query. Read-only op, so the batch
        // repeats the same call; min of 3 samples sheds GC/JIT noise.
        const result = await api.listPaginated<Task>({
          type: 'task',
          limit: 20,
          offset: 0,
        }); // warmup
        expect(result.items.length).toBe(20);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(
              () => api.listPaginated<Task>({ type: 'task', limit: 20, offset: 0 }),
              32
            )
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.listPaginated);
      },
      30_000
    );

    it(
      'should handle multiple pages efficiently',
      async () => {
        // Same CPU-time conversion as the single-page test above (el-19vmmo):
        // an average of single-shot WALL-CLOCK page fetches is dominated by
        // whichever page got descheduled; per-page CPU cost measures the code.
        const pageSize = 20;
        const totalPages = Math.ceil(DATASET_SIZES.medium / pageSize);
        const durations: number[] = [];

        for (let page = 0; page < totalPages; page++) {
          durations.push(
            await measureCpuPerCall(
              () =>
                api.listPaginated<Task>({
                  type: 'task',
                  limit: pageSize,
                  offset: page * pageSize,
                }),
              16
            )
          );
        }

        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
        expect(avgDuration).toBeLessThan(THRESHOLDS.listPaginated);
      },
      30_000
    );

    it(
      'should sort by created_at within threshold',
      async () => {
        await api.list<Task>({ type: 'task', orderBy: 'created_at', orderDir: 'desc' }); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(
              () => api.list<Task>({ type: 'task', orderBy: 'created_at', orderDir: 'desc' }),
              32
            )
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.listFiltered);
      },
      30_000
    );
  });

  // ==========================================================================
  // Ready/Blocked Query Performance
  // ==========================================================================

  describe('Ready/Blocked Query Performance', () => {
    // CPU-time conversion (el-19vmmo): each of these timed a SINGLE ready()
    // or blocked() call on wall clock — the same single-shot shape that
    // flaked elsewhere in this file (ready costs ~0.9ms of CPU; one 150ms+
    // descheduling stall under a sustained build crossed the threshold).
    // Both queries are reads, so samples repeat the same call; ready() is
    // the most expensive read here so its batch is 8 (~7ms CPU/sample),
    // blocked() uses 16. Min of 3 samples after a warmup; result-shape
    // assertions moved onto the warmup call.
    it(
      'should query ready tasks with no dependencies within threshold',
      async () => {
        // Use pageSize to stay within default API limits
        await createTaskBatch(api, DATASET_SIZES.pageSize);

        const warm = await api.ready();
        expect(warm.length).toBe(DATASET_SIZES.pageSize);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.ready(), 8));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.ready);
      },
      30_000
    );

    it(
      'should query ready tasks with filters within threshold',
      async () => {
        await createTaskBatch(api, DATASET_SIZES.pageSize);

        await api.ready({ priority: Priority.MEDIUM }); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.ready({ priority: Priority.MEDIUM }), 8));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.ready);
      },
      30_000
    );

    it(
      'should query blocked tasks within threshold',
      async () => {
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

        const warm = await api.blocked();
        expect(warm.length).toBe(DATASET_SIZES.pageSize / 2);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.blocked(), 16));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.blocked);
      },
      30_000
    );

    it(
      'should handle ready query with complex dependency graph',
      async () => {
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

        await api.ready(); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.ready(), 8));
        }

        // Should still complete within threshold even with chain
        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.ready);
      },
      30_000
    );

    it(
      'should handle ready query by assignee within threshold',
      async () => {
        // Create tasks with different assignees - use pageSize to stay within limits
        for (let i = 0; i < DATASET_SIZES.pageSize; i++) {
          const task = await createTestTask({
            assignee: `user:agent-${i % 10}` as EntityId,
          });
          await api.create(toCreateInput(task));
        }

        const warm = await api.ready({ assignee: 'user:agent-0' as EntityId });
        // 10% of tasks should be assigned to agent-0
        expect(warm.length).toBe(DATASET_SIZES.pageSize / 10);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(() => api.ready({ assignee: 'user:agent-0' as EntityId }), 8)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.ready);
      },
      30_000
    );
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
    }, 30_000);

    it(
      'should add multiple dependencies efficiently',
      async () => {
        // CPU-time conversion (el-19vmmo review): this was the second
        // addDependency site (per-dependency average), left on wall clock by
        // el-1ao326 which fixed the single-call site above. Same defect
        // class, milder dose: one timed batch of 10 deps averaged a single
        // stall over 10 items, so a ~500ms stall under a sustained build
        // crossed the 50ms bound. Now: fixed batch of `count` DISTINCT pairs
        // per sample (addDependency mutates and rejects duplicates — 409
        // ConflictError — so every sample consumes a fresh slice of a pair
        // pool), warmup on a dedicated pair, min of 5 samples.
        const count = DATASET_SIZES.small;
        const RUNS = 5;
        const pool = await createTaskBatch(api, count * RUNS * 2 + 2);
        // Warmup pair at the END of the pool so it cannot collide with a
        // measured pair.
        await api.addDependency({
          blockerId: pool[pool.length - 1].id,
          blockedId: pool[pool.length - 2].id,
          type: DependencyType.BLOCKS,
        });

        let call = 0;
        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          const cpu = await measureCpu(async () => {
            for (let i = 0; i < count; i++) {
              const c = call++;
              await api.addDependency({
                blockerId: pool[c * 2 + 1].id,
                blockedId: pool[c * 2].id,
                type: DependencyType.BLOCKS,
              });
            }
          });
          samples.push(cpu / count);
        }

        const perDep = Math.min(...samples);
        expect(perDep).toBeLessThan(THRESHOLDS.addDependency);
      },
      30_000
    );

    it(
      'should get dependency tree within threshold',
      async () => {
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

        // CPU-time conversion (el-19vmmo): single-shot wall clock, same
        // shape as the other conversions. Read-only, so the batch repeats
        // the same tree walk.
        const warm = await api.getDependencyTree(tasks[0].id);
        expect(warm.root.element.id).toBe(tasks[0].id);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(() => api.getDependencyTree(tasks[0].id), 32)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.getDependencyTree);
      },
      30_000
    );

    it(
      'should get dependencies and dependents within threshold',
      async () => {
        const tasks = await createTaskBatch(api, 20);

        // Create hub-and-spoke: tasks 1-19 all blocked by task 0
        for (let i = 1; i < 20; i++) {
          await api.addDependency({
            blockedId: tasks[i].id,
            blockerId: tasks[0].id,
            type: DependencyType.BLOCKS,
          });
        }

        // CPU-time conversion (el-19vmmo): these two were single-shot wall
        // clocks against INLINE literals (50/100) — the same defect class
        // with the constant inlined. The bounds are unchanged and now live
        // in THRESHOLDS (getDependencies/getDependents) so the file has one
        // threshold style. These are the cheapest reads in the file
        // (~0.005ms / ~0.014ms CPU), so their batch is 256 to keep a sample
        // (~1.3ms / ~3.6ms CPU) safely above clock granularity.
        const deps = await api.getDependencies(tasks[1].id);
        const dependents = await api.getDependents(tasks[0].id);
        expect(deps.length).toBe(1);
        expect(dependents.length).toBe(19);

        const depsSamples: number[] = [];
        for (let r = 0; r < 3; r++) {
          depsSamples.push(
            await measureCpuPerCall(() => api.getDependencies(tasks[1].id), 256)
          );
        }
        const dependentsSamples: number[] = [];
        for (let r = 0; r < 3; r++) {
          dependentsSamples.push(
            await measureCpuPerCall(() => api.getDependents(tasks[0].id), 256)
          );
        }

        expect(Math.min(...depsSamples)).toBeLessThan(THRESHOLDS.getDependencies);
        expect(Math.min(...dependentsSamples)).toBeLessThan(THRESHOLDS.getDependents);
      },
      30_000
    );
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

    // CPU-time conversion (el-19vmmo): each of these timed a SINGLE search
    // call on wall clock — the same single-shot shape that flaked elsewhere
    // in this file. FTS search over 100 docs costs ~0.4-0.6ms of CPU, so
    // one 200ms+ descheduling stall under a sustained build crossed the
    // bound. Search is a read, so samples repeat the same call 16 times
    // (~6-10ms CPU per sample); min of 3 after a warmup. The result-shape
    // assertion moved onto the warmup call.
    it(
      'should search by content keyword within threshold',
      async () => {
        const warm = await api.search(uniqueSearchKeyword);
        // Half the documents have the unique keyword in content
        expect(warm.length).toBe(DATASET_SIZES.medium / 2);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.search(uniqueSearchKeyword), 16));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.search);
      },
      30_000
    );

    it(
      'should search by content within threshold',
      async () => {
        await api.search('performance testing'); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.search('performance testing'), 16));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.search);
      },
      30_000
    );

    it(
      'should search with type filter within threshold',
      async () => {
        // Add some tasks too
        await createTaskBatch(api, 20);

        await api.search('Document', { type: 'document' }); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(
            await measureCpuPerCall(() => api.search('Document', { type: 'document' }), 16)
          );
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.search);
      },
      30_000
    );
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
    }, 30_000);

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
      // Fixed batch (el-19vmmo): CPU-time samples need enough calls to sit far
      // above clock granularity (~0.2ms CPU per page read → ~3ms per sample).
      // The adaptive batch-until-≥1ms wall-clock loop this replaces was itself
      // load-sensitive: a single stalled call is ≥1ms, so the loop could return
      // exactly the outlier it was meant to exclude (see el-50x1).
      const CALLS_PER_SAMPLE = 16;

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

        // CPU time per call, MIN of several samples (el-19vmmo): wall-clock
        // medians still failed once under a sustained build loop — long
        // descheduling stalls survive the median; they do not survive CPU
        // time at all. Min-of-samples sheds the GC/JIT noise that runs
        // on-CPU and inflates individual samples.
        const runs: number[] = [];
        for (let r = 0; r < RUNS_PER_SIZE; r++) {
          runs.push(
            await measureCpuPerCall(
              () => api.list<Task>({ type: 'task', limit: PAGE_SIZE }),
              CALLS_PER_SAMPLE
            )
          );
        }
        listTimes.push(Math.min(...runs));
      }

      // A page read from the ordering index should not care about table size at
      // all (measured CPU ratio ~1). The bound is unchanged from the
      // wall-clock version — 2x headroom, far below the 5x the table grew —
      // because what it guards against is unchanged: a regression back to
      // temp-b-tree materialization pushes the ratio toward sizeRatio (5x)
      // and fails this.
      const ratio = listTimes[listTimes.length - 1] / listTimes[0];
      const sizeRatio = sizes[sizes.length - 1] / sizes[0];
      expect(ratio).toBeLessThan(sizeRatio * 0.4);
    }, 30_000);

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
      // Explicit timeout (el-19vmmo): 4 depCounts x (warmup + 5 samples x 8
      // ready() calls) = 164 calls whose CPU cost is ~2ms each but whose
      // WALL time balloons under a sustained concurrent build — the default
      // 5s per-test timeout was observed firing mid-test under load, which
      // fails a passing assertion. 60s is ~10x the loaded wall-clock
      // duration; the test still measures CPU ratios internally.
    }, 60_000);
  });

  // ==========================================================================
  // Combined Operation Performance
  // ==========================================================================

  describe('Combined Operation Performance', () => {
    // CPU-time conversion (el-19vmmo): both tests timed one composite pass
    // on wall clock against INLINE literals (100 per-iteration / 500 whole-
    // sequence). The cycle test's total stall budget was 100ms x 20 = 2s and
    // the mixed test's 500ms — survivable most days, but the same wall-clock
    // defect class: a long descheduling stall under a sustained build fails
    // a passing assertion. Bounds unchanged, lifted into THRESHOLDS
    // (combinedCyclePerIteration / mixedOperationBatch). Both passes mutate
    // (create/update), so inputs are distinct per sample: createTestTask
    // yields unique ids, and the mixed pass updates with a distinct title
    // each time so a repeated identical write cannot hit a content-unchanged
    // fast path.
    it(
      'should handle create-update-query cycle efficiently',
      async () => {
        const iterations = 20;
        let n = 0;
        const runCycle = async () => {
          for (let i = 0; i < iterations; i++) {
            const task = await createTestTask();
            const created = await api.create(toCreateInput(task));
            await api.update<Task>(created.id, {
              status: TaskStatus.IN_PROGRESS,
              title: `Updated Task ${n++}`,
            });
            await api.ready();
          }
        };

        // Warmup: 2 iterations are enough for JIT/statement preparation
        for (let i = 0; i < 2; i++) {
          const task = await createTestTask();
          const created = await api.create(toCreateInput(task));
          await api.update<Task>(created.id, {
            status: TaskStatus.IN_PROGRESS,
            title: `Warmup ${i}`,
          });
          await api.ready();
        }

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          const cpu = await measureCpu(runCycle);
          samples.push(cpu / iterations);
        }

        // Each iteration should complete in reasonable time
        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.combinedCyclePerIteration);
      },
      30_000
    );

    it(
      'should handle concurrent-like operations efficiently',
      async () => {
        // Simulate multiple operations that might happen in rapid succession
        const tasks = await createTaskBatch(api, 50);
        let pass = 0;
        const runPass = async () => {
          const p = pass++;
          // Mix of operations
          await api.list<Task>({ type: 'task' });
          await api.ready();
          await api.get(tasks[0].id);
          await api.update<Task>(tasks[0].id, {
            status: TaskStatus.IN_PROGRESS,
            title: `Concurrent pass ${p}`,
          });
          await api.ready();
          await api.blocked();
          await api.search('Test');
          await api.getDependencies(tasks[0].id);
        };

        await runPass(); // warmup

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpu(runPass));
        }

        // All operations should complete quickly
        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.mixedOperationBatch);
      },
      30_000
    );
  });

  // ==========================================================================
  // Stats Performance
  // ==========================================================================

  describe('Stats Performance', () => {
    it(
      'should compute stats within threshold',
      async () => {
        // Create diverse dataset
        await createTaskBatch(api, DATASET_SIZES.medium);
        for (let i = 0; i < 20; i++) {
          const doc = await createTestDocument();
          await api.create(toCreateInput(doc));
        }

        // CPU-time conversion (el-19vmmo): single-shot wall clock against an
        // INLINE literal (200). stats() is the most expensive single read
        // here (~1.6ms CPU over 120 elements) yet still has the least
        // headroom of the read thresholds (~120x) — a sustained-load stall
        // crossed 200ms of wall clock. Bound unchanged, lifted into
        // THRESHOLDS.stats; read-only, so the batch repeats the call.
        const warm = await api.stats();
        expect(warm.elementsByType.task).toBe(DATASET_SIZES.medium);
        expect(warm.elementsByType.document).toBe(20);

        const samples: number[] = [];
        for (let r = 0; r < 3; r++) {
          samples.push(await measureCpuPerCall(() => api.stats(), 8));
        }

        expect(Math.min(...samples)).toBeLessThan(THRESHOLDS.stats);
      },
      30_000
    );
  });
});

// ============================================================================
// Benchmark Summary Helper
//
// Deliberately NOT converted to CPU time (el-19vmmo inventory): this block
// only LOGS wall-clock numbers for human reading and asserts nothing about
// time (sole assertion: every operation completed, i.e. duration > 0). It is
// informational output, not a load-sensitive assertion.
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
