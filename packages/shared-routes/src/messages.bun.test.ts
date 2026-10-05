/**
 * Message Routes Tests
 *
 * Regression coverage for error-to-HTTP-status mapping in POST /api/messages:
 * core factories throw StoneforgeError ValidationError with codes like
 * INVALID_ID (never the literal 'VALIDATION_ERROR'), so the route must map
 * via the error's httpStatus — not a code-string comparison — to return 400
 * instead of leaking a 500.
 */

import { describe, expect, test } from 'bun:test';
import type { StorageBackend } from '@stoneforge/storage';
import { createMessageRoutes } from './messages.js';
import type { CollaborateServicesWithBroadcast, QuarryLikeAPI } from './types.js';

// ============================================================================
// Fakes & Helpers
// ============================================================================

const CHANNEL_ID = 'el-chn01';
const SENDER_ID = 'el-send';

function createElementMap(): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      CHANNEL_ID,
      {
        id: CHANNEL_ID,
        type: 'channel',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdBy: SENDER_ID,
        tags: [],
        metadata: {},
        name: 'test-channel',
        description: null,
        channelType: 'group',
        members: [SENDER_ID],
        permissions: {
          visibility: 'private',
          joinPolicy: 'invite-only',
          modifyMembers: [SENDER_ID],
        },
      },
    ],
    [
      SENDER_ID,
      {
        id: SENDER_ID,
        type: 'entity',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdBy: SENDER_ID,
        tags: [],
        metadata: {},
        name: 'Sender',
        entityType: 'agent',
      },
    ],
  ]);
}

function createFakeServices(
  apiOverrides: Record<string, unknown> = {}
): CollaborateServicesWithBroadcast {
  const elements = createElementMap();
  const api = {
    get: async (id: string) => elements.get(id) ?? null,
    create: async (input: Record<string, unknown>) => input,
    ...apiOverrides,
  } as unknown as QuarryLikeAPI;

  return {
    api,
    inboxService: {} as CollaborateServicesWithBroadcast['inboxService'],
    storageBackend: {} as unknown as StorageBackend,
  };
}

function postMessage(
  services: CollaborateServicesWithBroadcast,
  body: unknown
): Promise<Response> {
  const app = createMessageRoutes(services);
  return app.request('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// POST /api/messages — validation errors map to 400
// ============================================================================

describe('POST /api/messages error mapping', () => {
  test('invalid threadId format returns 400, not 500', async () => {
    const services = createFakeServices();

    // The route does not pre-validate threadId; createMessage throws
    // ValidationError (code INVALID_ID, httpStatus 400) for a malformed id.
    const res = await postMessage(services, {
      channelId: CHANNEL_ID,
      sender: SENDER_ID,
      content: 'hello world',
      threadId: 'not-a-valid-thread-id',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('invalid format');
  });

  test('valid message still returns 200 with hydrated content', async () => {
    const services = createFakeServices();

    const res = await postMessage(services, {
      channelId: CHANNEL_ID,
      sender: SENDER_ID,
      content: 'hello world',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { channelId: string; _content: string };
    expect(body.channelId).toBe(CHANNEL_ID);
    expect(body._content).toBe('hello world');
  });

  test('non-validation failures still return 500', async () => {
    const services = createFakeServices({
      create: async () => {
        throw new Error('boom');
      },
    });

    const res = await postMessage(services, {
      channelId: CHANNEL_ID,
      sender: SENDER_ID,
      content: 'hello world',
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
