/**
 * Session Routes - Rate Limit Guard Tests
 *
 * Tests that POST /api/agents/:id/start and POST /api/agents/:id/resume
 * return HTTP 429 with Retry-After header when all worker accounts are
 * rate-limited (global stall) — and, since dispatch tiers, when the target
 * agent's OWN account is limited while other accounts are free.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Hono } from 'hono';
import type { EntityId } from '@stoneforge/core';
import { createTimestamp } from '@stoneforge/core';
import type { SessionRecord } from '@stoneforge/smithy';
import { createSessionRoutes } from './sessions.js';
import type { Services } from '../services.js';

// ============================================================================
// Minimal mock factories
// ============================================================================

/** A limited account key as tracked by the (mocked) rate limit tracker. */
interface MockLimit {
  executable: string;
  resetsAt: string;
}

/** Knobs of the mocked dispatch daemon. */
interface MockOptions {
  /** `getRateLimitStatus().isPaused` — true only when EVERY account is limited. */
  rateLimitPaused?: boolean;
  /** `getRateLimitStatus().soonestReset` (ISO). */
  soonestReset?: string;
  /** Currently limited account keys. Defaults to `claude` when paused. */
  limits?: MockLimit[];
  /** The agent returned by `agentRegistry.getAgent`. */
  agent?: {
    id?: string;
    name?: string;
    /** The agent's own executable — defines its account key. */
    executablePath?: string;
  };
}

/**
 * Builds the minimal `Services` object the session routes need.
 *
 * The mocked `dispatchDaemon.isAgentRateLimited` mirrors the real daemon's
 * per-agent rule at small scale: the agent is limited when its effective
 * executable (`metadata.agent.executablePath` ?? the provider default
 * `claude`) appears in `limits`. The fallback-chain variant of that rule is
 * covered by the dispatch-daemon tests (`dispatch-daemon.bun.test.ts`).
 */
function createMockServices(overrides?: MockOptions): Services {
  const isPaused = overrides?.rateLimitPaused ?? false;
  const soonestReset = overrides?.soonestReset;
  const limits: MockLimit[] = overrides?.limits
    ?? (isPaused ? [{ executable: 'claude', resetsAt: soonestReset ?? new Date(Date.now() + 60_000).toISOString() }] : []);

  const mockAgent = {
    id: overrides?.agent?.id ?? 'agent-test-123',
    name: overrides?.agent?.name ?? 'test-worker',
    metadata: {
      agent: {
        agentRole: 'worker',
        workerMode: 'ephemeral',
        ...(overrides?.agent?.executablePath
          ? { executablePath: overrides.agent.executablePath }
          : {}),
      },
    },
  };

  return {
    api: {
      get: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    orchestratorApi: {
      assignTaskToAgent: vi.fn(async () => ({})),
    },
    agentRegistry: {
      getAgent: vi.fn(async () => mockAgent),
      getDirector: vi.fn(async () => ({ id: 'director-123' })),
      listAgents: vi.fn(async () => []),
    },
    sessionManager: {
      getActiveSession: vi.fn(() => null),
      startSession: vi.fn(async (agentId: EntityId) => {
        const session: SessionRecord = {
          id: `session-${Date.now()}`,
          agentId,
          agentRole: 'worker',
          workerMode: 'ephemeral',
          mode: 'headless',
          status: 'running',
          workingDirectory: '/tmp/test',
          createdAt: createTimestamp(),
          startedAt: createTimestamp(),
          lastActivityAt: createTimestamp(),
        };
        return { session, events: new EventEmitter() };
      }),
      resumeSession: vi.fn(async (agentId: EntityId) => {
        const session: SessionRecord = {
          id: `session-${Date.now()}`,
          agentId,
          agentRole: 'worker',
          workerMode: 'ephemeral',
          mode: 'headless',
          status: 'running',
          workingDirectory: '/tmp/test',
          createdAt: createTimestamp(),
          startedAt: createTimestamp(),
          lastActivityAt: createTimestamp(),
          providerSessionId: 'provider-123',
        };
        return { session, events: new EventEmitter(), uwpCheck: undefined };
      }),
      getMostRecentResumableSession: vi.fn(() => ({
        id: 'session-resumable',
        providerSessionId: 'provider-123',
      })),
      getSession: vi.fn(() => undefined),
      listSessions: vi.fn(() => []),
      getSessionHistory: vi.fn(async () => []),
    },
    spawnerService: {},
    worktreeManager: undefined,
    taskAssignmentService: {},
    dispatchService: {},
    roleDefinitionService: {},
    workerTaskService: {},
    stewardScheduler: {},
    pluginExecutor: {},
    poolService: undefined,
    inboxService: {},
    mergeStewardService: {},
    docsStewardService: {},
    dispatchDaemon: {
      getRateLimitStatus: vi.fn(() => ({
        isPaused,
        limits,
        soonestReset,
      })),
      // Per-agent guard: limited when the agent's effective executable is
      // one of the limited account keys.
      isAgentRateLimited: vi.fn((agent: { metadata?: { agent?: { executablePath?: string } } }) => {
        const effective = agent.metadata?.agent?.executablePath ?? 'claude';
        const limit = limits.find((entry) => entry.executable === effective);
        return limit ? { accountKey: limit.executable, resetsAt: limit.resetsAt } : undefined;
      }),
      // Satisfy the DispatchDaemon interface enough to avoid type errors
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => false),
    },
    sessionInitialPrompts: new Map<string, string>(),
    sessionMessageService: {
      saveMessage: vi.fn(() => {}),
      getSessionMessages: vi.fn(() => []),
      getLatestDisplayableMessages: vi.fn(() => new Map()),
    },
    storageBackend: {},
  } as unknown as Services;
}

// ============================================================================
// Tests
// ============================================================================

/** Builds a Hono app with the session routes mounted on the given services. */
function createApp(services: Services): Hono {
  const app = new Hono();
  app.route('/', createSessionRoutes(services, vi.fn(() => {})));
  return app;
}

/** POSTs an empty JSON body to the given session route. */
function request(app: Hono, path: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('Session Routes - Rate Limit Guard', () => {
  describe('POST /api/agents/:id/start', () => {
    test('returns 429 with Retry-After when all executables are rate-limited', async () => {
      const soonestReset = new Date(Date.now() + 30_000).toISOString();
      const services = createMockServices({
        rateLimitPaused: true,
        soonestReset,
      });

      const app = new Hono();
      app.route('/', createSessionRoutes(services, vi.fn(() => {})));

      const response = await app.request('/api/agents/agent-test-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(429);

      const retryAfter = response.headers.get('Retry-After');
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
      expect(Number(retryAfter)).toBeLessThanOrEqual(30);

      const body = await response.json() as { error: { code: string; message: string; retryAfter: number; soonestReset: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toContain('rate-limited');
      expect(body.error.retryAfter).toBeGreaterThan(0);
      expect(body.error.soonestReset).toBe(soonestReset);
    });

    test('allows session start when executables are not rate-limited', async () => {
      const services = createMockServices({
        rateLimitPaused: false,
      });

      const app = new Hono();
      app.route('/', createSessionRoutes(services, vi.fn(() => {})));

      const response = await app.request('/api/agents/agent-test-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should succeed (201) since no rate limit
      expect(response.status).toBe(201);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    test('returns 429 with default Retry-After when soonestReset is not available', async () => {
      const services = createMockServices({
        rateLimitPaused: true,
        soonestReset: undefined,
      });

      const app = new Hono();
      app.route('/', createSessionRoutes(services, vi.fn(() => {})));

      const response = await app.request('/api/agents/agent-test-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(429);
      const retryAfter = response.headers.get('Retry-After');
      expect(retryAfter).toBe('60'); // Default 60 seconds
    });
  });

  describe('POST /api/agents/:id/resume', () => {
    test('returns 429 with Retry-After when all executables are rate-limited', async () => {
      const soonestReset = new Date(Date.now() + 45_000).toISOString();
      const services = createMockServices({
        rateLimitPaused: true,
        soonestReset,
      });

      const app = new Hono();
      app.route('/', createSessionRoutes(services, vi.fn(() => {})));

      const response = await app.request('/api/agents/agent-test-123/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(429);

      const retryAfter = response.headers.get('Retry-After');
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
      expect(Number(retryAfter)).toBeLessThanOrEqual(45);

      const body = await response.json() as { error: { code: string; message: string; retryAfter: number; soonestReset: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toContain('rate-limited');
    });

    test('allows session resume when executables are not rate-limited', async () => {
      const services = createMockServices({
        rateLimitPaused: false,
      });

      const app = new Hono();
      app.route('/', createSessionRoutes(services, vi.fn(() => {})));

      const response = await app.request('/api/agents/agent-test-123/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should succeed (201) since no rate limit
      expect(response.status).toBe(201);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  describe('per-agent account guard (partial limit)', () => {
    // Since dispatch tiers, `isPaused` is true only when EVERY account is
    // limited. A partial limit must still refuse the agent whose own
    // account is exhausted — otherwise the session spawns and immediately
    // hits the limit — while agents on free accounts keep starting.

    test('start returns 429 naming the account when only the target agent\'s account is limited', async () => {
      const agentReset = new Date(Date.now() + 90_000).toISOString();
      const services = createMockServices({
        rateLimitPaused: false,
        soonestReset: new Date(Date.now() + 30_000).toISOString(), // another account resets sooner
        limits: [
          { executable: 'claude', resetsAt: new Date(Date.now() + 30_000).toISOString() },
          { executable: 'claude-glm', resetsAt: agentReset },
        ],
        agent: { id: 'agent-glm', name: 'glm-worker', executablePath: 'claude-glm' },
      });

      const response = await request(createApp(services), '/api/agents/agent-glm/start');

      expect(response.status).toBe(429);

      const body = await response.json() as {
        error: { code: string; message: string; retryAfter: number; accountKey?: string; resetsAt?: string };
      };
      expect(body.error.code).toBe('RATE_LIMITED');
      // The refusal names the limited account key …
      expect(body.error.accountKey).toBe('claude-glm');
      expect(body.error.message).toContain('claude-glm');
      // … and ITS reset time, not the global soonest reset
      expect(body.error.resetsAt).toBe(agentReset);
      expect(body.error.message).toContain(agentReset);

      const retryAfter = Number(response.headers.get('Retry-After'));
      expect(retryAfter).toBeGreaterThan(60); // 90s, not the 30s soonest reset
      expect(retryAfter).toBeLessThanOrEqual(90);
      expect(body.error.retryAfter).toBe(retryAfter);
    });

    test('start allows an agent whose account is free while another account is limited', async () => {
      const services = createMockServices({
        rateLimitPaused: false,
        soonestReset: new Date(Date.now() + 30_000).toISOString(),
        limits: [{ executable: 'claude', resetsAt: new Date(Date.now() + 30_000).toISOString() }],
        agent: { id: 'agent-glm-free', name: 'glm-worker-free', executablePath: 'claude-glm' },
      });

      const response = await request(createApp(services), '/api/agents/agent-glm-free/start');

      // The `claude` account being limited must not block a `claude-glm` agent
      expect(response.status).toBe(201);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    test('start allows a default-account agent when the limit is on an unrelated wrapper', async () => {
      // The mirror of the case above: the agent has no `executablePath`
      // (provider default `claude` account) and only `claude-glm` is limited.
      const services = createMockServices({
        rateLimitPaused: false,
        limits: [{ executable: 'claude-glm', resetsAt: new Date(Date.now() + 30_000).toISOString() }],
        agent: { id: 'agent-default', name: 'default-worker' },
      });

      const response = await request(createApp(services), '/api/agents/agent-default/start');

      expect(response.status).toBe(201);
    });

    test('resume returns 429 naming the account when only the target agent\'s account is limited', async () => {
      const agentReset = new Date(Date.now() + 70_000).toISOString();
      const services = createMockServices({
        rateLimitPaused: false,
        limits: [
          { executable: 'claude', resetsAt: new Date(Date.now() + 20_000).toISOString() },
          { executable: 'claude-glm', resetsAt: agentReset },
        ],
        agent: { id: 'agent-glm-resume', name: 'glm-worker-resume', executablePath: 'claude-glm' },
      });

      const response = await request(createApp(services), '/api/agents/agent-glm-resume/resume');

      expect(response.status).toBe(429);
      const body = await response.json() as {
        error: { code: string; message: string; retryAfter: number; accountKey?: string; resetsAt?: string };
      };
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.accountKey).toBe('claude-glm');
      expect(body.error.resetsAt).toBe(agentReset);
      expect(body.error.message).toContain('claude-glm');

      const retryAfter = Number(response.headers.get('Retry-After'));
      expect(retryAfter).toBeGreaterThan(60);
      expect(retryAfter).toBeLessThanOrEqual(70);
    });

    test('resume allows an agent whose account is free while another account is limited', async () => {
      const services = createMockServices({
        rateLimitPaused: false,
        soonestReset: new Date(Date.now() + 30_000).toISOString(),
        limits: [{ executable: 'claude', resetsAt: new Date(Date.now() + 30_000).toISOString() }],
        agent: { id: 'agent-glm-resume-free', name: 'glm-worker-resume-free', executablePath: 'claude-glm' },
      });

      const response = await request(createApp(services), '/api/agents/agent-glm-resume-free/resume');

      expect(response.status).toBe(201);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  describe('when dispatchDaemon is undefined', () => {
    test('allows session start without rate limit check', async () => {
      const services = createMockServices();
      // Override dispatchDaemon to be undefined (no git repo scenario)
      (services as { dispatchDaemon: undefined }).dispatchDaemon = undefined;

      const app = new Hono();
      app.route('/', createSessionRoutes(services, vi.fn(() => {})));

      const response = await app.request('/api/agents/agent-test-123/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should succeed since dispatchDaemon is undefined (no rate limit check possible)
      expect(response.status).toBe(201);
    });
  });
});
