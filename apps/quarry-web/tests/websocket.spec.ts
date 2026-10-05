import { test, expect, type Page } from '@playwright/test';

/**
 * TB4: Real-time Updates (WebSocket)
 *
 * The routed app (AppShell + TanStack Router) keeps a WebSocket connection
 * to /ws (src/api/hooks/useRealtimeEvents.ts). The header indicator shows
 * 'Live' while connected, and broadcast events invalidate React Query
 * caches so dashboard data refreshes without a reload.
 *
 * The Playwright API/web servers run on dynamic ports (playwright.config.ts),
 * so requests must go through the Vite proxy (relative URLs) instead of a
 * hardcoded localhost:3456.
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

test.describe('TB4: Real-time Updates (WebSocket)', () => {
  // The Vite dev server transforms the module graph on first page load of
  // each run, so the first app-ready signal can take well over 10s when
  // parallel workers hit a cold server.
  test.beforeEach(() => test.setTimeout(60_000));

  test('WebSocket endpoint accepts connections', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // A plain HTTP GET to /ws does not negotiate an upgrade (it falls through
    // to the API router), so verify the endpoint the way the app uses it:
    // open a real WebSocket from the page through the same origin/proxy.
    const connected = await page.evaluate(() =>
      new Promise<boolean>((resolve) => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
        const timer = setTimeout(() => {
          socket.close();
          resolve(false);
        }, 5000);
        socket.onopen = () => {
          clearTimeout(timer);
          socket.close();
          resolve(true);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      })
    );
    expect(connected).toBe(true);
  });

  test('connection indicator shows Live when connected', async ({ page }) => {
    await page.goto('/');
    // The AppShell header indicator shows "Live" once the WebSocket connects
    await expect(page.getByText('Live')).toBeVisible({ timeout: 30000 });
  });

  test('ready tasks list updates when a task is created out-of-band', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Live')).toBeVisible({ timeout: 10000 });

    // Create a task server-side (previously done via the sf CLI)
    const task = await createTaskViaApi(page, `WebSocket Test Task ${Date.now()}`);

    // The server broadcasts a task event, the client invalidates its
    // ['tasks', 'ready'] cache, and the new task card appears WITHOUT a
    // reload (priority 1 keeps it at the top of the list)
    await expect(page.getByTestId(`task-card-${task.id}`)).toBeVisible({ timeout: 10000 });
  });

  test('dashboard metrics update in real-time when an element is created', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Live')).toBeVisible({ timeout: 30000 });

    // Total Tasks = ready + blocked (fed by /api/stats, invalidated on task
    // events); metric values render '...' while loading
    const totalTasks = page.getByTestId('metric-total-tasks').locator('p.font-semibold');
    await expect(totalTasks).not.toHaveText('...', { timeout: 10000 });
    const initialCount = parseInt((await totalTasks.textContent()) ?? '0', 10);

    await createTaskViaApi(page, `Real-time Stats Test ${Date.now()}`);

    // A new open task with no dependencies is ready, so the count grows
    await expect(async () => {
      const currentCount = parseInt((await totalTasks.textContent()) ?? '0', 10);
      expect(currentCount).toBeGreaterThan(initialCount);
    }).toPass({ timeout: 10000 });
  });

  test('client reconnects after the WebSocket connection drops', async ({ page }) => {
    // Route the app's WebSockets so the test can drop every live connection
    // on demand. The app opens several (AppShell and the DataPreloader each
    // subscribe; React StrictMode opens more while mounting in dev), and the
    // header indicator tracks the AppShell one — so all must be dropped.
    const routedSockets: { close: () => void }[] = [];
    await page.routeWebSocket(/\/ws$/, (ws) => {
      ws.connectToServer();
      routedSockets.push(ws);
    });

    await page.goto('/');
    await expect(page.getByText('Live')).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(500); // let mount-time connections settle
    expect(routedSockets.length).toBeGreaterThan(0);

    // Simulate the server dropping every connection; sockets routed after
    // this point are the client's reconnect attempts and pass through.
    for (const socket of [...routedSockets]) {
      try {
        socket.close();
      } catch {
        // Already closed (e.g. a mount-time connection the app discarded)
      }
    }

    await expect(page.getByText('Reconnecting...', { exact: true })).toBeVisible({ timeout: 8000 });
    // The client retries with exponential backoff and returns to Live
    await expect(page.getByText('Live')).toBeVisible({ timeout: 15000 });
  });

  test('health endpoint shows WebSocket stats', async ({ page }) => {
    // First visit the page to establish a WebSocket connection
    await page.goto('/');
    await expect(page.getByText('Live')).toBeVisible({ timeout: 30000 });

    // Now check the health endpoint
    const response = await page.request.get('/api/health');
    expect(response.ok()).toBe(true);

    const health = await response.json();
    expect(health.websocket).toBeDefined();
    expect(typeof health.websocket.clients).toBe('number');
    expect(health.websocket.clients).toBeGreaterThanOrEqual(1);
    expect(typeof health.websocket.broadcasting).toBe('boolean');
  });

  test('system status section shows WebSocket status', async ({ page }) => {
    await page.goto('/');

    // Wait for WebSocket connection and page load
    await expect(page.getByText('Live')).toBeVisible({ timeout: 30000 });

    // The dashboard System Status block (DashboardPage → SystemStatus)
    // surfaces the server's WebSocket stats
    await expect(page.getByText('System Status')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('WebSocket Clients')).toBeVisible();
    await expect(page.getByText('Broadcasting')).toBeVisible();
  });
});
