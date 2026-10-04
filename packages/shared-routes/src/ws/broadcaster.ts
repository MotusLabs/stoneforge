/**
 * Event Broadcaster
 *
 * Singleton service for broadcasting events to connected WebSocket clients.
 * Uses a polling mechanism to check for new events in the database.
 */

import type { QuarryLikeAPI } from '../types.js';
import type { WebSocketEvent } from './types.js';

/**
 * Database event row structure
 */
interface EventRow {
  id: number;
  element_id: string;
  event_type: string;
  actor: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

/**
 * Listener callback for events
 */
export type EventListener = (event: WebSocketEvent) => void;

/**
 * Event Broadcaster Service
 *
 * Polls the database for new events and broadcasts them to listeners.
 */
export class EventBroadcaster {
  private api: QuarryLikeAPI;
  private listeners: Set<EventListener> = new Set();
  private lastEventId: number = 0;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  /**
   * In-flight startup promise, so concurrent `start()` calls share one
   * startup and `stop()` can wait for startup work to settle.
   */
  private startPromise: Promise<void> | null = null;
  /**
   * Incremented on every `stop()`. A `start()` that began before a `stop()`
   * detects the mismatch once its awaits resume and must not arm the poll
   * interval — otherwise teardown leaves a late-started poller running
   * against a closed database.
   */
  private stopGeneration = 0;

  constructor(api: QuarryLikeAPI, pollIntervalMs: number = 500) {
    this.api = api;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Add a listener for events
   */
  addListener(listener: EventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a listener
   */
  removeListener(listener: EventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Get the number of active listeners
   */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Start polling for events.
   *
   * Safe to call concurrently: overlapping calls await the same startup.
   * If `stop()` is called while startup is in flight, the startup completes
   * but the poll interval is never armed.
   */
  async start(): Promise<void> {
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
    // Initialize last event ID from database
    await this.initializeLastEventId();

    // A stop() raced this startup — do not arm the poll interval
    if (generation !== this.stopGeneration) {
      return;
    }

    // Start polling
    this.pollInterval = setInterval(() => {
      this.pollForEvents().catch((err) => {
        console.error('[ws] Error polling for events:', err);
      });
    }, this.pollIntervalMs);

    console.log(`[ws] Event broadcaster started (polling every ${this.pollIntervalMs}ms)`);
  }

  /**
   * Stop polling for events.
   *
   * If a `start()` is still in flight, this awaits it first, so once the
   * returned promise resolves no startup work (and no poll interval armed by
   * it) is left running. Callers tearing down shared resources (e.g. closing
   * the database) should await this before doing so.
   */
  async stop(): Promise<void> {
    this.stopGeneration++;

    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Startup errors are logged by performStart paths; stop must not throw
      }
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[ws] Event broadcaster stopped');
    }
  }

  /**
   * Initialize the last event ID from the database
   */
  private async initializeLastEventId(): Promise<void> {
    try {
      // Access the backend through the API's internal structure
      // The API stores the backend, but we need to get it indirectly
      const backend = (this.api as unknown as { backend: { query: (sql: string) => EventRow[] } }).backend;
      const rows = backend.query('SELECT MAX(id) as id FROM events');
      if (rows.length > 0 && rows[0].id) {
        this.lastEventId = rows[0].id;
      }
    } catch (err) {
      console.error('[ws] Error initializing last event ID:', err);
    }
  }

  /**
   * Poll for new events and broadcast them
   */
  private async pollForEvents(): Promise<void> {
    if (this.listeners.size === 0) {
      return;
    }

    try {
      // Access the backend through the API
      const backend = (this.api as unknown as { backend: { query: (sql: string, params: unknown[]) => EventRow[] } }).backend;

      // Query for events newer than our last known event
      const events = backend.query(
        'SELECT e.*, el.type as element_type FROM events e LEFT JOIN elements el ON e.element_id = el.id WHERE e.id > ? ORDER BY e.id ASC LIMIT 100',
        [this.lastEventId]
      ) as (EventRow & { element_type: string | null })[];

      for (const event of events) {
        const wsEvent: WebSocketEvent = {
          id: event.id,
          elementId: event.element_id as import('@stoneforge/core').ElementId,
          eventType: event.event_type as import('@stoneforge/core').EventType,
          actor: event.actor as import('@stoneforge/core').EntityId,
          oldValue: event.old_value ? JSON.parse(event.old_value) : null,
          newValue: event.new_value ? JSON.parse(event.new_value) : null,
          createdAt: event.created_at as import('@stoneforge/core').Timestamp,
          elementType: event.element_type ?? 'unknown',
        };

        // Broadcast to all listeners
        for (const listener of this.listeners) {
          try {
            listener(wsEvent);
          } catch (err) {
            console.error('[ws] Error in event listener:', err);
          }
        }

        // Update last event ID
        if (event.id > this.lastEventId) {
          this.lastEventId = event.id;
        }
      }
    } catch (err) {
      console.error('[ws] Error polling for events:', err);
    }
  }
}

/**
 * Singleton broadcaster instance
 */
let broadcaster: EventBroadcaster | null = null;

/**
 * Initialize the event broadcaster with an API instance
 */
export function initializeBroadcaster(api: QuarryLikeAPI, pollIntervalMs?: number): EventBroadcaster {
  if (!broadcaster) {
    broadcaster = new EventBroadcaster(api, pollIntervalMs);
  }
  return broadcaster;
}

/**
 * Get the broadcaster instance
 */
export function getBroadcaster(): EventBroadcaster | null {
  return broadcaster;
}

/**
 * Clear the singleton broadcaster instance.
 *
 * After a server/app is stopped, the singleton still points at the stopped
 * broadcaster (bound to a possibly-closed database). A later
 * `initializeBroadcaster()` in the same process — e.g. integration tests
 * that create and tear down apps sequentially — would otherwise reuse that
 * stale instance. Call this during teardown so the next
 * `initializeBroadcaster()` creates a fresh instance.
 *
 * When `instance` is passed, the singleton is only cleared if it is that
 * exact instance — stopping one app must not unregister a different app's
 * broadcaster that has since taken over the singleton.
 */
export function resetBroadcaster(instance?: EventBroadcaster): void {
  if (instance && broadcaster !== instance) {
    return;
  }
  if (broadcaster) {
    void broadcaster.stop();
  }
  broadcaster = null;
}
