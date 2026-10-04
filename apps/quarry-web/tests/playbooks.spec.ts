import { test, expect } from '@playwright/test';
import {
  makePlaybook,
  mockPlaybookRoutes,
  openCreateWorkflowModal,
  selectPlaybookInModal,
  type InstantiateCall,
} from './helpers/create-workflow-modal';

test.describe('TB26: Playbook Browser', () => {
  // ============================================================================
  // API Endpoint Tests
  // ============================================================================

  test('GET /api/playbooks returns list of playbooks', async ({ page }) => {
    const response = await page.request.get('/api/playbooks');
    expect(response.ok()).toBe(true);
    const playbooks = await response.json();
    expect(Array.isArray(playbooks)).toBe(true);

    // Check each playbook has required fields
    for (const playbook of playbooks) {
      expect(playbook.name).toBeDefined();
      expect(playbook.path).toBeDefined();
      expect(playbook.directory).toBeDefined();
    }
  });

  test('GET /api/playbooks/:name returns 404 for invalid name', async ({ page }) => {
    const response = await page.request.get('/api/playbooks/nonexistent-playbook-12345');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('GET /api/playbooks/:name returns playbook details when exists', async ({ page }) => {
    // First check if any playbooks exist
    const listResponse = await page.request.get('/api/playbooks');
    const playbooks = await listResponse.json();

    if (playbooks.length === 0) {
      test.skip();
      return;
    }

    // Get the first playbook's details
    const response = await page.request.get(`/api/playbooks/${playbooks[0].name}`);
    expect(response.ok()).toBe(true);
    const playbook = await response.json();

    expect(playbook.name).toBe(playbooks[0].name);
    expect(playbook.title).toBeDefined();
    expect(playbook.version).toBeDefined();
    expect(Array.isArray(playbook.steps)).toBe(true);
    expect(Array.isArray(playbook.variables)).toBe(true);
    expect(playbook.filePath).toBeDefined();
    expect(playbook.directory).toBeDefined();
  });

  // ============================================================================
  // UI Tests - Create Modal with Playbook Browser
  //
  // Creation is playbook-only: the modal has no quick mode, requires a
  // playbook to be selected before submitting, and instantiates the selected
  // playbook. The playbook endpoints are mocked because the Quarry server
  // only discovers playbooks from the filesystem and does not serve the
  // CRUD/instantiate API the shared modal uses.
  // ============================================================================

  test('create modal shows playbook picker and no quick mode', async ({ page }) => {
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModal(page);

    // The playbook picker is the first required field
    await expect(page.getByTestId('playbook-picker')).toBeVisible({ timeout: 5000 });

    // There is no quick/playbook mode toggle anymore
    await expect(page.getByTestId('mode-quick')).toHaveCount(0);
    await expect(page.getByTestId('mode-playbook')).toHaveCount(0);

    // The workflow title input only appears after a playbook is selected
    await expect(page.getByTestId('create-title-input')).toHaveCount(0);
  });

  test('submit button is disabled until a playbook is selected', async ({ page }) => {
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModal(page);

    // No playbook selected: submit is disabled
    await expect(page.getByTestId('create-submit-button')).toBeVisible();
    await expect(page.getByTestId('create-submit-button')).toBeDisabled();

    // Selecting a playbook enables submission
    await selectPlaybookInModal(page, playbook);
    await expect(page.getByTestId('create-submit-button')).toBeEnabled();
  });

  test('playbook picker shows available playbooks when they exist', async ({ page }) => {
    const first = makePlaybook();
    const second = makePlaybook({
      id: 'pb-test-2',
      name: 'another_playbook',
      title: 'Another Playbook',
    });
    await mockPlaybookRoutes(page, { playbooks: [first, second] });

    await openCreateWorkflowModal(page);

    // Click the picker trigger
    await page.getByTestId('playbook-picker-trigger').click();

    // Dropdown should be visible with every playbook option
    await expect(page.getByTestId('playbook-picker-dropdown')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId(`playbook-option-${first.id}`)).toBeVisible();
    await expect(page.getByTestId(`playbook-option-${second.id}`)).toBeVisible();
    await expect(page.getByTestId(`playbook-option-${first.id}`)).toContainText(first.title);
  });

  test('playbook picker dropdown toggles closed via the trigger', async ({ page }) => {
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModal(page);

    // Open the dropdown
    await page.getByTestId('playbook-picker-trigger').click();
    await expect(page.getByTestId('playbook-picker-dropdown')).toBeVisible({ timeout: 5000 });

    // Clicking the trigger again closes it (the picker has no click-outside handling)
    await page.getByTestId('playbook-picker-trigger').click();
    await expect(page.getByTestId('playbook-picker-dropdown')).not.toBeVisible({ timeout: 5000 });
  });

  test('selecting a playbook shows info, steps preview and default title', async ({ page }) => {
    const playbook = makePlaybook();
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModal(page);

    await selectPlaybookInModal(page, playbook);

    // Title input appears, defaulting to the playbook title
    await expect(page.getByTestId('create-title-input')).toBeVisible();
    await expect(page.getByTestId('create-title-input')).toHaveValue(playbook.title);

    // Playbook details and steps preview are shown
    await expect(page.getByTestId('steps-preview')).toBeVisible();
    await expect(page.getByTestId('steps-preview')).toContainText(`Steps (${playbook.steps.length})`);
    await expect(page.getByTestId('steps-preview')).toContainText(playbook.steps[0].title);
  });

  test('playbook with variables shows variable inputs', async ({ page }) => {
    const playbook = makePlaybook({
      variables: [
        { name: 'deploy_env', type: 'string', required: false, default: 'staging' },
      ],
    });
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModal(page);

    await selectPlaybookInModal(page, playbook);

    // A variable input is rendered for each playbook variable
    await expect(page.getByTestId('variable-input-deploy_env')).toBeVisible({ timeout: 5000 });
  });

  test('required variable without default keeps submit disabled until filled', async ({ page }) => {
    const playbook = makePlaybook({
      variables: [
        { name: 'api_key', type: 'string', required: true },
      ],
    });
    await mockPlaybookRoutes(page, { playbooks: [playbook] });

    await openCreateWorkflowModal(page);

    await selectPlaybookInModal(page, playbook);

    // Required variable without a default blocks submission
    await expect(page.getByTestId('variable-input-api_key')).toBeVisible();
    await expect(page.getByTestId('create-submit-button')).toBeDisabled();

    // Filling the variable enables submission
    await page.getByTestId('variable-input-api_key').fill('secret-value');
    await expect(page.getByTestId('create-submit-button')).toBeEnabled();
  });

  test('creating a workflow submits the selected playbook and title', async ({ page }) => {
    const playbook = makePlaybook();
    const calls: InstantiateCall[] = [];
    await mockPlaybookRoutes(page, {
      playbooks: [playbook],
      onInstantiate: (call) => calls.push(call),
    });

    await openCreateWorkflowModal(page);

    await selectPlaybookInModal(page, playbook);

    // Override the default title
    const workflowTitle = `E2E Playbook Workflow ${Date.now()}`;
    await page.getByTestId('create-title-input').fill(workflowTitle);

    // Submit
    await page.getByTestId('create-submit-button').click();

    // Modal should close
    await expect(
      page.getByRole('dialog', { name: 'Create Workflow', exact: true })
    ).not.toBeVisible({ timeout: 10000 });

    // The selected playbook and title were sent to the instantiate endpoint
    expect(calls).toHaveLength(1);
    expect(calls[0].playbookId).toBe(playbook.id);
    expect(calls[0].title).toBe(workflowTitle);
    expect(calls[0].ephemeral).toBe(true);
  });
});
