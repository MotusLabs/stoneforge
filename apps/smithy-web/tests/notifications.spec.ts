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

/**
 * Wait for the notification bell to render before asserting on the header.
 *
 * The e2e web server is the Vite dev server, and page delivery under
 * parallel-suite load is nothing like production: measured on this suite's
 * CI box with 8 concurrent contexts, the module graph can take ~13s to
 * arrive after goto() commits, the vite client may replace the document
 * (same-URL reload) when module fetches are slow, and navigating to `/`
 * additionally redirects to `/activity` via the router's beforeLoad. A
 * locator can resolve against a first document that is then immediately
 * replaced, so an assertion made right after goto() (or right after the
 * bell appears) can run against a page with no DOM at all. Waiting on the
 * bell (the badge's parent) with an explicit budget — and navigating
 * directly to /activity in tests that assert immediately, avoiding the
 * redirect — separates "app delivered slowly" (waits) from "header rendered
 * but badge missing/wrong" (the clobber regression signature, which still
 * fails once the header is stable).
 */
async function awaitBell(page: Page, timeout = 30_000) {
  await expect(page.getByTestId('notification-bell')).toBeVisible({ timeout });
}

/**
 * Build unread notification objects suitable for localStorage seeding.
 */
function makeNotifications(count: number, idPrefix = 'test'): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${idPrefix}-${i}`,
    type: 'info',
    title: `Test Notification ${i} (${idPrefix})`,
    message: `Test message ${i}`,
    timestamp: new Date().toISOString(),
    read: false,
    dismissed: false,
  }));
}

/**
 * Seed orchestrator-notifications BEFORE any app code runs, then navigate.
 *
 * addInitScript executes on every navigation of the page before any app
 * script, so the app's first loadNotifications() sees the seeded data. This
 * replaces the old goto → page.evaluate → reload dance, which raced the
 * still-live first mount: the app's save-on-change effect could overwrite
 * localStorage between the test's write and the reload (the 'badge shows 99+'
 * flake — the badge never rendered because the reload read a clobbered, empty
 * store). With init-script seeding there is no write-after-mount at all.
 */
async function seedNotifications(page: Page, notifications: Record<string, unknown>[]) {
  await page.addInitScript((data) => {
    localStorage.setItem('orchestrator-notifications', JSON.stringify(data));
  }, notifications);
}

test.describe('TB-O25a: Notification System', () => {
  // The dev server can take >30s to deliver the app under parallel-suite load
  // (see awaitBell). The suite default of 30s per test turns that environment
  // slowness into infra failures unrelated to what these tests assert; give
  // them headroom. Timeouts are upper bounds — runs on a fast/uncontended
  // server finish in the usual ~10-20s.
  test.setTimeout(90_000);

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

      // Wait for the app shell to render (explicit budget — see awaitBell)
      await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });

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

      // Badge should not be visible once the header has rendered (asserting
      // absence before the app renders would vacuously pass)
      await expect(page.getByTestId('notification-bell')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('notification-badge')).not.toBeVisible();
    });

    test('shows badge with unread count', async ({ page }) => {
      // Seed before any app code runs, then load once — no write-after-mount
      await seedNotifications(page, [
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
      ]);
      await page.goto('/activity');

      // Header first (see awaitBell), then the badge with a window that
      // crosses dev-server document transients but still fails on a stable
      // header whose badge never renders.
      awaitBell(page);
      const badge = page.getByTestId('notification-badge');
      await expect(badge).toBeVisible({ timeout: 10_000 });
      await expect(badge).toHaveText('2');
    });

    test('badge shows 99+ for large counts', async ({ page }) => {
      // Seed before any app code runs, then load once — deterministic even
      // under cold Vite / parallel-suite conditions (the historical flake:
      // the badge never rendered after reload because a save-on-change
      // overwrote the 100 seeded entries before the reload read them back).
      await seedNotifications(page, makeNotifications(100));
      await page.goto('/activity');

      // Header first, then the badge. The badge window is generous enough to
      // cross the dev server's transient document replacements (see the
      // awaitBell docstring) but still fails deterministically if the header
      // is stable and the badge never renders — the clobber signature.
      awaitBell(page);
      const badge = page.getByTestId('notification-badge');
      await expect(badge).toBeVisible({ timeout: 10_000 });
      await expect(badge).toHaveText('99+');
    });
  });

  test.describe('External Writer Contract', () => {
    // loadNotifications()/saveNotifications() in useNotifications.ts promise
    // that external writers (tests, other tools, other tabs) can set
    // notifications via localStorage and have them counted. These tests pin
    // the other half of that contract: an external write must also SURVIVE a
    // subsequent app-side state change instead of being clobbered by the
    // hook's persist-on-change effect (the root cause behind the
    // 'badge shows 99+' flake).

    test('external localStorage write survives an app-side state change', async ({ page }) => {
      // App starts with two seeded notifications (adopted at mount).
      await seedNotifications(page, [
        {
          id: 'seeded-1',
          type: 'info',
          title: 'Seeded Notification 1',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
        {
          id: 'seeded-2',
          type: 'info',
          title: 'Seeded Notification 2',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
      ]);
      await page.goto('/activity');
      awaitBell(page);
      await expect(page.getByTestId('notification-badge')).toHaveText('2', { timeout: 10_000 });

      // External, same-tab write AFTER the app mounted. Same-tab writes fire
      // no storage event, so the app's in-memory state does not know about
      // these yet — the next in-memory save must not overwrite them.
      await page.evaluate(() => {
        const external = Array.from({ length: 3 }, (_, i) => ({
          id: `external-${i}`,
          type: 'warning',
          title: `External Notification ${i}`,
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        }));
        const seeded = JSON.parse(
          localStorage.getItem('orchestrator-notifications') || '[]'
        );
        localStorage.setItem(
          'orchestrator-notifications',
          JSON.stringify([...seeded, ...external])
        );
      });

      // App-side state change: mark all as read. Before the fix this saved
      // the (stale) in-memory list and silently dropped the external entries.
      await openSidebar(page);
      await page.getByLabel('Mark all as read').click();

      // The merged list — seeded + external — is now live in the sidebar…
      await expect(page.getByTestId('notification-external-0')).toBeVisible();
      await expect(page.getByTestId('notification-seeded-1')).toBeVisible();

      // …and persisted: the external entries survived the save.
      const persistedIds = await page.evaluate(() =>
        (JSON.parse(localStorage.getItem('orchestrator-notifications') || '[]') as Array<{ id: string }>).map(
          (n) => n.id
        )
      );
      for (const id of ['seeded-1', 'seeded-2', 'external-0', 'external-1', 'external-2']) {
        expect(persistedIds, `expected ${id} to survive the state change`).toContain(id);
      }
    });

    test('adopts a cross-tab external write via the storage event', async ({ page, context }) => {
      // Fix direction (c): a live tab must adopt an external write performed
      // by ANOTHER page sharing the same localStorage — the storage event
      // fires only in contexts other than the writer. A second page of the
      // same context shares storage; its write must show up in the first
      // page's live state, not be overwritten by its next save.
      const seed = Array.from({ length: 2 }, (_, i) => ({
        id: `cross-seeded-${i}`,
        type: 'info',
        title: `Cross Seeded ${i}`,
        timestamp: new Date().toISOString(),
        read: false,
        dismissed: false,
      }));
      await seedNotifications(page, seed);
      await page.goto('/activity');
      awaitBell(page);
      await expect(page.getByTestId('notification-badge')).toHaveText('2', { timeout: 10_000 });

      // Second page in the SAME context. It only needs to be a same-origin
      // document to share localStorage — navigating to a static asset avoids
      // paying the app's module-graph delivery a second time (which under
      // parallel-suite load can exceed 30s and has nothing to do with what
      // this test asserts).
      const page2 = await context.newPage();
      await page2.goto('/favicon.ico');

      // External write from page 2 — page 1 receives a storage event.
      await page2.evaluate(() => {
        const stored = JSON.parse(
          localStorage.getItem('orchestrator-notifications') || '[]'
        );
        stored.push({
          id: 'cross-external-0',
          type: 'warning',
          title: 'Cross External 0',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        });
        localStorage.setItem('orchestrator-notifications', JSON.stringify(stored));
      });

      // Page 1 adopts the external entry into its live state.
      await expect(page.getByTestId('notification-badge')).toHaveText('3', { timeout: 10_000 });
      await openSidebar(page);
      await expect(page.getByTestId('notification-cross-external-0')).toBeVisible();

      // And the adopted state is what persists — the external entry survives.
      const persistedIds = await page.evaluate(() =>
        (JSON.parse(localStorage.getItem('orchestrator-notifications') || '[]') as Array<{ id: string }>).map(
          (n) => n.id
        )
      );
      expect(persistedIds).toContain('cross-external-0');
      await page2.close();
    });
  });

  test.describe('Notification List', () => {
    test('displays notifications from localStorage', async ({ page }) => {
      await seedNotifications(page, [
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
      ]);
      await page.goto('/');

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
      await seedNotifications(page, [
        {
          id: 'dismiss-test',
          type: 'info',
          title: 'Dismissable Notification',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
      ]);
      await page.goto('/');

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
      await seedNotifications(page, [
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
      ]);
      await page.goto('/activity');

      // Badge should show 2 unread
      awaitBell(page);
      await expect(page.getByTestId('notification-badge')).toHaveText('2', { timeout: 10_000 });

      // Open sidebar and mark all as read
      await openSidebar(page);
      await page.getByLabel('Mark all as read').click();

      // Badge should be gone (no unread)
      await expect(page.getByTestId('notification-badge')).not.toBeVisible();
    });

    test('clears all notifications when clicking clear button', async ({ page }) => {
      await seedNotifications(page, [
        {
          id: 'clear-1',
          type: 'info',
          title: 'To Be Cleared',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
      ]);
      await page.goto('/');

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
      await seedNotifications(page, [
        {
          id: 'toast-test',
          type: 'success',
          title: 'Toast Test',
          message: 'This is a test notification',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
      ]);
      await page.goto('/');

      // Verify notification was loaded
      await openSidebar(page);
      await expect(page.getByText('Toast Test')).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('notification bell has proper aria attributes', async ({ page }) => {
      await page.goto('/activity');

      // Header first (see awaitBell) — this test also asserts immediately
      // after goto, so it needs the same delivery tolerance as the badge
      // tests.
      awaitBell(page);
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
      await seedNotifications(page, [
        {
          id: 'a11y-test',
          type: 'info',
          title: 'Accessible Notification',
          timestamp: new Date().toISOString(),
          read: false,
          dismissed: false,
        },
      ]);
      await page.goto('/');

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
