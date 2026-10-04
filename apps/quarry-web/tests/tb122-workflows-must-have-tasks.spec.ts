import { test, expect } from '@playwright/test';
import {
  makePlaybook,
  mockPlaybookRoutes,
  mockWorkflowRoutes,
  openCreateWorkflowModalFromTemplate,
} from './helpers/create-workflow-modal';

/**
 * TB122: Workflows Must Have Task Children
 *
 * Tests that:
 * 1. Creating a workflow directly requires at least one task (initialTask or initialTaskId)
 * 2. Creating a workflow from a playbook requires at least one step
 * 3. Cannot delete the last task from a workflow
 * 4. UI shows appropriate warnings and disabled states
 */
test.describe('TB122: Workflows Must Have Task Children', () => {
  // ============================================================================
  // API Tests - POST /api/workflows Validation
  // ============================================================================

  test.describe('API - Create Workflow Validation', () => {
    test('POST /api/workflows without initial task returns validation error', async ({ page }) => {
      const response = await page.request.post('/api/workflows', {
        data: {
          title: 'Test Workflow Without Tasks',
          createdBy: 'system',
        },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('at least one task');
    });

    test('POST /api/workflows with initialTask creates workflow and task atomically', async ({ page }) => {
      const workflowTitle = `Test Workflow ${Date.now()}`;
      const taskTitle = `Initial Task ${Date.now()}`;

      const response = await page.request.post('/api/workflows', {
        data: {
          title: workflowTitle,
          createdBy: 'system',
          initialTask: {
            title: taskTitle,
            priority: 3,
          },
        },
      });

      expect(response.ok()).toBe(true);
      const created = await response.json();

      expect(created.workflow.id).toBeDefined();
      expect(created.workflow.title).toBe(workflowTitle);
      expect(created.initialTask).toBeDefined();
      expect(created.initialTask.id).toBeDefined();

      // Verify task was created and added to workflow
      const tasksResponse = await page.request.get(`/api/workflows/${created.workflow.id}/tasks`);
      expect(tasksResponse.ok()).toBe(true);
      const tasksBody = await tasksResponse.json();
      expect(tasksBody.tasks.length).toBe(1);
      expect(tasksBody.tasks[0].title).toBe(taskTitle);

      // Cleanup - use delete with force
      await page.request.delete(`/api/workflows/${created.workflow.id}?force=true`);
    });

    test('POST /api/workflows with initialTaskId adds existing task to workflow', async ({ page }) => {
      // Create a task first
      const taskResponse = await page.request.post('/api/tasks', {
        data: {
          title: `Existing Task ${Date.now()}`,
          createdBy: 'system',
        },
      });
      const task = await taskResponse.json();

      // Create workflow with existing task
      const workflowTitle = `Test Workflow ${Date.now()}`;
      const response = await page.request.post('/api/workflows', {
        data: {
          title: workflowTitle,
          createdBy: 'system',
          initialTaskId: task.id,
        },
      });

      expect(response.ok()).toBe(true);
      const created = await response.json();

      expect(created.workflow.id).toBeDefined();
      expect(created.workflow.title).toBe(workflowTitle);
      expect(created.initialTask.id).toBe(task.id);

      // Verify task was added to workflow
      const tasksResponse = await page.request.get(`/api/workflows/${created.workflow.id}/tasks`);
      const tasksBody = await tasksResponse.json();
      expect(tasksBody.tasks.length).toBe(1);
      expect(tasksBody.tasks[0].id).toBe(task.id);

      // Cleanup - delete workflow with force (will clean up task too)
      await page.request.delete(`/api/workflows/${created.workflow.id}?force=true`);
    });

    test('POST /api/workflows with invalid initialTaskId returns error', async ({ page }) => {
      const response = await page.request.post('/api/workflows', {
        data: {
          title: 'Test Workflow',
          createdBy: 'system',
          initialTaskId: 'el-nonexistent123',
        },
      });

      expect(response.status()).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // ============================================================================
  // API Tests - POST /api/workflows/instantiate Validation
  // ============================================================================

  test.describe('API - Create Workflow Validation', () => {
    test('POST /api/workflows/instantiate with empty steps returns validation error', async ({ page }) => {
      const response = await page.request.post('/api/workflows/instantiate', {
        data: {
          playbook: {
            name: 'empty-playbook',
            version: '1.0.0',
            variables: [],
            steps: [], // Empty steps
          },
          createdBy: 'system',
          title: 'Workflow from Empty Playbook',
        },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toContain('no steps defined');
    });

    test('POST /api/workflows/instantiate with valid playbook creates workflow with tasks', async ({ page }) => {
      const workflowTitle = `Create Test ${Date.now()}`;

      const response = await page.request.post('/api/workflows/instantiate', {
        data: {
          playbook: {
            name: 'test-playbook',
            version: '1.0.0',
            variables: [],
            steps: [
              { id: 'step-1', title: 'Step 1' },
              { id: 'step-2', title: 'Step 2' },
            ],
          },
          createdBy: 'system',
          title: workflowTitle,
        },
      });

      expect(response.ok()).toBe(true);
      const result = await response.json();

      expect(result.workflow).toBeDefined();
      expect(result.workflow.title).toBe(workflowTitle);
      expect(result.tasks).toBeDefined();
      expect(result.tasks.length).toBe(2);

      // Cleanup
      await page.request.delete(`/api/workflows/${result.workflow.id}?force=true`);
    });
  });

  // ============================================================================
  // API Tests - Delete Last Task Prevention
  // ============================================================================

  test.describe('API - Delete Last Task Prevention', () => {
    let workflowId: string;
    let taskId: string;

    test.beforeEach(async ({ page }) => {
      // Create a workflow with one task
      const response = await page.request.post('/api/workflows', {
        data: {
          title: `Test Workflow ${Date.now()}`,
          createdBy: 'system',
          initialTask: { title: `Task ${Date.now()}` },
        },
      });
      const created = await response.json();
      workflowId = created.workflow.id;
      taskId = created.initialTask.id;
    });

    test.afterEach(async ({ page }) => {
      // Cleanup - delete the workflow
      await page.request.delete(`/api/workflows/${workflowId}?force=true`);
    });

    test('DELETE /api/tasks/:id returns error when deleting last task in workflow', async ({ page }) => {
      // Try to delete the only task
      const response = await page.request.delete(`/api/tasks/${taskId}`);

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('LAST_TASK');
      expect(body.error.message).toContain('last task in a workflow');
    });

    test('GET /api/workflows/:id/can-delete-task/:taskId returns canDelete=false for last task', async ({ page }) => {
      const response = await page.request.get(`/api/workflows/${workflowId}/can-delete-task/${taskId}`);

      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.canDelete).toBe(false);
      expect(body.reason).toContain('last task');
      expect(body.isLastTask).toBe(true);
    });

    test('can delete task when workflow has multiple tasks', async ({ page }) => {
      // Create workflow with two tasks via create
      const response = await page.request.post('/api/workflows/instantiate', {
        data: {
          playbook: {
            name: 'two-step-playbook',
            version: '1.0.0',
            variables: [],
            steps: [
              { id: 'step-1', title: 'Step 1' },
              { id: 'step-2', title: 'Step 2' },
            ],
          },
          createdBy: 'system',
          title: `Multi-Task Workflow ${Date.now()}`,
        },
      });
      const result = await response.json();
      const multiWorkflowId = result.workflow.id;
      const firstTaskId = result.tasks[0].id;
      const secondTaskId = result.tasks[1].id;

      // Check canDelete for first task
      const canDeleteResponse = await page.request.get(`/api/workflows/${multiWorkflowId}/can-delete-task/${firstTaskId}`);
      const canDeleteBody = await canDeleteResponse.json();
      expect(canDeleteBody.canDelete).toBe(true);

      // Now we can delete the first task
      const deleteResponse = await page.request.delete(`/api/tasks/${firstTaskId}`);
      expect(deleteResponse.ok()).toBe(true);

      // Verify workflow still has one task
      const tasksResponse = await page.request.get(`/api/workflows/${multiWorkflowId}/tasks`);
      const tasksBody = await tasksResponse.json();
      expect(tasksBody.tasks.length).toBe(1);
      expect(tasksBody.tasks[0].id).toBe(secondTaskId);

      // Now the remaining task cannot be deleted
      const canDeleteSecondResponse = await page.request.get(`/api/workflows/${multiWorkflowId}/can-delete-task/${secondTaskId}`);
      const canDeleteSecondBody = await canDeleteSecondResponse.json();
      expect(canDeleteSecondBody.canDelete).toBe(false);

      // Cleanup
      await page.request.delete(`/api/workflows/${multiWorkflowId}?force=true`);
    });
  });

  // ============================================================================
  // UI Tests
  //
  // Creation is playbook-only: a workflow always gets its tasks from the
  // selected playbook's steps. The modal previews those steps and the server
  // rejects playbooks with no steps. The first tests mock the playbook
  // endpoints to exercise the modal UI with a known dataset; the remaining
  // ones run against the Quarry server and the playbook fixtures seeded by
  // the global setup.
  // ============================================================================

  test.describe('UI - Create Workflow Modal', () => {

    test('Create Workflow button is visible on playbook cards', async ({ page }) => {
      const playbook = makePlaybook();
      await mockPlaybookRoutes(page, { playbooks: [playbook] });

      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

      await expect(page.getByTestId(`playbook-create-${playbook.id}`)).toBeVisible();
    });

    test('clicking Create Workflow on a playbook opens the modal', async ({ page }) => {
      const playbook = makePlaybook();
      await mockPlaybookRoutes(page, { playbooks: [playbook] });

      await openCreateWorkflowModalFromTemplate(page, playbook);
      await expect(page.getByTestId('create-title-input')).toBeVisible();
    });

    test('create modal previews the playbook steps that become tasks', async ({ page }) => {
      const playbook = makePlaybook({
        steps: [
          { id: 'step-1', title: 'First Step' },
          { id: 'step-2', title: 'Second Step' },
          { id: 'step-3', title: 'Third Step' },
        ],
      });
      await mockPlaybookRoutes(page, { playbooks: [playbook] });

      await openCreateWorkflowModalFromTemplate(page, playbook);

      // Every step is listed — these become the workflow's tasks
      const stepsPreview = page.getByTestId('steps-preview');
      await expect(stepsPreview).toBeVisible();
      await expect(stepsPreview).toContainText('Steps (3)');
      await expect(stepsPreview).toContainText('First Step');
      await expect(stepsPreview).toContainText('Second Step');
      await expect(stepsPreview).toContainText('Third Step');
    });

    test('steps preview lists the tasks the workflow will get', async ({ page }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

      await page.getByTestId('playbook-create-e2e-release-flow').click();
      await expect(page.getByTestId('create-title-input')).toBeVisible({ timeout: 10000 });

      await expect(page.getByTestId('steps-preview')).toContainText('Steps (2)');
      await expect(page.getByTestId('steps-preview')).toContainText('Run test suite');
      await expect(page.getByTestId('steps-preview')).toContainText('Deploy to environment');
    });

    test('instantiating a playbook with no steps is rejected', async ({ page }) => {
      const playbook = makePlaybook({ steps: [] });
      await mockPlaybookRoutes(page, {
        playbooks: [playbook],
        // Mirrors the TB122 server guard: workflows must have at least one task
        instantiateError: {
          status: 400,
          code: 'VALIDATION_ERROR',
          message:
            'Cannot instantiate workflow: playbook has no steps defined. Workflows must have at least one task.',
        },
      });

      await openCreateWorkflowModalFromTemplate(page, playbook);
      await page.getByTestId('create-submit-button').click();

      // The error is surfaced in the modal, which stays open
      await expect(
        page.getByText('Workflows must have at least one task.')
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.getByRole('dialog', { name: 'Create Workflow', exact: true })
      ).toBeVisible();
    });

    test('instantiating a playbook without steps is rejected with the TB122 message', async ({ page }) => {
      await page.goto('/workflows');
      await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

      await page.getByTestId('playbook-create-e2e-empty-steps').click();
      await expect(page.getByTestId('create-title-input')).toBeVisible({ timeout: 10000 });

      await page.getByTestId('create-submit-button').click();

      // The modal stays open and surfaces the server-side TB122 rejection
      const dialog = page.getByRole('dialog', { name: 'Create Workflow', exact: true });
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await expect(dialog).toContainText('Workflows must have at least one task');

      // Nothing was created
      const listResponse = await page.request.get('/api/workflows?playbookId=e2e-empty-steps');
      const workflows = (await listResponse.json()).workflows;
      expect(workflows).toHaveLength(0);
    });

  });

  test.describe('UI - Workflow Detail View', () => {
    // The workflows page renders an inline detail view for the selected
    // workflow, listing its tasks. The last-task deletion guard itself is
    // enforced by the API (see the can-delete-task tests above). The first
    // tests mock the workflow endpoints to exercise the detail UI with a
    // known dataset; the last runs against the Quarry server.

    test('detail view shows the workflow task', async ({ page }) => {
      const workflow = {
        id: 'wf-single-task',
        title: 'Single Task Workflow',
        tasks: [{ id: 'task-only', title: 'Only Task' }],
      };
      await mockWorkflowRoutes(page, { workflows: [workflow] });

      await page.goto('/workflows?tab=active');
      await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

      // Click on the workflow card to open the detail view
      await page.getByTestId(`workflow-card-${workflow.id}`).click();
      await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('workflow-progress-dashboard')).toBeVisible();
      await expect(page.getByTestId('workflow-task-task-only')).toBeVisible();
    });

    test('detail view shows every task of a multi-task workflow', async ({ page }) => {
      const workflow = {
        id: 'wf-multi-task',
        title: 'Multi Task Workflow',
        tasks: [
          { id: 'task-first', title: 'First Step' },
          { id: 'task-second', title: 'Second Step' },
        ],
      };
      await mockWorkflowRoutes(page, { workflows: [workflow] });

      await page.goto('/workflows?tab=active');
      await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

      await page.getByTestId(`workflow-card-${workflow.id}`).click();
      await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 5000 });

      // Both tasks are listed
      await expect(page.getByTestId('workflow-task-task-first')).toBeVisible();
      await expect(page.getByTestId('workflow-task-task-second')).toBeVisible();
    });

    test('detail view lists the tasks of the workflow', async ({ page }) => {
      // Create a workflow with two tasks from the seeded playbook
      const createResponse = await page.request.post('/api/playbooks/e2e-release-flow/instantiate', {
        data: { variables: { environment: 'production' } },
      });
      expect(createResponse.status()).toBe(201);
      const result = await createResponse.json();

      await page.goto(`/workflows?tab=active&selected=${result.workflow.id}`);
      await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 10000 });

      // Both tasks of the workflow are listed
      await expect(page.getByTestId(`workflow-task-${result.tasks[0].id}`)).toBeVisible();
      await expect(page.getByTestId(`workflow-task-${result.tasks[1].id}`)).toBeVisible();
      await expect(page.getByTestId('workflow-progress-dashboard')).toContainText('Run test suite');
      await expect(page.getByTestId('workflow-progress-dashboard')).toContainText('Deploy to environment');

      // Cleanup
      await page.request.delete(`/api/workflows/${result.workflow.id}?force=true`);
    });

  });
});
