/**
 * Shared fixture helpers for browser specs that create group channels through
 * the running Quarry server (message-attachments, tb131-virtualized-messages).
 *
 * The channel-creation contract (POST /api/channels in
 * packages/shared-routes/src/channels.ts -> createGroupChannel in
 * packages/core/src/types/channel.ts):
 *
 * - `createdBy` is required and must be a valid entity id (`el-xxxxx`).
 * - A group channel needs at least two member entities. The creator is added
 *   to `members` automatically, so the payload must name at least one member
 *   OTHER than `createdBy` — `members: [createdBy]` is a one-member group and
 *   is rejected by the API.
 * - The Quarry server does expose POST /api/entities
 *   (packages/quarry/src/server/index.ts — note the shared-routes factory
 *   in packages/shared-routes/src/entities.ts has GET only, which is easy
 *   to mistake for the whole surface). It rejects duplicate names, though,
 *   so per-run fixtures are better served by the two entities that
 *   tests/global-setup.ts seeds through the storage API before the server
 *   starts (el-0000 "operator" and el-0001 "e2e-participant"): they are
 *   deterministic and shared by every spec in the run.
 * - Channel names allow only alphanumerics, hyphens, underscores, and colons
 *   — no spaces.
 * - GET /api/channels and /api/entities answer with the paginated envelope
 *   {items, total, offset, limit, hasMore}, not a bare array; unwrap `.items`
 *   before indexing.
 *
 * Every helper asserts what it creates. A failed create must turn the test
 * red with the response body in the failure message — a fixture that quietly
 * returns an error body makes the spec skip or fail far away from the cause
 * (el-3kh1rt).
 */

import { expect, type Page } from '@playwright/test';

/** The subset of a channel element these fixtures read. */
export interface FixtureChannel {
  id: string;
  name: string;
  channelType: 'group' | 'direct';
  members: string[];
}

/** GET /api/channels, unwrapped from the paginated envelope to its items. */
export async function listChannels(page: Page): Promise<FixtureChannel[]> {
  const response = await page.request.get('/api/channels');
  const body = await response.json().catch(() => null);
  expect(
    response.ok(),
    `GET /api/channels failed (${response.status()}): ${JSON.stringify(body)}`
  ).toBe(true);
  return body?.items ?? [];
}

/** GET /api/entities, unwrapped from the paginated envelope to its items. */
export async function listEntities(page: Page): Promise<{ id: string; name: string }[]> {
  const response = await page.request.get('/api/entities');
  const body = await response.json().catch(() => null);
  expect(
    response.ok(),
    `GET /api/entities failed (${response.status()}): ${JSON.stringify(body)}`
  ).toBe(true);
  return body?.items ?? [];
}

/**
 * Create a valid two-member group channel via POST /api/channels and assert
 * the create succeeded. `name` must be unique per call (no spaces; hyphens
 * are fine) so parallel specs never share a channel by accident.
 */
export async function createGroupChannelFixture(
  page: Page,
  name: string
): Promise<FixtureChannel> {
  const entities = await listEntities(page);
  expect(
    entities.length,
    'group-channel fixtures need at least two entities, but GET /api/entities returned fewer. ' +
      'tests/global-setup.ts seeds el-0000 and el-0001 for exactly this purpose ' +
      '(group channels need >= 2 member entities)'
  ).toBeGreaterThanOrEqual(2);

  const createdBy = entities[0].id;
  const otherMember = entities[1].id;
  const response = await page.request.post('/api/channels', {
    data: {
      name,
      channelType: 'group',
      createdBy,
      // The creator is added automatically; naming both members keeps the
      // two-member requirement explicit at the call site.
      members: [createdBy, otherMember],
      permissions: {
        visibility: 'public',
        joinPolicy: 'open',
        modifyMembers: [createdBy],
      },
    },
  });
  const body = await response.json().catch(() => null);
  expect(
    response.status(),
    `POST /api/channels failed for fixture "${name}": ${JSON.stringify(body)}`
  ).toBe(201);
  expect(body?.id, 'created channel must have an id').toBeDefined();
  expect(
    Array.isArray(body?.members) ? body.members.length : 0,
    'created group channel must have at least two members'
  ).toBeGreaterThanOrEqual(2);
  return body;
}
