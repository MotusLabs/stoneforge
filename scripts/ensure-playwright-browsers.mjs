#!/usr/bin/env node
/**
 * Ensure the Playwright browser builds this repository's suites spawn are
 * present and complete in the shared browsers directory, serialized across
 * every concurrent process in the workspace.
 *
 * Why this exists (details in the workspace runbook "Playwright browser cache
 * in the workspace", doc el-2423ix):
 *
 * - `/opt/playwright` (PLAYWRIGHT_BROWSERS_PATH) lives on the container
 *   overlay, not on the persistent `/home/coder` mount. Builds installed at
 *   runtime are therefore wiped by every pod restart, while image-baked
 *   builds survive. The repo's Playwright needs a build the image does not
 *   ship, so the first browser run after each restart must re-provision it.
 * - Playwright extracts downloads directly into the final browser directory
 *   and writes the INSTALLATION_COMPLETE marker only afterwards. Its
 *   `__dirlock` serializes installers against each other, but nothing
 *   serializes installers against test runners that are already spawning
 *   browsers. Two suites starting around the same restart race: one spawns
 *   the half-extracted binary and dies with `ETXTBSY` on spawn or
 *   "V8 startup snapshot" load errors — before any test executes.
 *
 * This script closes that gap for every entry point that uses it:
 *
 * 1. Marker fast path — when the target build directory already has its
 *    INSTALLATION_COMPLETE marker (and the executable is runnable), exit
 *    immediately. Repeated runs never re-download a present build.
 * 2. Exclusive lockfile inside the browsers directory — shared by every
 *    worktree and process in the pod because the browsers directory itself
 *    is shared. Waits (with staleness recovery) instead of racing.
 * 3. Double-checked install — re-verify after acquiring the lock so N
 *    waiting processes do not run N installs; the winner installs via the
 *    repo-local Playwright CLI with the browser GC disabled
 *    (PLAYWRIGHT_SKIP_BROWSER_GC=1) so an install can never garbage-collect
 *    a build directory another running suite is still executing.
 * 4. Verification — the marker and the executable are checked before
 *    returning, so a partial download surfaces here as a provisioning error
 *    instead of as ETXTBSY deep inside a test.
 *
 * Usage:
 *   node scripts/ensure-playwright-browsers.mjs [--only-shell] [forwarded args]
 *
 *   --only-shell  ensure only chromium_headless_shell-<rev> (headless suites)
 *   (default)     ensure chromium-<rev> and the headless shell (headed test:ui)
 *
 * Any other arguments (e.g. --with-deps, --force, --dry-run) are forwarded to
 * `playwright install`; --with-deps, --force and --dry-run also disable the
 * fast path so the CLI always runs.
 *
 * The browsers directory is resolved with Playwright's own semantics:
 * PLAYWRIGHT_BROWSERS_PATH if set (relative paths resolve against INIT_CWD),
 * otherwise the platform cache directory (`.../ms-playwright`). The value "0"
 * (browsers bundled inside the package tree) is rejected — the locking and
 * verification model here assumes a shared, writable browsers directory.
 *
 * Exit code 0 means the browsers are present and verified. Non-zero means
 * provisioning failed; do not start browser tests.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

const LOCK_FILE_NAME = '.ensure-browsers.lock';
const LOCK_WAIT_MS = 10 * 60 * 1000; // wait up to 10 minutes for another installer
const LOCK_STALE_MS = 15 * 60 * 1000; // steal a lock whose holder is long dead
const LOCK_POLL_MS = 200;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000; // playwright retries downloads internally

const FORWARDED_BUT_NO_FAST_PATH = new Set(['--with-deps', '--force', '--dry-run']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function log(message) {
  process.stdout.write(`[ensure-playwright-browsers] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[ensure-playwright-browsers] ERROR: ${message}\n`);
}

function parseArgs(argv) {
  const parsed = { shellOnly: false, forwarded: [], alwaysInvoke: false };
  for (const arg of argv) {
    if (arg === '--only-shell') {
      parsed.shellOnly = true;
    } else {
      parsed.forwarded.push(arg);
      if (FORWARDED_BUT_NO_FAST_PATH.has(arg)) parsed.alwaysInvoke = true;
    }
  }
  return parsed;
}

/**
 * Locate an app directory whose node_modules contains the Playwright CLI.
 * The CLI is resolved from the app that will run the tests (never a global
 * install) because each worktree's lockfile decides which browser revision
 * is required.
 */
function resolveAppDir() {
  const candidates = [];
  if (process.env.PW_ENSURE_APP_DIR) candidates.push(process.env.PW_ENSURE_APP_DIR);
  candidates.push(process.cwd());
  // Repo-root fallbacks are only considered when already running inside this
  // repository (e.g. invoked from the root), never for unrelated callers.
  const cwdInsideRepo = process.cwd() === REPO_ROOT || process.cwd().startsWith(REPO_ROOT + '/');
  if (cwdInsideRepo) {
    for (const app of ['quarry-web', 'smithy-web']) {
      candidates.push(join(REPO_ROOT, 'apps', app));
    }
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', 'playwright', 'cli.js'))) {
      return resolve(candidate);
    }
  }
  throw new Error(
    `cannot locate a Playwright CLI. Run this script from an app directory ` +
      `(apps/quarry-web or apps/smithy-web) after \`pnpm install --frozen-lockfile\`, ` +
      `or set PW_ENSURE_APP_DIR to an app directory. Tried: ${candidates.join(', ')}`
  );
}

/** Read the browser revisions the app-local Playwright will request. */
function readRevisions(appDir) {
  const cliPath = join(appDir, 'node_modules', 'playwright', 'cli.js');
  const browsersJsonCandidates = [
    join(dirname(realpathSync(cliPath)), '..', 'playwright-core', 'browsers.json'),
    join(appDir, 'node_modules', 'playwright-core', 'browsers.json'),
  ];
  let browsersJson;
  for (const candidate of browsersJsonCandidates) {
    if (existsSync(candidate)) {
      browsersJson = candidate;
      break;
    }
  }
  if (!browsersJson) {
    throw new Error(
      `cannot find playwright-core/browsers.json near ${cliPath}; ` +
        `run \`pnpm install --frozen-lockfile\` first`
    );
  }
  const descriptors = JSON.parse(readFileSync(browsersJson, 'utf8')).browsers;
  const revisions = {};
  for (const name of ['chromium', 'chromium-headless-shell']) {
    const descriptor = descriptors.find((d) => d.name === name);
    if (!descriptor) throw new Error(`${name} is missing from ${browsersJson}`);
    revisions[name] = descriptor.revision;
  }
  return revisions;
}

/** Mirror playwright-core's registryDirectory() resolution. */
function resolveBrowsersDirectory() {
  const envDefined = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envDefined === '0') {
    throw new Error(
      'PLAYWRIGHT_BROWSERS_PATH=0 (browsers inside the package tree) is not ' +
        'supported; use a shared browsers directory so installs can be serialized'
    );
  }
  let result;
  if (envDefined) {
    result = envDefined;
  } else {
    let cacheDirectory;
    if (process.platform === 'linux') {
      cacheDirectory = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    } else if (process.platform === 'darwin') {
      cacheDirectory = join(homedir(), 'Library', 'Caches');
    } else if (process.platform === 'win32') {
      cacheDirectory = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    } else {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    result = join(cacheDirectory, 'ms-playwright');
  }
  if (!isAbsolute(result)) {
    result = resolve(process.env.INIT_CWD || process.cwd(), result);
  }
  return result;
}

/** The directories `playwright install chromium [--only-shell]` populates. */
function buildTargets(browsersDir, revisions, shellOnly) {
  const targets = [
    {
      name: `chromium_headless_shell-${revisions['chromium-headless-shell']}`,
      dir: join(browsersDir, `chromium_headless_shell-${revisions['chromium-headless-shell']}`),
      executableName: 'chrome-headless-shell',
    },
  ];
  if (!shellOnly) {
    targets.push({
      name: `chromium-${revisions.chromium}`,
      dir: join(browsersDir, `chromium-${revisions.chromium}`),
      executableName: 'chrome',
    });
  }
  return targets;
}

/** Find `executableName` anywhere under `dir` (bounded) and check it is runnable. */
function findExecutable(dir, executableName) {
  const queue = [dir];
  let entries;
  while (queue.length) {
    const current = queue.shift();
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && entry.name === executableName) {
        try {
          accessSync(fullPath, fsConstants.X_OK);
          return fullPath;
        } catch {
          return null;
        }
      } else if (entry.isDirectory() && entry.name !== '.') {
        queue.push(fullPath);
      }
    }
  }
  return null;
}

/**
 * A target is complete when the marker exists. The marker is written strictly
 * after extraction finishes, so its presence means no other process is
 * writing into the directory. On non-Darwin platforms the executable must
 * also exist and be runnable (Darwin bundles are app packages with
 * platform-specific layouts; there the marker is authoritative).
 */
function isComplete(target) {
  if (!existsSync(join(target.dir, 'INSTALLATION_COMPLETE'))) return false;
  if (process.platform === 'darwin') return true;
  return findExecutable(target.dir, target.executableName) !== null;
}

function describeIncomplete(targets) {
  return targets
    .filter((t) => !isComplete(t))
    .map((t) => `${t.name} (missing INSTALLATION_COMPLETE or executable in ${t.dir})`)
    .join('; ');
}

/** Exclusive lock via O_EXCL create, with stale-holder recovery. */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      try {
        writeFileSync(lockPath, `${process.pid}\n`);
      } catch {
        // Best effort — the file's existence is the lock, not its content.
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone; nothing to release.
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let mtimeMs;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        continue; // Released between open and stat; retry immediately.
      }
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        log(`stealing stale lock ${lockPath} (holder died; held for over ${Math.round(LOCK_STALE_MS / 60000)} min)`);
        try {
          unlinkSync(lockPath);
        } catch {
          // Another waiter stole it first; that is fine.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${Math.round(LOCK_WAIT_MS / 60000)} min waiting for lock ${lockPath}; ` +
            `another process is provisioning browsers. If it is stuck, delete the lock file and rerun.`
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * Ensure the browser builds are present and verified. Returns an exit code.
 * Exported for tests and programmatic use; the CLI entry point below calls it.
 */
export async function ensurePlaywrightBrowsers(argv = []) {
  const { shellOnly, forwarded, alwaysInvoke } = parseArgs(argv);
  const appDir = resolveAppDir();
  const revisions = readRevisions(appDir);
  const browsersDir = resolveBrowsersDirectory();
  const targets = buildTargets(browsersDir, revisions, shellOnly);
  const cliPath = join(appDir, 'node_modules', 'playwright', 'cli.js');

  if (!alwaysInvoke && targets.every(isComplete)) {
    log(`${targets.map((t) => t.name).join(', ')} already provisioned in ${browsersDir}`);
    return 0;
  }

  mkdirSync(browsersDir, { recursive: true });
  const release = acquireLock(join(browsersDir, LOCK_FILE_NAME));
  try {
    // Double-checked: the lock winner may have finished while we waited.
    if (!alwaysInvoke && targets.every(isComplete)) {
      log(`${targets.map((t) => t.name).join(', ')} provisioned by a concurrent process`);
      return 0;
    }

    const args = ['install', 'chromium', ...(shellOnly ? ['--only-shell'] : []), ...forwarded];
    log(`running ${cliPath} ${args.join(' ')} (serialized via lock; browser GC disabled)`);
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
      stdio: 'inherit',
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (result.error) {
      throw new Error(`failed to run playwright install: ${result.error.message}`);
    }
    if (result.signal) {
      throw new Error(
        `playwright ${args.join(' ')} terminated by ${result.signal} after ` +
          `${Math.round(INSTALL_TIMEOUT_MS / 60000)} min (hung download?)`
      );
    }
    if (result.status !== 0) {
      throw new Error(`playwright ${args.join(' ')} exited with code ${result.status}`);
    }

    const incomplete = describeIncomplete(targets);
    if (incomplete) {
      throw new Error(
        `provisioning incomplete after install: ${incomplete}. ` +
          `Delete the listed directories and rerun; do not start browser tests against them.`
      );
    }
    log(`${targets.map((t) => t.name).join(', ')} provisioned and verified`);
    return 0;
  } finally {
    release();
  }
}

async function main() {
  try {
    process.exitCode = await ensurePlaywrightBrowsers(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    process.exitCode = 1;
  }
}

// CLI entry point guard (works when invoked directly, not when imported).
let invokedAsCli = false;
try {
  invokedAsCli = process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_PATH;
} catch {
  invokedAsCli = false;
}
if (invokedAsCli) {
  await main();
}
