import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Tests for scripts/ensure-playwright-browsers.mjs.
 *
 * The script is exercised end-to-end as a subprocess against a fake app
 * directory: a stub `playwright/cli.js` "installs" a fake chromium_headless_shell
 * build (extraction first, INSTALLATION_COMPLETE marker last — the same
 * ordering as the real installer) and appends start/end records to a log so
 * the tests can assert how many installs ran and whether they overlapped.
 */

const SCRIPT = resolve(import.meta.dirname, 'ensure-playwright-browsers.mjs')

const FAKE_CLI = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const START = Date.now();',
  'const args = process.argv.slice(2);',
  'function note(phase) {',
  '  fs.appendFileSync(process.env.FAKE_INSTALL_LOG, JSON.stringify({',
  '    phase, pid: process.pid, start: START, end: Date.now(), args,',
  '    skipGc: process.env.PLAYWRIGHT_SKIP_BROWSER_GC,',
  '  }) + "\\n");',
  '}',
  "note('start');",
  "if (process.env.FAKE_FAIL === '1') { console.error('fake install failure'); process.exit(1); }",
  'setTimeout(() => {',
  '  try {',
  "    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;",
  "    const shellDir = path.join(browsers, 'chromium_headless_shell-9999', 'chrome-headless-shell-linux64');",
  '    fs.mkdirSync(shellDir, { recursive: true });',
  "    if (process.env.FAKE_NO_BINARY !== '1') {",
  "      fs.writeFileSync(path.join(shellDir, 'chrome-headless-shell'), 'fake-binary');",
  "      fs.chmodSync(path.join(shellDir, 'chrome-headless-shell'), 0o755);",
  '    }',
  // Marker last, exactly like the real fetcher: its presence means the
    // directory is no longer being written.
  "    fs.writeFileSync(path.join(browsers, 'chromium_headless_shell-9999', 'INSTALLATION_COMPLETE'), '');",
  "    if (!args.includes('--only-shell')) {",
  "      const fullDir = path.join(browsers, 'chromium-9999', 'chrome-linux');",
  '      fs.mkdirSync(fullDir, { recursive: true });',
  "      fs.writeFileSync(path.join(fullDir, 'chrome'), 'fake-binary');",
  "      fs.chmodSync(path.join(fullDir, 'chrome'), 0o755);",
  "      fs.writeFileSync(path.join(browsers, 'chromium-9999', 'INSTALLATION_COMPLETE'), '');",
  '    }',
  "    note('end');",
  '  } catch (error) {',
  '    console.error(error);',
  '    process.exit(1);',
  '  }',
  '}, 350);',
].join('\n')

let root: string
let appDir: string
let browsersDir: string
let installLog: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ensure-browsers-test-'))
  appDir = join(root, 'app')
  browsersDir = join(root, 'browsers')
  installLog = join(root, 'installs.log')
  mkdirSync(join(appDir, 'node_modules', 'playwright'), { recursive: true })
  mkdirSync(join(appDir, 'node_modules', 'playwright-core'), { recursive: true })
  const cli = join(appDir, 'node_modules', 'playwright', 'cli.js')
  writeFileSync(cli, FAKE_CLI)
  chmodSync(cli, 0o755)
  writeFileSync(
    join(appDir, 'node_modules', 'playwright-core', 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: '9999' },
        { name: 'chromium-headless-shell', revision: '9999' },
      ],
    })
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function runEnsure(args: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browsersDir,
      FAKE_INSTALL_LOG: installLog,
      ...extraEnv,
    },
  })
}

function readInstalls(): Array<{ phase: string; pid: number; start: number; end: number; args: string[]; skipGc?: string }> {
  try {
    return readFileSync(installLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('installs the headless shell and verifies it when missing', () => {
  const result = runEnsure(['--only-shell'])
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(existsSync(join(browsersDir, 'chromium_headless_shell-9999', 'INSTALLATION_COMPLETE'))).toBe(true)

  const installs = readInstalls().filter((entry) => entry.phase === 'start')
  expect(installs).toHaveLength(1)
  expect(installs[0].args).toEqual(['install', 'chromium', '--only-shell'])
  // Browser GC stays off so an install can never delete a build a running
  // suite is still executing.
  expect(installs[0].skipGc).toBe('1')

  // The lock must not linger behind a successful run.
  expect(existsSync(join(browsersDir, '.ensure-browsers.lock'))).toBe(false)
})

test('default mode ensures full chromium and the shell', () => {
  const result = runEnsure([])
  expect(result.status).toBe(0)
  expect(existsSync(join(browsersDir, 'chromium-9999', 'INSTALLATION_COMPLETE'))).toBe(true)
  expect(existsSync(join(browsersDir, 'chromium_headless_shell-9999', 'INSTALLATION_COMPLETE'))).toBe(true)
  expect(readInstalls().filter((e) => e.phase === 'start')[0].args).toEqual(['install', 'chromium'])
})

test('does not re-download an already present build', () => {
  expect(runEnsure(['--only-shell']).status).toBe(0)
  const second = runEnsure(['--only-shell'])
  expect(second.status).toBe(0)
  expect(second.stdout).toContain('already provisioned')
  // The installer ran exactly once across both invocations.
  expect(readInstalls().filter((e) => e.phase === 'start')).toHaveLength(1)
})

test('serializes concurrent provisioning to a single install', async () => {
  // Five processes race post-restart style: none sees a complete build at
  // start, all must succeed, and the installer may run exactly once with no
  // overlapping invocations.
  const children = Array.from({ length: 5 }, () =>
    new Promise<{ status: number | null; stderr: string }>((resolveChild) => {
      const child = spawn('node', [SCRIPT, '--only-shell'], {
        cwd: appDir,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browsersDir,
          FAKE_INSTALL_LOG: installLog,
        },
      })
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (status) => resolveChild({ status, stderr }))
    })
  )
  const results = await Promise.all(children)
  for (const result of results) {
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  }

  const starts = readInstalls().filter((e) => e.phase === 'start')
  const ends = readInstalls().filter((e) => e.phase === 'end')
  expect(starts).toHaveLength(1)
  expect(ends).toHaveLength(1)
  expect(starts[0].end).toBeLessThanOrEqual(ends[0].end)
})

test('forwards extra args and bypasses the fast path for --with-deps', () => {
  expect(runEnsure(['--only-shell']).status).toBe(0)
  const result = runEnsure(['--only-shell', '--with-deps'])
  expect(result.status).toBe(0)
  const starts = readInstalls().filter((e) => e.phase === 'start')
  expect(starts).toHaveLength(2)
  expect(starts[1].args).toEqual(['install', 'chromium', '--only-shell', '--with-deps'])
})

test('surfaces installer failures instead of letting tests hit a broken cache', () => {
  const result = runEnsure(['--only-shell'], { FAKE_FAIL: '1' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('exited with code 1')
})

test('rejects a marker without a runnable executable (partial extraction)', () => {
  const result = runEnsure(['--only-shell'], { FAKE_NO_BINARY: '1' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('provisioning incomplete')
})

test('rejects PLAYWRIGHT_BROWSERS_PATH=0', () => {
  const result = runEnsure(['--only-shell'], { PLAYWRIGHT_BROWSERS_PATH: '0' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('not supported')
})

test('fails with guidance when no Playwright CLI is resolvable', () => {
  const nowhere = join(root, 'empty-dir')
  mkdirSync(nowhere)
  const result = spawnSync('node', [SCRIPT, '--only-shell'], {
    cwd: nowhere,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browsersDir,
      FAKE_INSTALL_LOG: installLog,
      // Point the repo-root fallbacks somewhere without an app either.
      PW_ENSURE_APP_DIR: nowhere,
    },
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('cannot locate a Playwright CLI')
})
