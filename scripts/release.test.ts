import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { validateRelease } from './release'

let root: string
const source = import.meta.dirname
function write(path: string, content: string) {
  writeFileSync(resolve(root, path), content)
}
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'release-test-'))
  for (const dir of ['scripts', '.changeset', 'packages/smithy', 'apps/smithy-web']) {
    mkdirSync(resolve(root, dir), { recursive: true })
  }
  for (const file of ['release.ts', 'motuslab-release-notes.sh', 'motuslab-version.sh']) {
    cpSync(resolve(source, file), resolve(root, 'scripts', file))
  }
  write('package.json', '{"private":true,"packageManager":"pnpm@8.15.5"}')
  write('pnpm-workspace.yaml', "packages:\n  - packages/*\n  - apps/*\n")
  write('.changeset/config.json', JSON.stringify({ fixed: [['@stoneforge/smithy', '@stoneforge/smithy-web']] }))
  write('.changeset/README.md', 'Changesets instructions')
  write('packages/smithy/package.json', '{"name":"@stoneforge/smithy","version":"1.26.0","private":true}')
  write('apps/smithy-web/package.json', '{"name":"@stoneforge/smithy-web","version":"1.26.0","private":true}')
  write('packages/smithy/CHANGELOG.md', '# Smithy\n\n## 1.26.0\n\n- Changesets release.\n\n## 1.25.0\n\n- Old release.\n')
  execFileSync('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: root })
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'version release'], { cwd: root })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function cli(args: string[]) {
  const result = spawnSync(process.execPath, ['run', 'scripts/release.ts', ...args], { cwd: root, encoding: 'utf8' })
  return { code: result.status, output: result.stdout + result.stderr }
}
function commit() {
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture change'], { cwd: root })
}

test('validates Changesets output without bumping or rewriting the lockfile', () => {
  const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')
  expect(validateRelease(root)).toBe('1.26.0')
  expect(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
})
for (const args of [[], ['--motuslab', '2']]) {
  test(`dry run ${args.join(' ')} preserves version and creates no tags`, () => {
    const result = cli([...args, '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.output).toContain(`git tag v1.26.0-motuslab.${args.length ? 2 : 1}`)
    expect(result.output).toContain('[dry-run] pnpm run build')
    expect(execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8' })).toBe('')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
  })
}
for (const args of [['patch'], ['minor'], ['major'], ['--bump', 'patch']]) {
  test(`rejects removed bump arguments: ${args.join(' ')}`, () => {
    expect(cli([...args, '--dry-run']).output).toContain('Bump mode was removed')
    expect(cli(args).code).toBe(1)
  })
}
for (const dryRun of [false, true]) {
  test(`pending changesets block ${dryRun ? 'dry run' : 'release'} before building`, () => {
    write('.changeset/pending.md', '---\n"@stoneforge/smithy": patch\n---\nFix\n')
    commit()
    const result = cli(dryRun ? ['--dry-run'] : [])
    expect(result.code).toBe(1)
    expect(result.output).toContain('Pending changesets')
    expect(result.output).not.toContain('Building all packages')
  })
}
test('rejects an app left at the old version', () => {
  write('apps/smithy-web/package.json', '{"name":"@stoneforge/smithy-web","version":"1.25.0"}')
  expect(() => validateRelease(root)).toThrow('not at release version 1.26.0')
})
for (const body of ['## 1.25.0\n\n- Old only.\n', '## 1.26.0\n\n## 1.25.0\n\n- Old only.\n']) {
  test('rejects missing or empty release notes', () => {
    write('packages/smithy/CHANGELOG.md', body)
    expect(() => validateRelease(root)).toThrow()
  })
}
test('rejects a stale lockfile without changing it', () => {
  write('apps/smithy-web/package.json', '{"name":"@stoneforge/smithy-web","version":"1.26.0","dependencies":{"missing-fixture-dependency":"1.0.0"}}')
  const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')
  expect(() => validateRelease(root)).toThrow()
  expect(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
})
test('release notes use the version already selected by Changesets', () => {
  const notes = execFileSync('bash', [resolve(root, 'scripts/motuslab-release-notes.sh'), 'v1.26.0-motuslab.2'], { encoding: 'utf8' })
  expect(notes).toContain('1.26.0+motuslab2')
  expect(notes).toContain('Changesets release.')
  expect(notes).not.toContain('Old release.')
})

test('real Changesets version consumes changesets and permits a single version release', () => {
  const config = JSON.parse(readFileSync(resolve(source, '../.changeset/config.json'), 'utf8'))
  config.fixed = [['@stoneforge/smithy', '@stoneforge/smithy-web']]
  write('.changeset/config.json', JSON.stringify(config))
  write('.changeset/release.md', '---\n"@stoneforge/smithy": patch\n---\nReal Changesets release.\n')
  expect(() => validateRelease(root)).toThrow('Pending changesets')
  execFileSync('node', [resolve(source, '../node_modules/@changesets/cli/bin.js'), 'version'], { cwd: root })
  execFileSync('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: root })
  commit()
  expect(validateRelease(root)).toBe('1.26.1')
  const result = cli(['--dry-run'])
  expect(result.code).toBe(0)
  expect(result.output).toContain('git tag v1.26.1-motuslab.1')
  const notes = execFileSync('bash', [resolve(root, 'scripts/motuslab-release-notes.sh'), 'v1.26.1-motuslab.1'], { encoding: 'utf8' })
  expect(notes).toContain('Real Changesets release.')
})

test('missing lockfile is refused without creating one', () => {
  rmSync(resolve(root, 'pnpm-lock.yaml'))
  expect(() => validateRelease(root)).toThrow('Missing pnpm-lock.yaml')
  expect(() => readFileSync(resolve(root, 'pnpm-lock.yaml'))).toThrow()
})
