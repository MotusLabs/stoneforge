/**
 * Session Routes Tests — rate-limit refusal on manual spawn endpoints
 *
 * POST /api/agents/:id/start and /resume must refuse explicitly (429
 * RATE_LIMITED + Retry-After) when dispatch is paused (manual sleep or all
 * worker accounts limited) or when the target agent's own account is
 * limited, instead of spawning a session that immediately dies.
 *
 * Context: incident 2026-10-04 — 'sf agent start' during a dispatch pause
 * reported a phantom success while nothing actually ran (task el-3hxa0i).
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import type { EntityId, ElementId } from '@stoneforge/core';
import type { Services } from '../services.js';
import { createSessionRoutes } from './sessions.js';
import { getProviderRegistry } from '../../providers/registry.js';

// ============================================================================
// Test Fixtures
// ============================================================================

interface MinimalAgent {
  id: ElementId;
  name: string;
  metadata: {
    agent: {
      agentRole: 'worker';
      sessionStatus?: string;
      workerMode?: string;
      /** Explicit executable override — defines the agent's account key. */
      executablePath?: string;
    };
  };
}

function createMockWorkerAgent(): MinimalAgent {
  return {
    id: 'agent-001' as ElementId,
    name: 'Test-worker',
    metadata: {
      agent: {
        agentRole: 'worker',
        sessionStatus: 'idle',
        workerMode: 'ephemeral',
      },
    },
  };
}

// ============================================================================
// Mock Services Factory
// ============================================================================

function createMockServices() {
  const agent = createMockWorkerAgent();

  const agentRegistry = {
    getAgent: vi.fn().mockResolvedValue(agent),
    getDirector: vi.fn().mockResolvedValue(undefined),
    updateAgentSession: vi.fn().mockResolvedValue(undefined),
  };

  const sessionRecord = {
    id: 'session-123',
    providerSessionId: 'provider-session-123',
    agentId: agent.id as EntityId,
    agentRole: 'worker',
    mode: 'headless',
    pid: 4321,
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  const sessionManager = {
    getActiveSession: vi.fn().mockReturnValue(undefined),
    startSession: vi.fn().mockResolvedValue({
      session: sessionRecord,
      events: new EventEmitter(),
    }),
    resumeSession: vi.fn().mockResolvedValue({
      session: sessionRecord,
      events: new EventEmitter(),
      uwpCheck: undefined,
    }),
    getMostRecentResumableSession: vi.fn().mockReturnValue(undefined),
  };

  const getRateLimitStatus = vi.fn().mockResolvedValue({
    isPaused: false,
    limits: [],
    soonestReset: undefined,
    manualSleepUntil: undefined,
  });

  const isAgentRateLimited = vi.fn().mockReturnValue(undefined);

  const services = {
    agentRegistry,
    sessionManager,
    dispatchDaemon: { getRateLimitStatus, isAgentRateLimited },
    orchestratorApi: {
      assignTaskToAgent: vi.fn().mockResolvedValue(undefined),
    },
    sessionInitialPrompts: new Map<string, string>(),
    sessionMessageService: {
      saveMessage: vi.fn(),
    },
    spawnerService: {},
  } as unknown as Services;

  return {
    services,
    agentRegistry,
    sessionManager,
    getRateLimitStatus,
    isAgentRateLimited,
    sessionRecord,
  };
}

function createApp(services: Services) {
  return createSessionRoutes(
    services,
    () => {} // notifyClientsOfNewSession
  );
}

/**
 * A limited account key as tracked by the (mocked) rate limit tracker.
 */
interface MockLimit {
  executable: string;
  resetsAt: string;
}

/**
 * Wires the mocks for an agent-scoped partial-limit scenario: the daemon
 * reports `limits` (with `isPaused: false` — a partial limit does not pause
 * dispatch) and `isAgentRateLimited` judges the agent it is actually given,
 * mirroring the real daemon's rule: the agent's effective executable is its
 * explicit `executablePath`, falling back to the provider default `claude`.
 *
 * Because the route passes the *fetched* agent entity to
 * `isAgentRateLimited`, deriving the verdict from that argument verifies
 * the wiring — a route that passed the wrong object fails these tests.
 */
function givenAgentWithAccount(
  mocks: ReturnType<typeof createMockServices>,
  options: {
    /** The agent's explicit executable; omit for the default `claude` account. */
    executablePath?: string;
    limits: MockLimit[];
    /** Global soonest reset across `limits` (the tracker reports it separately). */
    soonestReset?: string;
  }
): void {
  const agent = createMockWorkerAgent();
  if (options.executablePath) {
    agent.metadata.agent.executablePath = options.executablePath;
  }
  mocks.agentRegistry.getAgent.mockResolvedValue(agent);

  mocks.getRateLimitStatus.mockResolvedValue({
    isPaused: false,
    limits: options.limits,
    soonestReset: options.soonestReset,
    manualSleepUntil: undefined,
  });
  mocks.isAgentRateLimited.mockImplementation(
    (passed: { metadata?: { agent?: { executablePath?: string } } }) => {
      const effective = passed?.metadata?.agent?.executablePath ?? 'claude';
      const limit = options.limits.find((entry) => entry.executable === effective);
      return limit ? { accountKey: limit.executable, resetsAt: limit.resetsAt } : undefined;
    }
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/agents/:id/start — rate limit refusal', () => {
  let mocks: ReturnType<typeof createMockServices>;

  beforeEach(() => {
    mocks = createMockServices();
  });

  it('returns 429 RATE_LIMITED and does not spawn when the agent account is limited', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mocks.isAgentRateLimited.mockReturnValue({
      accountKey: 'claude-glm',
      resetsAt,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPrompt: 'begin' }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as {
      error: { code: string; message: string; accountKey: string; resetsAt: string; retryAfter: number };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.accountKey).toBe('claude-glm');
    expect(body.error.resetsAt).toBe(resetsAt);
    expect(body.error.message).toContain('rate-limited');
    expect(body.error.message).toContain('was NOT started');
    expect(body.error.message).toContain('sf daemon wake');
    expect(body.error.retryAfter).toBeGreaterThan(0);
    // The spawn must not have happened — no phantom session.
    expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('returns 429 when dispatch is paused by manual sleep', async () => {
    const sleepUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [],
      soonestReset: undefined,
      manualSleepUntil: sleepUntil,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPrompt: 'begin' }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toContain('manual sleep');
    expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('returns 429 when all worker accounts are limited', async () => {
    const soonest = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [{ executable: 'claude', resetsAt: soonest }],
      soonestReset: soonest,
      manualSleepUntil: undefined,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPrompt: 'begin' }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toContain('All worker accounts');
    expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('derives Retry-After from soonestReset and echoes it in the error body (all accounts limited)', async () => {
    // Ported from apps/smithy-server/src/routes/sessions.rate-limit.test.ts:
    // the header and error.retryAfter must both follow soonestReset, and the
    // body echoes the timestamp so clients can schedule precisely.
    const soonestReset = new Date(Date.now() + 45_000).toISOString();
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [{ executable: 'claude', resetsAt: soonestReset }],
      soonestReset,
      manualSleepUntil: undefined,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(45);

    const body = (await res.json()) as {
      error: { code: string; retryAfter: number; soonestReset: string };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.soonestReset).toBe(soonestReset);
    expect(body.error.retryAfter).toBe(retryAfter);
  });

  it('returns the default Retry-After of 60 seconds when no reset time is known', async () => {
    // Ported from apps/smithy-server/src/routes/sessions.rate-limit.test.ts:
    // a pause without any known reset (soonestReset undefined) must still
    // advise a bounded wait instead of omitting the header.
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [],
      soonestReset: undefined,
      manualSleepUntil: undefined,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = (await res.json()) as { error: { retryAfter: number } };
    expect(body.error.retryAfter).toBe(60);
  });

  it('derives Retry-After from the manual sleep deadline', async () => {
    // Ported from apps/smithy-server/src/routes/sessions.rate-limit.test.ts.
    const sleepUntil = new Date(Date.now() + 120_000).toISOString();
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [],
      soonestReset: undefined,
      manualSleepUntil: sleepUntil,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(120);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('manual sleep');
  });

  it('keeps Retry-After at the sleep deadline even when account limits reset sooner', async () => {
    // Ported from apps/smithy-server/src/routes/sessions.rate-limit.test.ts:
    // real limits may reset sooner than the operator's pause, but the pause
    // holds — Retry-After must not promise an early resume.
    const soonestReset = new Date(Date.now() + 30_000).toISOString();
    const sleepUntil = new Date(Date.now() + 300_000).toISOString();
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [{ executable: 'claude', resetsAt: soonestReset }],
      soonestReset,
      manualSleepUntil: sleepUntil,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(30); // not the (sooner) limit reset
    expect(retryAfter).toBeLessThanOrEqual(300); // the sleep deadline
  });

  it('spawns normally when the agent account is not rate-limited', async () => {
    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPrompt: 'begin' }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; session: { id: string } };
    expect(body.success).toBe(true);
    expect(body.session.id).toBe('session-123');
    expect(mocks.sessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it('spawns when no dispatch daemon is available (daemon-less server)', async () => {
    (mocks.services as { dispatchDaemon?: unknown }).dispatchDaemon = undefined;

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    expect(mocks.sessionManager.startSession).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/agents/:id/resume — rate limit refusal', () => {
  let mocks: ReturnType<typeof createMockServices>;

  beforeEach(() => {
    mocks = createMockServices();
  });

  it('returns 429 RATE_LIMITED and does not resume when the agent account is limited', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mocks.isAgentRateLimited.mockReturnValue({
      accountKey: 'claude',
      resetsAt,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'provider-session-123' }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; accountKey: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.accountKey).toBe('claude');
    expect(mocks.sessionManager.resumeSession).not.toHaveBeenCalled();
  });

  it('resumes normally when the agent account is not rate-limited', async () => {
    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'provider-session-123' }),
    });

    expect(res.status).toBe(201);
    expect(mocks.sessionManager.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('returns 429 with Retry-After derived from soonestReset when all accounts are limited', async () => {
    // Ported from apps/smithy-server/src/routes/sessions.rate-limit.test.ts:
    // the resume route shares the global-pause refusal, so its Retry-After
    // must follow soonestReset exactly like the start route's.
    const soonestReset = new Date(Date.now() + 45_000).toISOString();
    mocks.getRateLimitStatus.mockResolvedValue({
      isPaused: true,
      limits: [{ executable: 'claude', resetsAt: soonestReset }],
      soonestReset,
      manualSleepUntil: undefined,
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'provider-session-123' }),
    });

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(45);
    const body = (await res.json()) as { error: { code: string; soonestReset: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.soonestReset).toBe(soonestReset);
    expect(mocks.sessionManager.resumeSession).not.toHaveBeenCalled();
  });
});

describe('partial limit — the agent\'s own account decides (agent-scoped)', () => {
  // Ported from apps/smithy-server/src/routes/sessions.rate-limit.test.ts.
  // Since dispatch tiers, `isPaused` is true only when EVERY account is
  // limited. A partial limit must still refuse the agent whose own account
  // is exhausted — otherwise the session spawns and immediately hits the
  // limit — while agents on free accounts keep starting. The mocks derive
  // the verdict from the agent the route passes, so these tests also pin
  // the wiring between the fetched agent and the guard.
  let mocks: ReturnType<typeof createMockServices>;

  beforeEach(() => {
    mocks = createMockServices();
  });

  it('start returns 429 naming the account and ITS reset, not the global soonest reset', async () => {
    const agentReset = new Date(Date.now() + 90_000).toISOString();
    givenAgentWithAccount(mocks, {
      executablePath: 'claude-glm',
      limits: [
        { executable: 'claude', resetsAt: new Date(Date.now() + 30_000).toISOString() },
        { executable: 'claude-glm', resetsAt: agentReset },
      ],
      // Another account resets sooner — the refusal must ignore it.
      soonestReset: new Date(Date.now() + 30_000).toISOString(),
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        retryAfter: number;
        accountKey?: string;
        resetsAt?: string;
        soonestReset?: string;
      };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    // The refusal names the limited account key …
    expect(body.error.accountKey).toBe('claude-glm');
    expect(body.error.message).toContain('claude-glm');
    // … and ITS reset time, not the global soonest reset.
    expect(body.error.resetsAt).toBe(agentReset);
    expect(body.error.message).toContain(agentReset);
    expect(body.error.soonestReset).toBeUndefined();

    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(60); // 90s, not the 30s soonest reset
    expect(retryAfter).toBeLessThanOrEqual(90);
    expect(body.error.retryAfter).toBe(retryAfter);
    expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('start allows an agent whose account is free while another account is limited', async () => {
    givenAgentWithAccount(mocks, {
      executablePath: 'claude-glm',
      limits: [{ executable: 'claude', resetsAt: new Date(Date.now() + 30_000).toISOString() }],
      soonestReset: new Date(Date.now() + 30_000).toISOString(),
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // The `claude` account being limited must not block a `claude-glm` agent.
    expect(res.status).toBe(201);
    expect(mocks.sessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it('start allows a default-account agent when the limit is on an unrelated wrapper', async () => {
    // The mirror of the case above: the agent has no `executablePath`
    // (provider default `claude` account) and only `claude-glm` is limited.
    givenAgentWithAccount(mocks, {
      limits: [{ executable: 'claude-glm', resetsAt: new Date(Date.now() + 30_000).toISOString() }],
      soonestReset: new Date(Date.now() + 30_000).toISOString(),
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    expect(mocks.sessionManager.startSession).toHaveBeenCalledTimes(1);
  });

  it('resume returns 429 naming the account and ITS reset, not the global soonest reset', async () => {
    const agentReset = new Date(Date.now() + 70_000).toISOString();
    givenAgentWithAccount(mocks, {
      executablePath: 'claude-glm',
      limits: [
        { executable: 'claude', resetsAt: new Date(Date.now() + 20_000).toISOString() },
        { executable: 'claude-glm', resetsAt: agentReset },
      ],
      soonestReset: new Date(Date.now() + 20_000).toISOString(),
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'provider-session-123' }),
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error: { code: string; message: string; accountKey?: string; resetsAt?: string };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.accountKey).toBe('claude-glm');
    expect(body.error.resetsAt).toBe(agentReset);
    expect(body.error.message).toContain('claude-glm');

    const retryAfter = Number(res.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(60); // 70s, not the 20s soonest reset
    expect(retryAfter).toBeLessThanOrEqual(70);
    expect(mocks.sessionManager.resumeSession).not.toHaveBeenCalled();
  });

  it('resume allows an agent whose account is free while another account is limited', async () => {
    givenAgentWithAccount(mocks, {
      executablePath: 'claude-glm',
      limits: [{ executable: 'claude', resetsAt: new Date(Date.now() + 30_000).toISOString() }],
      soonestReset: new Date(Date.now() + 30_000).toISOString(),
    });

    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'provider-session-123' }),
    });

    expect(res.status).toBe(201);
    expect(mocks.sessionManager.resumeSession).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Spawn option forwarding and validation (start/resume)
//
// 'sf agent start' routes every non-streaming option through the server
// (task el-3hxa0i). The start route must forward the spawn-shaping body
// fields to sessionManager.startSession and reject invalid ones with 400
// instead of letting them fail mid-spawn or be silently dropped; the resume
// route must explicitly refuse start-only options (a resumed session keeps
// its original shape) rather than ignoring them.
// ============================================================================

describe('start/resume routes — spawn option forwarding and validation', () => {
  const FAKE_PROVIDER = 'vitest-fake-start-provider';

  beforeAll(() => {
    // Register an always-available provider so provider forwarding can be
    // asserted without probing a real executable.
    getProviderRegistry().register({
      name: FAKE_PROVIDER,
      headless: {
        name: `${FAKE_PROVIDER}-headless`,
        spawn: async () => {
          throw new Error('not expected in route tests');
        },
        isAvailable: async () => true,
      },
      interactive: {
        name: `${FAKE_PROVIDER}-interactive`,
        spawn: async () => {
          throw new Error('not expected in route tests');
        },
        isAvailable: async () => true,
      },
      isAvailable: async () => true,
      getInstallInstructions: () => 'not needed',
      listModels: async () => [],
    });
  });

  let mocks: ReturnType<typeof createMockServices>;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks = createMockServices();
  });

  it('forwards spawn-shaping options to sessionManager.startSession', async () => {
    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interactive: true,
        cols: 160,
        rows: 40,
        environmentVariables: { MY_VAR: 'value' },
        provider: FAKE_PROVIDER,
        model: 'fake-vendor/fake-model',
        timeout: 300000,
      }),
    });

    expect(res.status).toBe(201);
    expect(mocks.sessionManager.startSession).toHaveBeenCalledTimes(1);
    expect(mocks.sessionManager.startSession).toHaveBeenCalledWith(
      'agent-001',
      expect.objectContaining({
        interactive: true,
        cols: 160,
        rows: 40,
        environmentVariables: { MY_VAR: 'value' },
        provider: FAKE_PROVIDER,
        model: 'fake-vendor/fake-model',
        timeout: 300000,
      })
    );
  });

  it.each([['abc'], [0], [-1], [null]])(
    'rejects an invalid timeout (%s) with 400 before spawning',
    async (badTimeout) => {
      const app = createApp(mocks.services);
      const res = await app.request('/api/agents/agent-001/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeout: badTimeout }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INVALID_TIMEOUT');
      expect(body.error.message).toContain('positive number');
      expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
    }
  );

  it('rejects an unknown provider with 400 and lists the available providers', async () => {
    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'definitely-not-registered' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_PROVIDER');
    expect(body.error.message).toContain("Provider 'definitely-not-registered' is not registered");
    expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('rejects a malformed model for the effective provider with 400 (no silent provider-default fallback)', async () => {
    const app = createApp(mocks.services);
    const res = await app.request('/api/agents/agent-001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'opencode', model: 'claude-sonnet-4' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_MODEL');
    expect(body.error.message).toContain('claude-sonnet-4');
    expect(mocks.sessionManager.startSession).not.toHaveBeenCalled();
  });

  it('resume forwards its options and explicitly refuses start-only options', async () => {
    const app = createApp(mocks.services);

    // Happy path: only resume-supported fields.
    const ok = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerSessionId: 'provider-session-123',
        workingDirectory: '/tmp/work',
        resumePrompt: 'continue',
      }),
    });
    expect(ok.status).toBe(201);
    expect(mocks.sessionManager.resumeSession).toHaveBeenCalledWith(
      'agent-001',
      expect.objectContaining({
        providerSessionId: 'provider-session-123',
        workingDirectory: '/tmp/work',
        resumePrompt: 'continue',
      })
    );

    // Start-only options are refused by name, not silently dropped.
    const refused = await app.request('/api/agents/agent-001/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerSessionId: 'provider-session-123', model: 'some-model' }),
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNSUPPORTED_FOR_RESUME');
    expect(body.error.message).toContain('model');
    // Only the successful resume above ran.
    expect(mocks.sessionManager.resumeSession).toHaveBeenCalledTimes(1);
  });
});
