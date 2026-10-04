import { test, expect, type Page } from '@playwright/test';

/**
 * Director Terminal Panel tests.
 *
 * The DirectorPanel is a tabbed, multi-director sidebar (see
 * apps/smithy-web/src/components/layout/DirectorPanel.tsx):
 * - Collapsed: narrow rail (w-12) with one icon per director, or a (+)
 *   "Create Director" button when no directors exist. There is no generic
 *   expand button; the panel is toggled with the Meta+D shortcut.
 * - Expanded: header with director tabs + per-director actions
 *   (maximize / collapse), and one DirectorTabContent per director
 *   (`director-terminal-container-<id>`, `director-xterminal-<id>`,
 *   `director-idle-overlay-<id>`).
 */

const DIRECTOR_ID = 'el-dir1';

/** Deterministic panel state for every test in this file. */
async function initPanelState(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('orchestrator-director-collapsed', 'true');
    localStorage.setItem('orchestrator-director-maximized', 'false');
    localStorage.removeItem('orchestrator-director-panel-width');
    localStorage.removeItem('orchestrator-director-active-tab');
    localStorage.removeItem('orchestrator-director-tab-order');
    // Suppress the onboarding tour so its tooltip doesn't interfere
    localStorage.setItem('stoneforge:onboarding-complete', 'true');
  });
}

/** Expand the director panel using the app's keyboard shortcut. */
async function expandPanel(page: Page) {
  // Wait for the app shell (and its shortcut handlers) to mount.
  // Generous timeout: the first test against a cold dev server pays the
  // module transform cost.
  await expect(page.getByTestId('director-panel-collapsed')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Meta+d');
  await expect(page.getByTestId('director-panel')).toBeVisible({ timeout: 10_000 });
}

/**
 * Mock the agents API so exactly one director exists with no active session.
 * The terminal area then shows the idle overlay ("Director Idle").
 */
async function mockSingleDirector(page: Page) {
  const director = {
    id: DIRECTOR_ID,
    name: 'Test Director',
    type: 'entity',
    entityType: 'agent',
    status: 'active',
    tags: [],
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    metadata: { agent: { agentRole: 'director' } },
  };

  await page.route('**/api/agents', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: [director] }),
      });
    } else {
      await route.continue();
    }
  });

  await page.route(`**/api/agents/${DIRECTOR_ID}/status`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agentId: DIRECTOR_ID,
        hasActiveSession: false,
        activeSession: null,
        recentHistory: [],
      }),
    });
  });
}

test.describe('TB-O17: Director Terminal Panel', () => {
  // AppShell computes breakpoints from viewport minus the director panel.
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeEach(async ({ page }) => {
    await initPanelState(page);
  });

  test.describe('Expanded Panel Layout', () => {
    test('displays expanded panel with zero-director empty state', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      // Header with panel actions
      await expect(page.getByTestId('director-panel-header')).toBeVisible();

      // No directors are registered against the test API
      await expect(page.getByText('No Directors')).toBeVisible();
      await expect(page.getByTestId('director-panel-create-btn')).toBeVisible();
    });

    test('has default panel width when expanded', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      // Default width is 384px (DEFAULT_WIDTH in DirectorPanel.tsx)
      const panel = page.getByTestId('director-panel');
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBe(384);
    });

    test('shows maximize and collapse buttons in header', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      await expect(page.getByTestId('director-panel-maximize')).toBeVisible();
      await expect(page.getByTestId('director-panel-collapse')).toBeVisible();
    });

    test('has a resize handle on the expanded panel edge', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      await expect(page.getByTestId('director-panel-resize-handle')).toBeVisible();
    });
  });

  test.describe('Panel Controls', () => {
    test('collapse button returns to collapsed state', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      await page.getByTestId('director-panel-collapse').click();

      await expect(page.getByTestId('director-panel-collapsed')).toBeVisible();
    });

    test('maximize button hides resize handle and offers restore', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      const maximize = page.getByTestId('director-panel-maximize');
      await maximize.click();

      // Maximized panel fills the content area: no resize handle
      await expect(page.getByTestId('director-panel-resize-handle')).not.toBeVisible();
      await expect(maximize).toHaveAttribute('aria-label', 'Restore Panel');

      // Restoring brings the resize handle back
      await maximize.click();
      await expect(page.getByTestId('director-panel-resize-handle')).toBeVisible();
      await expect(maximize).toHaveAttribute('aria-label', 'Maximize Panel');
    });
  });

  test.describe('Collapsed State', () => {
    test('collapsed panel shows Create Director button when no directors exist', async ({ page }) => {
      await page.goto('/');

      const collapsedPanel = page.getByTestId('director-panel-collapsed');
      await expect(collapsedPanel).toBeVisible({ timeout: 20_000 });

      // Zero-director state renders a (+) create button
      const createButton = page.getByTestId('director-collapsed-create');
      await expect(createButton).toBeVisible();
    });

    test('collapsed panel has narrow width', async ({ page }) => {
      await page.goto('/');

      const collapsedPanel = page.getByTestId('director-panel-collapsed');
      await expect(collapsedPanel).toBeVisible({ timeout: 20_000 });

      // Collapsed rail is 48px wide (w-12)
      const box = await collapsedPanel.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBe(48);
    });

    test('collapsed panel shows a director icon when directors exist', async ({ page }) => {
      await mockSingleDirector(page);
      await page.goto('/');

      const collapsedPanel = page.getByTestId('director-panel-collapsed');
      await expect(collapsedPanel).toBeVisible({ timeout: 20_000 });

      const directorIcon = page.getByTestId(`director-collapsed-${DIRECTOR_ID}`);
      await expect(directorIcon).toBeVisible();
      await expect(directorIcon).toHaveAttribute('aria-label', 'Open Test Director');

      // Clicking the icon expands the panel and selects that director
      await directorIcon.click();
      await expect(page.getByTestId('director-panel')).toBeVisible();
      await expect(
        page.getByTestId(`director-tab-content-${DIRECTOR_ID}`)
      ).toBeVisible();
    });
  });

  test.describe('Terminal XTerm Integration', () => {
    test.beforeEach(async ({ page }) => {
      await mockSingleDirector(page);
    });

    test('renders terminal container and idle overlay for an inactive director', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      // Terminal area exists for the director
      await expect(
        page.getByTestId(`director-terminal-container-${DIRECTOR_ID}`)
      ).toBeVisible();

      // No active session: idle overlay with start button
      const overlay = page.getByTestId(`director-idle-overlay-${DIRECTOR_ID}`);
      await expect(overlay).toBeVisible();
      await expect(overlay.getByText('Director Idle')).toBeVisible();
      await expect(
        page.getByTestId(`director-overlay-start-btn-${DIRECTOR_ID}`)
      ).toBeVisible();
    });

    test('terminal area has dark background', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      // The terminal surface uses a dark background (#1a1a1a)
      const terminalArea = page
        .getByTestId(`director-terminal-container-${DIRECTOR_ID}`)
        .locator('div')
        .first();
      await expect(terminalArea).toHaveClass(/bg-\[#1a1a1a\]/);
    });
  });

  test.describe('Accessibility', () => {
    test('collapse button has accessible label', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      const collapseButton = page.getByTestId('director-panel-collapse');
      await expect(collapseButton).toHaveAttribute('aria-label', 'Collapse Director Panel');
    });

    test('maximize button has accessible label', async ({ page }) => {
      await page.goto('/');

      await expandPanel(page);

      await expect(page.getByTestId('director-panel-maximize')).toHaveAttribute(
        'aria-label',
        'Maximize Panel'
      );
    });

    test('collapsed create button has accessible label', async ({ page }) => {
      await page.goto('/');

      await expect(page.getByTestId('director-panel-collapsed')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('director-collapsed-create')).toHaveAttribute(
        'aria-label',
        'Create Director'
      );
    });
  });

  test.describe('Responsive Behavior', () => {
    test('director panel maintains layout on smaller screens', async ({ page }) => {
      // Tablet-sized viewport (>= md breakpoint keeps the director panel)
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto('/');

      await expandPanel(page);

      await expect(page.getByTestId('director-panel')).toBeVisible();
      await expect(page.getByTestId('director-panel-header')).toBeVisible();
    });
  });
});
