/**
 * Sync Export Write Lock
 *
 * A per-output-directory async mutex serializing writes to the JSONL sync
 * files against non-writing critical sections that must not interleave with
 * them — most importantly the merge steward's live-state snapshot dance
 * (`packages/smithy/src/git/merge.ts`), which briefly checks out committed
 * content over the live `.stoneforge/sync/*.jsonl` files to let a fast-forward
 * through, then restores the live content.
 *
 * Without coordination, an export landing inside that window is silently
 * destroyed: the dance's restore writes the pre-dance snapshot back over the
 * freshly exported file while the export's dirty marks were already cleared —
 * leaving the JSONL stale with no retry (the recovery is a full export).
 *
 * Scope and limits:
 * - In-process only. All writers inside one process (auto-export ticks,
 *   HTTP-triggered exports via `SyncService.export`, the merge steward's
 *   dance) share this mutex and are fully serialized.
 * - A separate process (e.g. `sf sync export` from a shell while the server
 *   runs) cannot be excluded by an in-memory lock. The SQLite database is
 *   authoritative; a lost export is healed by the next full export
 *   (`sf sync export --full`), which is why procedures that manipulate the
 *   live files from outside the server end with one.
 *
 * @module
 */

import { resolve } from 'node:path';

/**
 * Tail of the critical-section chain per resolved output directory.
 * Acquisitions queue on this promise; entries are removed once settled so
 * the map does not grow with the number of directories ever locked.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the sync-export write lock for `outputDir`.
 *
 * Concurrent calls for the same directory execute in acquisition order; calls
 * for different directories proceed in parallel. A failing critical section
 * never wedges the chain — its rejection propagates to its own caller, and
 * the next waiter still runs.
 *
 * `SyncService.export` takes this lock for every export, so any caller that
 * holds it is excluded from — and waits out — in-flight exports in the same
 * process.
 *
 * @param outputDir - The sync output directory the critical section writes
 *   to or reads from (resolved to a canonical map key).
 * @param fn - The critical section. Must not itself call `SyncService.export`
 *   or re-acquire the lock for the same directory (the mutex is not
 *   reentrant).
 * @returns Whatever `fn` resolves to.
 */
export function withSyncExportLock<T>(
  outputDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = resolve(outputDir);
  const previous = chains.get(key) ?? Promise.resolve();

  // Run after the previous holder settles — whether it succeeded or failed.
  const run = previous.then(fn, fn);

  // The chain tail swallows the outcome so one failed critical section cannot
  // poison the waiters behind it.
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) {
      chains.delete(key);
    }
  });

  return run;
}
