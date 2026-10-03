/**
 * Codex credential check tests
 *
 * Pins the behaviour that guards against the 2026-10-03 outage: an installed
 * but unauthenticated Codex CLI starts threads fine and then fails every turn
 * with `401 Unauthorized`, which from the orchestrator's point of view looks
 * like a broken session pipeline rather than a missing credential.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodexCredentialIssue, codexHome } from './credentials.js';

describe('getCodexCredentialIssue', () => {
  const originalEnv = { ...process.env };
  let fakeCodexHome: string;

  beforeEach(() => {
    fakeCodexHome = mkdtempSync(join(tmpdir(), 'codex-creds-test-'));
    process.env.CODEX_HOME = fakeCodexHome;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(fakeCodexHome, { recursive: true, force: true });
  });

  it('reports a missing credential when auth.json is absent and no API key is set', () => {
    const issue = getCodexCredentialIssue();
    expect(issue).toBeDefined();
    expect(issue).toContain('not authenticated');
    expect(issue).toContain('codex login');
  });

  it('considers the CLI authenticated when auth.json exists (codex login)', () => {
    writeFileSync(join(fakeCodexHome, 'auth.json'), '{}');
    expect(getCodexCredentialIssue()).toBeUndefined();
  });

  it('considers the CLI authenticated when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(getCodexCredentialIssue()).toBeUndefined();
  });

  it('considers the CLI authenticated when a configured model-provider env_key is set', () => {
    writeFileSync(
      join(fakeCodexHome, 'config.toml'),
      [
        '[model_providers.internal]',
        'name = "internal"',
        'base_url = "https://internal.example/v1"',
        'env_key = "INTERNAL_API_KEY"',
        '',
      ].join('\n')
    );
    expect(getCodexCredentialIssue()).toBeDefined(); // key not set yet

    process.env.INTERNAL_API_KEY = 'secret';
    expect(getCodexCredentialIssue()).toBeUndefined();
  });

  it('uses CODEX_HOME when resolving the credential files', () => {
    expect(codexHome()).toBe(fakeCodexHome);
    expect(existsSync(join(codexHome(), 'config.toml'))).toBe(false);
  });

  it('tolerates a CODEX_HOME directory that does not exist', () => {
    process.env.CODEX_HOME = join(fakeCodexHome, 'does-not-exist');
    expect(getCodexCredentialIssue()).toBeDefined();
  });
});
