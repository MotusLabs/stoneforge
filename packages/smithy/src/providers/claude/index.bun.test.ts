/**
 * Claude Agent Provider Tests
 *
 * Regression coverage for ClaudeAgentProvider.listModels().
 *
 * listModels() must never start a real agent turn. Historically it called
 * sdkQuery({ prompt: '' }) just to reach supportedModels(); the empty string
 * is delivered as a user turn, so a full Claude session started in the
 * caller's cwd (a worker worktree during tests) and ran for minutes. Those
 * phantom sessions looked like a second worker spawn overlapping the real
 * one. The probe must use streaming input that yields no user message, abort
 * the CLI process when done, and run from a neutral cwd.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import type { Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';

// ============================================================================
// Module-level mocks
// ============================================================================

interface CapturedQuery {
  prompt: unknown;
  options: SDKOptions | undefined;
}

let capturedQueries: CapturedQuery[] = [];
let closeQuery: ReturnType<typeof mock>;
let supportedModels: ReturnType<typeof mock>;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: unknown; options?: SDKOptions }) => {
    capturedQueries.push({ prompt, options });
    const gen = (async function* () {
      // Not consumed by these tests; listModels builds its own input iterable.
    })();
    Object.assign(gen, {
      interrupt: mock(async () => {}),
      close: closeQuery,
      supportedModels,
      streamInput: mock(async () => {}),
    });
    return gen;
  },
}));

// ============================================================================
// Helpers
// ============================================================================

/**
 * Drain the probe input iterable. Returns 'yielded' if a user message was
 * produced (a bug — that starts a real turn), 'pending' if the iterable is
 * still waiting (correct: no turn), or 'done' if it completed empty.
 */
async function drainProbeInput(
  prompt: unknown,
  timeoutMs = 50
): Promise<'yielded' | 'pending' | 'done' | 'not-iterable'> {
  if (prompt == null || typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    return 'not-iterable';
  }
  const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  const timeoutPromise = new Promise<'pending'>((resolve) => {
    setTimeout(() => resolve('pending'), timeoutMs);
  });
  const result = await Promise.race([
    nextPromise.then((r) => (r.done ? ('done' as const) : ('yielded' as const))),
    timeoutPromise,
  ]);
  // If the iterator produced a message, finish it so we don't leak.
  if (result === 'yielded' || result === 'done') {
    await iterator.return?.(undefined).catch(() => {});
  }
  return result;
}

// ============================================================================
// Tests
// ============================================================================

describe('ClaudeAgentProvider', () => {
  beforeEach(() => {
    capturedQueries = [];
    closeQuery = mock(() => {});
    supportedModels = mock(async () => [
      { value: 'claude-sonnet-4-20250514', displayName: 'Default (recommended)', description: 'Claude Sonnet 4 · Fast and efficient model' },
      { value: 'claude-opus-4-20250514', displayName: 'Opus', description: 'Claude Opus 4 · Most capable model' },
    ]);
  });

  afterEach(() => {
    supportedModels.mockRestore?.();
    closeQuery.mockRestore?.();
  });

  describe('listModels()', () => {
    it('returns models mapped from SDK format to provider format', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      const models = await provider.listModels();

      expect(models).toEqual([
        {
          id: 'claude-sonnet-4-20250514',
          displayName: 'Claude Sonnet 4',
          description: 'Claude Sonnet 4 · Fast and efficient model',
          isDefault: true,
        },
        {
          id: 'claude-opus-4-20250514',
          displayName: 'Claude Opus 4',
          description: 'Claude Opus 4 · Most capable model',
        },
      ]);
      expect(supportedModels).toHaveBeenCalledTimes(1);
    });

    it('extracts display name from the description prefix when present', async () => {
      supportedModels = mock(async () => [
        { value: 'opus-4-5', displayName: 'Default (recommended)', description: 'Opus 4.5 · Most capable model' },
      ]);
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      const models = await provider.listModels();

      expect(models[0].displayName).toBe('Opus 4.5');
      expect(models[0].id).toBe('opus-4-5');
      expect(models[0].isDefault).toBe(true);
    });

    it('handles empty model list', async () => {
      supportedModels = mock(async () => []);
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      const models = await provider.listModels();
      expect(models).toEqual([]);
    });

    // ------------------------------------------------------------------
    // Regression: listModels() must not start a real agent session
    // ------------------------------------------------------------------

    it('does NOT pass a string prompt (a string prompt starts a real turn)', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      await provider.listModels();

      expect(capturedQueries).toHaveLength(1);
      const { prompt } = capturedQueries[0];
      expect(typeof prompt).not.toBe('string');
      // Streaming input (async iterable) is the only prompt form that can
      // initialize without delivering a user turn.
      expect(typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
    });

    it('probe input yields no user message (no agent turn is started)', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      await provider.listModels();

      const { prompt } = capturedQueries[0];
      // After listModels() resolves the probe is torn down; draining it must
      // not produce a user message. Before teardown it must stay pending.
      const drained = await drainProbeInput(prompt);
      expect(drained).not.toBe('yielded');
      expect(drained).not.toBe('not-iterable');
    });

    it('probe input stays pending while listing (does not close the turn window early)', async () => {
      // Hold supportedModels open so we can inspect the live probe input.
      let releaseModels!: (v: Array<{ value: string; displayName: string; description: string }>) => void;
      supportedModels = mock(
        () =>
          new Promise((resolve) => {
            releaseModels = resolve;
          })
      );

      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      const listPromise = provider.listModels();
      // Give the call a tick to create the query.
      await new Promise((r) => setTimeout(r, 10));

      expect(capturedQueries).toHaveLength(1);
      const liveDrain = await drainProbeInput(capturedQueries[0].prompt, 30);
      expect(liveDrain).toBe('pending');

      releaseModels([]);
      await listPromise;
    });

    it('runs the probe from a neutral cwd so a leak cannot impersonate a worker', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      await provider.listModels();

      const { options } = capturedQueries[0];
      expect(options?.cwd).toBe(tmpdir());
      // Must not inherit process.cwd() (a worker worktree during tests).
      expect(options?.cwd).not.toBe(process.cwd());
    });

    it('aborts the probe and closes the query on success', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      await provider.listModels();

      const { options } = capturedQueries[0];
      expect(options?.abortController).toBeDefined();
      expect(options?.abortController?.signal.aborted).toBe(true);
      expect(closeQuery).toHaveBeenCalledTimes(1);
    });

    it('aborts the probe and closes the query when supportedModels() throws', async () => {
      supportedModels = mock(async () => {
        throw new Error('SDK exploded');
      });
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      await expect(provider.listModels()).rejects.toThrow('Failed to list models from Claude SDK');

      const { options } = capturedQueries[0];
      expect(options?.abortController?.signal.aborted).toBe(true);
      expect(closeQuery).toHaveBeenCalledTimes(1);
    });

    it('maps SDK ModelInfo fields correctly (value → id)', () => {
      const sdkModel = {
        value: 'test-model',
        displayName: 'Test Model',
        description: 'A test model',
      };

      const providerModel = {
        id: sdkModel.value,
        displayName: sdkModel.displayName,
        description: sdkModel.description,
      };

      expect(providerModel.id).toBe('test-model');
      expect(providerModel.displayName).toBe('Test Model');
      expect(providerModel.description).toBe('A test model');
    });
  });

  describe('provider setup', () => {
    it('should have correct provider name', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();
      expect(provider.name).toBe('claude-code');
    });

    it('should create headless and interactive providers', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider();

      expect(provider.headless).toBeDefined();
      expect(provider.interactive).toBeDefined();
      expect(provider.headless.name).toBe('claude-headless');
      expect(provider.interactive.name).toBe('claude-interactive');
    });

    it('should accept custom executable path', async () => {
      const { ClaudeAgentProvider } = await import('./index.js');
      const provider = new ClaudeAgentProvider('/custom/path/claude');

      // Interactive provider stores the executable path
      expect(provider.interactive).toBeDefined();
    });
  });
});
