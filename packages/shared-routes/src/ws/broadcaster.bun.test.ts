/**
 * Event Broadcaster Tests
 *
 * Covers the polling lifecycle and the startup/shutdown race: a stop() that
 * lands while start() is still awaiting its database initialization must
 * prevent the poll interval from being armed afterwards, so no async work
 * outlives teardown (closed database, removed temp dirs).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  EventBroadcaster,
  initializeBroadcaster,
  getBroadcaster,
  resetBroadcaster,
} from './broadcaster.js';
import type { EventListener } from './broadcaster.js';
import type { QuarryLikeAPI } from '../types.js';
import type { WebSocketEvent } from './types.js';

// ============================================================================
// Fakes & Helpers
// ============================================================================

interface FakeEventRow {
  id: number;
  element_id: string;
  event_type: string;
  actor: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

/**
 * Minimal API double — the broadcaster only reaches the database through
 * `api.backend.query(...)`, so a bare query function is enough.
 */
function createFakeApi(rows: FakeEventRow[] = []) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const api = {
    backend: {
      query: (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('MAX(id)')) {
          return [{ id: rows.length > 0 ? rows[rows.length - 1].id : 0 }];
        }
        // Event poll query — return a copy so tests can mutate `rows` later
        return [...rows];
      },
    },
  };
  return { api: api as unknown as QuarryLikeAPI, queries };
}

function makeRow(id: number): FakeEventRow {
  return {
    id,
    element_id: `el-${id}`,
    event_type: 'task.created',
    actor: 'el-actor1',
    old_value: null,
    new_value: JSON.stringify({ title: 'Test' }),
    created_at: new Date().toISOString(),
  };
}

/** Wait for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Polling Lifecycle
// ============================================================================

describe('EventBroadcaster', () => {
  test('broadcasts new events to listeners while started', async () => {
    const { api } = createFakeApi();
    const broadcaster = new EventBroadcaster(api, 10);

    const received: WebSocketEvent[] = [];
    const listener: EventListener = (event) => received.push(event);
    broadcaster.addListener(listener);

    await broadcaster.start();

    // broadcaster keeps its own lastEventId; push an event it has not seen
    const { api: apiWithEvent } = createFakeApi([makeRow(1)]);
    (broadcaster as unknown as { api: QuarryLikeAPI }).api = apiWithEvent;

    await sleep(50);
    broadcaster.stop();
    await broadcaster.stop(); // idempotent

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].elementId).toBe('el-1');
  });

  test('stop halts polling — no events delivered after stop', async () => {
    const { api } = createFakeApi();
    const broadcaster = new EventBroadcaster(api, 10);

    const received: WebSocketEvent[] = [];
    broadcaster.addListener((event) => received.push(event));

    await broadcaster.start();
    await broadcaster.stop();

    // Expose fresh rows after stop
    const { api: apiWithEvent } = createFakeApi([makeRow(1)]);
    (broadcaster as unknown as { api: QuarryLikeAPI }).api = apiWithEvent;

    await sleep(50);

    expect(received).toHaveLength(0);
  });

  test('start is idempotent — concurrent starts share one startup', async () => {
    const { api } = createFakeApi();
    const broadcaster = new EventBroadcaster(api, 10);

    const [a, b] = await Promise.all([broadcaster.start(), broadcaster.start()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();

    await broadcaster.stop();
  });

  // --------------------------------------------------------------------------
  // Startup/shutdown race
  // --------------------------------------------------------------------------

  test('stop during startup prevents the poll interval from arming', async () => {
    const { api } = createFakeApi();
    const broadcaster = new EventBroadcaster(api, 10);

    // Begin startup but do NOT await it — stop() races the in-flight
    // initialization. Old behavior: stop() saw no pollInterval (no-op), then
    // start() resumed and armed the interval anyway, leaving a poller
    // running against torn-down resources.
    const started = broadcaster.start();
    const stopped = broadcaster.stop();
    await Promise.all([started, stopped]);

    // If the interval were (wrongly) armed, ticks every 10ms would deliver
    // this event within the wait window below.
    const { api: apiWithEvent } = createFakeApi([makeRow(1)]);
    (broadcaster as unknown as { api: QuarryLikeAPI }).api = apiWithEvent;

    const received: WebSocketEvent[] = [];
    broadcaster.addListener((event) => received.push(event));

    await sleep(60);

    expect(received).toHaveLength(0);
  });

  test('restart after stop works (fresh start re-arms polling)', async () => {
    const { api } = createFakeApi();
    const broadcaster = new EventBroadcaster(api, 10);

    await broadcaster.start();
    await broadcaster.stop();

    const received: WebSocketEvent[] = [];
    broadcaster.addListener((event) => received.push(event));

    await broadcaster.start();

    const { api: apiWithEvent } = createFakeApi([makeRow(1)]);
    (broadcaster as unknown as { api: QuarryLikeAPI }).api = apiWithEvent;

    await sleep(60);
    await broadcaster.stop();

    expect(received.length).toBeGreaterThan(0);
  });

  test('initializeLastEventId failure does not arm polling when stopped', async () => {
    // Backend that throws on every query (e.g. database already closed)
    const api = {
      backend: {
        query: () => {
          throw new Error('Database is closed');
        },
      },
    } as unknown as QuarryLikeAPI;
    const broadcaster = new EventBroadcaster(api, 10);

    const started = broadcaster.start();
    const stopped = broadcaster.stop();
    await Promise.all([started, stopped]);

    // No throw, and no interval armed: nothing delivers events afterwards
    const received: WebSocketEvent[] = [];
    broadcaster.addListener((event) => received.push(event));
    await sleep(40);
    expect(received).toHaveLength(0);
  });
});

// ============================================================================
// Singleton Management
// ============================================================================

describe('broadcaster singleton', () => {
  beforeEach(() => {
    resetBroadcaster();
  });

  afterEach(() => {
    resetBroadcaster();
  });

  test('initializeBroadcaster returns and caches the singleton', () => {
    const { api } = createFakeApi();
    const a = initializeBroadcaster(api);
    const b = initializeBroadcaster(api);

    expect(getBroadcaster()).toBe(a);
    expect(b).toBe(a);
  });

  test('resetBroadcaster clears the singleton so the next init is fresh', () => {
    const { api } = createFakeApi();
    const a = initializeBroadcaster(api);
    resetBroadcaster();

    expect(getBroadcaster()).toBeNull();

    const { api: api2 } = createFakeApi();
    const b = initializeBroadcaster(api2);
    expect(b).not.toBe(a);
    expect(getBroadcaster()).toBe(b);
  });

  test('resetBroadcaster with a foreign instance leaves the singleton alone', () => {
    const { api } = createFakeApi();
    const a = initializeBroadcaster(api);
    const { api: api2 } = createFakeApi();
    const foreign = new EventBroadcaster(api2);

    resetBroadcaster(foreign);
    expect(getBroadcaster()).toBe(a);

    // Own instance still resets
    resetBroadcaster(a);
    expect(getBroadcaster()).toBeNull();
  });
});
