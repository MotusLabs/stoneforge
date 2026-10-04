/**
 * OpenCode Agent Provider
 *
 * Combines the OpenCode headless and interactive providers
 * into a single AgentProvider implementation.
 *
 * @module
 */

import type { AgentProvider, HeadlessProvider, InteractiveProvider, ModelInfo } from '../types.js';
import { OpenCodeHeadlessProvider, parseModelId } from './headless.js';
import { OpenCodeInteractiveProvider } from './interactive.js';
import { serverManager } from './server-manager.js';

export { OpenCodeHeadlessProvider, parseModelId } from './headless.js';
export { OpenCodeInteractiveProvider } from './interactive.js';
export { OpenCodeEventMapper } from './event-mapper.js';
export type { OpenCodeEvent } from './event-mapper.js';
export { AsyncQueue } from './async-queue.js';
export { serverManager } from './server-manager.js';

export interface OpenCodeProviderConfig {
  executablePath?: string;
  port?: number;
}

/**
 * OpenCode Agent Provider - alternative provider using OpenCode CLI and SDK.
 */
export class OpenCodeAgentProvider implements AgentProvider {
  readonly name = 'opencode';
  readonly headless: HeadlessProvider;
  readonly interactive: InteractiveProvider;
  private readonly config?: OpenCodeProviderConfig;

  constructor(config?: OpenCodeProviderConfig) {
    this.config = config;
    this.headless = new OpenCodeHeadlessProvider({ port: config?.port });
    this.interactive = new OpenCodeInteractiveProvider(config?.executablePath);
  }

  async isAvailable(): Promise<boolean> {
    const headlessAvailable = await this.headless.isAvailable();
    const interactiveAvailable = await this.interactive.isAvailable();
    return headlessAvailable || interactiveAvailable;
  }

  getInstallInstructions(): string {
    return 'Install OpenCode SDK: npm install @opencode-ai/sdk\nInstall OpenCode CLI: see https://opencode.ai';
  }

  async listModels(): Promise<ModelInfo[]> {
    return serverManager.listModels({ port: this.config?.port });
  }

  /**
   * OpenCode model IDs are composite '<providerID>/<modelID>' strings
   * (e.g., 'anthropic/claude-sonnet-4-5-20250929'). The headless provider
   * cannot apply a model it cannot parse into those two segments — it
   * silently drops it and the session runs on the server's default model —
   * so structurally invalid IDs are rejected here for callers that want to
   * fail loudly before spawning. This does NOT check the model actually
   * exists in any catalog.
   */
  validateModel(model: string): string | undefined {
    const example = "e.g., 'anthropic/claude-sonnet-4-5-20250929'";
    const spec = parseModelId(model);
    if (!spec) {
      return (
        `Invalid model '${model}' for provider 'opencode': OpenCode models are ` +
        `composite '<provider>/<model>' IDs (${example}).`
      );
    }
    if (!spec.providerID.trim() || !spec.modelID.trim()) {
      return (
        `Invalid model '${model}' for provider 'opencode': both segments of ` +
        `the '<provider>/<model>' ID must be non-empty (${example}).`
      );
    }
    return undefined;
  }
}
