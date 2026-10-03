import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean
  motuslab: number
}

const ROOT = resolve(import.meta.dirname, '..')
const VERSION_SOURCE = 'packages/smithy'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

function step(n: number, total: number, msg: string) {
  console.log(`\n${bold(`[${n}/${total}]`)} ${msg}`)
}

function ok(msg: string) {
  console.log(`  ${green('✓')} ${msg}`)
}

function fail(msg: string): never {
  console.error(`  ${red('✗')} ${msg}`)
  process.exit(1)
}

function run(cmd: string, opts: { cwd?: string; dryRun?: boolean } = {}): string {
  if (opts.dryRun) {
    console.log(`  ${dim(`[dry-run] ${cmd}`)}`)
    return ''
  }
  return execSync(cmd, { cwd: opts.cwd ?? ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

/** Validate the committed Changesets output before any build or tag command. */
export function validateRelease(root: string): string {
  const pending = readdirSync(resolve(root, '.changeset'))
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
  if (pending.length) {
    throw new Error(`Pending changesets: ${pending.join(', ')}. Run pnpm changeset version first.`)
  }
  const version = readJson(resolve(root, VERSION_SOURCE, 'package.json')).version
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`)
  }
  const fixed = readJson(resolve(root, '.changeset/config.json')).fixed.flat() as string[]
  const manifests = ['packages', 'apps'].flatMap((base) =>
    readdirSync(resolve(root, base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(root, base, entry.name, 'package.json'))
      .filter((path) => existsSync(path)),
  )
  for (const name of fixed) {
    const path = manifests.find((path) => readJson(path).name === name)
    if (!path) throw new Error(`Missing fixed-group package: ${name}`)
    if (readJson(path).version !== version) {
      throw new Error(`${name} is not at release version ${version}. Run pnpm changeset version first.`)
    }
  }
  // Use the same section extraction and nonempty-body check as release CI.
  const { GITHUB_OUTPUT: _githubOutput, ...env } = process.env
  execFileSync('bash', [resolve(root, 'scripts/motuslab-release-notes.sh'), motuslabTag(version, 1)],
    { cwd: root, stdio: 'pipe', env })
  if (!existsSync(resolve(root, 'pnpm-lock.yaml'))) {
    throw new Error('Missing pnpm-lock.yaml. Refresh and commit the lockfile before releasing.')
  }
  // Frozen + lockfile-only validates all importers without installing packages,
  // running lifecycle scripts, accessing the network, or rewriting the lockfile.
  execFileSync('pnpm', ['install', '--lockfile-only', '--frozen-lockfile', '--offline', '--ignore-scripts'],
    { cwd: root, stdio: 'pipe', env: { ...env, COREPACK_ENABLE_AUTO_PIN: '0' } })
  return version
}

function motuslabTag(version: string, motuslab: number): string {
  return `v${version}-motuslab.${motuslab}`
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function usage(): string {
  return [
    'Usage: bun run scripts/release.ts [options]',
    '',
    'Validates committed Changesets versions and creates/pushes the MotusLab tag',
    '  v<version>-motuslab.<n>',
    '',
    'First run pnpm changeset version, refresh the lockfile, and commit/push the result.',
    '',
    'Options:',
    '  --motuslab <n>   MotusLab release counter for the tag (default: 1)',
    '  --dry-run        Validate state and print build/tag/push commands without running them',
    '',
    'This script never publishes to npm or any other third-party service.',
  ].join('\n')
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let dryRun = false
  let motuslab = 1

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case 'patch':
      case 'minor':
      case 'major':
      case '--bump':
        fail('Bump mode was removed. Run pnpm changeset version, refresh the lockfile, and commit/push before releasing.')
      case '--motuslab': {
        const value = args[++i]
        if (!value) fail('--motuslab requires a positive integer')
        motuslab = Number(value)
        if (!Number.isSafeInteger(motuslab) || motuslab < 1) {
          fail(`Invalid --motuslab value: ${value}. Must be a positive integer.`)
        }
        break
      }
      case '--dry-run':
        dryRun = true
        break
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
        break
      default:
        console.error(usage())
        fail(`Unknown argument: ${arg}`)
    }
  }

  return { dryRun, motuslab }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs()
  const totalSteps = 3

  if (opts.dryRun) {
    console.log(bold('\n🏜️  DRY RUN — no changes will be made\n'))
  }

  // ── 1. Preflight ──────────────────────────────────────────────────────────

  step(1, totalSteps, 'Preflight checks...')

  const status = run('git status --porcelain')
  if (status) {
    fail('Git working tree is not clean. Commit or stash changes first.')
  }
  ok('Git working tree clean')

  let version: string
  try {
    version = validateRelease(ROOT)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const output = (error as { stdout?: Buffer }).stdout?.toString() ?? ''
    fail(`Release state is not ready: ${detail}\n${output}Run pnpm changeset version and pnpm install --lockfile-only, then commit/push the result.`)
  }
  ok('Changesets, workspace versions, release notes and frozen lockfile validated')
  const tag = motuslabTag(version, opts.motuslab)
  ok(`MotusLab tag ${bold(tag)}`)

  // ── 2. Build ──────────────────────────────────────────────────────────────

  step(2, totalSteps, 'Building all packages...')

  if (opts.dryRun) {
    console.log(`  ${dim('[dry-run] pnpm run build')}`)
    console.log(`  ${dim('[dry-run] pnpm --filter @stoneforge/smithy-web run build:web')}`)
  } else {
    try {
      execSync('pnpm run build', { cwd: ROOT, stdio: 'inherit' })
      ok('Build succeeded')
    } catch {
      fail('Build failed. Fix errors before releasing.')
    }

    // Build the web UI and copy assets into packages/smithy/web/ so they are
    // present for the MotusLab .deb packaging step (used by `sf serve`).
    try {
      execSync('pnpm --filter @stoneforge/smithy-web run build:web', { cwd: ROOT, stdio: 'inherit' })
      ok('Web UI built and copied to packages/smithy/web/')
    } catch {
      fail('Web UI build failed. Fix errors before releasing.')
    }
  }

  step(3, totalSteps, 'Git tag...')
  run(`git tag ${tag}`, { dryRun: opts.dryRun })
  run(`git push origin ${tag}`, { dryRun: opts.dryRun })
  ok(`Prepared tag ${bold(tag)}`)

  console.log(
    `\n${green(bold('Done!'))} Prepared MotusLab release ${bold(tag)}. ` +
      `Nothing was published to npm or any third-party service. ` +
      `The release workflow publishes the .deb to GitHub Releases only.\n`,
  )
}

if (import.meta.main) main()
