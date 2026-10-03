/**
 * Incremental Export Merging
 *
 * Merges a set of changed (dirty) serialized elements into an existing
 * `elements.jsonl` file.
 *
 * This is the safety net that makes incremental export non-destructive: the
 * JSONL files are the git-tracked source of truth, so an incremental export
 * must never replace the file with only the dirty subset — it merges the dirty
 * elements into whatever is already on disk.
 *
 * Merge rules:
 * - Existing lines are preserved verbatim unless their element is dirty
 *   (byte-for-byte identical output for untouched elements => small git diffs).
 * - A dirty element replaces the existing line with the same `id`; if the id is
 *   not present yet, the element is appended.
 * - Duplicate ids in the existing file collapse to the first occurrence.
 * - Lines that cannot be parsed are preserved verbatim (never dropped) and
 *   sorted to the end of the file.
 * - The result is sorted with the same ordering as a full export
 *   (`sortElementsForExport`): type priority, then createdAt, then id.
 */

import { getTypePriority } from './types.js';

/**
 * Result of merging serialized updates into existing JSONL content
 */
export interface MergeLinesResult {
  /** Merged JSONL content (no trailing newline) */
  content: string;
  /** Total number of element lines in the merged content */
  total: number;
  /** Number of existing lines that were replaced by an update */
  replaced: number;
  /** Number of updates appended as new lines */
  appended: number;
}

/** Information extracted from one existing JSONL line */
interface LineInfo {
  /** The raw, unparsed line (preserved verbatim when not dirty) */
  line: string;
  /** Element id, or null when the line cannot be parsed */
  id: string | null;
  /** Export sort key, or null when the line cannot be parsed */
  sortKey: SortKey | null;
}

/** Export sort key (mirrors sortElementsForExport ordering) */
interface SortKey {
  priority: number;
  createdAt: string;
  id: string;
}

/**
 * Parse a single JSONL line just enough to identify and order it.
 *
 * Deliberately lenient — only a light `JSON.parse`, no schema validation:
 * lines that fail to parse (or lack a string `id`) are treated as opaque. They
 * are preserved rather than dropped, since dropping data from the source of
 * truth is exactly what this module exists to prevent.
 */
function parseLine(line: string): LineInfo {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as { id?: unknown; type?: unknown; createdAt?: unknown };
      if (typeof obj.id === 'string' && obj.id.length > 0) {
        return {
          line,
          id: obj.id,
          sortKey: {
            priority: getTypePriority(typeof obj.type === 'string' ? obj.type : ''),
            createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
            id: obj.id,
          },
        };
      }
    }
  } catch {
    // fall through: treat as opaque
  }
  return { line, id: null, sortKey: null };
}

/**
 * Compare two lines by the full-export ordering (type priority, createdAt, id).
 *
 * Lines without a parseable sort key sort last (they are anomalies we preserve
 * but cannot order); `Array.prototype.sort` is stable, so both parseable and
 * unparseable lines keep their relative input order.
 */
function compareLines(a: LineInfo, b: LineInfo): number {
  const keyA = a.sortKey;
  const keyB = b.sortKey;

  if (keyA === null && keyB === null) return 0;
  if (keyA === null) return 1;
  if (keyB === null) return -1;

  const typeDiff = keyA.priority - keyB.priority;
  if (typeDiff !== 0) return typeDiff;

  const timeDiff = keyA.createdAt.localeCompare(keyB.createdAt);
  if (timeDiff !== 0) return timeDiff;

  return keyA.id.localeCompare(keyB.id);
}

/**
 * Merge serialized element updates into existing JSONL content.
 *
 * @param existingContent - Current contents of elements.jsonl (may be empty)
 * @param updates - Map of element id to freshly serialized line. Ids already
 *   present in the existing content replace the existing line; others append.
 * @returns Merged content plus merge statistics
 */
export function mergeElementLines(
  existingContent: string,
  updates: Map<string, string>
): MergeLinesResult {
  const existingInfos = existingContent
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(parseLine);

  const merged: LineInfo[] = [];
  const seenIds = new Set<string>();
  let replaced = 0;

  for (const info of existingInfos) {
    if (info.id !== null) {
      // Collapse duplicate ids to the first occurrence
      if (seenIds.has(info.id)) {
        continue;
      }
      seenIds.add(info.id);

      const update = updates.get(info.id);
      if (update !== undefined) {
        merged.push(parseLine(update));
        replaced++;
        continue;
      }
    }

    // Not dirty (or opaque) — keep the existing line byte-for-byte
    merged.push(info);
  }

  let appended = 0;
  for (const [id, update] of updates) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      merged.push(parseLine(update));
      appended++;
    }
  }

  merged.sort(compareLines);

  return {
    content: merged.map((info) => info.line).join('\n'),
    total: merged.length,
    replaced,
    appended,
  };
}
