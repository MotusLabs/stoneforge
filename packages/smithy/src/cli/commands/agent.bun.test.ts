/**
 * Agent Command Tests
 *
 * Tests for orchestrator CLI agent commands structure and validation.
 */

import { describe, it, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, initializeSchema } from '@stoneforge/quarry';
import { createOrchestratorAPI } from '../../api/index.js';
import { isAgentDisabled } from '../../services/agent-registry.js';
import type { EntityId } from '@stoneforge/core';
import type { AgentMetadata } from '../../types/index.js';
import {
  agentCommand,
  agentListCommand,
  agentShowCommand,
  agentRegisterCommand,
  agentStartCommand,
  agentStopCommand,
  agentStreamCommand,
  agentDisableCommand,
  agentEnableCommand,
  agentSetTierCommand,
} from './agent.js';

describe('Agent Command Structure', () => {
  describe('agentCommand (parent)', () => {
    it('should have correct name and description', () => {
      expect(agentCommand.name).toBe('agent');
      expect(agentCommand.description).toBe('Manage orchestrator agents');
    });

    it('should have all subcommands', () => {
      expect(agentCommand.subcommands).toBeDefined();
      expect(agentCommand.subcommands!.list).toBe(agentListCommand);
      expect(agentCommand.subcommands!.show).toBe(agentShowCommand);
      expect(agentCommand.subcommands!.register).toBe(agentRegisterCommand);
      expect(agentCommand.subcommands!.start).toBe(agentStartCommand);
      expect(agentCommand.subcommands!.stop).toBe(agentStopCommand);
      expect(agentCommand.subcommands!.stream).toBe(agentStreamCommand);
      expect(agentCommand.subcommands!.disable).toBe(agentDisableCommand);
      expect(agentCommand.subcommands!.enable).toBe(agentEnableCommand);
      expect(agentCommand.subcommands!['set-tier']).toBe(agentSetTierCommand);
    });

    it('should default to list handler', () => {
      expect(agentCommand.handler).toBe(agentListCommand.handler);
    });
  });

  describe('agentListCommand', () => {
    it('should have correct structure', () => {
      expect(agentListCommand.name).toBe('list');
      expect(agentListCommand.description).toBe('List registered agents');
      expect(agentListCommand.usage).toBe('sf agent list [options]');
      expect(typeof agentListCommand.handler).toBe('function');
    });

    it('should have all filter options', () => {
      expect(agentListCommand.options).toBeDefined();
      expect(agentListCommand.options!.length).toBe(6);
      expect(agentListCommand.options![0].name).toBe('role');
      expect(agentListCommand.options![1].name).toBe('status');
      expect(agentListCommand.options![2].name).toBe('workerMode');
      expect(agentListCommand.options![3].name).toBe('focus');
      expect(agentListCommand.options![4].name).toBe('reportsTo');
      expect(agentListCommand.options![5].name).toBe('hasSession');
    });
  });

  describe('agentShowCommand', () => {
    it('should have correct structure', () => {
      expect(agentShowCommand.name).toBe('show');
      expect(agentShowCommand.description).toBe('Show agent details');
      expect(agentShowCommand.usage).toBe('sf agent show <id>');
      expect(typeof agentShowCommand.handler).toBe('function');
    });
  });

  describe('agentRegisterCommand', () => {
    it('should have correct structure', () => {
      expect(agentRegisterCommand.name).toBe('register');
      expect(agentRegisterCommand.description).toBe('Register a new agent');
      expect(agentRegisterCommand.usage).toBe('sf agent register <name> --role <role> [options]');
      expect(typeof agentRegisterCommand.handler).toBe('function');
    });

    it('should have all registration options', () => {
      expect(agentRegisterCommand.options).toBeDefined();
      expect(agentRegisterCommand.options!.length).toBe(12);

      // Required role option
      const roleOption = agentRegisterCommand.options![0];
      expect(roleOption.name).toBe('role');
      expect(roleOption.required).toBe(true);

      // Mode option for workers
      const modeOption = agentRegisterCommand.options![1];
      expect(modeOption.name).toBe('mode');
      expect(modeOption.hasValue).toBe(true);

      // Focus option for stewards
      const focusOption = agentRegisterCommand.options![2];
      expect(focusOption.name).toBe('focus');
      expect(focusOption.hasValue).toBe(true);

      // MaxTasks option
      const maxTasksOption = agentRegisterCommand.options![3];
      expect(maxTasksOption.name).toBe('maxTasks');
      expect(maxTasksOption.hasValue).toBe(true);

      // Tags option
      const tagsOption = agentRegisterCommand.options![4];
      expect(tagsOption.name).toBe('tags');
      expect(tagsOption.hasValue).toBe(true);

      // ReportsTo option
      const reportsToOption = agentRegisterCommand.options![5];
      expect(reportsToOption.name).toBe('reportsTo');
      expect(reportsToOption.hasValue).toBe(true);

      // RoleDef option
      const roleDefOption = agentRegisterCommand.options![6];
      expect(roleDefOption.name).toBe('roleDef');
      expect(roleDefOption.hasValue).toBe(true);

      // Trigger option
      const triggerOption = agentRegisterCommand.options![7];
      expect(triggerOption.name).toBe('trigger');
      expect(triggerOption.hasValue).toBe(true);

      // Provider option
      const providerOption = agentRegisterCommand.options![8];
      expect(providerOption.name).toBe('provider');
      expect(providerOption.hasValue).toBe(true);

      // Model option
      const modelOption = agentRegisterCommand.options![9];
      expect(modelOption.name).toBe('model');
      expect(modelOption.hasValue).toBe(true);

      // Target branch option
      const targetBranchOption = agentRegisterCommand.options![10];
      expect(targetBranchOption.name).toBe('targetBranch');
      expect(targetBranchOption.hasValue).toBe(true);

      // Dispatch tier option
      const tierOption = agentRegisterCommand.options![11];
      expect(tierOption.name).toBe('tier');
      expect(tierOption.hasValue).toBe(true);
    });

    it('should have --tier option with correct properties', () => {
      const tierOption = agentRegisterCommand.options!.find(opt => opt.name === 'tier');
      expect(tierOption).toBeDefined();
      expect(tierOption!.hasValue).toBe(true);
      expect(tierOption!.description).toContain('Dispatch tier');
    });

    it('should accept --tier flag via parser', async () => {
      const { parseArgs } = await import('@stoneforge/quarry/cli');
      const result = parseArgs(
        ['agent', 'register', 'CheapWorker', '--role', 'worker', '--tier', '2'],
        agentRegisterCommand.options!,
        { strict: false }
      );
      expect(result.commandOptions.tier).toBe('2');
    });

    it('should have --model option with correct properties', () => {
      const modelOption = agentRegisterCommand.options!.find(opt => opt.name === 'model');
      expect(modelOption).toBeDefined();
      expect(modelOption!.hasValue).toBe(true);
      expect(modelOption!.description).toContain('LLM model');
    });

    it('should have --target-branch option with correct properties', () => {
      const targetBranchOption = agentRegisterCommand.options!.find(opt => opt.name === 'targetBranch');
      expect(targetBranchOption).toBeDefined();
      expect(targetBranchOption!.hasValue).toBe(true);
      expect(targetBranchOption!.description).toContain('Target branch');
    });

    it('should accept --target-branch flag via parser', async () => {
      const { parseArgs } = await import('@stoneforge/quarry/cli');
      const result = parseArgs(
        ['agent', 'register', 'TestDir', '--role', 'director', '--target-branch', 'staging'],
        agentRegisterCommand.options!,
        { strict: false }
      );
      expect(result.commandOptions.targetBranch).toBe('staging');
    });
  });

  describe('agentStartCommand', () => {
    it('should have correct structure', () => {
      expect(agentStartCommand.name).toBe('start');
      expect(agentStartCommand.description).toBe('Start an agent process');
      expect(agentStartCommand.usage).toBe('sf agent start <id> [options]');
      expect(typeof agentStartCommand.handler).toBe('function');
    });

    it('should have all start options', () => {
      expect(agentStartCommand.options).toBeDefined();
      expect(agentStartCommand.options!.length).toBe(12);
      expect(agentStartCommand.options![0].name).toBe('prompt');
      expect(agentStartCommand.options![1].name).toBe('mode');
      expect(agentStartCommand.options![2].name).toBe('resume');
      expect(agentStartCommand.options![3].name).toBe('workdir');
      expect(agentStartCommand.options![4].name).toBe('cols');
      expect(agentStartCommand.options![5].name).toBe('rows');
      expect(agentStartCommand.options![6].name).toBe('timeout');
      expect(agentStartCommand.options![7].name).toBe('env');
      expect(agentStartCommand.options![8].name).toBe('taskId');
      expect(agentStartCommand.options![9].name).toBe('stream');
      expect(agentStartCommand.options![10].name).toBe('provider');
      expect(agentStartCommand.options![11].name).toBe('model');
    });

    it('should have --model option with correct properties', () => {
      const modelOption = agentStartCommand.options!.find(opt => opt.name === 'model');
      expect(modelOption).toBeDefined();
      expect(modelOption!.hasValue).toBe(true);
      expect(modelOption!.description).toContain('model');
    });
  });

  describe('agentStopCommand', () => {
    it('should have correct structure', () => {
      expect(agentStopCommand.name).toBe('stop');
      expect(agentStopCommand.description).toBe('Stop an agent session');
      expect(agentStopCommand.usage).toBe('sf agent stop <id> [options]');
      expect(typeof agentStopCommand.handler).toBe('function');
    });

    it('should have all stop options', () => {
      expect(agentStopCommand.options).toBeDefined();
      expect(agentStopCommand.options!.length).toBe(3);
      expect(agentStopCommand.options![0].name).toBe('graceful');
      expect(agentStopCommand.options![1].name).toBe('no-graceful');
      expect(agentStopCommand.options![2].name).toBe('reason');
      expect(agentStopCommand.options![2].hasValue).toBe(true);
    });
  });

  describe('agentStreamCommand', () => {
    it('should have correct structure', () => {
      expect(agentStreamCommand.name).toBe('stream');
      expect(agentStreamCommand.description).toBe('Get agent channel for streaming');
      expect(agentStreamCommand.usage).toBe('sf agent stream <id>');
      expect(typeof agentStreamCommand.handler).toBe('function');
    });
  });

  describe('agentDisableCommand', () => {
    it('should have correct structure', () => {
      expect(agentDisableCommand.name).toBe('disable');
      expect(agentDisableCommand.description).toBe('Disable an agent (skipped by dispatch and scheduler, kept in the list)');
      expect(agentDisableCommand.usage).toBe('sf agent disable <id>');
      expect(typeof agentDisableCommand.handler).toBe('function');
    });
  });

  describe('agentEnableCommand', () => {
    it('should have correct structure', () => {
      expect(agentEnableCommand.name).toBe('enable');
      expect(agentEnableCommand.description).toBe('Enable a previously disabled agent');
      expect(agentEnableCommand.usage).toBe('sf agent enable <id>');
      expect(typeof agentEnableCommand.handler).toBe('function');
    });
  });

  describe('agentSetTierCommand', () => {
    it('should have correct structure', () => {
      expect(agentSetTierCommand.name).toBe('set-tier');
      expect(agentSetTierCommand.description).toBe('Set or clear a worker dispatch tier (1 = most preferred)');
      expect(agentSetTierCommand.usage).toBe('sf agent set-tier <id> <n|none>');
      expect(typeof agentSetTierCommand.handler).toBe('function');
    });
  });
});

describe('Agent Command Validation', () => {
  describe('agentShowCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentShowCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });
  });

  describe('agentRegisterCommand', () => {
    it('should fail without name argument', async () => {
      const result = await agentRegisterCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });

    it('should fail without role option', async () => {
      const result = await agentRegisterCommand.handler(['TestAgent'], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('--role');
    });

    it('should fail with invalid role', async () => {
      const result = await agentRegisterCommand.handler(['TestAgent'], { role: 'invalid' });
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Invalid role');
    });

    it('should reject --tier on a non-worker role', async () => {
      const result = await agentRegisterCommand.handler(['TestAgent'], { role: 'director', tier: '1' });
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('--tier can only be set on worker agents');
    });
  });

  describe('agentStartCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentStartCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });
  });

  describe('agentStopCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentStopCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });
  });

  describe('agentStreamCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentStreamCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });
  });

  describe('agentDisableCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentDisableCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });
  });

  describe('agentEnableCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentEnableCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });
  });

  describe('agentSetTierCommand', () => {
    it('should fail without id argument', async () => {
      const result = await agentSetTierCommand.handler([], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });

    it('should fail without tier argument', async () => {
      const result = await agentSetTierCommand.handler(['el-abc123'], {});
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Usage');
    });

    it.each([['0'], ['-1'], ['1.5'], ['abc'], ['0x2'], [' ']])(
      'should reject invalid tier "%s" before touching the agent',
      async (tierArg) => {
        const result = await agentSetTierCommand.handler(['el-abc123', tierArg], {});
        expect(result.exitCode).not.toBe(0);
        expect(result.error).toContain('Invalid tier');
        expect(result.error).toContain('positive integer');
      }
    );
  });
});

// ============================================================================
// Behavioural round-trip tests for agent disable / enable
//
// The CLI handlers call createOrchestratorClient(), which runs
// findStoneforgeDir(process.cwd()) before honouring options.db. Invoking the
// handler literally in a test environment (no .stoneforge dir on disk) would
// always hit the "Run sf init first" early-return path, so these tests verify
// the mutation behaviour by calling the SAME api methods the handlers call,
// using an in-memory SQLite backend. The handler bodies are intentionally
// thin wrappers around api.updateAgentMetadata, so this approach gives full
// coverage of the observable effect without duplicating handler logic.
// ============================================================================

describe('agent disable / enable behavioural', () => {
  // Reuse the OPERATOR_ENTITY_ID constant ('el-0000') as the creator.
  // It is a valid EntityId string - no DB row is needed for it since
  // registerWorker only stores the value, it does not foreign-key-check it.
  const CREATOR = 'el-0000' as EntityId;

  let api: ReturnType<typeof createOrchestratorAPI>;
  let agentId: EntityId;

  beforeEach(async () => {
    const backend = createStorage({ path: ':memory:' });
    initializeSchema(backend);
    api = createOrchestratorAPI(backend);

    const registered = await api.registerWorker({
      name: 'test-worker',
      workerMode: 'ephemeral',
      createdBy: CREATOR,
    });
    agentId = registered.id as unknown as EntityId;
  });

  test('disable round-trip: updateAgentMetadata sets disabled to true', async () => {
    // This mirrors exactly what agentDisableHandler does after resolving the API.
    await api.updateAgentMetadata(agentId, { disabled: true } as Partial<AgentMetadata>);

    const agent = await api.getAgent(agentId);
    expect(agent).toBeDefined();
    expect((agent!.metadata.agent as { disabled?: boolean }).disabled).toBe(true);
    expect(isAgentDisabled(agent!)).toBe(true);
  });

  test('enable round-trip: updateAgentMetadata removes disabled key from serialised JSON', async () => {
    // First disable the agent, then re-enable it - same sequence as the two
    // handlers called back-to-back.
    await api.updateAgentMetadata(agentId, { disabled: true } as Partial<AgentMetadata>);
    // Sanity-check that it is actually disabled before we enable it.
    const disabledAgent = await api.getAgent(agentId);
    expect(isAgentDisabled(disabledAgent!)).toBe(true);

    // This mirrors exactly what agentEnableHandler does after resolving the API.
    await api.updateAgentMetadata(agentId, { disabled: undefined } as Partial<AgentMetadata>);

    const agent = await api.getAgent(agentId);
    expect(agent).toBeDefined();

    // isAgentDisabled must return false after the enable call.
    expect(isAgentDisabled(agent!)).toBe(false);

    // JSON.stringify drops undefined values, so the serialised agent metadata
    // must contain no "disabled" key - this is the contract that
    // absent-means-enabled relies on.
    expect(JSON.stringify(agent!.metadata!.agent).includes('"disabled"')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // agentListHandler annotation test
  //
  // chdir into a tmpdir with a real .stoneforge/stoneforge.db so that
  // createOrchestratorClient can resolve the DB and the handler runs end-to-end.
  // -------------------------------------------------------------------------
  test('list output marks disabled agents', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sf-disable-list-'));
    try {
      mkdirSync(join(tmpRoot, '.stoneforge'), { recursive: true });
      const dbPath = join(tmpRoot, '.stoneforge', 'stoneforge.db');
      const tmpBackend = createStorage({ path: dbPath, create: true });
      initializeSchema(tmpBackend);
      const tmpApi = createOrchestratorAPI(tmpBackend);

      await tmpApi.registerWorker({
        name: 'enabled-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      const disabledRegistered = await tmpApi.registerWorker({
        name: 'disabled-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      await tmpApi.updateAgentMetadata(
        disabledRegistered.id as unknown as EntityId,
        { disabled: true } as Partial<AgentMetadata>
      );

      const cwdBefore = process.cwd();
      process.chdir(tmpRoot);
      try {
        const result = await agentListCommand.handler!([], { db: dbPath } as never);
        expect(result.exitCode).toBe(0);
        const out = String(result.message ?? '');
        // Disabled agent should have (disabled) in its row
        const disabledLine = out.split('\n').find(l => l.includes('disabled-w'));
        expect(disabledLine).toBeTruthy();
        expect(disabledLine).toContain('(disabled)');
        // Enabled agent must NOT have the marker
        const enabledLine = out.split('\n').find(l => l.includes('enabled-w'));
        expect(enabledLine).toBeTruthy();
        expect(enabledLine).not.toContain('(disabled)');
      } finally {
        process.chdir(cwdBefore);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // agentStartHandler refusal test
  //
  // createOrchestratorClient calls findStoneforgeDir(process.cwd()), so we
  // chdir into a tmpdir that has a .stoneforge subdir containing a real SQLite
  // DB. This lets us exercise the actual handler code path (including the
  // isAgentDisabled guard) without spawning a process.
  // -------------------------------------------------------------------------
  test('start refuses on a disabled agent', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sf-disable-test-'));
    const cwdBefore = process.cwd();
    try {
      mkdirSync(join(tmpRoot, '.stoneforge'), { recursive: true });
      const dbPath = join(tmpRoot, '.stoneforge', 'stoneforge.db');
      const tmpBackend = createStorage({ path: dbPath, create: true });
      initializeSchema(tmpBackend);
      const tmpApi = createOrchestratorAPI(tmpBackend);
      const registered = await tmpApi.registerWorker({
        name: 'disabled-worker',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      // Disable the agent via the API (same as agentDisableHandler would do).
      await tmpApi.updateAgentMetadata(registered.id as unknown as EntityId, { disabled: true } as Partial<AgentMetadata>);

      process.chdir(tmpRoot);
      try {
        const result = await agentStartCommand.handler!(
          [registered.id as unknown as string],
          { db: dbPath } as never
        );
        expect(result.exitCode).not.toBe(0);
        const errMsg = String(result.error ?? '');
        expect(errMsg.toLowerCase()).toContain('disabled');
        expect(errMsg).toContain('sf agent enable');
      } finally {
        process.chdir(cwdBefore);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Behavioural round-trip tests for worker dispatch tiers
//
// Same tmpdir + chdir approach as above: the handlers resolve the workspace DB
// through findStoneforgeDir(process.cwd()), so we give them a throwaway
// .stoneforge/stoneforge.db and run the real handler code end-to-end.
// ============================================================================

describe('agent tier behavioural', () => {
  const CREATOR = 'el-0000' as EntityId;

  /** Creates a tmp workspace with a .stoneforge/stoneforge.db and returns it. */
  async function makeWorkspace(prefix: string) {
    const tmpRoot = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(tmpRoot, '.stoneforge'), { recursive: true });
    const dbPath = join(tmpRoot, '.stoneforge', 'stoneforge.db');
    const backend = createStorage({ path: dbPath, create: true });
    initializeSchema(backend);
    return { tmpRoot, dbPath, api: createOrchestratorAPI(backend) };
  }

  /** Reads the agent metadata through the API the handlers write to. */
  async function readMeta(api: ReturnType<typeof createOrchestratorAPI>, agentId: string) {
    const agent = await api.getAgent(agentId as EntityId);
    expect(agent).toBeDefined();
    return (agent!.metadata.agent ?? {}) as { tier?: number };
  }

  test('register --tier stores the tier on the worker', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-tier-register-');
    const cwdBefore = process.cwd();
    try {
      process.chdir(tmpRoot);
      const result = await agentRegisterCommand.handler!(
        ['CheapWorker', '--role', 'worker'],
        { db: dbPath, role: 'worker', tier: '2' } as never
      );
      expect(result.exitCode).toBe(0);

      const agents = await api.listAgents();
      expect(agents).toHaveLength(1);
      const meta = await readMeta(api, agents[0].id);
      expect(meta.tier).toBe(2);
      // The tier must round-trip through serialised JSON (not just in memory).
      expect(JSON.stringify(meta)).toContain('"tier":2');
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('register without --tier leaves the worker untiered', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-tier-untiered-');
    const cwdBefore = process.cwd();
    try {
      process.chdir(tmpRoot);
      const result = await agentRegisterCommand.handler!(
        ['PlainWorker', '--role', 'worker'],
        { db: dbPath, role: 'worker' } as never
      );
      expect(result.exitCode).toBe(0);

      const agents = await api.listAgents();
      const meta = await readMeta(api, agents[0].id);
      expect(meta.tier).toBeUndefined();
      expect(JSON.stringify(meta)).not.toContain('"tier"');
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test.each([['0'], ['-1'], ['2.5'], ['abc']])(
    'register with invalid tier %s fails and registers nothing',
    async (badTier) => {
      const { tmpRoot, dbPath, api } = await makeWorkspace('sf-tier-invalid-reg-');
      const cwdBefore = process.cwd();
      try {
        process.chdir(tmpRoot);
        const result = await agentRegisterCommand.handler!(
          ['BadWorker', '--role', 'worker'],
          { db: dbPath, role: 'worker', tier: badTier } as never
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.error).toContain('Invalid tier');
        // The agent must not have been created.
        expect(await api.listAgents()).toHaveLength(0);
      } finally {
        process.chdir(cwdBefore);
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  );

  test('set-tier sets, clears and rejects invalid values without changing the agent', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-tier-set-');
    const cwdBefore = process.cwd();
    try {
      const registered = await api.registerWorker({
        name: 'tiered-worker',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      const agentId = registered.id as unknown as string;

      process.chdir(tmpRoot);

      // Set
      const setResult = await agentSetTierCommand.handler!([agentId, '3'], { db: dbPath } as never);
      expect(setResult.exitCode).toBe(0);
      expect(await readMeta(api, agentId)).toMatchObject({ tier: 3 });

      // Invalid: agent unchanged
      const badResult = await agentSetTierCommand.handler!([agentId, '0'], { db: dbPath } as never);
      expect(badResult.exitCode).not.toBe(0);
      expect(badResult.error).toContain('Invalid tier');
      expect(await readMeta(api, agentId)).toMatchObject({ tier: 3 });

      // Clear with "none"
      const clearResult = await agentSetTierCommand.handler!([agentId, 'none'], { db: dbPath } as never);
      expect(clearResult.exitCode).toBe(0);
      const cleared = await readMeta(api, agentId);
      expect(cleared.tier).toBeUndefined();
      // JSON.stringify drops undefined, so the key is gone from persisted metadata.
      expect(JSON.stringify(cleared)).not.toContain('"tier"');

      // Re-set after clearing still works
      const resetResult = await agentSetTierCommand.handler!([agentId, '1'], { db: dbPath } as never);
      expect(resetResult.exitCode).toBe(0);
      expect(await readMeta(api, agentId)).toMatchObject({ tier: 1 });
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('set-tier refuses a non-worker agent', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-tier-nonworker-');
    const cwdBefore = process.cwd();
    try {
      const director = await api.registerDirector({ name: 'the-director', createdBy: CREATOR });
      process.chdir(tmpRoot);

      const result = await agentSetTierCommand.handler!(
        [director.id as unknown as string, '1'],
        { db: dbPath } as never
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('not a worker');
      const meta = (await api.getAgent(director.id))!.metadata.agent;
      expect(JSON.stringify(meta)).not.toContain('"tier"');
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('set-tier reports a missing agent', async () => {
    const { tmpRoot, dbPath } = await makeWorkspace('sf-tier-missing-');
    const cwdBefore = process.cwd();
    try {
      process.chdir(tmpRoot);
      const result = await agentSetTierCommand.handler!(['el-missing', '1'], { db: dbPath } as never);
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain('Agent not found');
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('list output has a TIER column showing the tier and "-" when unset', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-tier-list-');
    const cwdBefore = process.cwd();
    try {
      const tiered = await api.registerWorker({
        name: 'tiered-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
        tier: 1,
      });
      await api.registerWorker({ name: 'untiered-w', workerMode: 'ephemeral', createdBy: CREATOR });

      process.chdir(tmpRoot);
      const result = await agentListCommand.handler!([], { db: dbPath } as never);
      expect(result.exitCode).toBe(0);
      const out = String(result.message ?? '');

      // Header row carries the new column.
      expect(out).toContain('TIER');

      const headerLine = out.split('\n')[0] ?? '';
      const roleIndex = headerLine.indexOf('ROLE');
      const tierIndex = headerLine.indexOf('TIER');
      const statusIndex = headerLine.indexOf('STATUS');
      expect(roleIndex).toBeGreaterThanOrEqual(0);
      expect(tierIndex).toBeGreaterThan(roleIndex);
      expect(statusIndex).toBeGreaterThan(tierIndex);

      const tieredLine = out.split('\n').find(l => /\btiered-w\b/.test(l));
      const untieredLine = out.split('\n').find(l => /\buntiered-w\b/.test(l));
      expect(tieredLine).toBeTruthy();
      expect(untieredLine).toBeTruthy();
      // The tier renders as a standalone cell, not as part of the ID or name.
      expect(tieredLine!).toMatch(/(^|\s)1(\s|$)/);
      expect(tieredLine!).toContain(tiered.id);
      expect(untieredLine!).toMatch(/(^|\s)-(\s|$)/);
      expect(untieredLine!).not.toMatch(/(^|\s)1(\s|$)/);
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
