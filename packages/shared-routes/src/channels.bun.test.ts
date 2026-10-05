/**
 * Channel Routes Tests
 *
 * Regression coverage for error-to-HTTP-status mapping in POST /api/channels:
 * core factories throw StoneforgeError ValidationError with codes like
 * INVALID_INPUT (never the literal 'VALIDATION_ERROR'), so the route must map
 * via the error's httpStatus — not a code-string comparison — to return 400
 * instead of leaking a 500.
 */

import { describe, expect, test } from 'bun:test';
import type { StorageBackend } from '@stoneforge/storage';
import { createChannelRoutes } from './channels.js';
import type { CollaborateServices, QuarryLikeAPI } from './types.js';

// ============================================================================
// Fakes & Helpers
// ============================================================================

interface FakeServicesOptions {
  /** Elements returned by api.get (keyed by id) */
  elements?: Map<string, unknown>;
  /** Overrides applied to the fake api (e.g. a failing create) */
  apiOverrides?: Record<string, unknown>;
}

function createFakeServices(options: FakeServicesOptions = {}): CollaborateServices {
  const elements = options.elements ?? new Map<string, unknown>();
  const api = {
    get: async (id: string) => elements.get(id) ?? null,
    create: async (input: Record<string, unknown>) => input,
    ...options.apiOverrides,
  } as unknown as QuarryLikeAPI;

  return {
    api,
    inboxService: {} as CollaborateServices['inboxService'],
    storageBackend: {} as unknown as StorageBackend,
  };
}

function postChannels(services: CollaborateServices, body: unknown): Promise<Response> {
  const app = createChannelRoutes(services);
  return app.request('/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// POST /api/channels — validation errors map to 400
// ============================================================================

describe('POST /api/channels error mapping', () => {
  test('group channel with fewer than 2 members returns 400, not 500', async () => {
    const services = createFakeServices();

    // Exact repro from el-6b7gdi: createGroupChannel throws
    // ValidationError (code INVALID_INPUT, httpStatus 400) after the creator
    // is merged into a 1-member list.
    const res = await postChannels(services, {
      channelType: 'group',
      name: 'x',
      createdBy: 'el-0000',
      members: ['el-0000'],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('at least 2 members');
  });

  test('direct channel with identical entities returns 400, not 500', async () => {
    const services = createFakeServices();

    const res = await postChannels(services, {
      channelType: 'direct',
      createdBy: 'el-aaaa',
      entityA: 'el-aaaa',
      entityB: 'el-aaaa',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('two different entities');
  });

  test('malformed member id returns 400 with the validator message', async () => {
    const services = createFakeServices();

    const res = await postChannels(services, {
      channelType: 'group',
      name: 'x',
      createdBy: 'el-0000',
      members: ['not-a-valid-id'],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('invalid format');
  });

  test('valid group channel still returns 201', async () => {
    const services = createFakeServices();

    const res = await postChannels(services, {
      channelType: 'group',
      name: 'x',
      createdBy: 'el-0000',
      members: ['el-0000', 'el-0001'],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { channelType: string; members: string[] };
    expect(body.channelType).toBe('group');
    expect(body.members).toHaveLength(2);
  });

  test('non-validation failures still return 500', async () => {
    const services = createFakeServices({
      apiOverrides: {
        create: async () => {
          throw new Error('boom');
        },
      },
    });

    const res = await postChannels(services, {
      channelType: 'group',
      name: 'x',
      createdBy: 'el-0000',
      members: ['el-0000', 'el-0001'],
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
