import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

interface PackageInfo {
  name: string
  dir: string
}

type BumpType = 'patch' | 'minor' | 'major'

interface CliArgs {
  bump: BumpType | undefined
  dryRun: boolean
  motuslab: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')

const PACKAGES: PackageInfo[] = [
  { name: '@stoneforge/core', dir: 'packages/core' },
  { name: '@stoneforge/ui', dir: 'packages/ui' },
  { name: '@stoneforge/storage', dir: 'packages/storage' },
  { name: '@stoneforge/quarry', dir: 'packages/quarry' },
  { name: '@stoneforge/shared-routes', dir: 'packages/shared-routes' },
  { name: '@stoneforge/smithy', dir: 'packages/smithy' },
]

/** Package that owns the MotusLab release version (see release-pipeline spec). */
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

function writeJson(path: string, data: Record<string, any>) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

// ─── Version logic ───────────────────────────────────────────────────────────

function bumpVersion(current: string, type: BumpType): string {
  const [major, minor, patch] = current.split('.').map(Number)
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
  }
}

function motuslabTag(version: string, motuslab: number): string {
  return `v${version}-motuslab.${motuslab}`
}

// ─── CLI parsing ─────────────────────────────────────────────────────────────

function usage(): string {
  return [
    'Usage: bun run scripts/release.ts [patch|minor|major] [options]',
    '',
    'Bumps workspace package versions, commits, and creates/pushes the MotusLab tag',
    '  v<version>-motuslab.<n>',
    '',
    'Options:',
    '  --motuslab <n>   MotusLab release counter for the tag (default: 1)',
    '  --dry-run        Print the commands without running them',
    '',
    'This script never publishes to npm or any other third-party service.',
  ].join('\n')
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let bump: BumpType | undefined
  let dryRun = false
  let motuslab = 1

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case 'patch':
      case 'minor':
      case 'major':
        if (bump) fail(`Multiple bump types given: ${bump}, ${arg}`)
        bump = arg
        break
      case '--bump': {
        const value = args[++i] as BumpType
        if (!['patch', 'minor', 'major'].includes(value)) {
          fail(`Invalid bump type: ${value}. Must be patch, minor, or major.`)
        }
        if (bump) fail(`Multiple bump types given: ${bump}, ${value}`)
        bump = value
        break
      }
      case '--motuslab': {
        const value = args[++i]
        if (!value) fail('--motuslab requires a positive integer')
        motuslab = Number(value)
        if (!Number.isInteger(motuslab) || motuslab < 1) {
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

  return { bump, dryRun, motuslab }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs()
  const totalSteps = 5

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

  // ── 2. Compute version ────────────────────────────────────────────────────

  const sourcePkgPath = resolve(ROOT, VERSION_SOURCE, 'package.json')
  const currentVersion = readJson(sourcePkgPath).version as string
  const newVersion = opts.bump ? bumpVersion(currentVersion, opts.bump) : currentVersion
  const tag = motuslabTag(newVersion, opts.motuslab)

  if (opts.bump) {
    step(2, totalSteps, `Bumping ${bold(currentVersion)} → ${bold(newVersion)} (${opts.bump})`)
  } else {
    step(2, totalSteps, `Releasing ${bold(currentVersion)} (no version bump)`)
  }
  ok(`MotusLab tag ${bold(tag)}`)

  // ── 3. Update versions ────────────────────────────────────────────────────

  step(3, totalSteps, 'Updating package versions...')

  for (const pkg of PACKAGES) {
    const pkgPath = resolve(ROOT, pkg.dir, 'package.json')
    const pkgJson = readJson(pkgPath)
    if (opts.bump) {
      const from = pkgJson.version as string
      pkgJson.version = newVersion
      if (!opts.dryRun) writeJson(pkgPath, pkgJson)
      ok(`${pkg.name} ${from} → ${newVersion}`)
    } else {
      ok(`${pkg.name} stays at ${pkgJson.version}`)
    }
  }

  // ── 4. Build ──────────────────────────────────────────────────────────────

  step(4, totalSteps, 'Building all packages...')

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

  // ── 5. Git commit & tag ───────────────────────────────────────────────────

  step(5, totalSteps, 'Git commit & tag...')

  if (opts.bump) {
    const filesToAdd = PACKAGES.map((p) => `${p.dir}/package.json`)

    if (opts.dryRun) {
      console.log(`  ${dim(`[dry-run] git add ${filesToAdd.join(' ')}`)}`)
      console.log(`  ${dim(`[dry-run] git commit -m "release: ${tag}"`)}`)
      console.log(`  ${dim(`[dry-run] git tag ${tag}`)}`)
      console.log(`  ${dim(`[dry-run] git push origin HEAD && git push origin ${tag}`)}`)
    } else {
      run(`git add ${filesToAdd.join(' ')}`)
      run(`git commit -m "release: ${tag}"`)
      run(`git tag ${tag}`)
      run('git push origin HEAD')
      run(`git push origin ${tag}`)
      ok(`Committed and tagged ${bold(tag)}`)
    }
  } else {
    if (opts.dryRun) {
      console.log(`  ${dim(`[dry-run] git tag ${tag}`)}`)
      console.log(`  ${dim(`[dry-run] git push origin ${tag}`)}`)
    } else {
      run(`git tag ${tag}`)
      run(`git push origin ${tag}`)
      ok(`Tagged ${bold(tag)}`)
    }
  }

  console.log(
    `\n${green(bold('Done!'))} Prepared MotusLab release ${bold(tag)}. ` +
      `Nothing was published to npm or any third-party service. ` +
      `The release workflow publishes the .deb to GitHub Releases only.\n`,
  )
}

main()
