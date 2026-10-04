import { test, expect } from '@playwright/test';

// Full-stack smoke test against the routed app (AppShell + TanStack Router).
// '/' redirects to the default dashboard lens ('/dashboard/overview'), which
// renders DashboardPage: MetricsOverview, ReadyTasksList, RecentActivityFeed,
// ElementTypesBreakdown and SystemStatus (see src/routes/dashboard/).
test.describe('TB1: Hello World Full Stack', () => {
  test('page loads and shows Quarry title', async ({ page }) => {
    await page.goto('/');
    // AppShell sets the document title dynamically ("Quarry | Overview" once
    // the '/' -> '/dashboard/overview' redirect resolves)
    await expect(page).toHaveTitle(/Quarry/);
    // Brand text is in the sidebar
    await expect(page.getByTestId('sidebar').getByText('Stoneforge')).toBeVisible();
  });

  test('connection status shows Live', async ({ page }) => {
    await page.goto('/');
    // Wait for the WebSocket connection to establish
    await expect(page.getByText('Live')).toBeVisible({ timeout: 10000 });
  });

  test('health endpoint is accessible via proxy', async ({ page }) => {
    const response = await page.request.get('/api/health');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
    expect(data.database).toBeDefined();
  });

  test('stats endpoint is accessible via proxy', async ({ page }) => {
    const response = await page.request.get('/api/stats');
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(typeof data.totalElements).toBe('number');
    expect(typeof data.readyTasks).toBe('number');
    expect(typeof data.blockedTasks).toBe('number');
    expect(data.computedAt).toBeDefined();
  });

  test('metrics overview displays stats cards', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 10000 });
    // Metric cards on the dashboard overview (fed by /api/stats and /api/entities)
    await expect(page.getByText('Total Tasks')).toBeVisible();
    await expect(page.getByText('Ready vs Blocked')).toBeVisible();
    await expect(page.getByText('Active Agents')).toBeVisible();
    await expect(page.getByText('Completed Today')).toBeVisible();
    // Ready tasks section heading (fed by /api/tasks/ready)
    await expect(page.getByRole('heading', { name: 'Ready Tasks' })).toBeVisible();
    // Metric values render as '...' while stats load; wait for real data
    await expect(page.getByTestId('metric-total-tasks').locator('p.font-semibold')).not.toHaveText('...', { timeout: 10000 });
  });

  test('system status section displays database path', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('System Status')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Database')).toBeVisible();
    // The test server runs against .stoneforge-test/stoneforge.db
    // (see playwright.config.ts: STONEFORGE_DB_PATH)
    await expect(page.getByText(/stoneforge-test\/stoneforge\.db/)).toBeVisible();
  });
});
