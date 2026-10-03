import type { StorageBackend } from '@stoneforge/storage';

/** Per-file ownership of test backends, including handles opened in test bodies. */
export function createBackendTracker() {
  const backends = new Set<StorageBackend>();

  return {
    track<T extends StorageBackend>(backend: T): T {
      backends.add(backend);
      return backend;
    },
    closeAll(): void {
      const errors: unknown[] = [];
      for (const backend of backends) {
        try {
          // StorageBackend.close() is idempotent; tests may close a handle early.
          backend.close();
          backends.delete(backend);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, 'Failed to close test storage backends');
      }
    },
  };
}
