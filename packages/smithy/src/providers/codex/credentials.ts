/**
 * Codex Credential Check
 *
 * Determines whether the Codex CLI can actually talk to a model backend.
 *
 * Why this exists: `codex --version` succeeds even when the CLI has no
 * credentials, and `codex app-server` happily starts threads in that state.
 * The failure only surfaces when a turn is started — every turn dies with
 * `unexpected status 401 Unauthorized: Missing bearer or basic authentication
 * in header` after ~15s of reconnect attempts. A stoneforge agent configured
 * for the codex provider in that state spawns successfully and then dies on
 * its first turn, which looks identical to a session/orchestration bug.
 * Checking credentials up front lets the orchestrator refuse the spawn with
 * an actionable message instead.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Environment variables that authenticate the default OpenAI-backed provider. */
const OPENAI_CREDENTIAL_ENV_VARS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/**
 * Resolves the Codex home directory (`CODEX_HOME` overrides the default
 * `~/.codex`), matching the Codex CLI's own resolution.
 */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * Extracts the `env_key` variable names declared by `[model_providers.*]`
 * entries in `config.toml`.
 *
 * Deliberately a tolerant scan rather than full TOML parsing: custom model
 * providers are configured as
 *
 *     [model_providers.my-proxy]
 *     name = "…"
 *     base_url = "…"
 * env_key = "MY_PROXY_API_KEY"
 *
 * and any of those keys being set is enough for Codex to authenticate. A
 * regex over the file keeps this dependency-free and catches the realistic
 * layouts; anything it misses falls back to "not authenticated", which is
 * the safe answer (the spawn is refused with instructions rather than
 * silently dying later).
 */
function configuredCredentialEnvKeys(configTomlPath: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(configTomlPath, 'utf-8');
  } catch {
    return [];
  }

  const keys: string[] = [];
  const envKeyPattern = /^\s*env_key\s*=\s*["']([^"']+)["']/gm;
  let match: RegExpExecArray | null;
  while ((match = envKeyPattern.exec(contents)) !== null) {
    keys.push(match[1]!);
  }
  return keys;
}

/**
 * Returns a human-readable reason the Codex CLI cannot run sessions, or
 * undefined when it appears to be authenticated.
 *
 * Credential sources, in the same order the Codex CLI effectively uses:
 * 1. `auth.json` in `$CODEX_HOME` (written by `codex login`)
 * 2. `OPENAI_API_KEY` / `CODEX_API_KEY` in the environment
 * 3. the `env_key` variable of any configured `[model_providers.*]` entry
 */
export function getCodexCredentialIssue(): string | undefined {
  const home = codexHome();

  if (existsSync(join(home, 'auth.json'))) {
    return undefined;
  }

  for (const envVar of OPENAI_CREDENTIAL_ENV_VARS) {
    if (process.env[envVar]) {
      return undefined;
    }
  }

  const customKeys = configuredCredentialEnvKeys(join(home, 'config.toml'));
  if (customKeys.some((key) => Boolean(process.env[key]))) {
    return undefined;
  }

  return [
    `Codex CLI is not authenticated: no ${join(home, 'auth.json')},`,
    `no ${OPENAI_CREDENTIAL_ENV_VARS.join(' or ')}, and no configured model-provider credential is set.`,
    'Run `codex login` (or export the credential for the orchestrator server process) before dispatching agents to this provider.',
  ].join(' ');
}
