/**
 * Dirty Tracking SQL
 *
 * Shared statements used by every storage backend to keep the dirty_elements
 * table's `marked_at` column usable as a per-element change token.
 *
 * Token semantics (relied upon by SyncService.export / clearDirtySnapshot):
 *
 * 1. **Atomic issuance.** markDirty is a single INSERT ... ON CONFLICT
 *    (UPSERT) statement whose new token is computed *inside* SQLite from the
 *    values visible at execution time. SQLite serializes write statements
 *    across connections, so two connections can never interleave a read of
 *    the old token with a write of the next one — the historic
 *    SELECT-then-INSERT OR REPLACE implementation allowed exactly that, and
 *    two connections could compute the *same* "next" token.
 *
 * 2. **Strictly monotonic per element.** The stored token only ever moves to
 *    a strictly greater value: on conflict the new token is at least
 *    stored + 1ms, so a re-mark is always distinguishable from a previously
 *    snapshotted mark even within the same wall-clock millisecond.
 *
 * 3. **Tokens are never reused — even after the row is cleared.** Issued
 *    tokens advance a global high-water mark (`dirty_token_floor`) via an
 *    AFTER INSERT/UPDATE trigger, which runs atomically within the marking
 *    statement itself. A fresh (or re-created) row takes
 *    max(wall clock, floor + 1ms), so clearing a row and re-marking it in the
 *    same millisecond cannot regenerate a token that a still-in-flight
 *    export snapshot holds — the snapshot's clearDirtySnapshot() then
 *    matches nothing and the newer mark survives.
 *
 * Tokens are canonical ISO 8601 strings (YYYY-MM-DDTHH:MM:SS.sssZ), which
 * compare correctly as plain strings. Unparseable legacy values never poison
 * the mechanism: an unparseable stored token is simply overwritten with a
 * fresh token, and an unparseable value never advances the floor.
 */

/**
 * The `marked_at` format used for all token arithmetic. Equivalent to
 * `new Date(ms).toISOString()`: `%f` renders seconds with millisecond
 * precision (SS.SSS).
 */
const ISO_TOKEN_FORMAT = '%Y-%m-%dT%H:%M:%fZ';

/**
 * SQL expression: the argument bumped by one millisecond, or NULL when the
 * argument is not a parseable timestamp (strftime returns NULL for
 * unparseable inputs rather than raising).
 */
const BUMP_1MS = (value: string): string =>
  `strftime('${ISO_TOKEN_FORMAT}', ${value}, '+0.001 seconds')`;

/**
 * The token the global floor will allow next: floor + 1ms, or NULL when
 * there is no floor row yet or it holds an unparseable value.
 */
const FLOOR_BUMP = `(SELECT ${BUMP_1MS('marked_at')} FROM dirty_token_floor WHERE id = 1)`;

/**
 * Schema for the dirty-tracking tables and the floor-advancing triggers.
 *
 * Idempotent (`IF NOT EXISTS`), so backends run it on every connection open
 * — this also upgrades existing databases without a schema migration, since
 * dirty tracking lives outside the versioned migration set.
 *
 * The trigger bodies deliberately avoid conflict-resolution clauses: the
 * DO UPDATE arm of an UPSERT runs fired triggers in a context where OR
 * IGNORE/OR REPLACE are downgraded to ABORT (a documented SQLite upsert
 * wart), which would make the INSERT fail once the floor row exists. A
 * guarded INSERT needs no conflict handling, and the whole trigger body
 * executes atomically inside the marking statement's lock.
 */
export const DIRTY_TRACKING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS dirty_elements (
    element_id TEXT PRIMARY KEY,
    marked_at TEXT NOT NULL
  );

  -- Global high-water mark of every token ever issued. Survives every form
  -- of dirty clear, which is what makes token reuse impossible.
  CREATE TABLE IF NOT EXISTS dirty_token_floor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    marked_at TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS dirty_token_floor_advance_insert
  AFTER INSERT ON dirty_elements
  BEGIN
    UPDATE dirty_token_floor SET marked_at = NEW.marked_at
      WHERE id = 1
        AND julianday(NEW.marked_at) IS NOT NULL
        AND (NEW.marked_at > marked_at OR julianday(marked_at) IS NULL);
    INSERT INTO dirty_token_floor (id, marked_at)
      SELECT 1, NEW.marked_at
      WHERE NOT EXISTS (SELECT 1 FROM dirty_token_floor WHERE id = 1);
  END;

  CREATE TRIGGER IF NOT EXISTS dirty_token_floor_advance_update
  AFTER UPDATE OF marked_at ON dirty_elements
  BEGIN
    UPDATE dirty_token_floor SET marked_at = NEW.marked_at
      WHERE id = 1
        AND julianday(NEW.marked_at) IS NOT NULL
        AND (NEW.marked_at > marked_at OR julianday(marked_at) IS NULL);
    INSERT INTO dirty_token_floor (id, marked_at)
      SELECT 1, NEW.marked_at
      WHERE NOT EXISTS (SELECT 1 FROM dirty_token_floor WHERE id = 1);
  END;
`;

/**
 * Atomically mark an element dirty (see module docs for the guarantees).
 *
 * Placeholders, in bind order (the wall-clock value repeats — plain `?`
 * parameters are positional per occurrence, which every driver supports):
 *
 *   1. elementId
 *   2. now (wall clock, canonical ISO string)
 *   3. now            — floor fallback on the INSERT path
 *   4. now            — candidate on the DO UPDATE path
 *   5. now            — fallback when the stored value is unparseable
 *   6. now            — floor fallback on the DO UPDATE path
 *
 * INSERT path (no row yet — including a row that was cleared earlier):
 *   token = max(now, floor + 1ms)   — never regenerates an earlier token.
 *
 * DO UPDATE path (row exists):
 *   token = max(now, stored + 1ms, floor + 1ms)   — strictly greater than
 *   the stored value whenever that value is parseable; an unparseable
 *   legacy value is replaced by a fresh token (the bump term falls back to
 *   now via COALESCE).
 */
export const MARK_DIRTY_SQL = `
  INSERT INTO dirty_elements (element_id, marked_at)
  VALUES (?, MAX(?, COALESCE(${FLOOR_BUMP}, ?)))
  ON CONFLICT(element_id) DO UPDATE SET marked_at = MAX(
    ?,
    COALESCE(${BUMP_1MS('dirty_elements.marked_at')}, ?),
    COALESCE(${FLOOR_BUMP}, ?)
  )`;
