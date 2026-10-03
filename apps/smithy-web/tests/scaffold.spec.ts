import { test, expect } from '@playwright/test';

test.describe('TB-O15: Orchestrator Web Scaffold', () => {
  // AppShell uses viewport width minus the director panel for breakpoints.
  // Keep enough room for the expanded desktop sidebar and director panel.
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('orchestrator-sidebar-collapsed', 'false');
      localStorage.setItem('orchestrator-director-collapsed', 'true');
      localStorage.setItem('orchestrator-director-maximized', 'false');
      localStorage.setItem('orchestrator-director-panel-width', '400');
    });
  });

  test.describe('Three-column layout', () => {
    test('displays sidebar, main content, and director panel', async ({ page }) => {
      await page.goto('/');

      // Wait for the app shell to render
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // Sidebar should be visible (on desktop)
      await expect(page.getByTestId('sidebar')).toBeVisible();

      // Header should be visible
      await expect(page.getByTestId('header')).toBeVisible();

      // Director panel should be visible (collapsed by default)
      await expect(page.getByTestId('director-panel-collapsed')).toBeVisible();
    });

    test('can expand and collapse director panel', async ({ page }) => {
      await page.goto('/');

      await expect(page.getByTestId('director-panel-collapsed')).toBeVisible();

      // The collapsed panel shows director icons (or Create Director), rather
      // than a generic expand button. Use the panel's keyboard shortcut.
      await page.keyboard.press('Meta+d');

      // Director panel should now be expanded
      await expect(page.getByTestId('director-panel')).toBeVisible();

      // Collapse button should be visible
      await page.getByTestId('director-panel-collapse').click();

      // Director panel should be collapsed again
      await expect(page.getByTestId('director-panel-collapsed')).toBeVisible();
    });

    test('can toggle sidebar collapse', async ({ page }) => {
      await page.goto('/');

      // Sidebar is explicitly initialized as expanded on desktop
      await expect(page.getByTestId('sidebar')).toBeVisible();

      // Click collapse button
      await page.getByTestId('sidebar-toggle').click();

      // After collapse, expand button should appear
      await expect(page.getByTestId('sidebar-expand-button')).toBeVisible();

      await page.getByTestId('sidebar-expand-button').click();
      await expect(page.getByTestId('sidebar-toggle')).toBeVisible();
      await expect(page.getByTestId('nav-section-work')).toBeVisible();
    });
  });

  test.describe('Navigation routes', () => {
    test('defaults to /activity route', async ({ page }) => {
      await page.goto('/');

      // Should redirect to /activity
      await expect(page).toHaveURL(/\/activity/);

      // Activity page should be visible
      await expect(page.getByTestId('activity-page')).toBeVisible();
    });

    test('navigates to /tasks', async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('nav-tasks').click();

      await expect(page).toHaveURL(/\/tasks/);
      await expect(page.getByTestId('tasks-page')).toBeVisible();
    });

    test('navigates to /agents', async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('nav-agents').click();

      await expect(page).toHaveURL(/\/agents/);
      await expect(page.getByTestId('agents-page')).toBeVisible();
    });

    test('navigates to /workspaces', async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('nav-workspaces').click();

      await expect(page).toHaveURL(/\/workspaces/);
      await expect(page.getByTestId('workspaces-page')).toBeVisible();
    });

    test('navigates to /workflows', async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('nav-workflows').click();

      await expect(page).toHaveURL(/\/workflows/);
      await expect(page.getByTestId('workflows-page')).toBeVisible();
    });

    test('navigates to /metrics', async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('nav-metrics').click();

      await expect(page).toHaveURL(/\/metrics/);
      await expect(page.getByTestId('metrics-page')).toBeVisible();
    });

    test('navigates to /settings', async ({ page }) => {
      await page.goto('/');

      await page.getByTestId('nav-settings').click();

      await expect(page).toHaveURL(/\/settings/);
      await expect(page.getByTestId('settings-page')).toBeVisible();
    });
  });

  test.describe('Theme toggle', () => {
    test('can toggle between themes', async ({ page }) => {
      await page.goto('/');

      // Theme toggle should be visible
      await expect(page.getByTestId('theme-toggle')).toBeVisible();

      // Click to cycle through themes
      await page.getByTestId('theme-toggle').click();

      // Verify the theme toggle still works
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
    });
  });

  test.describe('Sidebar navigation sections', () => {
    test('displays all navigation sections', async ({ page }) => {
      await page.goto('/');

      // All sections should be visible
      await expect(page.getByTestId('nav-section-overview')).toBeVisible();
      await expect(page.getByTestId('nav-section-work')).toBeVisible();
      await expect(page.getByTestId('nav-section-orchestration')).toBeVisible();
      await expect(page.getByTestId('nav-section-collaborate')).toBeVisible();
      await expect(page.getByTestId('nav-section-analytics')).toBeVisible();
    });

    test('can collapse and expand navigation sections', async ({ page }) => {
      await page.goto('/');

      const workItems = page.getByTestId('nav-tasks').locator('..');
      await expect(workItems).toHaveClass(/max-h-96/);

      // Click to collapse the work section
      await page.getByTestId('section-toggle-work').click();

      // Check the collapsed container rather than sleeping for its transition.
      await expect(workItems).toHaveClass(/max-h-0/);
      await expect(workItems).toHaveCSS('max-height', '0px');

      // Click to expand the work section
      await page.getByTestId('section-toggle-work').click();

      await expect(workItems).toHaveClass(/max-h-96/);
      // Tasks nav item should be visible again after expanding
      await expect(page.getByTestId('nav-tasks')).toBeVisible();
    });
  });

  test.describe('Breadcrumbs', () => {
    test('displays breadcrumbs for current route', async ({ page }) => {
      await page.goto('/tasks');

      // Breadcrumbs should be visible
      await expect(page.getByTestId('breadcrumbs')).toBeVisible();

      // Should show Tasks in breadcrumb
      await expect(page.getByTestId('breadcrumb-tasks')).toBeVisible();
    });
  });
});
