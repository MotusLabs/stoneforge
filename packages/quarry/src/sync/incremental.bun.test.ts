/**
 * Incremental Export Merge Tests
 *
 * mergeElementLines() is the guard that keeps incremental exports
 * non-destructive: dirty elements are merged into the existing JSONL instead of
 * replacing it.
 */

import { describe, expect, test } from 'bun:test';
import { mergeElementLines } from './incremental.js';

/** Build a serialized element line */
function line(overrides: Record<string, unknown> & { id: string }): string {
  return JSON.stringify({
    type: 'task',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'el-system1',
    tags: [],
    metadata: {},
    ...overrides,
  });
}

function updatesOf(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

describe('mergeElementLines', () => {
  test('keeps existing lines that are not dirty, byte-for-byte', () => {
    const existing = [line({ id: 'el-a' }), line({ id: 'el-b' })].join('\n');

    const result = mergeElementLines(existing, updatesOf([['el-c', line({ id: 'el-c' })]]));

    expect(result.content).toContain(line({ id: 'el-a' }));
    expect(result.content).toContain(line({ id: 'el-b' }));
    expect(result.total).toBe(3);
    expect(result.appended).toBe(1);
    expect(result.replaced).toBe(0);
  });

  test('replaces the line for a dirty element id', () => {
    const existing = [line({ id: 'el-a' }), line({ id: 'el-b' })].join('\n');
    const updated = line({ id: 'el-a', title: 'changed', updatedAt: '2026-02-02T00:00:00.000Z' });

    const result = mergeElementLines(existing, updatesOf([['el-a', updated]]));

    expect(result.total).toBe(2);
    expect(result.replaced).toBe(1);
    expect(result.appended).toBe(0);

    const lines = result.content.split('\n');
    expect(lines).toContain(updated);
    // The stale version must not survive
    expect(lines).not.toContain(line({ id: 'el-a' }));
    expect(lines).toContain(line({ id: 'el-b' }));
  });

  test('appends dirty elements that are not yet present', () => {
    const existing = line({ id: 'el-a' });
    const added = line({ id: 'el-new' });

    const result = mergeElementLines(existing, updatesOf([['el-new', added]]));

    expect(result.total).toBe(2);
    expect(result.appended).toBe(1);
    expect(result.content).toContain(added);
  });

  test('keeps tombstone lines for deleted elements', () => {
    const existing = [line({ id: 'el-a' }), line({ id: 'el-b' })].join('\n');
    const tombstone = line({
      id: 'el-a',
      status: 'tombstone',
      deletedAt: '2026-03-03T00:00:00.000Z',
    });

    const result = mergeElementLines(existing, updatesOf([['el-a', tombstone]]));

    expect(result.total).toBe(2);
    expect(result.content).toContain(tombstone);
    expect(result.content).toContain(line({ id: 'el-b' }));
  });

  test('sorts merged lines like a full export (type priority, createdAt, id)', () => {
    // Existing: entity created later, task created earlier
    const existing = [
      line({ id: 'el-task', type: 'task', createdAt: '2026-01-01T00:00:00.000Z' }),
      line({ id: 'el-ent', type: 'entity', createdAt: '2026-05-01T00:00:00.000Z' }),
    ].join('\n');

    // New entity created earliest — must sort before both
    const added = line({ id: 'el-ent0', type: 'entity', createdAt: '2026-01-01T00:00:00.000Z' });

    const result = mergeElementLines(existing, updatesOf([['el-ent0', added]]));
    const ids = result.content.split('\n').map((l) => (JSON.parse(l) as { id: string }).id);

    expect(ids).toEqual(['el-ent0', 'el-ent', 'el-task']);
  });

  test('preserves unparseable lines instead of dropping them', () => {
    const garbage = '{not valid json';
    const existing = [line({ id: 'el-a' }), garbage].join('\n');

    const result = mergeElementLines(existing, updatesOf([['el-b', line({ id: 'el-b' })]]));

    expect(result.content).toContain(garbage);
    expect(result.total).toBe(3);
  });

  test('collapses duplicate ids to a single line', () => {
    const existing = [
      line({ id: 'el-a', title: 'first' }),
      line({ id: 'el-a', title: 'second' }),
      line({ id: 'el-b' }),
    ].join('\n');

    const result = mergeElementLines(existing, new Map());

    expect(result.total).toBe(2);
    // First occurrence wins
    expect(result.content).toContain('first');
    expect(result.content).not.toContain('second');
  });

  test('handles an empty existing file', () => {
    const result = mergeElementLines('', updatesOf([['el-a', line({ id: 'el-a' })]]));

    expect(result.total).toBe(1);
    expect(result.appended).toBe(1);
    expect(result.content).toBe(line({ id: 'el-a' }));
  });

  test('handles no updates (re-sorts only)', () => {
    const existing = [line({ id: 'el-b' }), line({ id: 'el-a' })].join('\n');

    const result = mergeElementLines(existing, new Map());

    expect(result.total).toBe(2);
    const ids = result.content.split('\n').map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids).toEqual(['el-a', 'el-b']);
  });
});
