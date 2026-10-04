/**
 * Agent Routes Tests — PATCH /api/agents/:id disabled handling
 *
 * Covers the disabled-flag plumbing on the PATCH route:
 * - boolean validation (400 on non-boolean)
 * - metadata write through agentRegistry.updateAgentMetadata
 * - live scheduler reconciliation for stewards (register on enable, unregister on disable)
 * - non-steward agents do NOT touch the scheduler
 * - scheduler errors are warning-swallowed and do not fail the request
 *
 * Also covers the worker dispatch tier on POST/PATCH:
 * - set / clear (null) / invalid (400) on the PATCH route
 * - accepted and returned in payloads
 * - rejected for non-worker agents
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElementId } from '@stoneforge/core';
import type { Services } from '../services.js';
import { createAgentRoutes } from './agents.js';

// ============================================================================
// Test Fixtures
// ============================================================================

interface MinimalAgent {
  id: ElementId;
  name: string;
  metadata: { agent: { agentRole: 'director' | 'worker' | 'steward'; sessionStatus?: string; workerMode?: string; stewardFocus?: string; disabled?: boolean; tier?: number } };
}

function createMockAgent(role: 'director' | 'worker' | 'steward', overrides: Partial<MinimalAgent> = {}): MinimalAgent {
  const baseMeta: MinimalAgent['metadata']['agent'] = {
    agentRole: role,
    sessionStatus: 'idle',
    ...(role === 'worker' ? { workerMode: 'ephemeral' as const } : {}),
    ...(role === 'steward' ? { stewardFocus: 'merge' as const } : {}),
  };
  return {
    id: 'agent-001' as ElementId,
    name: `Test-${role}`,
    metadata: { agent: baseMeta },
    ...overrides,
  };
}

// ============================================================================
// Mock Services Factory
// ============================================================================

function createMockServices() {
  const agentRegistry = {
    getAgent: vi.fn(),
    listAgents: vi.fn(),
    getAgentsByRole: vi.fn(),
    registerWorker: vi.fn(),
    updateAgent: vi.fn(),
    updateAgentMetadata: vi.fn(),
  };

  const stewardScheduler = {
    isRunning: vi.fn().mockReturnValue(true),
    registerSteward: vi.fn().mockResolvedValue(true),
    unregisterSteward: vi.fn().mockResolvedValue(true),
    refreshSteward: vi.fn().mockResolvedValue(undefined),
  };

  const sessionManager = {
    getActiveSession: vi.fn(),
  };

  const services = {
    agentRegistry,
    sessionManager,
    taskAssignmentService: {},
    stewardScheduler,
  } as unknown as Services;

  return { services, agentRegistry, stewardScheduler };
}

// ============================================================================
// Tests
// ============================================================================

describe('PATCH /api/agents/:id — disabled flag', () => {
  let services: Services;
  let agentRegistry: ReturnType<typeof createMockServices>['agentRegistry'];
  let stewardScheduler: ReturnType<typeof createMockServices>['stewardScheduler'];

  beforeEach(() => {
    const mocks = createMockServices();
    services = mocks.services;
    agentRegistry = mocks.agentRegistry;
    stewardScheduler = mocks.stewardScheduler;
  });

  it('accepts disabled: true and writes through updateAgentMetadata', async () => {
    const agent = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue(agent);
    agentRegistry.updateAgentMetadata.mockResolvedValue(agent);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    expect(res.status).toBe(200);
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', { disabled: true });
  });

  it('accepts disabled: false and writes the absent-means-enabled shape', async () => {
    const agent = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue(agent);
    agentRegistry.updateAgentMetadata.mockResolvedValue(agent);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: false }),
    });

    expect(res.status).toBe(200);
    // false should produce undefined so JSON.stringify drops the key on persist
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', { disabled: undefined });
  });

  it('rejects non-boolean disabled with 400 VALIDATION_ERROR', async () => {
    const agent = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue(agent);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: 'yes' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toMatch(/boolean/i);
    expect(agentRegistry.updateAgentMetadata).not.toHaveBeenCalled();
  });

  it('unregisters a steward from the scheduler when disabling', async () => {
    const steward = createMockAgent('steward');
    agentRegistry.getAgent.mockResolvedValue(steward);
    // After update, the agent's metadata reflects disabled: true and role: steward
    agentRegistry.updateAgentMetadata.mockResolvedValue({
      ...steward,
      metadata: { agent: { ...steward.metadata.agent, disabled: true } },
    });

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    expect(res.status).toBe(200);
    expect(stewardScheduler.unregisterSteward).toHaveBeenCalledWith('agent-001');
    expect(stewardScheduler.registerSteward).not.toHaveBeenCalled();
  });

  it('registers a steward with the scheduler when enabling', async () => {
    const steward = createMockAgent('steward');
    agentRegistry.getAgent.mockResolvedValue(steward);
    agentRegistry.updateAgentMetadata.mockResolvedValue(steward);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: false }),
    });

    expect(res.status).toBe(200);
    expect(stewardScheduler.registerSteward).toHaveBeenCalledWith('agent-001');
    expect(stewardScheduler.unregisterSteward).not.toHaveBeenCalled();
  });

  it('does not touch the scheduler for non-steward agents (worker)', async () => {
    const worker = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue(worker);
    agentRegistry.updateAgentMetadata.mockResolvedValue(worker);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    expect(res.status).toBe(200);
    expect(stewardScheduler.unregisterSteward).not.toHaveBeenCalled();
    expect(stewardScheduler.registerSteward).not.toHaveBeenCalled();
  });

  it('does not touch the scheduler when it is not running', async () => {
    const steward = createMockAgent('steward');
    agentRegistry.getAgent.mockResolvedValue(steward);
    agentRegistry.updateAgentMetadata.mockResolvedValue({
      ...steward,
      metadata: { agent: { ...steward.metadata.agent, disabled: true } },
    });
    stewardScheduler.isRunning.mockReturnValue(false);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    expect(res.status).toBe(200);
    expect(stewardScheduler.unregisterSteward).not.toHaveBeenCalled();
    expect(stewardScheduler.registerSteward).not.toHaveBeenCalled();
  });

  it('swallows scheduler errors and still returns 200', async () => {
    const steward = createMockAgent('steward');
    agentRegistry.getAgent.mockResolvedValue(steward);
    agentRegistry.updateAgentMetadata.mockResolvedValue({
      ...steward,
      metadata: { agent: { ...steward.metadata.agent, disabled: true } },
    });
    stewardScheduler.unregisterSteward.mockRejectedValue(new Error('scheduler kaboom'));

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    expect(res.status).toBe(200);
    // metadata write should still have happened despite the scheduler failure
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', { disabled: true });
  });

  it('returns 404 for an unknown agent', async () => {
    agentRegistry.getAgent.mockResolvedValue(undefined);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
    expect(agentRegistry.updateAgentMetadata).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Worker dispatch tier
// ============================================================================

describe('POST /api/agents — worker dispatch tier', () => {
  let services: Services;
  let agentRegistry: ReturnType<typeof createMockServices>['agentRegistry'];

  beforeEach(() => {
    const mocks = createMockServices();
    services = mocks.services;
    agentRegistry = mocks.agentRegistry;
  });

  it('accepts a valid tier, passes it to registerWorker and returns it in the payload', async () => {
    const created = createMockAgent('worker');
    agentRegistry.registerWorker.mockResolvedValue({
      ...created,
      metadata: { agent: { ...created.metadata.agent, tier: 2 } },
    });

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'worker', name: 'cheap-worker', workerMode: 'ephemeral', tier: 2 }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(agentRegistry.registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cheap-worker', workerMode: 'ephemeral', tier: 2 })
    );
    expect(body.agent?.metadata?.agent?.tier).toBe(2);
  });

  it('defaults to an untiered worker when tier is omitted or null', async () => {
    const created = createMockAgent('worker');
    agentRegistry.registerWorker.mockResolvedValue(created);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'worker', name: 'plain-worker', workerMode: 'ephemeral', tier: null }),
    });

    expect(res.status).toBe(201);
    expect(agentRegistry.registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ tier: undefined })
    );
  });

  it.each([0, -1, 1.5, '2'])
    ('rejects an invalid tier %s with 400 and registers nothing', async (tier) => {
      const app = createAgentRoutes(services);
      const res = await app.request('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'worker', name: 'bad-worker', workerMode: 'ephemeral', tier }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error?.message).toMatch(/positive integer/i);
      expect(agentRegistry.registerWorker).not.toHaveBeenCalled();
    });

  it('rejects a tier on a non-worker role with 400', async () => {
    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'director', name: 'the-director', tier: 1 }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error?.message).toMatch(/worker agents/i);
  });
});

describe('POST /api/agents/worker — dispatch tier', () => {
  let services: Services;
  let agentRegistry: ReturnType<typeof createMockServices>['agentRegistry'];

  beforeEach(() => {
    const mocks = createMockServices();
    services = mocks.services;
    agentRegistry = mocks.agentRegistry;
  });

  it('accepts a valid tier on the dedicated worker endpoint', async () => {
    const created = createMockAgent('worker');
    agentRegistry.registerWorker.mockResolvedValue({
      ...created,
      metadata: { agent: { ...created.metadata.agent, tier: 1 } },
    });

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'preferred-worker', workerMode: 'ephemeral', tier: 1 }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(agentRegistry.registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 1 })
    );
    expect(body.agent?.metadata?.agent?.tier).toBe(1);
  });

  it('rejects an invalid tier with 400', async () => {
    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/worker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad-worker', workerMode: 'ephemeral', tier: 0 }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error?.message).toMatch(/positive integer/i);
    expect(agentRegistry.registerWorker).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/agents/:id — dispatch tier', () => {
  let services: Services;
  let agentRegistry: ReturnType<typeof createMockServices>['agentRegistry'];

  beforeEach(() => {
    const mocks = createMockServices();
    services = mocks.services;
    agentRegistry = mocks.agentRegistry;
  });

  it('accepts a valid tier and writes through updateAgentMetadata', async () => {
    const worker = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue(worker);
    agentRegistry.updateAgentMetadata.mockResolvedValue({
      ...worker,
      metadata: { agent: { ...worker.metadata.agent, tier: 3 } },
    });

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 3 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', { tier: 3 });
    expect(body.agent?.metadata?.agent?.tier).toBe(3);
  });

  it('clears the tier when tier is null', async () => {
    const worker = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue({
      ...worker,
      metadata: { agent: { ...worker.metadata.agent, tier: 2 } },
    });
    agentRegistry.updateAgentMetadata.mockResolvedValue(worker);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: null }),
    });

    expect(res.status).toBe(200);
    // null becomes undefined so JSON.stringify drops the key on persist
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', { tier: undefined });
  });

  it.each([0, -1, 2.5, '2', {}])
    ('rejects an invalid tier %s with 400 VALIDATION_ERROR and leaves the agent unchanged', async (tier) => {
      const worker = createMockAgent('worker');
      agentRegistry.getAgent.mockResolvedValue({
        ...worker,
        metadata: { agent: { ...worker.metadata.agent, tier: 2 } },
      });

      const app = createAgentRoutes(services);
      const res = await app.request('/api/agents/agent-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(body.error?.message).toMatch(/positive integer/i);
      expect(agentRegistry.updateAgentMetadata).not.toHaveBeenCalled();
    });

  it('rejects a tier on a steward with 400', async () => {
    const steward = createMockAgent('steward');
    agentRegistry.getAgent.mockResolvedValue(steward);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 1 }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error?.message).toMatch(/worker agents/i);
    expect(agentRegistry.updateAgentMetadata).not.toHaveBeenCalled();
  });

  it('coexists with other field updates: tier applies after the model update', async () => {
    const worker = createMockAgent('worker');
    agentRegistry.getAgent.mockResolvedValue(worker);
    agentRegistry.updateAgentMetadata.mockResolvedValue(worker);

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', tier: 1 }),
    });

    expect(res.status).toBe(200);
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', {
      model: 'claude-sonnet-4-5-20250929',
    });
    expect(agentRegistry.updateAgentMetadata).toHaveBeenCalledWith('agent-001', { tier: 1 });
  });
});

// ============================================================================
// Model field (ported from apps/smithy-server/src/index.bun.test.ts — the
// legacy duplicate tree removed in task el-5zmnji; these cases were not
// covered elsewhere in the live package)
// ============================================================================

describe('POST /api/agents — model field', () => {
  let services: Services;
  let agentRegistry: ReturnType<typeof createMockServices>['agentRegistry'];

  beforeEach(() => {
    const mocks = createMockServices();
    services = mocks.services;
    agentRegistry = mocks.agentRegistry;
  });

  it('stores model in agent metadata', async () => {
    const created = createMockAgent('worker');
    agentRegistry.registerWorker.mockResolvedValue({
      ...created,
      metadata: { agent: { ...created.metadata.agent, model: 'claude-sonnet-4-5-20250929' } },
    });

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'worker', name: 'model-test-worker', workerMode: 'ephemeral', model: 'claude-sonnet-4-5-20250929' }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(agentRegistry.registerWorker).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'model-test-worker', model: 'claude-sonnet-4-5-20250929' })
    );
    // Model is stored inside metadata.agent.model (following AgentMetadata structure)
    expect(body.agent?.metadata?.agent?.model).toBe('claude-sonnet-4-5-20250929');
  });
});

describe('PATCH /api/agents/:id — model field validation', () => {
  let services: Services;
  let agentRegistry: ReturnType<typeof createMockServices>['agentRegistry'];

  beforeEach(() => {
    const mocks = createMockServices();
    services = mocks.services;
    agentRegistry = mocks.agentRegistry;
  });

  it('rejects an empty model string with 400 VALIDATION_ERROR', async () => {
    agentRegistry.getAgent.mockResolvedValue(createMockAgent('worker'));

    const app = createAgentRoutes(services);
    const res = await app.request('/api/agents/agent-001', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toContain('Model must be a non-empty string');
    expect(agentRegistry.updateAgentMetadata).not.toHaveBeenCalled();
  });
});
