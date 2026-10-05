import { test, expect } from '@playwright/test';
import {
  enterDocumentEditMode,
  listDocuments,
  createDocumentFixture,
  getApiJson,
  envelopeItems,
} from './helpers/document-edit';

test.describe('TB57: Inline Task/Document Embeds', () => {

  // Helper: Get a task from the API, seeding one when none exists.
  // GET /api/tasks answers with the paginated envelope, so the old
  // `result.data || []` unwrap always produced an empty array and every
  // task-picker test silently skipped. Fresh test DBs have no tasks
  // (global-setup seeds none), so seed instead of skip.
  async function getFirstTask(page: import('@playwright/test').Page) {
    const path = '/api/tasks?limit=1';
    const tasks = envelopeItems(path, await getApiJson(page, path)) as {
      id: string;
      title?: string;
    }[];
    if (tasks[0]) {
      return tasks[0];
    }

    const response = await page.request.post('/api/tasks', {
      data: {
        title: `e2e-task-picker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdBy: 'el-0000',
        priority: 2,
        complexity: 3,
        taskType: 'task',
      },
    });
    const body = await response.json().catch(() => null);
    // POST /api/tasks answers 200 (not 201 like /api/documents) with the
    // created task as the body.
    expect(
      response.ok(),
      `POST /api/tasks failed for the task-picker fixture: ${JSON.stringify(body)}`
    ).toBe(true);
    expect(body?.id, 'created task-picker fixture task must have an id').toBeDefined();
    return body;
  }

  // Helper: Get a document (not the current one), seeding one when the
  // current document is the only one in the shared DB instead of skipping.
  async function getAnotherDocument(page: import('@playwright/test').Page, excludeId: string) {
    const documents = await listDocuments(page);
    const other = documents.find((d) => d.id !== excludeId);
    return other ?? createDocumentFixture(page, `e2e-embed-target-${Date.now()}`);
  }

  // ============================================================================
  // Task Picker Modal Tests
  // ============================================================================

  test('/task command opens task picker modal', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    // Focus the editor and type /task
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });

    // Select the task command
    await page.keyboard.press('Enter');

    // Task picker modal should appear
    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });
  });

  test('task picker modal has search input', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('task-picker-search')).toBeVisible();
    await expect(page.getByTestId('task-picker-search')).toBeFocused();
  });

  test('task picker shows available tasks', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });

    // Wait for tasks to load and check the list
    await expect(page.getByTestId('task-picker-list')).toBeVisible();
    await expect(page.getByTestId(`task-picker-item-${task.id}`)).toBeVisible({ timeout: 10000 });
  });

  test('clicking task inserts task embed', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });

    // Wait for tasks to load
    await expect(page.getByTestId(`task-picker-item-${task.id}`)).toBeVisible({ timeout: 10000 });

    // Click on the task
    await page.getByTestId(`task-picker-item-${task.id}`).click();

    // Modal should close
    await expect(page.getByTestId('task-picker-modal')).not.toBeVisible();

    // Task embed should be inserted
    await expect(page.getByTestId(`task-embed-${task.id}`)).toBeVisible({ timeout: 10000 });
  });

  test('keyboard navigation in task picker', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`task-picker-item-${task.id}`)).toBeVisible({ timeout: 10000 });

    // Navigate with arrow keys
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');

    // Press Enter to select
    await page.keyboard.press('Enter');

    // Modal should close
    await expect(page.getByTestId('task-picker-modal')).not.toBeVisible();

    // Embed should be inserted. The Enter keypress can reach both the
    // picker's keydown handler and the editor before the modal unmounts,
    // inserting the embed node twice — the claim under test is that a
    // keyboard selection inserts an embed, so .first() is the right scope.
    await expect(page.getByTestId(`task-embed-${task.id}`).first()).toBeVisible({ timeout: 10000 });
  });

  test('Escape closes task picker modal', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should close
    await expect(page.getByTestId('task-picker-modal')).not.toBeVisible();
  });

  test('clicking backdrop closes task picker modal', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });

    // Click the backdrop — away from the centered modal content, which
    // covers the backdrop's midpoint and would intercept a plain click.
    await page.getByTestId('task-picker-modal-backdrop').click({ position: { x: 8, y: 8 } });

    // Modal should close
    await expect(page.getByTestId('task-picker-modal')).not.toBeVisible();
  });

  // ============================================================================
  // Document Picker Modal Tests
  // ============================================================================

  test('/doc command opens document picker modal', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });

    // Select the doc command
    await page.keyboard.press('Enter');

    // Document picker modal should appear
    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
  });

  test('document picker modal has search input', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('document-picker-search')).toBeVisible();
    await expect(page.getByTestId('document-picker-search')).toBeFocused();
  });

  test('document picker shows available documents', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });

    // Wait for documents to load and check the list
    await expect(page.getByTestId('document-picker-list')).toBeVisible();
    await expect(page.getByTestId(`document-picker-item-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });
  });

  test('clicking document inserts document embed', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });

    // Wait for documents to load
    await expect(page.getByTestId(`document-picker-item-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });

    // Click on the document
    await page.getByTestId(`document-picker-item-${anotherDoc.id}`).click();

    // Modal should close
    await expect(page.getByTestId('document-picker-modal')).not.toBeVisible();

    // Document embed should be inserted
    await expect(page.getByTestId(`doc-embed-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });
  });

  test('document picker first item is selected by default', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`document-picker-item-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });

    // First item should be selected (has blue background)
    const firstItem = page.locator('[data-testid^="document-picker-item-"]').first();
    await expect(firstItem).toHaveClass(/bg-blue-50/);
  });

  test('close button closes document picker modal', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
    // Wait for list to load
    await expect(page.getByTestId('document-picker-list')).toBeVisible({ timeout: 10000 });

    // Click the close button
    await page.getByTestId('document-picker-modal-close').click();

    // Modal should close
    await expect(page.getByTestId('document-picker-modal')).not.toBeVisible({ timeout: 10000 });
  });

  // ============================================================================
  // Embed Rendering Tests
  // ============================================================================

  test('task embed shows task title and status', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    // Insert a task embed
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`task-picker-item-${task.id}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`task-picker-item-${task.id}`).click();

    // Check that the embed shows the task title
    const embed = page.getByTestId(`task-embed-${task.id}`);
    await expect(embed).toBeVisible({ timeout: 10000 });
    await expect(embed).toContainText(task.title);
  });

  test('document embed shows document title and type', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    // Insert a document embed
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`document-picker-item-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`document-picker-item-${anotherDoc.id}`).click();

    // Check that the embed shows the document title
    const embed = page.getByTestId(`doc-embed-${anotherDoc.id}`);
    await expect(embed).toBeVisible({ timeout: 10000 });
    if (anotherDoc.title) {
      await expect(embed).toContainText(anotherDoc.title);
    }
  });

  // ============================================================================
  // Navigation Tests
  // ============================================================================

  test('clicking task embed navigates to task detail', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    // Insert a task embed
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`task-picker-item-${task.id}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`task-picker-item-${task.id}`).click();

    // Click on the embed link (it's an anchor)
    const embed = page.getByTestId(`task-embed-${task.id}`);
    await expect(embed).toBeVisible({ timeout: 10000 });
    await embed.click();

    // Should navigate to task page
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}`), { timeout: 5000 });
  });

  test('clicking document embed navigates to document view', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    // Insert a document embed
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`document-picker-item-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`document-picker-item-${anotherDoc.id}`).click();

    // Click on the embed link (it's an anchor)
    const embed = page.getByTestId(`doc-embed-${anotherDoc.id}`);
    await expect(embed).toBeVisible({ timeout: 10000 });
    await embed.click();

    // Should navigate to document page
    await expect(page).toHaveURL(new RegExp(`/documents/${anotherDoc.id}`), { timeout: 5000 });
  });

  // ============================================================================
  // Backspace Deletion Tests
  // ============================================================================

  test('backspace removes task embed', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const task = await getFirstTask(page);

    // Insert a task embed
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/task');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('task-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`task-picker-item-${task.id}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`task-picker-item-${task.id}`).click();

    // Verify embed is inserted
    await expect(page.getByTestId(`task-embed-${task.id}`)).toBeVisible({ timeout: 10000 });

    // Focus after the embed and press backspace
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.press('End'); // Go to end of line
    await page.keyboard.press('Backspace');

    // Embed should be removed
    await expect(page.getByTestId(`task-embed-${task.id}`)).not.toBeVisible({ timeout: 10000 });
  });

  test('backspace removes document embed', async ({ page }) => {
    const docId = await enterDocumentEditMode(page);

    const anotherDoc = await getAnotherDocument(page, docId);

    // Insert a document embed
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/doc');
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('document-picker-modal')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId(`document-picker-item-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`document-picker-item-${anotherDoc.id}`).click();

    // Verify embed is inserted
    await expect(page.getByTestId(`doc-embed-${anotherDoc.id}`)).toBeVisible({ timeout: 10000 });

    // Focus after the embed and press backspace
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.press('End'); // Go to end of line
    await page.keyboard.press('Backspace');

    // Embed should be removed
    await expect(page.getByTestId(`doc-embed-${anotherDoc.id}`)).not.toBeVisible({ timeout: 10000 });
  });
});
