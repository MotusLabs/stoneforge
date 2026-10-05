import { test, expect } from '@playwright/test';

/**
 * TB6 / TB28 / TB30 / TB32: Task Flow
 *
 * The dedicated task-flow page was removed: the /tasks kanban view carries
 * the task-flow columns, /dashboard/task-flow is a legacy redirect to /tasks,
 * and the 'task-flow' dashboard lens maps to /tasks (Quarry Web Reference
 * el-4iiz, routes table + section 7a). These tests pin that contract on the
 * current surface:
 *
 * - the task status endpoints the flow is built on
 * - the legacy /dashboard/task-flow URL and 'task-flow' lens both land on /tasks
 * - the sidebar entry (nav-tasks) navigates to /tasks
 * - the kanban task-flow columns, their counts, cards, and per-column
 *   filter/sort dropdowns
 *
 * Detail-panel interactions and status editing are covered by
 * task-detail.spec.ts and task-edit.spec.ts. The completed-column date-range
 * selector and the slide-over description preview (TB124 'Show more') were
 * removed with the page; description editing is covered by
 * tb124-task-description-editor.spec.ts.
 */

test.describe('TB6: Task Flow', () => {
  test('blocked tasks endpoint is accessible', async ({ page }) => {
    const response = await page.request.get('/api/tasks/blocked');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('completed tasks endpoint is accessible', async ({ page }) => {
    const response = await page.request.get('/api/tasks/completed');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    // TB32: Response is now { items: Task[], hasMore: boolean }
    expect(data.items).toBeDefined();
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.hasMore).toBe('boolean');
  });

  test('legacy /dashboard/task-flow URL redirects to /tasks', async ({ page }) => {
    await page.goto('/dashboard/task-flow');
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
  });

  test("legacy 'task-flow' default lens redirects root to /tasks", async ({ page }) => {
    // The task-flow lens is no longer selectable in settings, but stored
    // preferences must still resolve: DASHBOARD_LENS_ROUTES maps it to /tasks.
    await page.addInitScript(() => {
      localStorage.setItem('settings.defaults', JSON.stringify({
        tasksView: 'list',
        dashboardLens: 'task-flow',
        sortOrder: 'updated_at',
      }));
    });

    await page.goto('/');
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
  });

  test('sidebar has a Tasks nav item and no legacy Task Flow item', async ({ page }) => {
    await page.goto('/dashboard/overview');
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10000 });

    // The task-flow entry was replaced by the Tasks nav item
    await expect(page.getByTestId('nav-tasks')).toBeVisible();
    await expect(page.getByTestId('nav-task-flow')).toHaveCount(0);
  });

  test('can navigate to the task flow (tasks kanban) from the sidebar', async ({ page }) => {
    await page.goto('/dashboard/overview');
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('nav-tasks').click();

    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('TB28: Task Flow - Click to Open', () => {
  test('in-progress tasks endpoint is accessible', async ({ page }) => {
    const response = await page.request.get('/api/tasks/in-progress');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('task flow displays status columns in the kanban view', async ({ page }) => {
    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });

    // The kanban view carries the task-flow columns (Open / In Progress / Blocked)
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    const columnIds = ['open', 'in-progress', 'blocked'];
    for (const columnId of columnIds) {
      await expect(page.getByTestId(`kanban-column-${columnId}`)).toBeVisible();
      await expect(page.getByTestId(`kanban-column-${columnId}-count`)).toBeVisible();
    }
  });

  test('clicking a task card opens the detail panel', async ({ page }) => {
    // Create a fresh open task so its card is present regardless of seed data
    const entitiesResponse = await page.request.get('/api/entities');
    const entitiesData = await entitiesResponse.json();
    const entities = entitiesData.items || entitiesData;
    expect(entities.length).toBeGreaterThan(0);

    const title = `Task Flow Card Test ${Date.now()}`;
    const createResponse = await page.request.post('/api/tasks', {
      data: {
        title,
        createdBy: entities[0].id,
        priority: 3,
        taskType: 'task',
        status: 'open',
      },
    });
    expect(createResponse.ok()).toBe(true);
    const task = await createResponse.json();

    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // Click the task card (newest first under the default sort)
    await page.getByTestId(`kanban-card-${task.id}`).click();

    // The slide-over was replaced by the persistent detail panel
    await expect(page.getByTestId('task-detail-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('task-detail-id')).toHaveText(task.id);
  });
});

test.describe('TB30: Task Flow - Filter & Sort', () => {
  test('each kanban column has a filter button', async ({ page }) => {
    await page.goto('/tasks');
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    for (const columnId of ['open', 'in-progress', 'blocked']) {
      await expect(page.getByTestId(`${columnId}-filter-button`)).toBeVisible();
    }
  });

  test('clicking a filter button opens the dropdown', async ({ page }) => {
    await page.goto('/tasks');
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    await page.getByTestId('open-filter-button').click();
    await expect(page.getByTestId('open-filter-dropdown')).toBeVisible({ timeout: 5000 });
  });

  test('filter dropdown has sort and priority controls', async ({ page }) => {
    await page.goto('/tasks');
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    await page.getByTestId('open-filter-button').click();
    await expect(page.getByTestId('open-filter-dropdown')).toBeVisible({ timeout: 5000 });

    // Sort field select with ascending/descending direction buttons
    await expect(page.getByTestId('open-sort-field')).toBeVisible();
    await expect(page.getByTestId('open-sort-asc')).toBeVisible();
    await expect(page.getByTestId('open-sort-desc')).toBeVisible();

    // Priority filter: All + 5 priority levels
    const prioritySelect = page.getByTestId('open-filter-priority');
    await expect(prioritySelect).toBeVisible();
    await expect(prioritySelect.locator('option')).toHaveCount(6);
  });

  test('filter dropdown closes when clicking outside', async ({ page }) => {
    await page.goto('/tasks');
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    await page.getByTestId('open-filter-button').click();
    await expect(page.getByTestId('open-filter-dropdown')).toBeVisible({ timeout: 5000 });

    // Click outside the dropdown
    await page.getByTestId('kanban-column-open').click({ position: { x: 10, y: 10 } });

    await expect(page.getByTestId('open-filter-dropdown')).not.toBeVisible();
  });
});

test.describe('TB32: Task Flow - Load Completed Tasks', () => {
  test('completed tasks API supports pagination params', async ({ page }) => {
    // Test with limit and offset
    const response = await page.request.get('/api/tasks/completed?limit=5&offset=0');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.items).toBeDefined();
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBeLessThanOrEqual(5);
    expect(typeof data.hasMore).toBe('boolean');
  });

  test('completed tasks API supports date filtering', async ({ page }) => {
    // Test with after param (today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const response = await page.request.get(`/api/tasks/completed?after=${today.toISOString()}`);
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.items).toBeDefined();
    expect(Array.isArray(data.items)).toBe(true);

    // Verify all returned tasks are from today
    for (const task of data.items) {
      expect(new Date(task.updatedAt).getTime()).toBeGreaterThanOrEqual(today.getTime());
    }
  });
});
