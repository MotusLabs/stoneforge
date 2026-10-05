/**
 * Vite dev-server warmup for Playwright runs.
 *
 * Why: both apps statically import every route component in `src/router.tsx`,
 * so the first `page.goto()` of a run fetches the entire unbundled module
 * graph through Vite's on-demand transform pipeline. With the default worker
 * count (half the CPUs, e.g. 8 on a 16-core host) every worker hits that
 * cold-cache first transform at the same moment and the single Vite process
 * serializes the transforms — the `load` event can then exceed Playwright's
 * default 30s navigation timeout. Four recorded flake incidents share this
 * signature (initial `page.goto` timeout under parallel load, green on
 * isolated retry): playbooks.spec.ts:193, workspaces.spec.ts:755/:873,
 * create-workflow-modal.ts:339, onboarding.spec.ts:521 — see task el-1pjuwe.
 *
 * Fix: `globalSetup` runs after the webServer is ready but *before* any
 * worker spawns. Loading the app once there populates Vite's in-memory
 * transform cache (and finishes dep pre-bundling), so every worker's first
 * navigation is a warm-cache load (~seconds, not tens of seconds).
 *
 * The route list is discovered from the specs themselves: every page.goto
 * string literal under tests/ (helpers included) is warmed, so new specs that
 * navigate to new routes are covered without maintaining a list by hand.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

/** Warmup navigation timeout: cold first-transform of the full module graph. */
const WARMUP_TIMEOUT_MS = 120_000;
/** Extra settle window for route-lazy chunks (e.g. dynamically imported editors). */
const NETWORK_IDLE_TIMEOUT_MS = 2_000;

/**
 * Collect distinct page.goto route targets from the test sources.
 * Query strings are stripped (they do not change the module graph) and the
 * list is sorted so the first, most expensive navigation covers the shared
 * entry graph before cheaper per-route warms run.
 *
 * Template literals are handled: a leading `${APP_URL}`/`${BASE_URL}`
 * interpolation carries no route information and is stripped, and
 * interpolations inside query strings (`/tasks?page=${n}`) vanish with the
 * query. An interpolated *path* segment (`/tasks/${id}`) is warmed as the
 * literal `/tasks/${id}` — the router still matches it to the same route
 * chunk, which is what the warmup needs.
 */
export function discoverGotoRoutes(testsDir: string): string[] {
  const routes = new Set<string>();
  const gotoPattern = /page\.goto\(\s*['"`]([^'"`)]+)['"`]/g;
  const baseURLPrefix = /^\$\{(?:APP_URL|BASE_URL)\}/;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) &&
        // Skip this scanner's own source: its doc comments name example
        // goto targets that no test navigates to.
        entry.name !== 'warm-vite.ts'
      ) {
        const source = readFileSync(fullPath, 'utf8');
        for (const match of source.matchAll(gotoPattern)) {
          const route = match[1]
            .replace(baseURLPrefix, '')
            .split('?')[0]
            .split('#')[0];
          if (route.startsWith('/')) routes.add(route);
        }
      }
    }
  };

  walk(testsDir);
  return [...routes].sort();
}

/**
 * Load every discovered route once in a throwaway browser so Vite transforms
 * (and dep pre-bundles) the whole module graph before workers start.
 *
 * Throws on failure: if even this single warmup load cannot complete, the
 * run would only flake randomly across workers — failing setup with a clear
 * message is the diagnosable alternative.
 */
export async function warmViteDevServer(baseURL: string, testsDir: string): Promise<void> {
  // Escape hatch for A/B comparisons and emergencies: E2E_SKIP_WARMUP=1
  // restores the old behavior (workers race the cold first transform).
  if (process.env.E2E_SKIP_WARMUP === '1') {
    console.log('[warm-vite] Skipped (E2E_SKIP_WARMUP=1)');
    return;
  }
  const routes = discoverGotoRoutes(testsDir);
  if (routes.length === 0) return;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const startedAt = Date.now();
    for (const route of routes) {
      await page.goto(baseURL + route, { timeout: WARMUP_TIMEOUT_MS });
      // Best-effort settle for dynamically imported route chunks; a route
      // that keeps polling never reaches idle, so the wait is capped.
      await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
    }
    console.log(`[warm-vite] Warmed ${routes.length} route(s) on ${baseURL} in ${Date.now() - startedAt}ms`);
  } finally {
    await browser.close();
  }
}
