/**
 * Hooks for the Dashboard page
 * All data fetching hooks for dashboard-related operations
 */

import { useQuery } from '@tanstack/react-query';
import type { Task } from '../../components/entity';
import type { StatsResponse, HealthResponse, StoneforgeEvent, Entity } from './types';

/**
 * Fetch system-wide statistics
 */
export function useStats() {
  return useQuery<StatsResponse>({
    queryKey: ['stats'],
    queryFn: async () => {
      const response = await fetch('/api/stats');
      if (!response.ok) throw new Error('Failed to fetch stats');
      return response.json();
    },
  });
}

/**
 * Fetch server health status with auto-refresh
 */
export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: async () => {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Failed to fetch health');
      return response.json();
    },
    refetchInterval: 30000,
  });
}

/**
 * Fetch tasks that are ready to be worked on
 */
export function useReadyTasks() {
  return useQuery<Task[]>({
    queryKey: ['tasks', 'ready'],
    queryFn: async () => {
      const response = await fetch('/api/tasks/ready');
      if (!response.ok) throw new Error('Failed to fetch ready tasks');
      return response.json();
    },
  });
}

/**
 * Fetch recent events for the activity feed with auto-refresh
 */
export function useRecentEvents() {
  return useQuery<StoneforgeEvent[]>({
    queryKey: ['events', 'recent'],
    queryFn: async () => {
      const response = await fetch('/api/events?limit=10');
      if (!response.ok) throw new Error('Failed to fetch events');
      return response.json();
    },
    refetchInterval: 30000,
  });
}

/**
 * Fetch all entities
 */
export function useEntities() {
  return useQuery<Entity[]>({
    queryKey: ['entities'],
    queryFn: async () => {
      const response = await fetch('/api/entities');
      if (!response.ok) throw new Error('Failed to fetch entities');
      const data = await response.json();
      // Handle paginated response format
      return data.items || data;
    },
  });
}

/**
 * Fetch count of tasks completed today.
 *
 * "Completed Today" = tasks whose completion timestamp — `closedAt` (set
 * exactly when the task was closed, cleared on reopen), falling back to
 * `updatedAt` only for tasks closed through paths that don't record
 * `closedAt` — falls within the local calendar day. A task closed yesterday
 * but edited today does NOT count.
 *
 * The rule is enforced server-side: `after` maps to TaskFilter.closedAfter
 * (a SQL filter applied before pagination), and the endpoint returns the
 * exact match count in `total` — see the response envelope documented in the
 * "Quarry Task List API Envelopes" workspace doc. No client-side filtering
 * or page-walking is needed (or correct: GET /api/tasks returns a ListResult
 * envelope, not an array — calling .filter() on it throws, which is how this
 * metric used to read as a permanent 0).
 */
export function useCompletedTodayCount() {
  return useQuery<number>({
    queryKey: ['tasks', 'completedToday'],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // limit=1: only the count is needed; `total` is exact regardless of
      // page size, and a one-row page keeps the response cheap.
      const response = await fetch(`/api/tasks/completed?after=${encodeURIComponent(today.toISOString())}&limit=1`);
      if (!response.ok) throw new Error('Failed to fetch completed-today count');

      const data: { total?: unknown } = await response.json();
      if (typeof data.total !== 'number') {
        // Fail loudly rather than report a wrong count — a missing `total`
        // means the contract changed, not that zero tasks completed today.
        throw new Error('GET /api/tasks/completed returned no total count');
      }
      return data.total;
    },
  });
}
