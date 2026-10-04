import { test, expect } from '@playwright/test';
import {
  makePlaybook,
  mockPlaybookRoutes,
  mockWorkflowRoutes,
  openCreateWorkflowModalFromTemplate,
  type MockWorkflow,
} from './helpers/create-workflow-modal';

test.describe('TB25: Workflow List + Create', () => {
  // ============================================================================
  // API Endpoint Tests
  // ============================================================================

  test('GET /api/workflows returns list of workflows', async ({ page }) => {
    const response = await page.request.get('/api/workflows');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(Array.isArray(body.workflows)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.total).toBe(body.workflows.length);

    // Check each workflow has required fields
    for (const workflow of body.workflows) {
      expect(workflow.type).toBe('workflow');
      expect(workflow.title).toBeDefined();
      expect(['pending', 'running', 'completed', 'failed', 'cancelled']).toContain(workflow.status);
      expect(workflow.createdAt).toBeDefined();
      expect(workflow.updatedAt).toBeDefined();
      expect(workflow.createdBy).toBeDefined();
    }
  });

  test('GET /api/workflows supports status filter parameter', async ({ page }) => {
    // Test that the status parameter is accepted
    const response = await page.request.get('/api/workflows?status=pending');
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(Array.isArray(body.workflows)).toBe(true);
    for (const workflow of body.workflows) {
      expect(workflow.status).toBe('pending');
    }
  });

  /**
   * Creates a workflow with one task so the read endpoints have data to
   * return regardless of test ordering.
   */
  async function createTestWorkflow(page: import('@playwright/test').Page) {
    const response = await page.request.post('/api/workflows', {
      data: {
        title: `Endpoint Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        initialTask: { title: 'Endpoint task' },
      },
    });
    expect(response.ok()).toBe(true);
    return response.json().then((body) => body.workflow);
  }

  test('GET /api/workflows/:id returns a workflow', async ({ page }) => {
    const workflow = await createTestWorkflow(page);

    // Get single workflow
    const response = await page.request.get(`/api/workflows/${workflow.id}`);
    expect(response.ok()).toBe(true);
    const body = await response.json();

    expect(body.workflow.id).toBe(workflow.id);
    expect(body.workflow.type).toBe('workflow');
    expect(body.workflow.title).toBe(workflow.title);

    // Cleanup
    await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
  });

  test('GET /api/workflows/:id returns 404 for invalid ID', async ({ page }) => {
    const response = await page.request.get('/api/workflows/el-invalid999999');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('GET /api/workflows/:id with hydrate.progress includes progress', async ({ page }) => {
    const workflow = await createTestWorkflow(page);

    const response = await page.request.get(`/api/workflows/${workflow.id}?hydrate.progress=true`);
    expect(response.ok()).toBe(true);
    const body = await response.json();

    expect(body.workflow._progress).toBeDefined();
    expect(body.workflow._progress.totalTasks).toBe(1);
    expect(typeof body.workflow._progress.completionPercentage).toBe('number');

    // Cleanup
    await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
  });

  test('GET /api/workflows/:id/progress returns progress metrics', async ({ page }) => {
    const workflow = await createTestWorkflow(page);

    const response = await page.request.get(`/api/workflows/${workflow.id}/progress`);
    expect(response.ok()).toBe(true);
    const progress = await response.json();

    expect(typeof progress.totalTasks).toBe('number');
    expect(typeof progress.completionPercentage).toBe('number');
    expect(typeof progress.readyTasks).toBe('number');
    expect(typeof progress.blockedTasks).toBe('number');

    // Validate percentage is between 0 and 100
    expect(progress.completionPercentage).toBeGreaterThanOrEqual(0);
    expect(progress.completionPercentage).toBeLessThanOrEqual(100);

    // Cleanup
    await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
  });

  test('GET /api/workflows/:id/tasks returns tasks in workflow', async ({ page }) => {
    const workflow = await createTestWorkflow(page);

    const response = await page.request.get(`/api/workflows/${workflow.id}/tasks`);
    expect(response.ok()).toBe(true);
    const body = await response.json();

    expect(Array.isArray(body.tasks)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.progress).toBeDefined();
    expect(typeof body.progress.total).toBe('number');
    expect(typeof body.progress.percentage).toBe('number');
    expect(Array.isArray(body.dependencies)).toBe(true);

    // Each task should be a valid task
    for (const task of body.tasks) {
      expect(task.type).toBe('task');
      expect(task.title).toBeDefined();
      expect(task.status).toBeDefined();
    }
    expect(body.total).toBe(1);
    expect(body.progress.total).toBe(1);

    // Cleanup
    await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
  });

  test('POST /api/workflows creates a new workflow with initial task', async ({ page }) => {
    // TB122: Workflows must have at least one task
    const newWorkflow = {
      title: `Test Workflow ${Date.now()}`,
      createdBy: 'test-user',
      status: 'pending',
      ephemeral: false,
      tags: ['test'],
      initialTask: {
        title: `Initial Task ${Date.now()}`,
        priority: 3,
      },
    };

    const response = await page.request.post('/api/workflows', {
      data: newWorkflow,
    });

    expect(response.status()).toBe(201);
    const created = await response.json();

    expect(created.workflow.type).toBe('workflow');
    expect(created.workflow.title).toBe(newWorkflow.title);
    expect(created.workflow.status).toBe('pending');
    expect(created.workflow.createdBy).toBe(newWorkflow.createdBy);
    expect(created.workflow.id).toBeDefined();
    expect(created.initialTask).toBeDefined();
    expect(created.initialTask.id).toBeDefined();

    // Cleanup
    await page.request.delete(`/api/workflows/${created.workflow.id}?force=true`);
  });

  test('POST /api/workflows validates required fields', async ({ page }) => {
    // Missing title
    const response1 = await page.request.post('/api/workflows', {
      data: { createdBy: 'test-user' },
    });
    expect(response1.status()).toBe(400);

    // Missing createdBy
    const response2 = await page.request.post('/api/workflows', {
      data: { title: 'Test Workflow' },
    });
    expect(response2.status()).toBe(400);
  });

  test('POST /api/workflows/instantiate creates workflow from playbook', async ({ page }) => {
    const playbook = {
      name: 'Test Playbook',
      version: '1.0.0',
      variables: [],
      steps: [
        { id: 'step-1', title: 'First Step', priority: 3 },
        { id: 'step-2', title: 'Second Step', priority: 2 },
      ],
    };

    const response = await page.request.post('/api/workflows/instantiate', {
      data: {
        playbook,
        createdBy: 'test-user',
        title: `Created Workflow ${Date.now()}`,
      },
    });

    expect(response.status()).toBe(201);
    const result = await response.json();

    expect(result.workflow).toBeDefined();
    expect(result.workflow.type).toBe('workflow');
    expect(result.tasks).toBeDefined();
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks.length).toBe(2);
  });

  test('POST /api/workflows/instantiate validates required fields', async ({ page }) => {
    // Missing playbook
    const response1 = await page.request.post('/api/workflows/instantiate', {
      data: { createdBy: 'test-user' },
    });
    expect(response1.status()).toBe(400);

    // Missing createdBy
    const response2 = await page.request.post('/api/workflows/instantiate', {
      data: { playbook: { name: 'Test', version: '1.0.0', variables: [], steps: [] } },
    });
    expect(response2.status()).toBe(400);
  });

  test('PATCH /api/workflows/:id updates a workflow', async ({ page }) => {
    // Create a workflow to update (TB122: must have initial task)
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Update Test Workflow ${Date.now()}`,
        createdBy: 'test-user',
        status: 'pending',
        initialTask: { title: `Task ${Date.now()}` },
      },
    });
    const created = await createResponse.json();
    const workflow = created.workflow;

    // Update the workflow
    const newTitle = `Updated Workflow Title ${Date.now()}`;
    const updateResponse = await page.request.patch(`/api/workflows/${workflow.id}`, {
      data: { title: newTitle, status: 'running' },
    });

    expect(updateResponse.ok()).toBe(true);
    const updated = await updateResponse.json();

    expect(updated.workflow.title).toBe(newTitle);
    expect(updated.workflow.status).toBe('running');

    // Cleanup
    await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
  });

  test('PATCH /api/workflows/:id validates status values', async ({ page }) => {
    const workflow = await createTestWorkflow(page);

    const response = await page.request.patch(`/api/workflows/${workflow.id}`, {
      data: { status: 'invalid_status' },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');

    // Cleanup
    await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
  });

  // ============================================================================
  // UI Tests - Workflows Page
  // ============================================================================

  test('workflows page is accessible', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });
  });

  test('workflows page shows header with title', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });
    // Use role-based selector to get the h1 specifically
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  });

  test('workflows page shows templates and active tabs', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // Both tabs are present (Templates is the default)
    await expect(page.getByTestId('workflows-tab-templates')).toBeVisible();
    await expect(page.getByTestId('workflows-tab-active')).toBeVisible();
    await expect(page.getByTestId('workflows-search')).toBeVisible();
  });

  test('workflows page shows create template button', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // The templates tab header button creates a new template (playbook)
    await expect(page.getByTestId('workflows-create')).toBeVisible();
    await expect(page.getByTestId('workflows-create')).toContainText('Create Template');
  });

  test('clicking create template button opens the template editor', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('workflows-create').click();
    await expect(page.getByRole('dialog', { name: 'Create Template', exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('templates tab lists playbook templates from the server', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // The global setup seeds the e2e-release-flow playbook fixture
    const card = page.getByTestId('playbook-card-e2e-release-flow');
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('E2E Release Flow');
    await expect(card).toContainText('2 steps');
  });

  test('clicking create workflow on a playbook card opens modal', async ({ page }) => {
    // Creation is playbook-only: the modal opens from a playbook template
    // card. Playbook endpoints are mocked because the Quarry server only
    // serves filesystem discovery for playbooks, not the CRUD/instantiate
    // API the shared modal uses.
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModalFromTemplate(page, playbook);
    await expect(page.getByTestId('create-title-input')).toBeVisible();
  });

  test('create workflow modal has input fields', async ({ page }) => {
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModalFromTemplate(page, playbook);

    // The title input and submit button appear once a playbook is selected
    await expect(page.getByTestId('create-title-input')).toBeVisible();
    await expect(page.getByTestId('create-submit-button')).toBeVisible();
    await expect(page.getByTestId('playbook-picker')).toBeVisible();
  });

  test('create workflow modal can be closed', async ({ page }) => {
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModalFromTemplate(page, playbook);

    await page.getByRole('dialog', { name: 'Create Workflow', exact: true }).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Create Workflow', exact: true })).not.toBeVisible({ timeout: 5000 });
  });

  test('clicking the active tab switches tabs', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // Click on the Active tab
    await page.getByTestId('workflows-tab-active').click();

    // The tab is reflected in the URL
    await expect(page).toHaveURL(/tab=active/);
  });

  test('active tab lists workflows when available', async ({ page }) => {
    // The shared UI hooks expect envelope responses the Quarry server does
    // not serve, so the list is exercised against mocked workflows
    const workflow = { id: 'wf-list-1', title: 'Listed Workflow', tasks: [] };
    await mockWorkflowRoutes(page, { workflows: [workflow] });

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // Should show the workflows grid with the workflow card
    await expect(page.getByTestId('active-workflows-grid')).toBeVisible();
    await expect(page.getByTestId(`workflow-card-${workflow.id}`)).toBeVisible();
  });

  test('active tab lists server workflows with their status', async ({ page }) => {
    // Create one active and one terminal workflow via the API
    const activeResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Active Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        initialTask: { title: 'Active task' },
      },
    });
    const active = (await activeResponse.json()).workflow;

    const terminalResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Terminal Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'completed',
        initialTask: { title: 'Terminal task' },
      },
    });
    const terminal = (await terminalResponse.json()).workflow;

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId('active-workflows-grid')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`workflow-card-${active.id}`)).toBeVisible();
    await expect(page.getByTestId(`workflow-card-${active.id}`)).toContainText('Active Workflow');
    await expect(page.getByTestId(`workflow-card-${terminal.id}`)).toBeVisible();

    // Cleanup
    await page.request.delete(`/api/workflows/${active.id}?force=true`);
    await page.request.delete(`/api/workflows/${terminal.id}?force=true`);
  });

  test('active tab shows empty state when there are no workflows', async ({ page }) => {
    await mockWorkflowRoutes(page, { workflows: [] });

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole('heading', { name: 'No workflows' })).toBeVisible();
  });

  test('clicking workflow card opens detail view', async ({ page }) => {
    const workflow = {
      id: 'wf-detail-1',
      title: 'Detail Workflow',
      tasks: [{ id: 'task-detail-1', title: 'Detail Task' }],
    };
    await mockWorkflowRoutes(page, { workflows: [workflow] });

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // Click on the workflow card
    await page.getByTestId(`workflow-card-${workflow.id}`).click();

    // Detail view should appear with the workflow's task
    await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('workflow-progress-dashboard')).toBeVisible();
    await expect(page.getByTestId('workflow-task-task-detail-1')).toBeVisible();
  });

  test('clicking a workflow card opens the detail view', async ({ page }) => {
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Detail Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        initialTask: { title: 'Detail task' },
      },
    });
    const createBody = await createResponse.json();
    const created = createBody.workflow;

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId(`workflow-card-${created.id}`)).toBeVisible({ timeout: 10000 });

    await page.getByTestId(`workflow-card-${created.id}`).click();

    // The detail view replaces the list and renders the workflow's tasks
    await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 10000 });
    const detail = page.getByTestId('workflow-progress-dashboard');
    await expect(detail.getByRole('heading', { name: created.title })).toBeVisible();
    await expect(page.getByTestId(`workflow-task-${createBody.initialTask.id}`)).toBeVisible();

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });

  test('workflow detail view back button works', async ({ page }) => {
    const workflow = {
      id: 'wf-back-1',
      title: 'Back Workflow',
      tasks: [{ id: 'task-back-1', title: 'Back Task' }],
    };
    await mockWorkflowRoutes(page, { workflows: [workflow] });

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    await page.getByTestId(`workflow-card-${workflow.id}`).click();
    await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 5000 });

    // Click back button
    await page.getByTestId('workflow-back-button').click();

    // Should return to the workflows list
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 5000 });
  });

  test('workflows page is navigable via sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 10000 });

    // Click on Workflows in sidebar
    await page.getByTestId('nav-workflows').click();

    // Should navigate to workflows page
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain('/workflows');
  });

  test('creating a workflow from a playbook shows it in list', async ({ page }) => {
    // Workflows are created by instantiating a playbook. Both the playbook
    // and workflow endpoints are mocked: the Quarry server does not serve the
    // API shapes the shared UI uses. The mocked workflow list is live, so the
    // workflow created through the modal appears in it.
    const workflows: MockWorkflow[] = [];
    await mockWorkflowRoutes(page, { workflows });

    const playbook = makePlaybook();
    const created = await mockPlaybookRoutes(page, {
      playbooks: [playbook],
      onInstantiate: (call) => {
        // Fires on submit, after `created` has been assigned
        workflows.push({
          id: created.id,
          title: call.title ?? playbook.title,
          tasks: playbook.steps.map((step, index) => ({
            id: `${created.id}-task-${index + 1}`,
            title: step.title,
          })),
        });
      },
    });

    await openCreateWorkflowModalFromTemplate(page, playbook);

    const workflowTitle = `E2E Test Workflow ${Date.now()}`;
    await page.getByTestId('create-title-input').fill(workflowTitle);
    await page.getByTestId('create-submit-button').click();

    // The modal closes and the page switches to the active tab
    await expect(
      page.getByRole('dialog', { name: 'Create Workflow', exact: true })
    ).not.toBeVisible({ timeout: 10000 });

    // The new workflow is listed
    await expect(page.getByTestId(`workflow-card-${created.id}`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`workflow-card-${created.id}`)).toContainText(workflowTitle);
  });

  test('creating a workflow from a template shows it in the active list', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // Open the create modal from the seeded template card: the playbook is
    // preselected and its details load from the playbook endpoints
    await page.getByTestId('playbook-create-e2e-release-flow').click();
    const dialog = page.getByRole('dialog', { name: 'Create Workflow', exact: true });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('create-title-input')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('create-title-input')).toHaveValue('E2E Release Flow');
    await expect(page.getByTestId('steps-preview')).toContainText('Run test suite');

    const workflowTitle = `E2E Template Workflow ${Date.now()}`;
    await page.getByTestId('create-title-input').fill(workflowTitle);

    await page.getByTestId('create-submit-button').click();

    // The modal closes and the page switches to the Active tab
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // Verify via the API that the workflow was created from the playbook
    const afterResponse = await page.request.get('/api/workflows?playbookId=e2e-release-flow');
    const afterWorkflows = (await afterResponse.json()).workflows;
    const created = afterWorkflows.find((w: { title: string }) => w.title === workflowTitle);
    expect(created).toBeDefined();

    // ...and that it is listed in the Active tab
    await expect(page.getByTestId(`workflow-card-${created.id}`)).toBeVisible({ timeout: 10000 });

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });

  test('deleting a completed durable workflow from its card forces the delete', async ({ page }) => {
    // A completed durable workflow lands in the Recent section, whose card
    // menu offers Delete. The Quarry server rejects DELETE of a durable
    // workflow unless it is sent with ?force=true, so the card's delete must
    // be issued as forced or it silently fails. Workflow list routes are
    // mocked (see mockWorkflowRoutes) with the forced DELETE intercepted
    // separately below.
    const workflows: MockWorkflow[] = [
      { id: 'wf-delete-1', title: 'Completed Durable Workflow', status: 'completed', ephemeral: false },
    ];
    await mockWorkflowRoutes(page, { workflows });

    // Fulfill the forced DELETE and drop the workflow from the live list, as
    // the server would. The glob '?' is literal, so only the forced URL
    // matches here; an unforced DELETE falls through to the real server,
    // which rejects it with 400 and fails this test.
    let forcedDeleteSeen = false;
    await page.route('**/api/workflows/*?force=true', async (route) => {
      forcedDeleteSeen = true;
      const url = new URL(route.request().url());
      const workflowId = url.pathname.split('/').pop();
      const index = workflows.findIndex((w) => w.id === workflowId);
      if (index !== -1) workflows.splice(index, 1);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, workflowId }),
      });
    });

    await page.goto('/workflows?tab=active');
    await expect(page.getByTestId('workflows-page')).toBeVisible({ timeout: 10000 });

    // The completed workflow is listed in the Recent section
    const card = page.getByTestId('workflow-card-wf-delete-1');
    await expect(card).toBeVisible();

    // Open the card menu and click Delete
    await card.getByRole('button', { name: 'Workflow actions' }).click();
    await card.getByRole('button', { name: 'Delete' }).click();

    // The delete was issued with force and the card is removed from the list
    await expect(card).not.toBeVisible({ timeout: 10000 });
    expect(forcedDeleteSeen).toBe(true);
  });

});

// ============================================================================
// TB48: Edit Workflow Tests
// ============================================================================

test.describe('TB48: Edit Workflow', () => {
  // ============================================================================
  // API Endpoint Tests - Delete
  // ============================================================================

  test('DELETE /api/workflows/:id deletes ephemeral workflow', async ({ page }) => {
    // First create an ephemeral workflow
    const createResponse = await page.request.post('/api/workflows/instantiate', {
      data: {
        playbook: {
          name: 'Test Delete Playbook',
          version: '1.0.0',
          variables: [],
          steps: [{ id: 'step-1', title: 'Step 1', priority: 3 }],
        },
        createdBy: 'test-user',
        title: `Delete Test Workflow ${Date.now()}`,
        ephemeral: true,
      },
    });
    expect(createResponse.status()).toBe(201);
    const createResult = await createResponse.json();
    const workflow = createResult.workflow;

    // Delete the workflow
    const deleteResponse = await page.request.delete(`/api/workflows/${workflow.id}`);
    expect(deleteResponse.ok()).toBe(true);
    const result = await deleteResponse.json();
    expect(result.workflowId).toBe(workflow.id);

    // Verify workflow no longer exists
    const getResponse = await page.request.get(`/api/workflows/${workflow.id}`);
    expect(getResponse.status()).toBe(404);
  });

  test('DELETE /api/workflows/:id returns 400 for durable workflow without force', async ({ page }) => {
    // First create a durable workflow
    const createResponse = await page.request.post('/api/workflows/instantiate', {
      data: {
        playbook: {
          name: 'Test Durable Playbook',
          version: '1.0.0',
          variables: [],
          steps: [{ id: 'step-1', title: 'Step 1', priority: 3 }],
        },
        createdBy: 'test-user',
        title: `Durable Test Workflow ${Date.now()}`,
        ephemeral: false,
      },
    });
    expect(createResponse.status()).toBe(201);
    const createResult = await createResponse.json();
    const workflow = createResult.workflow;

    // Try to delete without force - should fail
    const deleteResponse = await page.request.delete(`/api/workflows/${workflow.id}`);
    expect(deleteResponse.status()).toBe(400);
    const body = await deleteResponse.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('DELETE /api/workflows/:id with force=true works for durable workflow', async ({ page }) => {
    // First create a durable workflow
    const createResponse = await page.request.post('/api/workflows/instantiate', {
      data: {
        playbook: {
          name: 'Test Force Delete Playbook',
          version: '1.0.0',
          variables: [],
          steps: [{ id: 'step-1', title: 'Step 1', priority: 3 }],
        },
        createdBy: 'test-user',
        title: `Force Delete Test Workflow ${Date.now()}`,
        ephemeral: false,
      },
    });
    expect(createResponse.status()).toBe(201);
    const createResult = await createResponse.json();
    const workflow = createResult.workflow;

    // Delete with force flag
    const deleteResponse = await page.request.delete(`/api/workflows/${workflow.id}?force=true`);
    expect(deleteResponse.ok()).toBe(true);
  });

  test('DELETE /api/workflows/:id returns 404 for non-existent workflow', async ({ page }) => {
    const response = await page.request.delete('/api/workflows/el-invalid999');
    expect(response.status()).toBe(404);
  });

  // ============================================================================
  // API Endpoint Tests - Promote
  // ============================================================================

  test('POST /api/workflows/:id/promote promotes ephemeral to durable', async ({ page }) => {
    // First create an ephemeral workflow
    const createResponse = await page.request.post('/api/workflows/instantiate', {
      data: {
        playbook: {
          name: 'Test Promote Playbook',
          version: '1.0.0',
          variables: [],
          steps: [{ id: 'step-1', title: 'Step 1', priority: 3 }],
        },
        createdBy: 'test-user',
        title: `Promote Test Workflow ${Date.now()}`,
        ephemeral: true,
      },
    });
    expect(createResponse.status()).toBe(201);
    const createResult = await createResponse.json();
    const workflow = createResult.workflow;
    expect(workflow.ephemeral).toBe(true);

    // Promote the workflow
    const promoteResponse = await page.request.post(`/api/workflows/${workflow.id}/promote`);
    expect(promoteResponse.ok()).toBe(true);
    const updated = await promoteResponse.json();
    expect(updated.workflow.ephemeral).toBe(false);
  });

  test('POST /api/workflows/:id/promote returns 400 for already durable workflow', async ({ page }) => {
    // First create a durable workflow
    const createResponse = await page.request.post('/api/workflows/instantiate', {
      data: {
        playbook: {
          name: 'Test Already Durable Playbook',
          version: '1.0.0',
          variables: [],
          steps: [{ id: 'step-1', title: 'Step 1', priority: 3 }],
        },
        createdBy: 'test-user',
        title: `Already Durable Workflow ${Date.now()}`,
        ephemeral: false,
      },
    });
    expect(createResponse.status()).toBe(201);
    const createResult = await createResponse.json();
    const workflow = createResult.workflow;

    // Try to promote - should fail
    const promoteResponse = await page.request.post(`/api/workflows/${workflow.id}/promote`);
    expect(promoteResponse.status()).toBe(400);
    const body = await promoteResponse.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('POST /api/workflows/:id/promote returns 404 for non-existent workflow', async ({ page }) => {
    const response = await page.request.post('/api/workflows/el-invalid999/promote');
    expect(response.status()).toBe(404);
  });

  // ============================================================================
  // UI Tests - Workflow Card Actions
  // ============================================================================

  test('cancelling a workflow from the card menu updates its status', async ({ page }) => {
    // Create a pending workflow via the API
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Cancel Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        initialTask: { title: 'Cancel task' },
      },
    });
    const created = (await createResponse.json()).workflow;

    await page.goto('/workflows?tab=active');
    const card = page.getByTestId(`workflow-card-${created.id}`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // Cancel through the card actions menu
    await card.getByRole('button', { name: 'Workflow actions' }).click();
    await card.getByRole('button', { name: 'Cancel', exact: true }).click();

    // The card moves to the terminal (Recent) section with cancelled status
    await expect(card).toContainText('Cancelled', { timeout: 10000 });

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });

  // ============================================================================
  // API Endpoint Tests - Lifecycle Transitions
  // ============================================================================

  test('POST /api/workflows/:id/start rejects a workflow that is not pending', async ({ page }) => {
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Start Guard Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'completed',
        initialTask: { title: 'Start guard task' },
      },
    });
    const created = (await createResponse.json()).workflow;

    const response = await page.request.post(`/api/workflows/${created.id}/start`);
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_STATUS');

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });

  test('POST /api/workflows/:id/start returns 404 for non-existent workflow', async ({ page }) => {
    const response = await page.request.post('/api/workflows/el-nonexistent999999/start');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('POST /api/workflows/:id/cancel rejects terminal workflows', async ({ page }) => {
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Cancel Guard Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        status: 'completed',
        initialTask: { title: 'Cancel guard task' },
      },
    });
    const created = (await createResponse.json()).workflow;

    const response = await page.request.post(`/api/workflows/${created.id}/cancel`, {
      data: {},
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_STATUS');

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });

  // ============================================================================
  // UI Tests - Workflow Card Actions
  //
  // The current Workflows page has no inline Start/Promote/Edit-title
  // affordances (those belonged to the WorkflowDetailPanel design that no page
  // renders): lifecycle transitions go through the card actions menu and the
  // server endpoints. The edit-title, Start-button, Promote-button and
  // delete-confirmation tests of the old design were replaced accordingly.
  // ============================================================================

  test('pending workflow card menu offers Cancel and not Delete', async ({ page }) => {
    // Creation via POST /api/workflows yields a pending durable workflow
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Card Actions Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        initialTask: { title: 'Card actions task' },
      },
    });
    const created = (await createResponse.json()).workflow;

    await page.goto('/workflows?tab=active');
    const card = page.getByTestId(`workflow-card-${created.id}`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // The card menu offers Cancel for a non-terminal workflow; Delete is
    // reserved for terminal ones (see the forced-delete test in TB25)
    await card.getByRole('button', { name: 'Workflow actions' }).click();
    await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });

  test('started workflow renders as running on its card and detail view', async ({ page }) => {
    const createResponse = await page.request.post('/api/workflows', {
      data: {
        title: `Started Workflow ${Date.now()}`,
        createdBy: 'el-0000',
        initialTask: { title: 'Started task' },
      },
    });
    const created = (await createResponse.json()).workflow;

    // The page has no Start affordance: the pending -> running transition is
    // driven by the server lifecycle endpoint
    const startResponse = await page.request.post(`/api/workflows/${created.id}/start`);
    expect(startResponse.ok()).toBe(true);
    const started = (await startResponse.json()).workflow;
    expect(started.status).toBe('running');
    expect(started.startedAt).toBeDefined();

    await page.goto('/workflows?tab=active');
    const card = page.getByTestId(`workflow-card-${created.id}`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText('Running');

    await card.click();
    await expect(page.getByTestId('workflow-detail-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('workflow-progress-dashboard')).toContainText(started.title);

    // Cleanup
    await page.request.delete(`/api/workflows/${created.id}?force=true`);
  });
});
