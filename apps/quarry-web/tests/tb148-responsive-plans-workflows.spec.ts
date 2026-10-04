/**
 * TB148: Responsive Plans & Workflows Pages Tests
 *
 * Tests for the responsive behavior of the Plans and Workflows pages across viewports.
 *
 * Behaviors tested:
 * - Plans: card list view, detail sheet/side panel, FAB for create on mobile
 * - Workflows: tabs + search at every size, template card grid that
 *   collapses to one column on mobile (no FAB), and the playbook-based
 *   Create Workflow modal opened from a template card
 * - Responsive create modals
 */

import { test, expect } from '@playwright/test';
import {
  setViewport,
  waitForResponsiveUpdate,
} from './helpers/responsive';
import {
  makePlaybook,
  mockPlaybookRoutes,
  openCreateWorkflowModalFromTemplate,
} from './helpers/create-workflow-modal';

test.describe('TB148: Responsive Plans Page', () => {
  test.describe('Mobile Viewport (< 640px)', () => {
    test.beforeEach(async ({ page }) => {
      // Set viewport BEFORE navigation
      await setViewport(page, 'xs');
      await page.goto('/plans');
      // Wait for responsive hooks to stabilize
      await waitForResponsiveUpdate(page, 300);
    });

    test('should show search bar on mobile', async ({ page }) => {
      // Search bar should be visible
      const searchInput = page.getByTestId('plan-search-input');
      await expect(searchInput).toBeVisible();
    });

    test('should show scrollable status filter on mobile', async ({ page }) => {
      // Status filter should be visible (plans use 'status-filter')
      const statusFilter = page.getByTestId('status-filter');
      await expect(statusFilter).toBeVisible();
    });

    test('should show card-based list view on mobile', async ({ page }) => {
      // Wait for plans to load
      await page.waitForSelector('[data-testid="mobile-plans-list"]', { timeout: 10000 });

      // Mobile list view should be visible
      const mobileListView = page.getByTestId('mobile-plans-list');
      await expect(mobileListView).toBeVisible();

      // Desktop list view should not be visible
      const desktopListView = page.getByTestId('plans-list');
      await expect(desktopListView).not.toBeVisible();
    });

    test('should show floating action button for create plan on mobile', async ({ page }) => {
      // FAB should be visible
      const fab = page.getByTestId('mobile-create-plan-fab');
      await expect(fab).toBeVisible();

      // Regular create button should not be visible
      const createButton = page.getByTestId('create-plan-btn');
      await expect(createButton).not.toBeVisible();
    });

    test('should open full-screen create modal when FAB is clicked', async ({ page }) => {
      // Click FAB
      const fab = page.getByTestId('mobile-create-plan-fab');
      await fab.click();

      // Create modal should be visible
      const createModal = page.getByTestId('create-plan-modal');
      await expect(createModal).toBeVisible();

      // Title input should be visible
      await expect(page.getByTestId('plan-title-input')).toBeVisible();
    });
  });

  test.describe('Tablet Viewport (768px)', () => {
    test.beforeEach(async ({ page }) => {
      await setViewport(page, 'lg');
      await page.goto('/plans');
      await waitForResponsiveUpdate(page);
    });

    test('should show desktop list view on tablet', async ({ page }) => {
      // Wait for list view content
      const listViewContent = page.getByTestId('plans-list');
      await expect(listViewContent).toBeVisible();

      // Mobile list view should not be present
      const mobileListView = page.getByTestId('mobile-plans-list');
      await expect(mobileListView).not.toBeVisible();
    });

    test('should show create plan button on tablet', async ({ page }) => {
      // Create button should be visible
      const createButton = page.getByTestId('create-plan-btn');
      await expect(createButton).toBeVisible();

      // FAB should not be visible
      const fab = page.getByTestId('mobile-create-plan-fab');
      await expect(fab).not.toBeVisible();
    });

    test('should show view toggle on tablet', async ({ page }) => {
      // View toggle should be visible
      const viewToggle = page.getByTestId('view-toggle');
      await expect(viewToggle).toBeVisible();
    });

    test('should show side panel when plan is selected on tablet', async ({ page }) => {
      // Wait for plans to load
      await page.waitForSelector('[data-testid="plans-list"]', { timeout: 10000 });

      // Click on first plan item
      const firstPlanItem = page.locator('[data-testid^="plan-item-"]').first();
      await firstPlanItem.click();

      // Side panel should be visible
      const detailContainer = page.getByTestId('plan-detail-container');
      await expect(detailContainer).toBeVisible();

      // Mobile detail sheet should not be visible
      const mobileDetailSheet = page.getByTestId('mobile-plan-detail-sheet');
      await expect(mobileDetailSheet).not.toBeVisible();
    });
  });

  test.describe('Desktop Viewport (1280px)', () => {
    test.beforeEach(async ({ page }) => {
      await setViewport(page, '2xl');
      await page.goto('/plans');
      await waitForResponsiveUpdate(page);
    });

    test('should show search bar on desktop', async ({ page }) => {
      // Search bar should be visible
      const searchInput = page.getByTestId('plan-search-input');
      await expect(searchInput).toBeVisible();
    });

    test('should show status filter on desktop', async ({ page }) => {
      // Status filter should be visible (plans use 'status-filter')
      const statusFilter = page.getByTestId('status-filter');
      await expect(statusFilter).toBeVisible();
    });

    test('should show view toggle on desktop', async ({ page }) => {
      // View toggle should be visible
      const viewToggle = page.getByTestId('view-toggle');
      await expect(viewToggle).toBeVisible();
    });

    test('should show desktop list view on desktop', async ({ page }) => {
      // Wait for list view content
      const listViewContent = page.getByTestId('plans-list');
      await expect(listViewContent).toBeVisible();

      // Mobile list view should not be present
      const mobileListView = page.getByTestId('mobile-plans-list');
      await expect(mobileListView).not.toBeVisible();
    });

    test('should show create plan button on desktop', async ({ page }) => {
      // Create button should be visible
      const createButton = page.getByTestId('create-plan-btn');
      await expect(createButton).toBeVisible();

      // FAB should not be visible
      const fab = page.getByTestId('mobile-create-plan-fab');
      await expect(fab).not.toBeVisible();
    });

    test('should show side panel when plan is selected on desktop', async ({ page }) => {
      // Wait for plans to load
      await page.waitForSelector('[data-testid="plans-list"]', { timeout: 10000 });

      // Click on first plan item
      const firstPlanItem = page.locator('[data-testid^="plan-item-"]').first();
      await firstPlanItem.click();

      // Side panel should be visible
      const detailContainer = page.getByTestId('plan-detail-container');
      await expect(detailContainer).toBeVisible();
    });
  });

  test.describe('Viewport Transitions', () => {
    test('should adapt layout when viewport changes from desktop to mobile', async ({ page }) => {
      // Start at desktop
      await setViewport(page, '2xl');
      await page.goto('/plans');
      await waitForResponsiveUpdate(page);

      // Verify desktop layout
      await expect(page.getByTestId('create-plan-btn')).toBeVisible();

      // Resize to mobile
      await setViewport(page, 'xs');
      await waitForResponsiveUpdate(page, 300);

      // Verify mobile layout
      await expect(page.getByTestId('mobile-create-plan-fab')).toBeVisible();
      await expect(page.getByTestId('create-plan-btn')).not.toBeVisible();
    });
  });
});

test.describe('TB148: Responsive Workflows Page', () => {
  // The page uses a single responsive layout: tabs (Templates | Active),
  // search, and a card grid that collapses to one column on mobile. There is
  // no mobile FAB and no status filter. Creation is playbook-only: the Create
  // Workflow modal opens from a playbook template card, so these tests mock
  // the playbook endpoints (the Quarry server only serves filesystem
  // discovery for playbooks, not the CRUD/instantiate API the modal uses).

  test.describe('Mobile Viewport (< 640px)', () => {
    test.beforeEach(async ({ page }) => {
      // Set viewport BEFORE navigation
      await setViewport(page, 'xs');
      await mockPlaybookRoutes(page, { playbooks: [makePlaybook()] });
      await page.goto('/workflows');
      // Wait for responsive hooks to stabilize
      await waitForResponsiveUpdate(page, 300);
    });

    test('should show tabs and search on mobile', async ({ page }) => {
      await expect(page.getByTestId('workflows-tab-templates')).toBeVisible();
      await expect(page.getByTestId('workflows-tab-active')).toBeVisible();
      await expect(page.getByTestId('workflows-search')).toBeVisible();
    });

    test('should show single-column template grid on mobile', async ({ page }) => {
      // The template cards render in a grid that collapses to one column
      const grid = page.getByTestId('playbooks-grid');
      await expect(grid).toBeVisible({ timeout: 10000 });

      // One column on mobile: the first card spans the full grid width
      const firstCard = grid.locator('[data-testid^="playbook-card-"]').first();
      const gridBox = await grid.boundingBox();
      const cardBox = await firstCard.boundingBox();
      expect(gridBox).not.toBeNull();
      expect(cardBox).not.toBeNull();
      expect(Math.round(cardBox!.width)).toBe(Math.round(gridBox!.width));
    });

    test('should show create template button, not a FAB, on mobile', async ({ page }) => {
      // The header create button stays visible on mobile; there is no FAB
      await expect(page.getByTestId('workflows-create')).toBeVisible();
      await expect(page.getByTestId('mobile-create-workflow-fab')).toHaveCount(0);
    });

    test('should open create workflow modal from a template card on mobile', async ({ page }) => {
      // Creation is playbook-only: the modal opens from a playbook card with
      // the playbook preselected, so the title input is immediately usable
      await openCreateWorkflowModalFromTemplate(page, makePlaybook());

      const createModal = page.getByRole('dialog', { name: 'Create Workflow', exact: true });
      await expect(createModal).toBeVisible();

      // Title input should be visible
      await expect(page.getByTestId('create-title-input')).toBeVisible();
    });
  });

  test.describe('Tablet Viewport (768px)', () => {
    test.beforeEach(async ({ page }) => {
      await setViewport(page, 'lg');
      await mockPlaybookRoutes(page, { playbooks: [makePlaybook()] });
      await page.goto('/workflows');
      await waitForResponsiveUpdate(page);
    });

    test('should show template grid on tablet', async ({ page }) => {
      await expect(page.getByTestId('playbooks-grid')).toBeVisible({ timeout: 10000 });
    });

    test('should show create template button on tablet', async ({ page }) => {
      await expect(page.getByTestId('workflows-create')).toBeVisible();

      // No FAB on tablet
      await expect(page.getByTestId('mobile-create-workflow-fab')).toHaveCount(0);
    });
  });

  test.describe('Desktop Viewport (1280px)', () => {
    test.beforeEach(async ({ page }) => {
      await setViewport(page, '2xl');
      await mockPlaybookRoutes(page, { playbooks: [makePlaybook()] });
      await page.goto('/workflows');
      await waitForResponsiveUpdate(page);
    });

    test('should show tabs and search on desktop', async ({ page }) => {
      await expect(page.getByTestId('workflows-tab-templates')).toBeVisible();
      await expect(page.getByTestId('workflows-tab-active')).toBeVisible();
      await expect(page.getByTestId('workflows-search')).toBeVisible();
    });

    test('should show multi-column template grid on desktop', async ({ page }) => {
      const grid = page.getByTestId('playbooks-grid');
      await expect(grid).toBeVisible({ timeout: 10000 });

      // Three columns on 2xl: a card is narrower than half the grid
      const firstCard = grid.locator('[data-testid^="playbook-card-"]').first();
      const gridBox = await grid.boundingBox();
      const cardBox = await firstCard.boundingBox();
      expect(gridBox).not.toBeNull();
      expect(cardBox).not.toBeNull();
      expect(cardBox!.width).toBeLessThan(gridBox!.width / 2);
    });

    test('should show create template button on desktop', async ({ page }) => {
      await expect(page.getByTestId('workflows-create')).toBeVisible();

      // No FAB on desktop
      await expect(page.getByTestId('mobile-create-workflow-fab')).toHaveCount(0);
    });
  });

  test.describe('Viewport Transitions', () => {
    test('create button stays available when viewport changes from desktop to mobile', async ({ page }) => {
      // Start at desktop
      await setViewport(page, '2xl');
      await mockPlaybookRoutes(page, { playbooks: [makePlaybook()] });
      await page.goto('/workflows');
      await waitForResponsiveUpdate(page);

      // Verify desktop layout
      await expect(page.getByTestId('workflows-create')).toBeVisible();

      // Resize to mobile
      await setViewport(page, 'xs');
      await waitForResponsiveUpdate(page, 300);

      // The same header button remains the create entry point
      await expect(page.getByTestId('workflows-create')).toBeVisible();
      await expect(page.getByTestId('mobile-create-workflow-fab')).toHaveCount(0);
    });
  });
});
