import { test, expect, type Page } from '@playwright/test';

/**
 * Notification system tests.
 *
 * The bell in the header (NotificationCenter) toggles a slide-in
 * NotificationSidebar (see apps/smithy-web/src/components/notification/).
 * The sidebar is always mounted and translated off-canvas when closed, so
 * open/closed state is asserted via the backdrop (only rendered while open)
 * and the bell's aria-expanded attribute.
 */

/** Open the notification sidebar via the bell and wait for it to appear. */
async function openSidebar(page: Page) {
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-sidebar-backdrop')).toBeVisible();
}

/** Assert the notification sidebar is closed. */
async function expectSidebarClosed(page: Page) {
  await expect(page.getByTestId('notification-sidebar-backdrop')).not.toBeVisible();
  await expect(page.getByTestId('notification-bell')).toHaveAttribute('aria-expanded', 'false');
}

test.describe('TB-O25a: Notification System', () => {
  // The /activity landing page auto-starts the onboarding tour ~800ms after
  // load whenever a workflow preset is configured (the e2e server ships one).
  // Mark it completed so its fixed-inset backdrop can't intercept clicks.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('stoneforge:onboarding-complete', 'true');
    });
  });

  test.describe('Notification Center UI', () => {
    test('displays notification bell in header', async ({ page }) => {
      await page.goto('/');

      // Wait for the app shell to render
      await expect(page.getByTestId('app-shell')).toBeVisible();

      // Notification center should be visible in header
      await expect(page.getByTestId('notification-center')).toBeVisible();

      // Bell button should be visible
      await expect(page.getByTestId('notification-bell')).toBeVisible();
    });

    test('opens notification sidebar on bell click', async ({ page }) => {
      await page.goto('/');

      // Click notification bell
      await page.getByTestId('notification-bell').click();

      // Sidebar should slide in (backdrop rendered, panel active)
      await expect(page.getByTestId('notification-sidebar-backdrop')).toBeVisible();
      const sidebar = page.getByTestId('notification-sidebar');
      await expect(sidebar).toHaveAttribute('aria-hidden', 'false');

      // Should show the notification list (empty state initially)
      await expect(page.getByTestId('notification-list')).toBeVisible();
    });

    test('closes sidebar when clicking the backdrop', async ({ page }) => {
      await page.goto('/');

      // Open sidebar
      await openSidebar(page);

      // Click the backdrop (outside the sidebar panel)
      await page.getByTestId('notification-sidebar-backdrop').click({ position: { x: 50, y: 300 } });

      // Sidebar should be closed
      await expectSidebarClosed(page);
    });

    test('closes sidebar on escape key', async ({ page }) => {
      await page.goto('/');

      // Open sidebar
      await openSidebar(page);

      // Press escape
      await page.keyboard.press('Escape');

      // Sidebar should be closed
      await expectSidebarClosed(page);
    });

    test('displays empty state message when no notifications', async ({ page }) => {
      // Clear localStorage to ensure no persisted notifications
      await page.goto('/');
      await page.evaluate(() => {
        localStorage.removeItem('orchestrator-notifications');
      });
      await page.reload();

      // Open sidebar
      await openSidebar(page);

      // Should show empty state
      await expect(page.getByText('No notifications')).toBeVisible();
      await expect(page.getByText("You're all caught up!")).toBeVisible();
    });
  });

  test.describe('Notification Badge', () => {
    test('does not show badge when no unread notifications', async ({ page }) => {
      // Clear localStorage
      await page.goto('/');
      await page.evaluate(() => {
        localStorage.removeItem('orchestrator-notifications');
      });
      await page.reload();

      // Badge should not be visible
      await expect(page.getByTestId('notification-badge')).not.toBeVisible();
    });

    test('shows badge with unread count', async ({ page }) => {
      // Set up notifications in localStorage
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'test-1',
            type: 'info',
            title: 'Test Notification 1',
            message: 'Test message 1',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
          {
            id: 'test-2',
            type: 'success',
            title: 'Test Notification 2',
            message: 'Test message 2',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Badge should show count of 2
      const badge = page.getByTestId('notification-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('2');
    });

    test('badge shows 99+ for large counts', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = Array.from({ length: 100 }, (_, i) => ({
          id: `test-${i}`,
          type: 'info',
          title: `Test Notification ${i}`,
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        }));
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Badge should show 99+ for > 99 unread notifications
      const badge = page.getByTestId('notification-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('99+');
    });
  });

  test.describe('Notification List', () => {
    test('displays notifications from localStorage', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'test-1',
            type: 'error',
            title: 'Agent Error: TestBot',
            message: 'Something went wrong',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
          {
            id: 'test-2',
            type: 'success',
            title: 'Task Completed',
            message: 'Task TB-001 was completed',
            timestamp: new Date().toISOString(),
            read: true,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Open sidebar
      await openSidebar(page);

      // Notifications should be visible
      await expect(page.getByTestId('notification-test-1')).toBeVisible();
      await expect(page.getByTestId('notification-test-2')).toBeVisible();

      // Should display notification content
      await expect(page.getByText('Agent Error: TestBot')).toBeVisible();
      await expect(page.getByText('Task Completed')).toBeVisible();
    });

    test('dismisses notification when X is clicked', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'dismiss-test',
            type: 'info',
            title: 'Dismissable Notification',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Open sidebar
      await openSidebar(page);

      // Notification should be visible
      await expect(page.getByTestId('notification-dismiss-test')).toBeVisible();

      // Hover to reveal dismiss button and click it
      await page.getByTestId('notification-dismiss-test').hover();
      await page.getByTestId('notification-dismiss-test').getByLabel('Dismiss notification').click();

      // Notification should be gone
      await expect(page.getByTestId('notification-dismiss-test')).not.toBeVisible();
    });
  });

  test.describe('Notification Actions', () => {
    test('marks all as read when clicking mark all button', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'unread-1',
            type: 'info',
            title: 'Unread 1',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
          {
            id: 'unread-2',
            type: 'info',
            title: 'Unread 2',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Badge should show 2 unread
      await expect(page.getByTestId('notification-badge')).toHaveText('2');

      // Open sidebar and mark all as read
      await openSidebar(page);
      await page.getByLabel('Mark all as read').click();

      // Badge should be gone (no unread)
      await expect(page.getByTestId('notification-badge')).not.toBeVisible();
    });

    test('clears all notifications when clicking clear button', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'clear-1',
            type: 'info',
            title: 'To Be Cleared',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Open sidebar
      await openSidebar(page);

      // Notification should exist
      await expect(page.getByTestId('notification-clear-1')).toBeVisible();

      // Clear all
      await page.getByLabel('Clear all notifications').click();

      // Should show empty state
      await expect(page.getByText('No notifications')).toBeVisible();
    });

    test('navigates to settings when clicking settings button', async ({ page }) => {
      await page.goto('/');

      // Open sidebar
      await openSidebar(page);

      // Click settings button
      await page.getByLabel('Notification settings').click();

      // Should navigate to settings page
      await expect(page).toHaveURL(/\/settings/);
    });
  });

  test.describe('Toast Notifications', () => {
    test('useToast hook exports are available', async ({ page }) => {
      await page.goto('/');

      // Test that the notification system is set up by adding a test notification
      // and checking it appears in localStorage
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'toast-test',
            type: 'success',
            title: 'Toast Test',
            message: 'This is a test notification',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      // Verify notification was loaded
      await openSidebar(page);
      await expect(page.getByText('Toast Test')).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('notification bell has proper aria attributes', async ({ page }) => {
      await page.goto('/');

      const bell = page.getByTestId('notification-bell');
      await expect(bell).toHaveAttribute('aria-label', /Notifications/);
      await expect(bell).toHaveAttribute('aria-expanded', 'false');

      // Open sidebar
      await bell.click();
      await expect(bell).toHaveAttribute('aria-expanded', 'true');
    });

    test('notification sidebar has proper role', async ({ page }) => {
      await page.goto('/');

      await openSidebar(page);

      const sidebar = page.getByTestId('notification-sidebar');
      await expect(sidebar).toHaveAttribute('role', 'dialog');
      await expect(sidebar).toHaveAttribute('aria-label', 'Notification sidebar');
    });

    test('notification items have accessible dismiss buttons', async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() => {
        const notifications = [
          {
            id: 'a11y-test',
            type: 'info',
            title: 'Accessible Notification',
            timestamp: new Date().toISOString(),
            read: false,
            dismissed: false,
          },
        ];
        localStorage.setItem('orchestrator-notifications', JSON.stringify(notifications));
      });
      await page.reload();

      await openSidebar(page);
      await page.getByTestId('notification-a11y-test').hover();

      // Dismiss button should have accessible label
      await expect(
        page.getByTestId('notification-a11y-test').getByLabel('Dismiss notification')
      ).toBeVisible();
    });
  });

  test.describe('Connection Status', () => {
    test('shows offline indicator when SSE not connected', async ({ page }) => {
      // Block SSE endpoint to simulate offline state
      await page.route('**/api/events**', (route) => {
        route.abort('connectionrefused');
      });

      await page.goto('/');

      await openSidebar(page);

      // The offline badge appears in the sidebar header when SSE is down
      const sidebar = page.getByTestId('notification-sidebar');
      await expect(sidebar.getByText('Offline')).toBeVisible();
    });
  });
});
