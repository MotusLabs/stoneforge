import { test, expect } from '@playwright/test';

test('debug: does aria snapshot include closed notification sidebar?', async ({ page }) => {
  await page.goto('/workspaces');
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30000 });

  // Sidebar must be closed (default state)
  const hidden = await page.evaluate(() =>
    document.querySelector('[data-testid="notification-sidebar"]')?.getAttribute('aria-hidden'),
  );
  console.log('SIDEBAR_ARIA_HIDDEN', hidden);
  expect(hidden).toBe('true'); // precondition: closed

  // Take the same aria snapshot Playwright uses for error contexts
  const yaml = await page.locator('body').ariaSnapshot();
  console.log('SNAPSHOT_CONTAINS_SIDEBAR', yaml.includes('all caught up') || yaml.includes('Notification sidebar'));
  console.log('SNAPSHOT_CONTAINS_REGION_ALT_T', yaml.includes('alt+T') || yaml.includes('Alt+T'));

  // Also check the CSS box: is the "closed" sidebar offscreen but CSS-visible?
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="notification-sidebar"]') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { right: r.right, viewportW: window.innerWidth, offscreen: r.left >= window.innerWidth };
  });
  console.log('SIDEBAR_BOX', JSON.stringify(box));
});
