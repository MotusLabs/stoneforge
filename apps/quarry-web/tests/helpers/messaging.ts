/**
 * Shared helpers for the messaging specs (message-display, send-message,
 * threading).
 *
 * The Quarry server's collection endpoints answer with a paginated envelope
 * `{ items, total, offset, limit, hasMore }` — NOT a bare array (see
 * GET /api/channels and GET /api/entities in packages/shared-routes/src).
 * Specs must unwrap `.items` before indexing: treating the envelope as an
 * array leaves `channels[0]` undefined and fails downstream with TypeErrors
 * like "Cannot read properties of undefined (reading 'id'/'members')" and
 * "channels is not iterable" (el-4bjca5).
 *
 * The messaging fixtures (two entities, a channel with a seed message, and an
 * empty channel) are seeded by tests/global-setup.ts; group channels require
 * at least two member entities and there is no HTTP endpoint for creating
 * entities, so the seed has to happen through the storage API before the
 * server starts.
 */

import type { Page } from '@playwright/test';

/** The subset of a channel element the messaging specs read. */
export interface TestChannel {
  id: string;
  name: string;
  channelType: 'group' | 'direct';
  members: string[];
}

/** GET /api/channels, unwrapped from the paginated envelope to its items. */
export async function getChannels(page: Page): Promise<TestChannel[]> {
  const response = await page.request.get('/api/channels');
  const data = await response.json();
  return data.items;
}

/** GET /api/entities, unwrapped from the paginated envelope; first entity or null. */
export async function getFirstEntity(page: Page): Promise<{ id: string; name: string } | null> {
  const response = await page.request.get('/api/entities');
  const data = await response.json();
  return data.items.length > 0 ? data.items[0] : null;
}
