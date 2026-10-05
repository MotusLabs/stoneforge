/**
 * Regression tests: piped CLI output must not be truncated on exit.
 *
 * `process.exit()` runs before Node has flushed the asynchronous stdout write
 * buffer, so when stdout is a pipe, output larger than the OS pipe buffer
 * (64KB on Linux) was silently cut to exactly 65,536 bytes. `sf show <id>
 * --json | jq` then received invalid JSON, and a piped read-modify-write
 * could even blank a document. See src/cli/exit.ts for the full story,
 * including the Bun-specific behaviour these tests pin down as well.
 *
 * The tests spawn the real CLI as a child process and read its stdout through
 * a pipe, which is exactly the failing scenario: the child writes ~300KB and
 * exits immediately.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_BIN = resolve(__dirname, '../bin/sf.ts');
const DIST_BIN = resolve(__dirname, '../../dist/bin/sf.js');
const DIST_EXIT = resolve(__dirname, '../../dist/cli/exit.js');
const SRC_EXIT = resolve(__dirname, 'exit.ts');

/** Pipe buffer size on Linux — the historical truncation point. */
const PIPE_BUFFER_BYTES = 65_536;
/** Payload comfortably above the pipe buffer (task requires > 200KB). */
const PAYLOAD_BYTES = 300_007;

/**
 * Upper bound for "the CLI exited instead of hanging".
 *
 * Sized for a loaded machine (el-19vmmo): under a sustained concurrent
 * turbo build on a 16-core box, a CLEAN `sf show` run has measured ~22s
 * wall clock, and a 20s ceiling killed it — failing a test whose
 * assertions all held. 45s still catches a genuine hang well inside the
 * 60s per-test timeouts; a clean run on an idle machine is ~1-2s.
 */
const EXIT_TIMEOUT_MS = 45_000;

const nodeCliAvailable = existsSync(DIST_BIN);

interface CliRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

interface RunOptions {
  cwd: string;
  /** Redirect stdout to this path instead of a pipe (the reference path). */
  stdoutFile?: string;
  timeoutMs?: number;
}

/** Spawns the CLI with the given runtime and collects everything it printed. */
function runCli(runtime: 'bun' | 'node', args: string[], options: RunOptions): Promise<CliRun> {
  return spawnWith(
    runtime === 'bun' ? ['bun', SRC_BIN, ...args] : ['node', DIST_BIN, ...args],
    options
  );
}

function spawnWith(cmd: string[], options: RunOptions): Promise<CliRun> {
  const started = Date.now();
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    stdout: options.stdoutFile ? openSync(options.stdoutFile, 'w') : 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', CI: '1' },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, options.timeoutMs ?? EXIT_TIMEOUT_MS);

  return Promise.all([
    options.stdoutFile ? Promise.resolve(new ArrayBuffer(0)) : new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, exitCode]) => {
    clearTimeout(timer);
    closeIfFd(proc.stdout);
    return {
      // With stdout redirected to a file, the file itself is the output.
      stdout: options.stdoutFile ? readFileSync(options.stdoutFile) : Buffer.from(out),
      stderr: err,
      exitCode,
      timedOut,
      durationMs: Date.now() - started,
    };
  });
}

/** Bun.spawn leaves an open fd when stdout is a file descriptor. */
function closeIfFd(stream: number | unknown): void {
  if (typeof stream === 'number') {
    try {
      closeSync(stream);
    } catch {
      // Already closed by the child exiting.
    }
  }
}

describe('CLI stdout truncation on exit (regression)', () => {
  let workspace: string;
  let documentId: string;

  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'sf-exit-test-'));
    const contentFile = join(workspace, 'big-payload.md');
    writeFileSync(contentFile, 'x'.repeat(PAYLOAD_BYTES), 'utf-8');

    // Initialise an isolated workspace (no .stoneforge anywhere above /tmp).
    const init = await runCli('bun', ['init', '--name', 'exit-test', '--preset', 'auto'], { cwd: workspace });
    expect(init.exitCode).toBe(0);

    const create = await runCli(
      'bun',
      ['document', 'create', '--title', 'Big payload', '--file', contentFile, '--type', 'markdown', '--json'],
      { cwd: workspace }
    );
    expect(create.exitCode).toBe(0);
    documentId = JSON.parse(create.stdout.toString('utf-8')).data.id;
    expect(typeof documentId).toBe('string');
  }, 60_000);

  afterAll(() => {
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  describe.each(['bun', 'node'] as const)('runtime: %s', (runtime) => {
    it.skipIf(runtime === 'node' && !nodeCliAvailable)(
      'delivers >200KB of valid JSON through a pipe without truncation',
      async () => {
        const piped = await runCli(runtime, ['show', documentId, '--json'], { cwd: workspace });
        expect(piped.timedOut).toBe(false);

        // Reference: the same command with stdout redirected to a file.
        const file = join(workspace, 'reference.json');
        const redirected = await runCli(runtime, ['show', documentId, '--json'], {
          cwd: workspace,
          stdoutFile: file,
        });
        expect(redirected.exitCode).toBe(0);

        expect(piped.exitCode).toBe(0);
        expect(redirected.stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
        // The exact regression: the piped byte count must match the file.
        expect(piped.stdout.length).toBe(redirected.stdout.length);

        const parsed = JSON.parse(piped.stdout.toString('utf-8'));
        expect(parsed.success).toBe(true);
        expect(parsed.data.id).toBe(documentId);
        expect(parsed.data.content.length).toBe(PAYLOAD_BYTES);
      },
      60_000
    );

    it.skipIf(runtime === 'node' && !nodeCliAvailable)(
      'reports a non-zero exit code through a pipe for a failing command',
      async () => {
        const piped = await runCli(runtime, ['show', 'el-doesnotexist', '--json'], { cwd: workspace });
        expect(piped.timedOut).toBe(false);
        expect(piped.exitCode).not.toBe(0);
      },
      60_000
    );

    it.skipIf(runtime === 'node' && !nodeCliAvailable)(
      'exits promptly after large output (no hang)',
      async () => {
        const piped = await runCli(runtime, ['show', documentId, '--json'], { cwd: workspace });
        expect(piped.exitCode).toBe(0);
        expect(piped.durationMs).toBeLessThan(EXIT_TIMEOUT_MS);
      },
      60_000
    );
  });
});

describe('exitGracefully() helper', () => {
  /**
   * Writes a >64KB payload to stdout and then exits through exitGracefully(),
   * in a child process, through a pipe. `extra` can leave an open handle
   * behind to prove the fallback exit still fires.
   *
   * Emission channel is runtime-specific (el-19vmmo):
   * - Node writes via `process.stdout.write` — that is the path whose
   *   buffering exitGracefully's drain (`write('', cb)`) exists to protect.
   * - Bun writes via `console.log` — the channel every real CLI command
   *   uses (cli/runner.ts outputResult). Under Bun a direct
   *   `process.stdout.write` is the documented-lossy WriteStream path
   *   (see src/cli/exit.ts: merely accessing process.stdout switches
   *   console off the fast direct-to-fd path), and no large-output command
   *   emits that way. Measured under a sustained concurrent build, piped
   *   through a slow reader: console.log + exitGracefully delivered all
   *   300,007 bytes in 40/40 runs; process.stdout.write truncated in
   *   40/40 (81,920 or 131,072 bytes) — the old probe pinned a contract
   *   nothing relies on and flaked under load.
   */
  async function runProbe(runtime: 'bun' | 'node', extra: 'clean' | 'stray-handle'): Promise<CliRun> {
    const dir = mkdtempSync(join(tmpdir(), 'sf-exit-probe-'));
    try {
      const importPath = runtime === 'bun' ? SRC_EXIT : DIST_EXIT;
      const write =
        runtime === 'bun'
          ? `console.log(${JSON.stringify('y'.repeat(PAYLOAD_BYTES - 1))});` // + \n = PAYLOAD_BYTES
          : `process.stdout.write(${JSON.stringify('y'.repeat(PAYLOAD_BYTES))});`;
      const code = [
        `import { exitGracefully } from ${JSON.stringify('file://' + importPath)};`,
        write,
        extra === 'stray-handle' ? 'setInterval(() => {}, 1000);' : '',
        'await exitGracefully(0);',
      ].join('\n');
      const script = join(dir, runtime === 'bun' ? 'probe.ts' : 'probe.mjs');
      writeFileSync(script, code, 'utf-8');
      return await spawnWith(runtime === 'bun' ? ['bun', script] : ['node', script], { cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(!nodeCliAvailable)(
    'node: flushes a >64KB buffered write before exiting',
    async () => {
      const result = await runProbe('node', 'clean');
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(PAYLOAD_BYTES);
    },
    30_000
  );

  it.skipIf(!nodeCliAvailable)(
    'node: still exits (with everything flushed) when a handle keeps the event loop alive',
    async () => {
      const result = await runProbe('node', 'stray-handle');
      expect(result.timedOut).toBe(false);   // would be true if it hung
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(PAYLOAD_BYTES);
      // Sized for a loaded machine (el-19vmmo): node startup + a 300KB piped
      // write can exceed 5s of wall clock under a concurrent build while
      // still exiting promptly — the 250ms forced-exit grace remains three
      // orders of magnitude below this bound. A true hang is caught
      // separately by `timedOut` (EXIT_TIMEOUT_MS) and the per-test timeout.
      expect(result.durationMs).toBeLessThan(15_000);
    },
    30_000
  );

  it(
    'bun: flushes a >64KB write on exit',
    async () => {
      const result = await runProbe('bun', 'clean');
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(PAYLOAD_BYTES);
    },
    30_000
  );
});
