/**
 * Plan API Hooks - React Query hooks for plan operations
 *
 * Centralized API hooks for fetching and mutating plan data.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { HydratedPlan, PlanProgress, PlanType, TaskType } from '../../routes/plans/types';

/**
 * Hook to fetch plans with optional status filter and progress hydration
 */
export function usePlans(status?: string) {
  return useQuery<HydratedPlan[]>({
    queryKey: ['plans', status, 'with-progress'],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('hydrate.progress', 'true');
      if (status) {
        params.set('status', status);
      }
      const response = await fetch(`/api/plans?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch plans');
      }
      return response.json();
    },
  });
}

/**
 * Hook to fetch a single plan by ID with progress hydration
 */
export function usePlan(planId: string | null) {
  return useQuery<HydratedPlan>({
    queryKey: ['plans', planId],
    queryFn: async () => {
      if (!planId) throw new Error('No plan selected');
      const response = await fetch(`/api/plans/${planId}?hydrate.progress=true`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to fetch plan');
      }
      return response.json();
    },
    enabled: !!planId,
  });
}

/**
 * Hook to fetch tasks belonging to a plan
 */
export function usePlanTasks(planId: string | null) {
  return useQuery<TaskType[]>({
    queryKey: ['plans', planId, 'tasks'],
    queryFn: async () => {
      if (!planId) throw new Error('No plan selected');
      const response = await fetch(`/api/plans/${planId}/tasks`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to fetch plan tasks');
      }
      return response.json();
    },
    enabled: !!planId,
  });
}

/**
 * Hook to fetch progress statistics for a plan
 */
export function usePlanProgress(planId: string | null) {
  return useQuery<PlanProgress>({
    queryKey: ['plans', planId, 'progress'],
    queryFn: async () => {
      if (!planId) throw new Error('No plan selected');
      const response = await fetch(`/api/plans/${planId}/progress`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to fetch plan progress');
      }
      return response.json();
    },
    enabled: !!planId,
  });
}

/**
 * Hook to update a plan
 */
export function useUpdatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, updates }: { planId: string; updates: Partial<PlanType> }) => {
      const response = await fetch(`/api/plans/${planId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to update plan');
      }
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId] });
    },
  });
}

/**
 * Hook to add a task to a plan
 */
export function useAddTaskToPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, taskId }: { planId: string; taskId: string }) => {
      const response = await fetch(`/api/plans/${planId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to add task to plan');
      }
      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId, 'tasks'] });
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId, 'progress'] });
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId] });
    },
  });
}

/**
 * Hook to remove a task from a plan
 */
export function useRemoveTaskFromPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ planId, taskId }: { planId: string; taskId: string }) => {
      const response = await fetch(`/api/plans/${planId}/tasks/${taskId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to remove task from plan');
      }
      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId, 'tasks'] });
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId, 'progress'] });
      queryClient.invalidateQueries({ queryKey: ['plans', variables.planId] });
    },
  });
}

/**
 * The GET /api/tasks response envelope (ListResult).
 *
 * This endpoint is contractually paginated — it NEVER returns a bare array
 * (see the "Quarry Task List API Envelopes" workspace doc, el-1ib6v4). Call
 * `.filter()`/`.map()` on the parsed response and you get a TypeError.
 */
interface TaskListResult {
  items: TaskType[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Page size used while walking GET /api/tasks. Larger pages mean fewer round
 * trips; anything up to the server's MAX_PAGE_SIZE (10000) is accepted.
 */
const TASKS_PAGE_SIZE = 500;

/** The picker renders at most this many rows. */
const MAX_PICKER_RESULTS = 50;

/**
 * Fetch the tasks that could still be added to a plan: every task not already
 * in it, optionally narrowed by a title/ID search query.
 *
 * Extracted from useAvailableTasks so the envelope handling is unit-testable
 * against real response fixtures (usePlanApi.bun.test.ts) — the hook itself
 * needs a React tree.
 */
export async function fetchAvailableTasks(
  planId: string | null,
  searchQuery: string
): Promise<TaskType[]> {
  if (!planId) return [];

  // Get ALL tasks, not just the first page. GET /api/tasks returns one page
  // of the ListResult envelope, so: unwrap `items` before any array method,
  // then keep paging (offset += items.length) until hasMore is false — the
  // ordering is tie-broken, so the walk is stable with no skips or repeats.
  // Fetching only one page (the server default is 50) would silently hide
  // tasks from the exclusion and the search below.
  const allTasks: TaskType[] = [];
  let offset = 0;
  for (;;) {
    const tasksResponse = await fetch(`/api/tasks?limit=${TASKS_PAGE_SIZE}&offset=${offset}`);
    if (!tasksResponse.ok) {
      throw new Error('Failed to fetch tasks');
    }
    const data: unknown = await tasksResponse.json();
    if (typeof data !== 'object' || data === null || !Array.isArray((data as TaskListResult).items)) {
      // Fail loudly, never return []: a response without an `items` array
      // means the envelope contract changed — an empty picker would look
      // like "no available tasks" and mislead the user (el-49ra rule).
      throw new Error('GET /api/tasks did not return the { items, ... } ListResult envelope');
    }
    const page = data as TaskListResult;
    allTasks.push(...page.items);
    if (!page.hasMore) break;
    if (page.items.length === 0) {
      // Defensive: hasMore=true with an empty page would loop forever.
      throw new Error('GET /api/tasks pagination stalled (hasMore=true with an empty page)');
    }
    offset += page.items.length;
  }

  // Get tasks already in the plan. Unlike /api/tasks, this endpoint returns
  // a bare Task[] (built on getTasksInPlan, not listPaginated) — no envelope.
  const planTasksResponse = await fetch(`/api/plans/${planId}/tasks`);
  if (!planTasksResponse.ok) {
    throw new Error('Failed to fetch plan tasks');
  }
  const planTasks = await planTasksResponse.json() as TaskType[];
  const planTaskIds = new Set(planTasks.map(t => t.id));

  // Filter to only tasks not in plan
  let available = allTasks.filter(t => !planTaskIds.has(t.id));

  // Filter by search query
  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    available = available.filter(t =>
      t.title.toLowerCase().includes(query) ||
      t.id.toLowerCase().includes(query)
    );
  }

  return available.slice(0, MAX_PICKER_RESULTS); // Limit results
}

/**
 * Hook to fetch tasks not currently in a plan (for task picker)
 */
export function useAvailableTasks(planId: string | null, searchQuery: string) {
  return useQuery<TaskType[]>({
    queryKey: ['tasks', 'available', planId, searchQuery],
    queryFn: () => fetchAvailableTasks(planId, searchQuery),
    enabled: !!planId,
  });
}
