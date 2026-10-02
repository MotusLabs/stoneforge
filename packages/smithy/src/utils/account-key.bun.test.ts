/**
 * Account Key Normalisation Unit Tests
 *
 * Covers `normalizeExecutableKey` and `resolveAccountKey`, including the
 * "Account key" requirement scenarios from the Worker Dispatch Tiers spec:
 * "Wrapper defines its own account", "Shared wrapper shares an account"
 * and "Path spelling normalised".
 *
 * PATH is pinned to a temporary directory so bare-command resolution is
 * deterministic regardless of the machine running the tests.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  normalizeExecutableKey,
  resolveAccountKey,
  clearExecutableResolutionCache,
} from './account-key.js';
import type { AgentEntity } from '../api/orchestrator-api.js';
import type { SettingsService } from '../services/settings-service.js';
import { createRateLimitTracker } from '../services/rate-limit-tracker.js';

describe('account key', () => {
  let tempDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-key-test-'));
    originalPath = process.env.PATH;
    process.env.PATH = tempDir;
    clearExecutableResolutionCache();
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearExecutableResolutionCache();
  });

  /** Creates an executable file in tempDir and returns its absolute path. */
  function makeExecutable(name: string): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(filePath, 0o755);
    return filePath;
  }

  /** Builds a minimal worker agent with the given provider/executablePath. */
  function makeAgent(meta: { provider?: string; executablePath?: string }): AgentEntity {
    return {
      id: 'el-test-agent',
      type: 'entity',
      name: 'test-agent',
      metadata: { agent: { agentRole: 'worker', ...meta } },
    } as unknown as AgentEntity;
  }

  /** Builds a SettingsService stub exposing only agent defaults. */
  function makeSettings(defaultExecutablePaths: Record<string, string> = {}): SettingsService {
    return {
      getAgentDefaults: () => ({ defaultExecutablePaths }),
    } as unknown as SettingsService;
  }

  describe('normalizeExecutableKey', () => {
    test('resolves a bare command on PATH to its absolute path', () => {
      const wrapperPath = makeExecutable('claude-glm');

      expect(normalizeExecutableKey('claude-glm')).toBe(wrapperPath);
    });

    test('returns the raw string when the command is not on PATH', () => {
      expect(normalizeExecutableKey('definitely-not-on-path-xyz')).toBe('definitely-not-on-path-xyz');
    });

    test('leaves spellings that contain a path separator unchanged', () => {
      expect(normalizeExecutableKey('/usr/local/bin/claude-glm')).toBe('/usr/local/bin/claude-glm');
      expect(normalizeExecutableKey('./relative/claude-glm')).toBe('./relative/claude-glm');
    });

    test('trims surrounding whitespace before resolving', () => {
      const wrapperPath = makeExecutable('claude-glm');

      expect(normalizeExecutableKey('  claude-glm  ')).toBe(wrapperPath);
    });

    test('caches command resolution per process', () => {
      const wrapperPath = makeExecutable('cache-probe');
      expect(normalizeExecutableKey('cache-probe')).toBe(wrapperPath);

      // Removing the file must not change the answer — the first
      // resolution is cached for the lifetime of the process.
      fs.rmSync(wrapperPath);
      expect(normalizeExecutableKey('cache-probe')).toBe(wrapperPath);
    });

    test('returns an empty string unchanged', () => {
      expect(normalizeExecutableKey('')).toBe('');
    });
  });

  describe('resolveAccountKey', () => {
    test('prefers the agent executablePath', () => {
      const wrapperPath = makeExecutable('claude-glm');

      const agent = makeAgent({ executablePath: 'claude-glm' });
      expect(resolveAccountKey(agent, makeSettings({ 'claude-code': '/usr/bin/claude-dev' }))).toBe(wrapperPath);
    });

    test('falls back to the workspace default for the provider', () => {
      const agent = makeAgent({ provider: 'claude-code' });
      expect(resolveAccountKey(agent, makeSettings({ 'claude-code': '/usr/bin/claude-dev' }))).toBe('/usr/bin/claude-dev');
    });

    test('falls back to the provider default binary (claude-code → claude)', () => {
      // 'claude' is not on the pinned PATH, so the raw provider binary name is the key
      const agent = makeAgent({});
      expect(resolveAccountKey(agent, makeSettings())).toBe('claude');
    });

    test('resolves the provider default binary on PATH when present', () => {
      const claudePath = makeExecutable('claude');

      const agent = makeAgent({});
      expect(resolveAccountKey(agent, makeSettings())).toBe(claudePath);
    });

    test('uses the provider name itself for providers without a mapped binary', () => {
      const agent = makeAgent({ provider: 'opencode' });
      expect(resolveAccountKey(agent, makeSettings())).toBe('opencode');
    });

    test('works without a settings service', () => {
      const agent = makeAgent({});
      expect(resolveAccountKey(agent)).toBe('claude');
    });
  });

  describe('spec scenario: Account key', () => {
    test('Wrapper defines its own account', () => {
      // e3 has executablePath 'claude-glm'; e1 has none and uses the
      // provider default ('claude'). Their account keys differ.
      makeExecutable('claude-glm');

      const e1 = makeAgent({});
      const e3 = makeAgent({ executablePath: 'claude-glm' });

      const key1 = resolveAccountKey(e1, makeSettings());
      const key3 = resolveAccountKey(e3, makeSettings());

      expect(key3).toBe(path.join(tempDir, 'claude-glm'));
      expect(key1).toBe('claude');
      expect(key1).not.toBe(key3);
    });

    test('Shared wrapper shares an account', () => {
      // e1 and e2 both run 'claude-glm', spelled differently.
      makeExecutable('claude-glm');

      const e1 = makeAgent({ executablePath: 'claude-glm' });
      const e2 = makeAgent({ executablePath: path.join(tempDir, 'claude-glm') });

      const key1 = resolveAccountKey(e1, makeSettings());
      const key2 = resolveAccountKey(e2, makeSettings());

      expect(key1).toBe(path.join(tempDir, 'claude-glm'));
      expect(key2).toBe(path.join(tempDir, 'claude-glm'));
      expect(key1).toBe(key2);
    });

    test('Path spelling normalised', () => {
      // A limit is reported for the absolute path; the worker is
      // configured with the bare command name, which resolves to it.
      const wrapperPath = makeExecutable('claude-glm');

      const tracker = createRateLimitTracker();
      tracker.markLimited(wrapperPath, new Date(Date.now() + 60_000));

      const worker = makeAgent({ executablePath: 'claude-glm' });
      const workerKey = resolveAccountKey(worker, makeSettings());

      expect(workerKey).toBe(wrapperPath);
      expect(tracker.isLimited(workerKey)).toBe(true);
      // The default account is unaffected
      expect(tracker.isLimited('claude')).toBe(false);
    });
  });
});
