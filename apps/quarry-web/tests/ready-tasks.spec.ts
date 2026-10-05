import { test, expect, type Page } from '@playwright/test';

/**
 * TB3: Ready Tasks List
 *
 * The routed app redirects '/' to the default dashboard lens
 * (/dashboard/overview), whose DashboardPage renders the ReadyTasksList
 * section: an h3 "Ready Tasks" heading, task cards, and loading/empty
 * states, fed by /api/tasks/ready (see src/routes/dashboard/).
 */

/** Create a ready task through the HTTP API (out-of-band from the page). */
async function createTaskViaApi(page: Page, title: string): Promise<{ id: string; title: string }> {
  // /api/entities is paginated ({ items }); global-setup seeds the operator
  const entitiesResponse = await page.request.get('/api/entities');
  expect(entitiesResponse.ok()).toBe(true);
  const entities = await entitiesResponse.json();
  const createdBy = entities.items?.[0]?.id;
  if (!createdBy) throw new Error('Test server has no entities to own the task');

  const response = await page.request.post('/api/tasks', {
    data: { title, createdBy, priority: 1, taskType: 'task' },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.describe('TB3: Ready Tasks List', () => {
  // The Vite dev server transforms the module graph on first page load of
  // each run, so the first app-ready signal can take well over 10s when
  // parallel workers hit a cold server.
  test.beforeEach(() => test.setTimeout(60_000));

  test('ready tasks endpoint is accessible', async ({ page }) => {
    const response = await page.request.get('/api/tasks/ready');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test('ready tasks section is displayed', async ({ page }) => {
    await page.goto('/');
    // The ReadyTasksList section heading on the routed dashboard (the only
    // "Ready Tasks" heading — the metrics card is "Ready vs Blocked")
    await expect(page.getByRole('heading', { name: 'Ready Tasks' })).toBeVisible({ timeout: 30000 });
  });

  test('ready tasks list reflects the API state (empty state when no tasks)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 30000 });

    // Wait for the ready tasks query to settle (no more loading text)
    await expect(page.getByText('Loading ready tasks...')).not.toBeVisible({ timeout: 10000 });

    // The list shows the empty state iff /api/tasks/ready has no tasks.
    // Poll until UI and API agree — parallel specs may create tasks at any
    // moment, and the WebSocket-driven refresh updates the list live.
    await expect(async () => {
      const response = await page.request.get('/api/tasks/ready');
      const tasks = await response.json();
      const emptyState = page.getByText('No ready tasks available');
      if (tasks.length === 0) {
        await expect(emptyState).toBeVisible();
      } else {
        await expect(emptyState).not.toBeVisible();
      }
    }).toPass({ timeout: 10000 });
  });

  test('task cards display correct information when tasks exist', async ({ page }) => {
    // Seed a ready task when the list is empty so card rendering is actually
    // exercised (the test database starts without tasks)
    let tasks = await (await page.request.get('/api/tasks/ready')).json();
    if (tasks.length === 0) {
      await createTaskViaApi(page, `Ready Tasks Spec Task ${Date.now()}`);
      tasks = await (await page.request.get('/api/tasks/ready')).json();
    }
    expect(tasks.length).toBeGreaterThan(0);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Ready Tasks' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Loading ready tasks...')).not.toBeVisible({ timeout: 10000 });

    // The API's first ready task renders as a TaskCard showing its title and
    // ID. Scope to the card: the Recent Activity feed on the same page also
    // renders element IDs.
    const firstTask = tasks[0];
    const card = page.getByTestId(`task-card-${firstTask.id}`);
    await expect(card).toBeVisible();
    await expect(card.getByText(firstTask.title)).toBeVisible();
    await expect(card.getByText(firstTask.id)).toBeVisible();
  });
});
