/**
 * Account Key Normalisation
 *
 * Provider rate limits are tracked per *account* — the subscription a
 * session's executable bills to — rather than per raw executable string.
 * The account key is derived from the worker's effective executable and
 * normalised so that equivalent spellings of the same executable (a bare
 * command name and its resolved absolute path) collapse to one key.
 *
 * Two helpers live here:
 *
 * - `normalizeExecutableKey(raw)` — normalises a single executable
 *   spelling. A slash-less command is resolved on `PATH` to an absolute
 *   path (cached per process); anything else is returned as-is.
 * - `resolveAccountKey(agent, settingsService)` — derives the effective
 *   executable for an agent (agent `executablePath` → workspace default
 *   for the provider → provider default binary) and normalises it.
 *
 * Every rate-limit `markLimited` / `isLimited` / chain lookup goes through
 * `normalizeExecutableKey`, so a limit reported by a session under one
 * spelling matches a worker configured under another.
 *
 * @module
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentEntity } from '../api/orchestrator-api.js';
import type { SettingsService } from '../services/settings-service.js';
import { createLogger } from './logger.js';

const logger = createLogger('account-key');

// ============================================================================
// Constants
// ============================================================================

/**
 * Provider name used when an agent does not specify one.
 * Mirrors the default in `dispatch-daemon.resolveExecutableWithFallback`.
 */
const DEFAULT_PROVIDER = 'claude-code';

/**
 * Provider name → the binary the provider invokes when no explicit
 * executable is configured anywhere. Only providers whose binary name
 * differs from the provider name need an entry (`claude-code` runs the
 * `claude` CLI); `opencode` and `codex` invoke binaries of the same name.
 */
const PROVIDER_DEFAULT_EXECUTABLES: Record<string, string> = {
  'claude-code': 'claude',
};

// ============================================================================
// Normalisation
// ============================================================================

/**
 * Per-process cache of command-name resolutions (including misses, which
 * map to the raw command). Keeps `PATH` scans off the hot dispatch path.
 */
const resolutionCache = new Map<string, string>();

/**
 * Normalises an executable spelling into a rate-limit account key.
 *
 * A bare command name (no `/` separator) is resolved on `PATH` to its
 * absolute path, so `claude-glm` and `/usr/local/bin/claude-glm` produce
 * the same key. Values that already contain a path separator are returned
 * unchanged (whitespace-trimmed). When a command cannot be resolved on
 * `PATH`, the raw string is returned — all lookups normalise the same way,
 * so spellings still agree.
 *
 * Results are cached per process.
 *
 * @param raw - The executable spelling to normalise (command name or path)
 * @returns The normalised account key
 */
export function normalizeExecutableKey(raw: string): string {
  const trimmed = raw.trim();
  // Only bare command names can be resolved on PATH; anything containing
  // a separator is already a path spelling.
  if (trimmed === '' || trimmed.includes('/')) {
    return trimmed;
  }

  const cached = resolutionCache.get(trimmed);
  if (cached !== undefined) {
    return cached;
  }

  const resolved = resolveOnPath(trimmed);
  const key = resolved ?? trimmed;
  resolutionCache.set(trimmed, key);

  if (!resolved) {
    // Logged once per command per process (misses are cached too).
    logger.debug(`Could not resolve '${trimmed}' on PATH — using raw string as account key`);
  }
  return key;
}

/**
 * Clears the per-process command resolution cache.
 *
 * Primarily useful in tests that manipulate `PATH`; production code has no
 * reason to call this.
 */
export function clearExecutableResolutionCache(): void {
  resolutionCache.clear();
}

/**
 * Resolves a bare command name against the current `PATH`.
 *
 * @param command - The command name (no path separators)
 * @returns The absolute path of the first matching executable file, or
 *          undefined when no directory on `PATH` provides one
 */
function resolveOnPath(command: string): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Returns true when the given path exists, is executable, and is a regular
 * file (a directory named like the command would also satisfy the X_OK
 * check alone).
 */
function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// ============================================================================
// Account Key Resolution
// ============================================================================

/**
 * Derives the rate-limit account key for an agent.
 *
 * The effective executable is chosen with the same priority the spawner
 * uses (`dispatch-daemon.resolveExecutableWithFallback` /
 * `session-manager.resolveExecutablePath`):
 *
 * 1. The agent's own `executablePath`
 * 2. The workspace default `agentDefaults.defaultExecutablePaths[provider]`
 * 3. The provider's default binary (`claude-code` → `claude`; otherwise the
 *    provider name itself)
 *
 * The result is then normalised with {@link normalizeExecutableKey}.
 *
 * @param agent - The agent (usually an ephemeral worker) to key
 * @param settingsService - Optional settings service providing workspace
 *                          defaults; without it only steps 1 and 3 apply
 * @returns The normalised account key
 */
export function resolveAccountKey(agent: AgentEntity, settingsService?: SettingsService): string {
  const meta = readExecutableMeta(agent);
  const provider = meta.provider ?? DEFAULT_PROVIDER;

  let effective = meta.executablePath;
  if (!effective && settingsService) {
    effective = settingsService.getAgentDefaults().defaultExecutablePaths[provider];
  }
  if (!effective) {
    effective = PROVIDER_DEFAULT_EXECUTABLES[provider] ?? provider;
  }

  return normalizeExecutableKey(effective);
}

/**
 * Safely reads the `provider` and `executablePath` fields from an agent's
 * metadata, tolerating missing or malformed metadata (the defaults from
 * `resolveAccountKey` then apply).
 */
function readExecutableMeta(agent: AgentEntity): { provider?: string; executablePath?: string } {
  const meta = (agent as { metadata?: { agent?: unknown } }).metadata?.agent;
  if (!meta || typeof meta !== 'object') {
    return {};
  }
  const { provider, executablePath } = meta as { provider?: unknown; executablePath?: unknown };
  return {
    provider: typeof provider === 'string' && provider ? provider : undefined,
    executablePath: typeof executablePath === 'string' && executablePath ? executablePath : undefined,
  };
}
