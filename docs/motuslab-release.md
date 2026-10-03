# Releasing and Installing MotusLab Builds

MotusLab releases publish only to GitHub Releases on
[MotusLabs/stoneforge](https://github.com/MotusLabs/stoneforge/releases).
No npm/registry publishing, Cloudflare deployment or external hosting is
allowed. Downloading build inputs is allowed. The release workflow temporarily
stores the package in this repository's Actions artifacts (seven-day retention).
See the MotusLab Ubuntu Release Spec (`el-12jf6c`) and Packaging Reference
(`el-41lvpy`) for design and implementation details.

## Install and upgrade

Supported targets are Ubuntu 22.04 and 24.04 LTS, amd64. The package bundles
Node.js, production dependencies, native modules and the smithy web UI under
`/opt/stoneforge`; `/usr/bin/sf` and `/usr/bin/stoneforge` launch that runtime.
Git and standard Ubuntu libraries are package dependencies. No separate Node.js,
npm, pnpm or Bun is needed to run the installed CLI.

Choose an existing release and download its `.deb` and `SHA256SUMS` into a fresh
directory. This example uses tag `v1.25.0-motuslab.1`; substitute your chosen tag
and corresponding Debian version throughout:

```bash
curl -fLO 'https://github.com/MotusLabs/stoneforge/releases/download/v1.25.0-motuslab.1/stoneforge_1.25.0+motuslab1_amd64.deb'
curl -fLO 'https://github.com/MotusLabs/stoneforge/releases/download/v1.25.0-motuslab.1/SHA256SUMS'
sha256sum -c SHA256SUMS
# Continue only if verification succeeds
sudo apt install ./stoneforge_1.25.0+motuslab1_amd64.deb
sf --version
type -a sf stoneforge
```

For an upgrade, repeat the download and checksum check for the newer build,
then `sudo apt install ./stoneforge_<ver>_amd64.deb` using its actual filename.
There is no apt repository, so `apt upgrade` alone will not fetch new builds.
Install, upgrade and `sudo apt purge stoneforge` preserve user workspaces and
configuration. Stop running servers/agents before upgrading, then restart them.

This fork no longer publishes npm packages. An npm-installed `sf` earlier on
`PATH` shadows `/usr/bin/sf`, including when agents invoke it. Remove the old
global installation using its original package manager or adjust `PATH`, run
`hash -r`, and check `command -v sf` resolves to `/usr/bin/sf`. A system Node.js
on `PATH` does not change the runtime used by the Debian launchers.

## Cut a release

Use a clean checkout of the intended release commit in MotusLabs/stoneforge,
with dependencies installed (pnpm 8.15.5, Node 22, Bun), permission to push to
that repository, and passing CI. Verify `git remote -v` points to MotusLabs.
Do not run release commands while implementing or reviewing documentation.

1. Run `pnpm changeset version` to consume pending changesets, update versions
   and generate package changelogs. Review the result, including the matching
   `## <x.y.z>` section in `packages/smithy/CHANGELOG.md`, then commit all
   version/changelog/lockfile changes and push the commit. Changesets has
   `commit: false`; the release script requires a clean working tree.
2. Run `bun run scripts/release.ts <bump> --motuslab <n>`, where the optional
   `<bump>` is `patch`, `minor` or `major`, and `<n>` is a positive integer
   (default 1). **Usually omit `<bump>` after Changesets has already selected
   the release version:** `bun run scripts/release.ts --motuslab 1`.
   Supplying a bump increases the current smithy version again, rewrites only
   the six library package manifests, and does not generate changelogs or
   update the lockfile/apps. If intentionally using that mode, ensure all
   versions, lockfile and the final smithy changelog section are aligned;
   otherwise the workflow's frozen install or release-note generation can fail.
3. The script builds packages and the smithy web UI, creates
   `v<x.y.z>-motuslab.<n>`, and **pushes that tag itself** with
   `git push origin v<x.y.z>-motuslab.<n>`. In bump mode it also commits the six
   manifests and pushes `HEAD` before the tag. In no-bump mode it only pushes
   the tag, so push your prepared version commit first. No separate tag push
   is needed after a successful script run.
4. Watch `Release (MotusLab)` in Actions, then verify the Release assets and
   install on a real supported Ubuntu PC. Do not create/upload assets manually.

`x.y.z` must equal `packages/smithy/package.json` at the tagged commit.
The tag `v1.25.0-motuslab.2` becomes Debian version `1.25.0+motuslab2` and
filename `stoneforge_1.25.0+motuslab2_amd64.deb`. Counters have no leading zeros.
The CLI reports the app version from quarry, so keep workspace versions aligned.

To inspect the script safely on a clean tree:

```bash
bun run scripts/release.ts --help
bun run scripts/release.ts --motuslab 2 --dry-run
bun run scripts/release.ts patch --motuslab 2 --dry-run
```

`--dry-run` prints build/commit/tag/push commands without performing them.

## What the workflow does

`.github/workflows/release-motuslab.yml` runs for `v*-motuslab.*` tag pushes or
manual dispatch with the required `tag` input. All jobs check out that tag.

- Build on Ubuntu 22.04: validate tag against the manifest before building,
  install dependencies with the frozen lockfile, audit workflows for forbidden
  publishing, build one `.deb` plus `SHA256SUMS`, verify checksums, and store
  the repository-scoped artifact.
- Smoke-test that exact artifact on Ubuntu 22.04 and 24.04: install, check
  bundled runtime/version, initialize a workspace, serve health and web UI,
  audit outbound connections, spawn a PTY, and purge while preserving user data.
- Publish only after both smoke jobs succeed: download the same artifact,
  verify checksums, generate notes from the matching smithy changelog section,
  refuse to overwrite an existing release, create the GitHub Release with the
  `.deb` and `SHA256SUMS`, then download assets back and verify integrity.

Actions are pinned to commit SHAs. Jobs have `contents: read`; only publish
has `contents: write`. CI's separate package job builds and smoke-tests on
Ubuntu 22.04 without uploading anything. Nothing publishes to third parties.

## Roll back a bad release

Stop or cancel any in-flight run for the bad tag before deleting it. From an
authenticated maintainer checkout, substitute the bad tag below:

```bash
gh release delete v1.25.0-motuslab.2 --repo MotusLabs/stoneforge --yes
git push origin --delete v1.25.0-motuslab.2
git tag -d v1.25.0-motuslab.2
```

Fix and commit the problem, then cut a new build with a higher counter, e.g.
`bun run scripts/release.ts --motuslab 3` for unchanged `1.25.0`. Never reuse
the bad counter or overwrite its assets. For changed app versions, use
Changesets first. Deleting a Release does not undo installations: affected
users must download, verify and install the corrected higher-version `.deb`.
If the pipeline itself must be reverted, use a reviewed git revert.

## Preserve fork deltas when merging upstream

- Keep `.github/workflows/publish.yml`, `deploy-docs.yml` and
  `deploy-website.yml` deleted. Do not resurrect npm or Cloudflare credentials,
  OIDC publishing or external deployment steps.
- Keep workspace package manifests `private: true` and remove `publishConfig`.
  Keep `scripts/release.ts` free of npm publishing and manual release uploads.
- Keep `.changeset/config.json` without `access: public`, with
  `privatePackages: { "version": true, "tag": false }` and the fixed version
  group. Changesets versions private packages and writes changelogs.
- Retain the MotusLab tag workflow, CI packaging job, bundled-runtime packaging
  and smoke checks. Reconcile upstream dependency/runtime changes against both
  Ubuntu targets. Run `scripts/check-no-third-party-publish.sh` after merging.

## Local checks and remaining verification

Documentation flags and command behavior can be checked against the scripts,
with release dry runs and helper self-tests. On Debian 12 without sudo, a built
package can be inspected with `dpkg-deb` and smoke-tested in extraction mode
(see `packaging/deb/README.md`). This does not verify apt installation/purge on
the supported Ubuntu versions. Those checks require CI or a human, as do actual
GitHub workflow execution, release publication and a real Ubuntu upgrade.
No release is cut as part of this documentation change.
