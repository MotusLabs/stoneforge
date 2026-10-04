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
import { ExitCode } from '@stoneforge/quarry/cli';
import { createOrchestratorAPI } from '../../api/index.js';
import { isAgentDisabled } from '../../services/agent-registry.js';
import { getProviderRegistry } from '../../providers/registry.js';
import type {
  AgentProvider,
  AgentMessage,
  HeadlessSession,
  HeadlessSpawnOptions,
} from '../../providers/types.js';
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
  resolveAgentStartOverrides,
  isConnectPhaseFailure,
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
      expect(agentStartCommand.options!.length).toBe(13);
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
      expect(agentStartCommand.options![12].name).toBe('server');
    });

    it('should have --model option with correct properties', () => {
      const modelOption = agentStartCommand.options!.find(opt => opt.name === 'model');
      expect(modelOption).toBeDefined();
      expect(modelOption!.hasValue).toBe(true);
      expect(modelOption!.description!.toLowerCase()).toContain('model');
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

// ============================================================================
// agent start — orchestrator server preference (task el-3hxa0i)
//
// 'sf agent start' must not report a phantom success when a dispatch pause is
// active. When an orchestrator server is reachable, the spawn goes through it
// (server-owned session, explicit refusals); its answers — success OR error —
// are surfaced verbatim. Only a server that was never reached (connect-phase
// failure: refused, DNS, unreachable) falls back to a local spawn. These
// tests stub globalThis.fetch so no real process is spawned.
// ============================================================================

/**
 * Stubs globalThis.fetch to fail in the connect phase (Bun's shape for a
 * refused connection), i.e. "no orchestrator server is running". Returns a
 * restore function. Used to exercise the local-spawn fallback without a
 * server — and to keep tests deterministic on machines where a real
 * orchestrator IS listening on the default port.
 */
function stubServerUnreachable(): () => void {
  const originalFetch = globalThis.fetch;
  const err = new TypeError('Unable to connect. Is the computer able to access the url?') as
    TypeError & { code?: string };
  err.code = 'ConnectionRefused';
  globalThis.fetch = (() => Promise.reject(err)) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Captures fetch calls and answers them with a canned Response. Returns the
 * capture list plus a restore function.
 */
function stubServerResponse(
  respond: (url: string, init: RequestInit | undefined) => Response
): { calls: { url: string; method: string; body: unknown }[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

/** A 429 RATE_LIMITED refusal shaped like the live route's response. */
function rateLimitedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'RATE_LIMITED',
        message:
          "Account 'claude-glm' is currently rate-limited until 2026-10-04T14:00:00.000Z. The session was NOT started. If the limit is stale, clear it with 'sf daemon wake'.",
        accountKey: 'claude-glm',
        resetsAt: '2026-10-04T14:00:00.000Z',
      },
    }),
    { status: 429, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('agent start via orchestrator server', () => {
  const CREATOR = 'el-0000' as EntityId;

  /**
   * Creates a tmp workspace with a real .stoneforge DB and one enabled
   * ephemeral worker, chdirs into it, and returns the cleanup handles.
   */
  async function setupWorkspace(): Promise<{
    agentId: string;
    dbPath: string;
    cleanup: () => void;
  }> {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'sf-agent-start-server-'));
    mkdirSync(join(tmpRoot, '.stoneforge'), { recursive: true });
    const dbPath = join(tmpRoot, '.stoneforge', 'stoneforge.db');
    const backend = createStorage({ path: dbPath, create: true });
    initializeSchema(backend);
    const api = createOrchestratorAPI(backend);
    const registered = await api.registerWorker({
      name: 'server-start-worker',
      workerMode: 'ephemeral',
      createdBy: CREATOR,
    });

    const cwdBefore = process.cwd();
    process.chdir(tmpRoot);
    return {
      agentId: registered.id as unknown as string,
      dbPath,
      cleanup: () => {
        process.chdir(cwdBefore);
        rmSync(tmpRoot, { recursive: true, force: true });
      },
    };
  }

  test('surfaces the server 429 RATE_LIMITED refusal instead of a phantom success', async () => {
    const ws = await setupWorkspace();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'RATE_LIMITED',
            message:
              "Account 'claude-glm' is currently rate-limited until 2026-10-04T14:00:00.000Z. The session was NOT started. If the limit is stale, clear it with 'sf daemon wake'.",
            accountKey: 'claude-glm',
            resetsAt: '2026-10-04T14:00:00.000Z',
          },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
      } as never);

      expect(result.exitCode).not.toBe(0);
      const errMsg = String(result.error ?? '');
      expect(errMsg).toContain('RATE_LIMITED');
      expect(errMsg).toContain('rate-limited');
      expect(errMsg).toContain('NOT started');
    } finally {
      globalThis.fetch = originalFetch;
      ws.cleanup();
    }
  });

  test('reports the server-owned session on success', async () => {
    const ws = await setupWorkspace();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          session: {
            id: 'session-server-1',
            providerSessionId: 'provider-1',
            status: 'running',
            mode: 'headless',
            pid: 1234,
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
      } as never);

      expect(result.exitCode).toBe(0);
      const out = String(result.message ?? '');
      expect(out).toContain('via orchestrator server');
      expect(out).toContain('session-server-1');
      expect(out).toContain('running');
    } finally {
      globalThis.fetch = originalFetch;
      ws.cleanup();
    }
  });

  test('surfaces other explicit server errors (e.g. SESSION_EXISTS) without spawning locally', async () => {
    const ws = await setupWorkspace();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'SESSION_EXISTS', message: 'Agent already has an active session' },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
      } as never);

      expect(result.exitCode).not.toBe(0);
      expect(String(result.error ?? '')).toContain('already has an active session');
    } finally {
      globalThis.fetch = originalFetch;
      ws.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Non-streaming options must route through the supervised server spawn.
  // Regression for the review finding: --mode/--resume/--provider/--model/
  // --env/--timeout/--cols/--rows used to bypass the server and keep the
  // CLI-owned spawn that dies when the CLI exits — never checking the live
  // dispatch pause.
  // -------------------------------------------------------------------------

  test('paused server + --mode headless surfaces the 429 instead of a phantom success', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() => rateLimitedResponse());
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        mode: 'headless',
      } as never);

      // The exact incident shape: an explicit refusal, never "running".
      expect(result.exitCode).not.toBe(0);
      const errMsg = String(result.error ?? '');
      expect(errMsg).toContain('RATE_LIMITED');
      expect(errMsg).toContain('NOT started');
      // The request actually went to the server with the mode mapped to the
      // route's body shape (headless => interactive: false).
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toContain(`/api/agents/${ws.agentId}/start`);
      expect(calls[0]!.body).toMatchObject({ interactive: false });
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('forwards spawn-shaping options (--mode interactive, --cols, --rows, --env, --timeout) in the server request', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() =>
      new Response(
        JSON.stringify({
          success: true,
          session: { id: 'session-shaped-1', status: 'running', mode: 'interactive' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        mode: 'interactive',
        cols: '160',
        rows: '40',
        env: 'MY_VAR=some=value',
        timeout: '300000',
      } as never);

      expect(result.exitCode).toBe(0);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body).toMatchObject({
        interactive: true,
        cols: 160,
        rows: 40,
        environmentVariables: { MY_VAR: 'some=value' },
        timeout: 300000,
      });
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('repeated --env flags accumulate into environmentVariables', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() =>
      new Response(
        JSON.stringify({
          success: true,
          session: { id: 'session-env-1', status: 'running', mode: 'headless' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    try {
      // Array form is what the arg parser produces for repeated --env flags.
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        env: ['FIRST=1', 'SECOND=two=values'],
      } as never);

      expect(result.exitCode).toBe(0);
      expect(calls[0]!.body).toMatchObject({
        environmentVariables: { FIRST: '1', SECOND: 'two=values' },
      });
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('forwards --provider/--model (flag form) in the server request', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() =>
      new Response(
        JSON.stringify({
          success: true,
          session: { id: 'session-pm-1', status: 'running', mode: 'headless' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        provider: 'opencode',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      } as never);

      expect(result.exitCode).toBe(0);
      expect(calls[0]!.body).toMatchObject({
        provider: 'opencode',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      });
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('--resume routes through the server resume endpoint (paused server refuses it too)', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() => rateLimitedResponse());
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        resume: 'prev-provider-session',
        prompt: 'continue where you left off',
      } as never);

      expect(result.exitCode).not.toBe(0);
      expect(String(result.error ?? '')).toContain('RATE_LIMITED');
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toContain(`/api/agents/${ws.agentId}/resume`);
      expect(calls[0]!.body).toMatchObject({
        providerSessionId: 'prev-provider-session',
        resumePrompt: 'continue where you left off',
      });
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('--resume success reports the server-owned session', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() =>
      new Response(
        JSON.stringify({
          success: true,
          session: { id: 'session-resumed-1', providerSessionId: 'prev-provider-session', status: 'running' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    );
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        resume: 'prev-provider-session',
      } as never);

      expect(result.exitCode).toBe(0);
      expect(String(result.message ?? '')).toContain('session-resumed-1');
      expect(calls[0]!.url).toContain('/resume');
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('--resume combined with start-only options surfaces the server refusal instead of dropping them', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() =>
      new Response(
        JSON.stringify({
          error: {
            code: 'UNSUPPORTED_FOR_RESUME',
            message:
              "Option(s) model are not supported when resuming a session — a resumed session keeps its original provider, model, environment and terminal shape. Drop them, or start a fresh session instead.",
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        resume: 'prev-provider-session',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      } as never);

      expect(result.exitCode).not.toBe(0);
      const errMsg = String(result.error ?? '');
      expect(errMsg).toContain('UNSUPPORTED_FOR_RESUME');
      expect(errMsg).toContain('not supported when resuming');
      // The option rode along so the server (not the CLI) could refuse it.
      expect(calls[0]!.body).toMatchObject({ model: 'anthropic/claude-sonnet-4-5-20250929' });
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('a "successful" server response without a session is an explicit error, never success', async () => {
    const ws = await setupWorkspace();
    const { restore } = stubServerResponse(() =>
      new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
      } as never);

      expect(result.exitCode).not.toBe(0);
      expect(String(result.error ?? '')).toContain('no session');
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('an ambiguous outcome (abort after submission) is an explicit error and never falls back locally', async () => {
    const ws = await setupWorkspace();
    const originalFetch = globalThis.fetch;
    // The CLI's abort timer firing after the request was submitted surfaces
    // as an AbortError DOMException — ambiguous: the server may have spawned.
    globalThis.fetch = (() =>
      Promise.reject(new DOMException('The operation was aborted', 'AbortError'))) as typeof fetch;
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        mode: 'headless',
      } as never);

      expect(result.exitCode).not.toBe(0);
      const errMsg = String(result.error ?? '');
      expect(errMsg).toContain('outcome is unknown');
      expect(errMsg).toContain('No local spawn was attempted');
      expect(errMsg).toContain(`sf agent show ${ws.agentId}`);
    } finally {
      globalThis.fetch = originalFetch;
      ws.cleanup();
    }
  });

  test.each([
    ['--timeout', 'timeout', 'abc'], ['--timeout', 'timeout', '0'], ['--timeout', 'timeout', '-5'],
    ['--cols', 'cols', 'x'], ['--rows', 'rows', '1.5'],
  ])('invalid %s %s fails validation before any spawn attempt', async (flag, optionKey, value) => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() => rateLimitedResponse());
    try {
      const result = await agentStartCommand.handler!(
        [ws.agentId],
        { db: ws.dbPath, server: 'http://localhost:3457', [optionKey]: value } as never
      );
      expect(result.exitCode).not.toBe(0);
      expect(String(result.error ?? '')).toContain(`Invalid ${flag}`);
      // Validation precedes the server attempt — nothing was submitted.
      expect(calls.length).toBe(0);
    } finally {
      restore();
      ws.cleanup();
    }
  });

  test('invalid --env fails validation instead of being silently dropped', async () => {
    const ws = await setupWorkspace();
    const { calls, restore } = stubServerResponse(() => rateLimitedResponse());
    try {
      const result = await agentStartCommand.handler!([ws.agentId], {
        db: ws.dbPath,
        server: 'http://localhost:3457',
        env: 'NO_EQUALS_SIGN',
      } as never);

      expect(result.exitCode).not.toBe(0);
      expect(String(result.error ?? '')).toContain('Invalid --env');
      expect(String(result.error ?? '')).toContain('KEY=VALUE');
      expect(calls.length).toBe(0);
    } finally {
      restore();
      ws.cleanup();
    }
  });
});

// ============================================================================
// isConnectPhaseFailure — the connect-phase vs ambiguous-outcome classifier
// used by trySpawnViaServer. Connect-phase failures prove the request was
// never delivered (safe local fallback); everything else may have been
// submitted and must surface as an explicit error.
// ============================================================================

describe('isConnectPhaseFailure', () => {
  it('classifies Bun-style connection refusal (code: ConnectionRefused)', () => {
    const err = Object.assign(
      new TypeError('Unable to connect. Is the computer able to access the url?'),
      { code: 'ConnectionRefused' }
    );
    expect(isConnectPhaseFailure(err)).toBe(true);
  });

  it('classifies Node/undici-style refusal via the cause chain (code: ECONNREFUSED)', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3457'), {
        code: 'ECONNREFUSED',
      }),
    });
    expect(isConnectPhaseFailure(err)).toBe(true);
  });

  it('classifies DNS failures (ENOTFOUND / EAI_AGAIN) as connect-phase', () => {
    expect(isConnectPhaseFailure(Object.assign(new TypeError('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(isConnectPhaseFailure(Object.assign(new TypeError('dns'), { code: 'EAI_AGAIN' }))).toBe(true);
  });

  it('classifies abort after submission (AbortError) as ambiguous — never safe to fall back', () => {
    expect(isConnectPhaseFailure(new DOMException('The operation was aborted', 'AbortError'))).toBe(false);
  });

  it('classifies a mid-flight connection reset (ECONNRESET) as ambiguous', () => {
    expect(isConnectPhaseFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false);
  });

  it('falls back to the message when no code is set', () => {
    expect(isConnectPhaseFailure(new TypeError('connect ECONNREFUSED 127.0.0.1:3457'))).toBe(true);
    expect(isConnectPhaseFailure(new TypeError('getaddrinfo ENOTFOUND no-such-host'))).toBe(true);
  });

  it('treats unrelated errors as ambiguous', () => {
    expect(isConnectPhaseFailure(new Error('something else'))).toBe(false);
    expect(isConnectPhaseFailure(undefined)).toBe(false);
  });
});

// ============================================================================
// agent start --provider / --model propagation
//
// 'sf agent start' advertises --provider and --model overrides. Historically
// neither flag reached the local spawner — they were parsed and silently
// dropped, so spawned agents ran with the wrong provider/model defaults.
// These tests pin the flag-to-spawner propagation path:
//   1. resolveAgentStartOverrides() — flag precedence + loud validation
//   2. the real handler — flags reach provider resolution and invalid values
//      fail with a clear error (no silent fallback, no spawn)
//   3. the spawner — SpawnOptions.provider/model reach the provider spawn
//      call and are recorded on the session (see spawner.bun.test.ts)
// ============================================================================

describe('resolveAgentStartOverrides', () => {
  it('returns undefined overrides when no flags and no metadata are set', () => {
    const result = resolveAgentStartOverrides({}, {});
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('CLI flags win over agent metadata', () => {
    const result = resolveAgentStartOverrides(
      { provider: 'opencode', model: 'gpt-4o' },
      { provider: 'claude-code', model: 'claude-sonnet-4-5-20250929' }
    );
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBe('opencode');
    expect(result.model).toBe('gpt-4o');
  });

  it('falls back to agent metadata when flags are absent', () => {
    const result = resolveAgentStartOverrides(
      {},
      { provider: 'opencode', model: 'claude-opus-4-6' }
    );
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBe('opencode');
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('lets a flag override one dimension while metadata supplies the other', () => {
    const result = resolveAgentStartOverrides(
      { model: 'claude-opus-4-6' },
      { provider: 'opencode', model: 'claude-sonnet-4-5-20250929' }
    );
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBe('opencode');
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('trims whitespace from flag and metadata values', () => {
    const result = resolveAgentStartOverrides(
      { provider: '  opencode  ', model: '  claude-opus-4-6  ' },
      {}
    );
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBe('opencode');
    expect(result.model).toBe('claude-opus-4-6');
  });

  it.each([
    [''], ['   '], ['\t'],
  ])('rejects an empty provider flag %j loudly', (badProvider) => {
    const result = resolveAgentStartOverrides({ provider: badProvider }, {});
    expect(result.error).toContain('Invalid provider');
    expect(result.error).toContain('non-empty');
  });

  it.each([
    [''], ['   '], ['\t'],
  ])('rejects an empty model flag %j loudly', (badModel) => {
    const result = resolveAgentStartOverrides({ model: badModel }, {});
    expect(result.error).toContain('Invalid model');
    expect(result.error).toContain('non-empty');
  });

  it('treats empty metadata values as unset instead of failing', () => {
    const result = resolveAgentStartOverrides(
      {},
      { provider: '   ', model: '' }
    );
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('ignores non-string metadata values', () => {
    const result = resolveAgentStartOverrides(
      {},
      { provider: 42, model: { id: 'x' } }
    );
    expect(result.error).toBeUndefined();
    expect(result.providerName).toBeUndefined();
    expect(result.model).toBeUndefined();
  });
});

describe('agent start provider/model behavioural', () => {
  const CREATOR = 'el-0000' as EntityId;

  /** Creates a tmp workspace with a .stoneforge/stoneforge.db. */
  async function makeWorkspace(prefix: string) {
    const tmpRoot = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(tmpRoot, '.stoneforge'), { recursive: true });
    const dbPath = join(tmpRoot, '.stoneforge', 'stoneforge.db');
    const backend = createStorage({ path: dbPath, create: true });
    initializeSchema(backend);
    return { tmpRoot, dbPath, api: createOrchestratorAPI(backend) };
  }

  test('start fails loudly on an unknown --provider instead of ignoring it', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-badprovider-');
    const cwdBefore = process.cwd();
    try {
      const registered = await api.registerWorker({
        name: 'provider-test-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      process.chdir(tmpRoot);

      const result = await agentStartCommand.handler!(
        [registered.id as unknown as string],
        { db: dbPath, provider: 'not-a-real-provider' } as never
      );
      expect(result.exitCode).not.toBe(0);
      // The error must name the bad provider and list what IS available —
      // the opposite of the old behaviour where the flag was silently dropped.
      expect(result.error).toContain("Provider 'not-a-real-provider' is not registered");
      expect(result.error).toContain('claude-code');
      // A validation failure, not a generic crash.
      expect(result.exitCode).toBe(ExitCode.VALIDATION);
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test.each([[''], ['   ']])(
    'start rejects an empty --provider flag %j before spawning',
    async (badProvider) => {
      const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-emptyprovider-');
      const cwdBefore = process.cwd();
      try {
        const registered = await api.registerWorker({
          name: 'empty-provider-w',
          workerMode: 'ephemeral',
          createdBy: CREATOR,
        });
        process.chdir(tmpRoot);

        const result = await agentStartCommand.handler!(
          [registered.id as unknown as string],
          { db: dbPath, provider: badProvider } as never
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.error).toContain('Invalid provider');
      } finally {
        process.chdir(cwdBefore);
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  );

  test.each([[''], ['   ']])(
    'start rejects an empty --model flag %j before spawning',
    async (badModel) => {
      const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-emptymodel-');
      const cwdBefore = process.cwd();
      try {
        const registered = await api.registerWorker({
          name: 'empty-model-w',
          workerMode: 'ephemeral',
          createdBy: CREATOR,
        });
        process.chdir(tmpRoot);

        const result = await agentStartCommand.handler!(
          [registered.id as unknown as string],
          { db: dbPath, model: badModel } as never
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.error).toContain('Invalid model');
      } finally {
        process.chdir(cwdBefore);
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  );

  test('start resolves the agent metadata provider when no flag is given', async () => {
    // An agent registered with a bogus provider must fail loudly even
    // WITHOUT --provider: the metadata default now reaches resolution too
    // (previously the CLI spawner ignored it entirely and always ran claude).
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-metaprovider-');
    const cwdBefore = process.cwd();
    try {
      const registered = await api.registerWorker({
        name: 'bogus-meta-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
        provider: 'bogus-meta-provider',
      });
      process.chdir(tmpRoot);

      const result = await agentStartCommand.handler!(
        [registered.id as unknown as string],
        { db: dbPath } as never
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain("Provider 'bogus-meta-provider' is not registered");
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Malformed model IDs must fail loudly. OpenCode only understands composite
  // '<provider>/<model>' IDs; its headless provider silently DROPS a model it
  // cannot parse (parseModelId -> undefined -> sendMessage omits the model),
  // so without this guard 'sf agent start --provider opencode --model bogus'
  // would spawn on the provider default while still reporting 'bogus' as the
  // session model.
  // -------------------------------------------------------------------------

  test('start rejects a non-composite --model for opencode loudly instead of dropping it', async () => {
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-badmodel-');
    const cwdBefore = process.cwd();
    try {
      const registered = await api.registerWorker({
        name: 'bad-model-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      process.chdir(tmpRoot);

      const result = await agentStartCommand.handler!(
        [registered.id as unknown as string],
        { db: dbPath, provider: 'opencode', model: 'claude-sonnet-4' } as never
      );
      expect(result.exitCode).toBe(ExitCode.VALIDATION);
      // The error names the rejected value, the expected format and an example.
      expect(result.error).toContain('claude-sonnet-4');
      expect(result.error).toContain("provider 'opencode'");
      expect(result.error).toContain("'<provider>/<model>'");
      expect(result.error).toContain('anthropic/claude-sonnet-4-5-20250929');
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test.each([['anthropic/'], ['/claude-sonnet-4'], ['/']])(
    'start rejects an OpenCode --model %j with empty segments',
    async (badModel) => {
      const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-emptysegment-');
      const cwdBefore = process.cwd();
      try {
        const registered = await api.registerWorker({
          name: 'empty-segment-w',
          workerMode: 'ephemeral',
          createdBy: CREATOR,
        });
        process.chdir(tmpRoot);

        const result = await agentStartCommand.handler!(
          [registered.id as unknown as string],
          { db: dbPath, provider: 'opencode', model: badModel } as never
        );
        expect(result.exitCode).toBe(ExitCode.VALIDATION);
        expect(result.error).toContain('non-empty');
      } finally {
        process.chdir(cwdBefore);
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  );

  test('a malformed model stored in agent metadata also fails loudly', async () => {
    // Same silent-fallback risk when the bad value comes from
    // 'sf agent register --model' instead of the start flag.
    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-badmetamodel-');
    const cwdBefore = process.cwd();
    try {
      const registered = await api.registerWorker({
        name: 'bad-meta-model-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
        provider: 'opencode',
        model: 'bogus',
      });
      process.chdir(tmpRoot);

      const result = await agentStartCommand.handler!(
        [registered.id as unknown as string],
        { db: dbPath } as never
      );
      expect(result.exitCode).toBe(ExitCode.VALIDATION);
      expect(result.error).toContain("Invalid model 'bogus'");
    } finally {
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Full flag-to-spawner propagation (happy path).
  //
  // A recording fake provider is registered in the REAL provider registry so
  // the actual handler code path runs end to end:
  //   CLI flags -> resolveAgentStartOverrides -> registry lookup ->
  //   spawner.spawn(provider, model) -> provider headless.spawn(model) ->
  //   SpawnedSession + command output metadata.
  // The assertions fail if the provider/model arguments are removed from the
  // handler's spawn call (the original bug) or if the spawner stops
  // forwarding SpawnOptions.model to the provider.
  // -------------------------------------------------------------------------

  /** Headless session that emits init, then a result, then ends. */
  function createInitThenResultSession(providerSessionId: string): HeadlessSession {
    let sentInit = false;
    let sentResult = false;
    return {
      sendMessage: () => {},
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentMessage>> {
            if (!sentInit) {
              sentInit = true;
              return {
                done: false,
                value: {
                  type: 'system',
                  subtype: 'init',
                  sessionId: providerSessionId,
                  raw: { type: 'system', subtype: 'init', session_id: providerSessionId },
                },
              };
            }
            if (!sentResult) {
              sentResult = true;
              await new Promise((resolve) => setTimeout(resolve, 50));
              return {
                done: false,
                value: {
                  type: 'result',
                  content: 'Task completed',
                  raw: { type: 'result', result: 'Task completed' },
                },
              };
            }
            return { done: true, value: undefined };
          },
        };
      },
      interrupt: async () => {},
      close: () => {},
    };
  }

  /** Registers a provider whose headless.spawn records the options it receives. */
  function registerRecordingProvider(name: string, calls: HeadlessSpawnOptions[]): void {
    const provider: AgentProvider = {
      name,
      headless: {
        name: `${name}-headless`,
        spawn: async (options: HeadlessSpawnOptions) => {
          calls.push(options);
          return createInitThenResultSession(`${name}-provider-session`);
        },
        isAvailable: async () => true,
      },
      interactive: {
        name: `${name}-interactive`,
        spawn: async () => {
          throw new Error('interactive spawn not expected in this test');
        },
        isAvailable: async () => true,
      },
      isAvailable: async () => true,
      getInstallInstructions: () => 'No install needed for recording test provider',
      listModels: async () => [],
    };
    getProviderRegistry().register(provider);
  }

  test('start forwards --provider/--model through the spawner to the provider spawn call', async () => {
    const FAKE_PROVIDER = 'recording-fake-provider';
    const FAKE_MODEL = 'fake-vendor/fake-model-1';
    const calls: HeadlessSpawnOptions[] = [];
    registerRecordingProvider(FAKE_PROVIDER, calls);

    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-propagation-');
    const cwdBefore = process.cwd();
    // --provider now routes through the orchestrator server when one is
    // reachable; simulate "no server" so this test exercises the local
    // fallback path the assertions were written for.
    const restoreFetch = stubServerUnreachable();
    try {
      const registered = await api.registerWorker({
        name: 'propagation-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      process.chdir(tmpRoot);

      const result = await agentStartCommand.handler!(
        [registered.id as unknown as string],
        { db: dbPath, provider: FAKE_PROVIDER, model: FAKE_MODEL } as never
      );

      expect(result.exitCode).toBe(0);

      // The registered fake provider actually ran the session exactly once...
      expect(calls.length).toBe(1);
      // ...and the --model flag reached its spawn call verbatim. This fails
      // if the handler or spawner drops the model override.
      expect(calls[0]!.model).toBe(FAKE_MODEL);

      // The session record reflects both overrides.
      const session = result.data as { provider?: string; model?: string; providerSessionId?: string };
      expect(session.provider).toBe(FAKE_PROVIDER);
      expect(session.model).toBe(FAKE_MODEL);
      expect(session.providerSessionId).toBe(`${FAKE_PROVIDER}-provider-session`);

      // And so does the human-readable output.
      const out = String(result.message ?? '');
      expect(out).toContain(`Provider:    ${FAKE_PROVIDER}`);
      expect(out).toContain(`Model:       ${FAKE_MODEL}`);

      // Let the background message loop (init -> result -> close) finish.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      restoreFetch();
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('start --json output reports the effective provider and model', async () => {
    const FAKE_PROVIDER = 'recording-fake-provider-json';
    const FAKE_MODEL = 'fake-vendor/fake-model-json';
    const calls: HeadlessSpawnOptions[] = [];
    registerRecordingProvider(FAKE_PROVIDER, calls);

    const { tmpRoot, dbPath, api } = await makeWorkspace('sf-start-propagation-json-');
    const cwdBefore = process.cwd();
    // Same as above: no server reachable -> local fallback path.
    const restoreFetch = stubServerUnreachable();
    try {
      const registered = await api.registerWorker({
        name: 'propagation-json-w',
        workerMode: 'ephemeral',
        createdBy: CREATOR,
      });
      process.chdir(tmpRoot);

      const result = await agentStartCommand.handler!(
        [registered.id as unknown as string],
        { db: dbPath, json: true, provider: FAKE_PROVIDER, model: FAKE_MODEL } as never
      );

      expect(result.exitCode).toBe(0);
      expect(calls.length).toBe(1);
      expect(calls[0]!.model).toBe(FAKE_MODEL);

      const payload = result.data as Record<string, unknown>;
      expect(payload.provider).toBe(FAKE_PROVIDER);
      expect(payload.model).toBe(FAKE_MODEL);
      expect(payload.status).toBe('running');

      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      restoreFetch();
      process.chdir(cwdBefore);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
