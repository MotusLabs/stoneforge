/**
 * Auto Export Service
 *
 * Polls for dirty elements and automatically triggers incremental JSONL exports.
 * Uses interval-based polling (same pattern as EventBroadcaster).
 */

import type { StorageBackend } from '@stoneforge/storage';
import type { SyncConfig } from '../config/types.js';
import { SyncService } from './service.js';

export interface AutoExportOptions {
  syncService: SyncService;
  backend: StorageBackend;
  syncConfig: SyncConfig;
  outputDir: string;
}

/**
 * Interval-based service that watches for dirty elements and exports them.
 */
export class AutoExportService {
  private syncService: SyncService;
  private backend: StorageBackend;
  private syncConfig: SyncConfig;
  private outputDir: string;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private exporting = false;
  /**
   * In-flight startup promise, so concurrent `start()` calls share one
   * startup and `stop()` can wait for the initial export to settle.
   */
  private startPromise: Promise<void> | null = null;
  /**
   * Incremented on every `stop()`. A `start()` that began before a `stop()`
   * detects the mismatch once its awaits resume and must not arm the poll
   * interval — otherwise teardown (closed database, removed temp dir) leaves
   * a late-started poller running against dead resources.
   */
  private stopGeneration = 0;
  /** Promise for an in-flight poll tick, awaited by `stop()`. */
  private inFlightTick: Promise<void> | null = null;

  constructor(options: AutoExportOptions) {
    this.syncService = options.syncService;
    this.backend = options.backend;
    this.syncConfig = options.syncConfig;
    this.outputDir = options.outputDir;
  }

  /**
   * Start the auto-export polling loop.
   * If autoExport is disabled in config, this is a no-op.
   *
   * Safe to call concurrently: overlapping calls await the same startup.
   * If `stop()` is called while the initial export is in flight, the export
   * finishes but the poll interval is never armed.
   */
  async start(): Promise<void> {
    if (!this.syncConfig.autoExport) {
      return;
    }

    if (this.pollInterval) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    const generation = this.stopGeneration;
    const promise = this.performStart(generation).finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = null;
      }
    });
    this.startPromise = promise;
    return promise;
  }

  private async performStart(generation: number): Promise<void> {
    // Initial full export to ensure JSONL files are in sync
    try {
      await this.syncService.export({
        outputDir: this.outputDir,
        full: true,
      });
      console.log('[auto-export] Initial full export complete');
    } catch (err) {
      console.error('[auto-export] Initial full export failed:', err);
    }

    // A stop() raced this startup — do not arm the poll interval
    if (generation !== this.stopGeneration) {
      return;
    }

    // Start polling
    this.pollInterval = setInterval(() => {
      // Skip while a previous tick is still draining — assigning here would
      // clobber the in-flight tick promise that stop() needs to await.
      if (this.inFlightTick) {
        return;
      }
      this.inFlightTick = this.tick()
        .catch((err) => {
          console.error('[auto-export] Export tick failed:', err);
        })
        .finally(() => {
          this.inFlightTick = null;
        });
    }, this.syncConfig.exportDebounce);

    console.log(
      `[auto-export] Started (polling every ${this.syncConfig.exportDebounce}ms)`
    );
  }

  /**
   * Stop the auto-export polling loop.
   *
   * If a `start()` (initial export) or a poll tick is still in flight, this
   * awaits it first, so once the returned promise resolves no async work is
   * left running. Callers tearing down shared resources (closing the
   * database, removing output directories) should await this before doing
   * so.
   */
  async stop(): Promise<void> {
    this.stopGeneration++;

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Startup errors are already logged inside performStart
      }
    }

    if (this.inFlightTick) {
      try {
        await this.inFlightTick;
      } catch {
        // Tick errors are already logged by the interval callback wrapper
      }
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[auto-export] Stopped');
    }
  }

  /**
   * Single poll tick: check for dirty elements and export if needed.
   */
  private async tick(): Promise<void> {
    if (this.exporting) {
      return;
    }

    const dirty = this.backend.getDirtyElements();
    if (dirty.length === 0) {
      return;
    }

    this.exporting = true;
    try {
      await this.syncService.export({
        outputDir: this.outputDir,
        full: false,
      });
    } finally {
      this.exporting = false;
    }
  }
}

/**
 * Create a new AutoExportService instance
 */
export function createAutoExportService(options: AutoExportOptions): AutoExportService {
  return new AutoExportService(options);
}
