/**
 * Workflow Preset Hook
 *
 * Fetches and updates the workspace workflow preset via the server API.
 * The preset is stored in the workspace config file (config.yaml) and
 * controls merge behavior and agent permissions.
 *
 * State is kept in the shared react-query cache so that every consumer
 * (AppShell tour gating, the dashboard's first-load modal, and the Settings
 * workflow preset section) sees updates immediately. Without the shared
 * cache, selecting a preset in the first-load modal would not notify
 * AppShell, and the onboarding tour would never auto-start until a manual
 * page reload.
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type WorkflowPreset = 'auto' | 'review' | 'approve';

export interface WorkflowPresetState {
  /** Current preset value, null if not yet selected */
  preset: WorkflowPreset | null;
  /** Whether the initial fetch is still loading */
  isLoading: boolean;
  /** Error message if fetch/update failed */
  error: string | null;
  /** Whether the preset has been selected (not null) */
  isConfigured: boolean;
  /** Set the workflow preset */
  setPreset: (preset: WorkflowPreset) => Promise<boolean>;
}

const API_BASE = '/api';
const WORKFLOW_PRESET_QUERY_KEY = ['workflow-preset'] as const;

interface WorkflowPresetResponse {
  preset: WorkflowPreset | null;
  isConfigured?: boolean;
}

/**
 * Hook for managing the workspace workflow preset.
 *
 * Fetches the current preset on mount and provides a setter that
 * persists the choice to the server (config.yaml) and updates the
 * shared cache for all hook consumers.
 */
export function useWorkflowPreset(): WorkflowPresetState {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<WorkflowPresetResponse, Error>({
    queryKey: WORKFLOW_PRESET_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/settings/workflow-preset`, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    },
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  // Update preset
  const setPreset = useCallback(async (newPreset: WorkflowPreset): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/settings/workflow-preset`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: newPreset }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(errData.error?.message || `HTTP ${res.status}`);
      }
      // Propagate to every useWorkflowPreset consumer via the shared cache
      queryClient.setQueryData(WORKFLOW_PRESET_QUERY_KEY, { preset: newPreset });
      return true;
    } catch {
      return false;
    }
  }, [queryClient]);

  const preset = data?.preset ?? null;

  return {
    preset,
    isLoading,
    error: error ? error.message : null,
    isConfigured: preset !== null,
    setPreset,
  };
}
