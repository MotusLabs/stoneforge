import { test, expect } from '@playwright/test';

test.describe('TB10: Command Palette', () => {
  test('command palette opens with Cmd+K', async ({ page }) => {
    await page.goto('/dashboard');

    // Wait for page to load
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Command palette should not be visible initially
    await expect(page.getByTestId('command-palette')).not.toBeVisible();

    // Press Cmd+K (or Ctrl+K on non-Mac)
    await page.keyboard.press('Meta+k');

    // Command palette should now be visible
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect(page.getByTestId('command-palette-input')).toBeVisible();
    await expect(page.getByTestId('command-palette-input')).toBeFocused();
  });

  test('command palette closes with Escape', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Press Escape to close
    await page.keyboard.press('Escape');

    // Command palette should be closed
    await expect(page.getByTestId('command-palette')).not.toBeVisible();
  });

  test('command palette closes when clicking backdrop', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Click backdrop to close - click near bottom right where dialog won't overlap
    await page.getByTestId('command-palette-backdrop').click({ position: { x: 50, y: 500 } });

    // Command palette should be closed
    await expect(page.getByTestId('command-palette')).not.toBeVisible();
  });

  test('command palette shows navigation items', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Check navigation items are visible
    await expect(page.getByTestId('command-item-nav-dashboard')).toBeVisible();
    await expect(page.getByTestId('command-item-nav-tasks')).toBeVisible();
    await expect(page.getByTestId('command-item-nav-plans')).toBeVisible();
    await expect(page.getByTestId('command-item-nav-timeline')).toBeVisible();
  });

  test('command palette navigates to tasks page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Click on Tasks navigation item
    await page.getByTestId('command-item-nav-tasks').click();

    // Should navigate to tasks page
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByTestId('tasks-page')).toBeVisible();

    // Command palette should be closed after navigation
    await expect(page.getByTestId('command-palette')).not.toBeVisible();
  });

  test('command palette navigates to timeline page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Click on Timeline navigation item
    await page.getByTestId('command-item-nav-timeline').click();

    // Should navigate to timeline page
    await expect(page).toHaveURL(/\/dashboard\/timeline/);
    await expect(page.getByTestId('timeline-page')).toBeVisible();

    // Command palette should be closed after navigation
    await expect(page.getByTestId('command-palette')).not.toBeVisible();
  });

  test('command palette filters results on search', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Type to filter
    await page.getByTestId('command-palette-input').fill('task');

    // Should show filtered results. 'task' matches only the Tasks nav item —
    // the separate task-flow nav command was removed when the task-flow lens
    // merged into the /tasks kanban view (see src/components/navigation/
    // CommandPalette.tsx and the Quarry Web Reference, el-4iiz).
    await expect(page.getByTestId('command-item-nav-tasks')).toBeVisible();

    // Should not show unrelated items
    await expect(page.getByTestId('command-item-nav-messages')).not.toBeVisible();
    await expect(page.getByTestId('command-item-nav-documents')).not.toBeVisible();
  });

  test('command palette shows no results message for invalid search', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Type something that won't match
    await page.getByTestId('command-palette-input').fill('xyznonexistent');

    // Should show no results message
    await expect(page.getByText('No results found.')).toBeVisible();
  });

  test('command palette keyboard navigation works', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Type to filter to a single item (Tasks — the task-flow nav command no
    // longer exists; the /tasks kanban view carries the task-flow columns)
    await page.getByTestId('command-palette-input').fill('Tasks');

    // Wait for filtering
    await expect(page.getByTestId('command-item-nav-tasks')).toBeVisible();

    // Press Enter to navigate (first matching item is auto-selected)
    await page.keyboard.press('Enter');

    // Should navigate to the tasks page
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.getByTestId('tasks-page')).toBeVisible();
  });

  test('command palette toggles open and closed with Cmd+K', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Open command palette
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();

    // Press Cmd+K again to close
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).not.toBeVisible();

    // Press Cmd+K again to reopen
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
  });

  test('command palette works with Ctrl+K on Windows/Linux', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible();

    // Command palette should not be visible initially
    await expect(page.getByTestId('command-palette')).not.toBeVisible();

    // Press Ctrl+K (Windows/Linux shortcut)
    await page.keyboard.press('Control+k');

    // Command palette should now be visible
    await expect(page.getByTestId('command-palette')).toBeVisible();
  });
});
