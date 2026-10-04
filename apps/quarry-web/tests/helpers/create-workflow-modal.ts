/**
 * Helpers for exercising the playbook-only Create Workflow modal.
 *
 * The shared CreateWorkflowModal (@stoneforge/ui) requires a playbook to be
 * selected before a workflow can be created: there is no quick mode, the
 * workflow title input only appears after selection, and submission calls
 * POST /api/playbooks/:id/instantiate.
 *
 * The Quarry server discovers playbooks from the filesystem and does not back
 * the playbook CRUD/instantiate endpoints the modal relies on, so creation
 * flow tests mock the playbook endpoints with page.route() (the same pattern
 * used by the smithy-web workflow suite and other Quarry specs such as
 * tb157-responsive-states).
 */

import { expect, type Page } from '@playwright/test';

// ============================================================================
// Mock data factories
// ============================================================================

export interface MockPlaybookStep {
  id: string;
  title: string;
}

export interface MockPlaybookVariable {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface MockPlaybook {
  id: string;
  name: string;
  title: string;
  version?: number;
  steps: MockPlaybookStep[];
  variables?: MockPlaybookVariable[];
}

/** Build a playbook matching the @stoneforge/ui Playbook shape */
export function makePlaybook(overrides: Partial<MockPlaybook> = {}): MockPlaybook {
  return {
    id: 'pb-test-1',
    name: 'test_playbook',
    title: 'Test Playbook',
    version: 1,
    steps: [
      { id: 'step-1', title: 'First Step' },
      { id: 'step-2', title: 'Second Step' },
    ],
    variables: [],
    ...overrides,
  };
}

function playbookResponseBody(playbook: MockPlaybook) {
  const now = new Date().toISOString();
  return {
    id: playbook.id,
    type: 'playbook' as const,
    name: playbook.name,
    title: playbook.title,
    version: playbook.version ?? 1,
    steps: playbook.steps,
    variables: playbook.variables ?? [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'el-0000',
    tags: [],
    metadata: {},
  };
}

// ============================================================================
// Route mocking
// ============================================================================

export interface InstantiateCall {
  playbookId: string;
  title?: string;
  variables?: Record<string, unknown>;
  ephemeral?: boolean;
}

export interface MockPlaybookOptions {
  playbooks: MockPlaybook[];
  /** Workflow returned by the mocked instantiate endpoint */
  workflow?: { id: string; title: string; status?: string };
  /** Called with the payload captured from POST /api/playbooks/:id/instantiate */
  onInstantiate?: (call: InstantiateCall) => void;
  /**
   * Reject instantiation with an error response instead of the default 201,
   * e.g. the TB122 guard for playbooks without steps:
   * { status: 400, code: 'VALIDATION_ERROR', message: '...' }
   */
  instantiateError?: { status: number; code: string; message: string };
}

/**
 * Mock the playbook endpoints used by CreateWorkflowModal:
 *
 *   GET  /api/playbooks                 -> { playbooks: [...] }
 *   GET  /api/playbooks/:id             -> { playbook: {...} }
 *   POST /api/playbooks/:id/instantiate -> { workflow: {...} }
 *
 * Playwright glob `*` does not match `/`, so the three patterns are disjoint.
 */
export async function mockPlaybookRoutes(page: Page, options: MockPlaybookOptions) {
  const createdWorkflow = options.workflow ?? {
    id: 'wf-test-1',
    title: 'Created Workflow',
    status: 'pending',
  };

  await page.route('**/api/playbooks', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playbooks: options.playbooks.map(playbookResponseBody),
        total: options.playbooks.length,
      }),
    });
  });

  await page.route('**/api/playbooks/*', async (route) => {
    const url = new URL(route.request().url());
    const playbookId = url.pathname.split('/').pop();
    const playbook = options.playbooks.find((p) => p.id === playbookId);
    if (!playbook) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Playbook not found' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playbook: playbookResponseBody(playbook) }),
    });
  });

  await page.route('**/api/playbooks/*/instantiate', async (route) => {
    const url = new URL(route.request().url());
    const playbookId = url.pathname.split('/').slice(-2, -1)[0];
    let body: InstantiateCall = {};
    try {
      body = route.request().postDataJSON() as InstantiateCall;
    } catch {
      // No JSON body — treat as empty payload
    }
    options.onInstantiate?.({ ...body, playbookId });

    if (options.instantiateError) {
      await route.fulfill({
        status: options.instantiateError.status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: options.instantiateError.code,
            message: options.instantiateError.message,
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        workflow: {
          type: 'workflow',
          status: 'pending',
          ephemeral: true,
          ...createdWorkflow,
          title: body?.title || createdWorkflow.title,
        },
      }),
    });
  });

  return createdWorkflow;
}

// ============================================================================
// Workflow route mocking
// ============================================================================

export interface MockWorkflowTask {
  id: string;
  title: string;
  status?: 'open' | 'in_progress' | 'blocked' | 'closed';
}

export interface MockWorkflow {
  id: string;
  title: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  ephemeral?: boolean;
  tasks?: MockWorkflowTask[];
}

export interface MockWorkflowOptions {
  /**
   * Workflows served by the mocked endpoints. The array is captured and served
   * live: pushing into it (e.g. from mockPlaybookRoutes' onInstantiate) is
   * reflected on the next fetch.
   */
  workflows: MockWorkflow[];
}

function workflowTaskBody(task: MockWorkflowTask, now: string) {
  return {
    id: task.id,
    type: 'task' as const,
    title: task.title,
    status: task.status ?? 'open',
    priority: 3,
    complexity: 3,
    taskType: 'feature',
    ephemeral: false,
    createdAt: now,
    updatedAt: now,
    tags: [],
  };
}

function workflowBody(workflow: MockWorkflow, now: string) {
  return {
    id: workflow.id,
    type: 'workflow' as const,
    title: workflow.title,
    status: workflow.status ?? 'pending',
    ephemeral: workflow.ephemeral ?? false,
    variables: {},
    createdAt: now,
    updatedAt: now,
    createdBy: 'el-0000',
    tags: [],
  };
}

/**
 * Mock the workflow endpoints used by the workflows page:
 *
 *   GET /api/workflows           -> { workflows: [...], total }
 *   GET /api/workflows/:id       -> { workflow: {...} }
 *   GET /api/workflows/:id/tasks -> { tasks: [...], progress, dependencies }
 *
 * The shared UI hooks expect these envelope shapes; the Quarry server returns
 * plain arrays/objects instead, so the page cannot render server workflows.
 * Mocking here exercises the list and detail UI with a known dataset.
 */
export async function mockWorkflowRoutes(page: Page, options: MockWorkflowOptions) {
  const now = new Date().toISOString();

  await page.route('**/api/workflows', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        workflows: options.workflows.map((workflow) => workflowBody(workflow, now)),
        total: options.workflows.length,
      }),
    });
  });

  await page.route('**/api/workflows/*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const workflowId = url.pathname.split('/').pop();
    const workflow = options.workflows.find((w) => w.id === workflowId);
    if (!workflow) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Workflow not found' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ workflow: workflowBody(workflow, now) }),
    });
  });

  await page.route('**/api/workflows/*/tasks', async (route) => {
    const url = new URL(route.request().url());
    const workflowId = url.pathname.split('/').slice(-2, -1)[0];
    const workflow = options.workflows.find((w) => w.id === workflowId);
    const tasks = (workflow?.tasks ?? []).map((task) => workflowTaskBody(task, now));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tasks,
        total: tasks.length,
        progress: {
          total: tasks.length,
          completed: 0,
          inProgress: 0,
          blocked: 0,
          open: tasks.length,
          percentage: 0,
        },
        dependencies: [],
      }),
    });
  });
}

// ============================================================================
// Modal helpers
// ============================================================================

/**
 * Open the Create Workflow modal via the dashboard quick action.
 *
 * The workflows page no longer has a dedicated create-workflow button: the
 * modal is reachable from playbook template cards (see
 * openCreateWorkflowModalFromTemplate) or from the global quick actions.
 */
export async function openCreateWorkflowModal(page: Page) {
  await page.goto('/dashboard');
  // Generous timeout: the first load of the dashboard route in a parallel
  // worker can wait on vite's dev-server transform of the route chunk
  await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 30000 });

  await page.getByTestId('quick-action-create-workflow').click();
  await expect(
    page.getByRole('dialog', { name: 'Create Workflow', exact: true })
  ).toBeVisible({ timeout: 5000 });
}

/**
 * Open the Create Workflow modal from a playbook template card on the
 * workflows page. Requires playbooks to be available (mock or real), and the
 * playbook arrives preselected in the modal.
 */
export async function openCreateWorkflowModalFromTemplate(
  page: Page,
  playbook: MockPlaybook
) {
  await page.goto('/workflows');
  // Generous timeout: the first load of the route chunk in a parallel worker
  // can wait on vite's dev-server transform
  await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 30000 });

  await page.getByTestId(`playbook-create-${playbook.id}`).click();
  await expect(
    page.getByRole('dialog', { name: 'Create Workflow', exact: true })
  ).toBeVisible({ timeout: 5000 });
  // The playbook is preselected; wait for its details to load
  await expect(page.getByTestId('create-title-input')).toBeVisible({ timeout: 5000 });
}

/** Pick a playbook in the modal picker and wait for its details to load */
export async function selectPlaybookInModal(page: Page, playbook: MockPlaybook) {
  await page.getByTestId('playbook-picker-trigger').click();
  await page.getByTestId(`playbook-option-${playbook.id}`).click();
  // Title input renders only once the selected playbook has loaded
  await expect(page.getByTestId('create-title-input')).toBeVisible({ timeout: 5000 });
}
