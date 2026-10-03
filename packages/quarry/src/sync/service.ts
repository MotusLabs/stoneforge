/**
 * Sync Service - Full export and import implementation
 *
 * Implements the sync operations specified in api/sync.md:
 * - Full and incremental export to JSONL
 * - Import with merge strategy
 * - Conflict resolution
 */

import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { StorageBackend } from '@stoneforge/storage';
import type { Element, ElementId, Timestamp, EntityId, Dependency, DependencyType } from '@stoneforge/core';
import { createTimestamp } from '@stoneforge/core';
import type {
  ExportResult,
  ImportResult as SyncImportResult,
  ExportOptions as SyncExportOptions,
  ImportOptions as SyncImportOptions,
  ImportError,
  ConflictRecord,
  DependencyConflictRecord,
} from './types.js';
import {
  serializeElement,
  serializeDependency,
  parseElements,
  parseDependencies,
  sortElementsForExport,
  sortDependenciesForExport,
} from './serialization.js';
import { mergeElements, mergeDependencies } from './merge.js';
import { mergeElementLines } from './incremental.js';

// ============================================================================
// Types
// ============================================================================

interface ElementRow {
  id: string;
  type: string;
  data: string;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  deleted_at: string | null;
  [key: string]: unknown;
}

/**
 * Everything needed to perform one export, with all storage reads and file
 * reads already done. Shared by the async and sync export paths so they cannot
 * drift apart.
 */
interface ExportPlan {
  /** Path of elements.jsonl to write */
  elementsPath: string;
  /** Path of dependencies.jsonl to write */
  dependenciesPath: string;
  /** Whether the elements file is rewritten from the full element set */
  full: boolean;
  /** True when an incremental export fell back to a full export */
  fallbackToFull: boolean;
  /** elements.jsonl content (no trailing newline; writeAtomic appends it) */
  elementsContent: string;
  /** Number of element lines that will be written */
  elementCount: number;
  /** Elements skipped because they failed validation */
  skippedCount: number;
  /** dependencies.jsonl content (no trailing newline; writeAtomic appends it) */
  dependenciesContent: string;
  /** Number of dependency lines that will be written */
  dependencyCount: number;
}

interface TagRow {
  element_id: string;
  tag: string;
  [key: string]: unknown;
}

interface DependencyRow {
  blocked_id: string;
  blocker_id: string;
  type: string;
  created_at: string;
  created_by: string;
  metadata: string | null;
  [key: string]: unknown;
}

/**
 * Terminate nonempty JSONL content with a single newline; empty content stays
 * empty.
 *
 * This is the historical writeFile() convention
 * (`content + (content ? '\n' : '')`). The atomic writers must keep it so a
 * re-export produces no spurious last-line diff against files written by older
 * versions, and so `wc -l` reports the element count exactly.
 */
function withTerminalNewline(content: string): string {
  return content.length > 0 ? `${content}\n` : content;
}

// ============================================================================
// Sync Service Implementation
// ============================================================================

/**
 * Service for handling JSONL export and import operations
 */
export class SyncService {
  constructor(private backend: StorageBackend) {}

  // --------------------------------------------------------------------------
  // Export Operations
  // --------------------------------------------------------------------------

  /**
   * Export elements to JSONL format
   *
   * An incremental export (`full: false`) *merges* the dirty elements into the
   * existing `elements.jsonl` rather than replacing it — the JSONL files are
   * the git-tracked source of truth, so overwriting them with only the dirty
   * subset would destroy data. If the existing file is missing or unreadable,
   * the incremental export falls back to a full export.
   *
   * @param options - Export configuration
   * @returns Export result with file paths and counts
   */
  async export(options: SyncExportOptions): Promise<ExportResult> {
    const now = createTimestamp();

    // Ensure output directory exists
    if (!existsSync(options.outputDir)) {
      await mkdir(options.outputDir, { recursive: true });
    }

    const plan = this.prepareExport(options);

    if (plan.skippedCount > 0) {
      console.warn(`[sync] Skipped ${plan.skippedCount} invalid element(s) during export`);
    }

    // Write files atomically (temp file + rename) so a crash mid-write can
    // never truncate the source of truth
    await this.writeAtomic(plan.elementsPath, plan.elementsContent);
    await this.writeAtomic(plan.dependenciesPath, plan.dependenciesContent);

    // Clear dirty tracking after successful export
    if (!options.full) {
      this.backend.clearDirty();
    }

    return {
      elementsExported: plan.elementCount,
      dependenciesExported: plan.dependencyCount,
      incremental: !options.full,
      elementsFile: plan.elementsPath,
      dependenciesFile: plan.dependenciesPath,
      exportedAt: now,
      ...(plan.fallbackToFull ? { fallbackToFull: true } : {}),
    };
  }

  /**
   * Export synchronously (useful for CLI and testing)
   */
  exportSync(options: SyncExportOptions): ExportResult {
    const now = createTimestamp();

    // Ensure output directory exists
    if (!existsSync(options.outputDir)) {
      mkdirSync(options.outputDir, { recursive: true });
    }

    const plan = this.prepareExport(options);

    if (plan.skippedCount > 0) {
      console.warn(`[sync] Skipped ${plan.skippedCount} invalid element(s) during export`);
    }

    // Write files atomically (temp file + rename)
    this.writeAtomicSync(plan.elementsPath, plan.elementsContent);
    this.writeAtomicSync(plan.dependenciesPath, plan.dependenciesContent);

    // Clear dirty tracking after successful export
    if (!options.full) {
      this.backend.clearDirty();
    }

    return {
      elementsExported: plan.elementCount,
      dependenciesExported: plan.dependencyCount,
      incremental: !options.full,
      elementsFile: plan.elementsPath,
      dependenciesFile: plan.dependenciesPath,
      exportedAt: now,
      ...(plan.fallbackToFull ? { fallbackToFull: true } : {}),
    };
  }

  /**
   * Export to string (for API and in-memory use)
   */
  exportToString(options?: { includeEphemeral?: boolean; includeDependencies?: boolean }): {
    elements: string;
    dependencies?: string;
  } {
    const elements = this.getAllElements(options?.includeEphemeral ?? false);
    const sortedElements = sortElementsForExport(elements);
    const { content: elementsContent } = this.serializeElementsSafe(sortedElements);

    let dependenciesContent: string | undefined;
    if (options?.includeDependencies !== false) {
      const dependencies = this.getAllDependencies();
      const sortedDependencies = sortDependenciesForExport(dependencies);
      dependenciesContent = sortedDependencies.map((d) => serializeDependency(d)).join('\n');
    }

    return {
      elements: elementsContent,
      dependencies: dependenciesContent,
    };
  }

  // --------------------------------------------------------------------------
  // Export Planning
  // --------------------------------------------------------------------------

  /**
   * Read everything needed for an export and decide what to write.
   *
   * A full export serializes the complete element set, **including
   * soft-deleted elements as tombstones** — deletions are part of the source
   * of truth and must survive a full re-export. An incremental export reads
   * the existing elements file and merges only the dirty elements into it
   * (replacing entries by id, appending new ones), so elements that are still
   * clean — including previously exported tombstones — survive in the file.
   */
  private prepareExport(options: SyncExportOptions): ExportPlan {
    // Build file paths
    const elementsFile = options.elementsFile ?? 'elements.jsonl';
    const dependenciesFile = options.dependenciesFile ?? 'dependencies.jsonl';
    const elementsPath = join(options.outputDir, elementsFile);
    const dependenciesPath = join(options.outputDir, dependenciesFile);

    // Dependencies are always written as a complete snapshot from storage, so
    // dependency insertions and deletions are both reflected without needing a
    // merge step.
    const dependencies = sortDependenciesForExport(this.getAllDependencies());
    const dependenciesContent = dependencies.map((d) => serializeDependency(d)).join('\n');

    if (options.full) {
      const serialized = this.serializeAllElements(options.includeEphemeral ?? false);
      return {
        elementsPath,
        dependenciesPath,
        full: true,
        fallbackToFull: false,
        elementsContent: serialized.content,
        elementCount: serialized.count,
        skippedCount: serialized.skipped,
        dependenciesContent,
        dependencyCount: dependencies.length,
      };
    }

    // Incremental export — merge dirty elements into the existing file.
    const existing = this.readElementsFile(elementsPath);

    if (existing === null) {
      // Without a readable base there is nothing to merge into; a full export
      // is the only way to produce a correct file.
      console.warn(
        `[sync] elements.jsonl not found or unreadable at ${elementsPath}; falling back to full export`
      );
      const serialized = this.serializeAllElements(options.includeEphemeral ?? false);
      return {
        elementsPath,
        dependenciesPath,
        full: true,
        fallbackToFull: true,
        elementsContent: serialized.content,
        elementCount: serialized.count,
        skippedCount: serialized.skipped,
        dependenciesContent,
        dependencyCount: dependencies.length,
      };
    }

    // Dirty elements, with ephemeral ones excluded exactly like a full export
    // would exclude them (otherwise they would creep into the file and only
    // disappear again on the next full export).
    let dirty = this.getDirtyElementsData();
    if (!options.includeEphemeral) {
      dirty = this.filterOutEphemeral(dirty);
    }

    // Serialize each dirty element. Elements that fail validation are skipped —
    // their existing line (if any) is left untouched in the file.
    const updates = new Map<string, string>();
    let skipped = 0;
    for (const element of dirty) {
      try {
        updates.set(element.id, serializeElement(element));
      } catch {
        console.warn(
          `[sync] Skipping invalid element ${element.id} (type=${element.type})`
        );
        skipped++;
      }
    }

    const merged = mergeElementLines(existing, updates);

    return {
      elementsPath,
      dependenciesPath,
      full: false,
      fallbackToFull: false,
      elementsContent: merged.content,
      elementCount: merged.total,
      skippedCount: skipped,
      dependenciesContent,
      dependencyCount: dependencies.length,
    };
  }

  /**
   * Serialize the full element set for a full export
   */
  private serializeAllElements(includeEphemeral: boolean): {
    content: string;
    count: number;
    skipped: number;
  } {
    const elements = this.getAllElements(includeEphemeral);
    const sortedElements = sortElementsForExport(elements);
    const { content, skipped } = this.serializeElementsSafe(sortedElements);
    return { content, count: sortedElements.length - skipped, skipped };
  }

  /**
   * Read the current elements file, or null when it is missing/unreadable.
   */
  private readElementsFile(path: string): string | null {
    try {
      return readFileSync(path, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`[sync] Failed to read ${path} (${code ?? 'unknown error'})`);
      }
      return null;
    }
  }

  /**
   * Unique temp file path next to the destination (safe against concurrent
   * exports from the same or another process).
   */
  private tempPath(filePath: string): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${filePath}.tmp-${process.pid}-${Date.now()}-${rand}`;
  }

  /**
   * Write a file atomically: write to a temp file, flush, then rename over the
   * destination. Readers either see the old file or the new one, never a
   * partially written file.
   *
   * Nonempty content is terminated with a single newline (see
   * withTerminalNewline) so files stay byte-compatible with exports written by
   * earlier versions.
   */
  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const tmpPath = this.tempPath(filePath);
    try {
      const handle = await open(tmpPath, 'w');
      try {
        await handle.writeFile(withTerminalNewline(content), 'utf-8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Synchronous atomic write (see writeAtomic)
   */
  private writeAtomicSync(filePath: string, content: string): void {
    const tmpPath = this.tempPath(filePath);
    let fd: number | null = null;
    try {
      fd = openSync(tmpPath, 'w');
      const buffer = Buffer.from(withTerminalNewline(content), 'utf-8');
      let offset = 0;
      while (offset < buffer.length) {
        // writeSync may write fewer bytes than requested; keep going until done
        offset += writeSync(fd, buffer, offset, buffer.length - offset);
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmpPath, filePath);
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best effort cleanup
        }
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort cleanup
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Import Operations
  // --------------------------------------------------------------------------

  /**
   * Import elements from JSONL files
   *
   * @param options - Import configuration
   * @returns Import result with counts and conflicts
   */
  async import(options: SyncImportOptions): Promise<SyncImportResult> {
    // Build file paths
    const elementsFile = options.elementsFile ?? 'elements.jsonl';
    const dependenciesFile = options.dependenciesFile ?? 'dependencies.jsonl';
    const elementsPath = join(options.inputDir, elementsFile);
    const dependenciesPath = join(options.inputDir, dependenciesFile);

    // Read files
    let elementsContent = '';
    let dependenciesContent = '';

    if (existsSync(elementsPath)) {
      elementsContent = await readFile(elementsPath, 'utf-8');
    }
    if (existsSync(dependenciesPath)) {
      dependenciesContent = await readFile(dependenciesPath, 'utf-8');
    }

    return this.importFromStrings(elementsContent, dependenciesContent, options);
  }

  /**
   * Import synchronously
   */
  importSync(options: SyncImportOptions): SyncImportResult {
    // Build file paths
    const elementsFile = options.elementsFile ?? 'elements.jsonl';
    const dependenciesFile = options.dependenciesFile ?? 'dependencies.jsonl';
    const elementsPath = join(options.inputDir, elementsFile);
    const dependenciesPath = join(options.inputDir, dependenciesFile);

    // Read files
    let elementsContent = '';
    let dependenciesContent = '';

    if (existsSync(elementsPath)) {
      elementsContent = readFileSync(elementsPath, 'utf-8');
    }
    if (existsSync(dependenciesPath)) {
      dependenciesContent = readFileSync(dependenciesPath, 'utf-8');
    }

    return this.importFromStrings(elementsContent, dependenciesContent, options);
  }

  /**
   * Import from JSONL strings (for API and in-memory use)
   */
  importFromStrings(
    elementsContent: string,
    dependenciesContent: string,
    options?: Partial<SyncImportOptions>
  ): SyncImportResult {
    const now = createTimestamp();
    const errors: ImportError[] = [];
    const conflicts: ConflictRecord[] = [];
    const dependencyConflicts: DependencyConflictRecord[] = [];
    const dryRun = options?.dryRun ?? false;
    const force = options?.force ?? false;

    let elementsImported = 0;
    let elementsSkipped = 0;
    let dependenciesImported = 0;
    let dependenciesSkipped = 0;

    // Parse elements
    const { elements: parsedElements, errors: parseErrors } = parseElements(elementsContent);
    for (const err of parseErrors) {
      errors.push({
        line: err.line,
        file: 'elements',
        message: err.message,
        content: err.content,
      });
    }

    // Parse dependencies
    const { dependencies: parsedDependencies, errors: depParseErrors } =
      parseDependencies(dependenciesContent);
    for (const err of depParseErrors) {
      errors.push({
        line: err.line,
        file: 'dependencies',
        message: err.message,
        content: err.content,
      });
    }

    // Sort elements for import order (entities first for referential integrity)
    const sortedElements = sortElementsForExport(parsedElements);

    // Process elements
    if (!dryRun) {
      this.backend.transaction((tx) => {
        for (const remoteElement of sortedElements) {
          const localElement = this.getElement(remoteElement.id);

          if (!localElement) {
            // New element - insert
            this.insertElement(tx, remoteElement);
            elementsImported++;
          } else {
            // Existing element - merge
            const mergeResult = mergeElements(localElement, remoteElement);

            if (mergeResult.localModified || force) {
              // Apply remote or merged changes
              const elementToSave = force ? remoteElement : mergeResult.element;
              this.updateElement(tx, elementToSave);
              elementsImported++;

              if (mergeResult.conflict) {
                conflicts.push(mergeResult.conflict);
              }
            } else {
              // No changes needed
              elementsSkipped++;
            }
          }
        }

        // Process dependencies
        // Build set of element IDs that exist in the database so we can
        // skip dependencies with dangling references (e.g. JSONL files
        // exported at different times, or elements deleted after export).
        // blocked_id has a FK constraint — INSERT OR IGNORE does NOT
        // suppress FK violations, so we must filter before inserting.
        const existingIds = new Set(
          this.backend.query<{ id: string }>('SELECT id FROM elements').map(r => r.id)
        );

        const localDependencies = this.getAllDependencies();
        const mergeResult = mergeDependencies(localDependencies, parsedDependencies);

        // Add new dependencies (skip those with dangling references)
        for (const dep of mergeResult.added) {
          if (!existingIds.has(dep.blockedId)) {
            errors.push({
              file: 'dependencies',
              message: `Skipped dependency: blocked element ${dep.blockedId} does not exist`,
            });
            dependenciesSkipped++;
            continue;
          }
          this.insertDependency(tx, dep);
          dependenciesImported++;
        }

        // Remove deleted dependencies
        for (const dep of mergeResult.removed) {
          this.deleteDependency(tx, dep);
        }

        dependencyConflicts.push(...mergeResult.conflicts);
        dependenciesSkipped = parsedDependencies.length - mergeResult.added.length;
      });
    } else {
      // Dry run - compute what would change without actually changing
      for (const remoteElement of sortedElements) {
        const localElement = this.getElement(remoteElement.id);

        if (!localElement) {
          elementsImported++;
        } else {
          const mergeResult = mergeElements(localElement, remoteElement);
          if (mergeResult.localModified || force) {
            elementsImported++;
            if (mergeResult.conflict) {
              conflicts.push(mergeResult.conflict);
            }
          } else {
            elementsSkipped++;
          }
        }
      }

      // Dry run for dependencies
      const localDependencies = this.getAllDependencies();
      const mergeResult = mergeDependencies(localDependencies, parsedDependencies);
      dependenciesImported = mergeResult.added.length;
      dependenciesSkipped = parsedDependencies.length - mergeResult.added.length;
      dependencyConflicts.push(...mergeResult.conflicts);
    }

    return {
      elementsImported,
      elementsSkipped,
      dependenciesImported,
      dependenciesSkipped,
      conflicts,
      dependencyConflicts,
      errors,
      importedAt: now,
    };
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Get all elements from storage, including soft-deleted ones (tombstones)
   *
   * Tombstones are deliberately included: the JSONL files are the git-tracked
   * source of truth, so a full export that omitted soft-deleted rows would
   * erase tombstones that earlier (incremental) exports recorded. Clones that
   * import such a file would never see those deletions and the deleted
   * elements could come back. Tombstones are serialized in the same form the
   * incremental path writes and the importer understands: the `deletedAt` /
   * `status: 'tombstone'` fields live in the element's `data` payload.
   */
  private getAllElements(includeEphemeral: boolean): Element[] {
    // Query all elements (live and soft-deleted)
    const conditions: string[] = [];
    if (!includeEphemeral) {
      // Exclude ephemeral workflows (with ephemeral: true)
      conditions.push("JSON_EXTRACT(data, '$.ephemeral') IS NOT true");
    }
    let sql = 'SELECT * FROM elements';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    // The rowid tiebreaker makes the order of rows sharing a created_at explicit
    // and deterministic (same direction as the ordering — see buildListQuery).
    // It also lets this be a forward scan of idx_elements_created_at, which
    // migration 13 keeps, instead of relying on the planner picking that index.
    sql += ' ORDER BY created_at, rowid ASC';

    const rows = this.backend.query<ElementRow>(sql);
    let elements = rows.map((row) => this.rowToElement(row));

    // If not including ephemeral, also filter out tasks that are children of ephemeral workflows
    if (!includeEphemeral) {
      elements = this.filterOutEphemeral(elements);
    }

    return elements;
  }

  /**
   * Ids of ephemeral workflows currently in storage.
   *
   * Queried from the database rather than derived from the candidate set, so
   * the incremental export path (which only sees dirty elements) can apply the
   * same exclusion as a full export.
   */
  private getEphemeralWorkflowIds(): Set<string> {
    const rows = this.backend.query<{ id: string }>(
      `SELECT id FROM elements
       WHERE type = 'workflow' AND deleted_at IS NULL
         AND JSON_EXTRACT(data, '$.ephemeral') IS TRUE`
    );
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Exclude ephemeral workflows and their child tasks from a set of elements
   */
  private filterOutEphemeral(elements: Element[]): Element[] {
    const ephemeralWorkflowIds = this.getEphemeralWorkflowIds();
    if (ephemeralWorkflowIds.size === 0) {
      return elements;
    }
    return this.filterOutEphemeralTasks(elements, ephemeralWorkflowIds);
  }

  /**
   * Filter out ephemeral workflows and tasks that are children of ephemeral
   * workflows
   */
  private filterOutEphemeralTasks(
    elements: Element[],
    ephemeralWorkflowIds: Set<string>
  ): Element[] {
    if (ephemeralWorkflowIds.size === 0) {
      return elements;
    }

    // Find task IDs that are children of ephemeral workflows via parent-child dependency
    const ephemeralTaskIds = new Set<string>();
    const depRows = this.backend.query<DependencyRow>(
      "SELECT * FROM dependencies WHERE type = 'parent-child'"
    );

    for (const row of depRows) {
      // In parent-child, blockedId is the child (task), blockerId is the parent (workflow)
      if (ephemeralWorkflowIds.has(row.blocker_id)) {
        ephemeralTaskIds.add(row.blocked_id);
      }
    }

    // Filter out ephemeral workflows and their tasks
    return elements.filter(
      (el) => !ephemeralWorkflowIds.has(el.id) && !ephemeralTaskIds.has(el.id)
    );
  }

  /**
   * Get dirty elements data (for incremental export)
   */
  private getDirtyElementsData(): Element[] {
    const dirtyRecords = this.backend.getDirtyElements();
    const elements: Element[] = [];

    for (const record of dirtyRecords) {
      const row = this.backend.queryOne<ElementRow>(
        'SELECT * FROM elements WHERE id = ?',
        [record.elementId]
      );
      if (row) {
        elements.push(this.rowToElement(row));
      }
    }

    return elements;
  }

  /**
   * Get all dependencies from storage
   */
  private getAllDependencies(): Dependency[] {
    const rows = this.backend.query<DependencyRow>('SELECT * FROM dependencies ORDER BY created_at');

    return rows.map((row) => ({
      blockedId: row.blocked_id as ElementId,
      blockerId: row.blocker_id as ElementId,
      type: row.type as DependencyType,
      createdAt: row.created_at as Timestamp,
      createdBy: row.created_by as EntityId,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }));
  }

  /**
   * Get a single element by ID
   */
  private getElement(id: ElementId): Element | null {
    const row = this.backend.queryOne<ElementRow>('SELECT * FROM elements WHERE id = ?', [id]);

    if (!row) {
      return null;
    }

    return this.rowToElement(row);
  }

  /**
   * Convert database row to Element
   */
  private rowToElement(row: ElementRow): Element {
    const data = JSON.parse(row.data);

    // Get tags for this element
    const tagRows = this.backend.query<TagRow>('SELECT tag FROM tags WHERE element_id = ?', [
      row.id,
    ]);
    const tags = tagRows.map((r) => r.tag);

    return {
      id: row.id as ElementId,
      type: data.type ?? row.type,
      createdAt: row.created_at as Timestamp,
      updatedAt: row.updated_at as Timestamp,
      createdBy: row.created_by as EntityId,
      tags,
      metadata: data.metadata ?? {},
      ...data,
    } as Element;
  }

  /**
   * Serialize elements to JSONL, skipping any that fail validation.
   */
  private serializeElementsSafe(elements: Element[]): { content: string; skipped: number } {
    const lines: string[] = [];
    let skipped = 0;
    for (const el of elements) {
      try {
        lines.push(serializeElement(el));
      } catch {
        console.warn(`[sync] Skipping invalid element ${el.id} (type=${el.type})`);
        skipped++;
      }
    }
    return { content: lines.join('\n'), skipped };
  }

  /**
   * Insert an element into storage (within transaction)
   */
  private insertElement(
    tx: {
      run: (sql: string, params?: unknown[]) => void;
    },
    element: Element
  ): void {
    // Extract base fields
    const { id, type, createdAt, updatedAt, createdBy, tags, ...typeData } = element;

    const data = JSON.stringify(typeData);

    // Check for deletedAt (tombstone)
    const deletedAt = 'deletedAt' in element ? (element as { deletedAt?: string }).deletedAt : null;

    tx.run(
      `INSERT OR REPLACE INTO elements (id, type, data, created_at, updated_at, created_by, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, type, data, createdAt, updatedAt, createdBy, deletedAt ?? null]
    );

    // Update tags
    tx.run('DELETE FROM tags WHERE element_id = ?', [id]);
    for (const tag of tags) {
      tx.run('INSERT INTO tags (element_id, tag) VALUES (?, ?)', [id, tag]);
    }
  }

  /**
   * Update an element in storage (within transaction)
   */
  private updateElement(
    tx: {
      run: (sql: string, params?: unknown[]) => void;
    },
    element: Element
  ): void {
    // Extract base fields
    const { id, type, createdAt, updatedAt, createdBy, tags, ...typeData } = element;

    const data = JSON.stringify(typeData);

    // Check for deletedAt (tombstone)
    const deletedAt = 'deletedAt' in element ? (element as { deletedAt?: string }).deletedAt : null;

    tx.run(
      `UPDATE elements SET data = ?, updated_at = ?, deleted_at = ?
       WHERE id = ?`,
      [data, updatedAt, deletedAt ?? null, id]
    );

    // Update tags
    tx.run('DELETE FROM tags WHERE element_id = ?', [id]);
    for (const tag of tags) {
      tx.run('INSERT INTO tags (element_id, tag) VALUES (?, ?)', [id, tag]);
    }
  }

  /**
   * Insert a dependency into storage (within transaction)
   */
  private insertDependency(
    tx: {
      run: (sql: string, params?: unknown[]) => void;
    },
    dep: Dependency
  ): void {
    tx.run(
      `INSERT OR IGNORE INTO dependencies (blocked_id, blocker_id, type, created_at, created_by, metadata)
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
   * Delete a dependency from storage (within transaction)
   */
  private deleteDependency(
    tx: {
      run: (sql: string, params?: unknown[]) => void;
    },
    dep: Dependency
  ): void {
    tx.run('DELETE FROM dependencies WHERE blocked_id = ? AND blocker_id = ? AND type = ?', [
      dep.blockedId,
      dep.blockerId,
      dep.type,
    ]);
  }
}

/**
 * Create a new SyncService instance
 */
export function createSyncService(backend: StorageBackend): SyncService {
  return new SyncService(backend);
}
