/**
 * Claude Agent Provider
 *
 * Combines the Claude headless (SDK) and interactive (PTY) providers
 * into a single AgentProvider implementation.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo as SDKModelInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ProviderError, type AgentProvider, type HeadlessProvider, type InteractiveProvider, type ModelInfo } from '../types.js';
import { ClaudeHeadlessProvider } from './headless.js';
import { ClaudeInteractiveProvider } from './interactive.js';
import { buildClaudeSpawnEnv } from './env.js';

export { ClaudeHeadlessProvider } from './headless.js';
export { ClaudeInteractiveProvider } from './interactive.js';

/**
 * Claude Agent Provider - the default provider using Claude Code CLI and SDK.
 */
export class ClaudeAgentProvider implements AgentProvider {
  readonly name = 'claude-code';
  readonly headless: HeadlessProvider;
  readonly interactive: InteractiveProvider;

  constructor(executablePath = 'claude') {
    this.headless = new ClaudeHeadlessProvider(executablePath);
    this.interactive = new ClaudeInteractiveProvider(executablePath);
  }

  async isAvailable(): Promise<boolean> {
    // Check if at least the headless provider is available (SDK installed)
    return this.headless.isAvailable();
  }

  getInstallInstructions(): string {
    return 'Install Claude Code: npm install -g @anthropic-ai/claude-code\nInstall Claude Agent SDK: npm install @anthropic-ai/claude-agent-sdk';
  }

  async listModels(): Promise<ModelInfo[]> {
    // Probe the SDK for its model catalog WITHOUT starting an agent turn.
    //
    // `supportedModels()` only needs the CLI initialize handshake, which
    // reports the available models. A string `prompt` — even the empty
    // string — is delivered as a real user turn, so the agent starts working
    // in `options.cwd` (historically the caller's cwd, i.e. a worker
    // worktree). Those phantom sessions look like a second worker spawn and
    // can run for minutes if `close()` loses the race with the first turn.
    //
    // Defences, in order:
    // 1. Streaming input that never yields a user message → no turn starts.
    // 2. AbortController aborted in `finally` → the CLI process is killed
    //    even if a turn somehow began.
    // 3. Neutral `cwd` (os.tmpdir()) → a leaked session cannot impersonate
    //    a worker by sitting inside that worker's worktree.
    const abortController = new AbortController();
    let releaseProbeInput!: () => void;
    const probeInputSettled = new Promise<void>((resolve) => {
      releaseProbeInput = resolve;
    });

    async function* probeInput(): AsyncGenerator<SDKUserMessage> {
      // Yield nothing. Keep the input stream open until the probe is done so
      // the query stays in "awaiting user input" after initialization.
      await probeInputSettled;
    }

    let queryInstance: ReturnType<typeof sdkQuery>;
    try {
      queryInstance = sdkQuery({
        prompt: probeInput(),
        options: {
          abortController,
          cwd: tmpdir(),
          env: buildClaudeSpawnEnv(process.env),
          // Use bypassPermissions to avoid permission prompts
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
      });
    } catch (error) {
      // SDK query creation failed (e.g., missing executable, spawn error)
      abortController.abort();
      releaseProbeInput();
      throw new ProviderError(
        `Failed to initialize Claude SDK query: ${error instanceof Error ? error.message : String(error)}`,
        'claude-code'
      );
    }

    try {
      const sdkModels: SDKModelInfo[] = await queryInstance.supportedModels();

      // Map SDK ModelInfo (value, displayName, description) to our ModelInfo (id, displayName, description?)
      // The SDK returns models in default-first order, so mark the first one as default.
      // The SDK's displayName can be generic (e.g. "Default (recommended)", "Sonnet").
      // The description contains the real model name before "·" (e.g. "Opus 4.5 · Most capable...").
      return sdkModels.map((model, index) => {
        // Extract model name from description: "Opus 4.5 · ..." → "Opus 4.5"
        const descriptionName = model.description?.split('·')[0]?.trim();
        const displayName = descriptionName || model.displayName;

        return {
          id: model.value,
          displayName,
          description: model.description,
          ...(index === 0 ? { isDefault: true } : {}),
        };
      });
    } catch (error) {
      // SDK query failed (e.g., auth error, process crash, "Query closed before response")
      throw new ProviderError(
        `Failed to list models from Claude SDK: ${error instanceof Error ? error.message : String(error)}`,
        'claude-code'
      );
    } finally {
      // Always tear down: close the query, kill the CLI process, and let the
      // probe input generator finish so it cannot hold the event loop open.
      queryInstance.close();
      abortController.abort();
      releaseProbeInput();
    }
  }
}
