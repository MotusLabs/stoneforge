#!/usr/bin/env bash
# motuslab-release-notes.sh — build the GitHub Release notes for a MotusLab release.
#
# Usage: scripts/motuslab-release-notes.sh <tag> [<changelog>] [--package-json <path>]
#        scripts/motuslab-release-notes.sh --self-test
#
# Writes Markdown to stdout, ready for `gh release create --notes-file`. The
# notes carry (spec el-12jf6c, design D6 / requirement "Artifact storage in
# MotusLabs space"):
#
#   * a "MotusLab build" header naming the tag and the Debian version,
#   * install and upgrade instructions for the .deb (including SHA256SUMS),
#   * the matching `## <x.y.z>` section of packages/smithy/CHANGELOG.md,
#   * what was verified before publishing.
#
# The tag is parsed and validated by scripts/motuslab-version.sh, so the notes
# cannot be generated for a tag whose version disagrees with the manifest.
#
# Exit codes: 0 ok, 1 no matching changelog section (or bad tag), 2 usage error.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_SCRIPT="$ROOT/scripts/motuslab-version.sh"
DEFAULT_CHANGELOG="$ROOT/packages/smithy/CHANGELOG.md"

usage() {
  cat >&2 <<EOF
Usage: scripts/motuslab-release-notes.sh <tag> [<changelog>] [--package-json <path>]
       scripts/motuslab-release-notes.sh --self-test

  tag          MotusLab release tag, e.g. v1.25.0-motuslab.2
  changelog    changesets changelog with a "## <x.y.z>" section
               (default: packages/smithy/CHANGELOG.md)
  --self-test  run the built-in unit tests (no repository needed)
EOF
  exit 2
}

die() { printf 'motuslab-release-notes: error: %s\n' "$*" >&2; exit 1; }
warn() { printf 'motuslab-release-notes: WARNING: %s\n' "$*" >&2; }

# changelog_section <changelog> <version>: print the body of the
# "## <version>" heading up to the next level-2 heading, without the trailing
# blank lines. Sub-headings ("### Minor Changes") are part of the section.
# Prints nothing when there is no such section.
changelog_section() {
  awk -v ver="$2" '
    {
      line = $0
      sub(/[[:space:]]+$/, "", line)
      if (line == "## " ver) { in_section = 1; next }
      if (in_section && line ~ /^## /) { exit }
      if (in_section) lines[++n] = $0
    }
    END {
      while (n > 0 && lines[n] ~ /^[[:space:]]*$/) n--
      first = 1
      while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
      for (i = first; i <= n; i++) print lines[i]
    }
  ' "$1"
}

# Generate the notes from <tag>, <app version>, <deb version>, <deb file> and
# the changelog section read from stdin.
render_notes() {
  local tag="$1" app="$2" deb="$3" deb_file="$4"
  local body
  body="$(cat)"

  cat <<NOTES
# Stoneforge ${deb} (MotusLab build)

MotusLab Ubuntu build of Stoneforge, built from tag \`${tag}\`. Installs on
Ubuntu 22.04 LTS and 24.04 LTS (amd64) with no Node.js, npm, pnpm or Bun
preinstalled — the runtime and the smithy web UI are bundled under
\`/opt/stoneforge\`.

## Install

Download \`${deb_file}\` and \`SHA256SUMS\` from this release, then:

\`\`\`bash
sha256sum -c SHA256SUMS
sudo apt install ./${deb_file}
sf --version
\`\`\`

Upgrading from an earlier MotusLab build: install the new \`.deb\` over the old
one (\`sudo apt install ./${deb_file}\`). Removing or purging the package deletes
only \`/opt/stoneforge\` and the \`sf\` / \`stoneforge\` launchers — workspaces and
user configuration are never touched.

This fork does not publish npm packages; releases live only on
MotusLabs/stoneforge. Note that an npm-installed \`sf\` earlier on \`PATH\` would
shadow \`/usr/bin/sf\`.

## Changes — @stoneforge/smithy ${app}

${body}

## Verification

* Built once on Ubuntu 22.04; the file attached to this release is the exact
  file that passed the smoke tests (verified by \`sha256sum -c SHA256SUMS\`).
* Smoke-tested on Ubuntu 22.04 and Ubuntu 24.04: install, \`sf --version\`,
  \`sf init\` in a temporary workspace, \`sf serve\` health check and web UI, a
  PTY spawn, then purge with user data left intact.
NOTES
}

# ── Unit tests (run via --self-test) ────────────────────────────────────────
self_test() {
  local total=0 failed=0
  local work out rc
  MOTUSLAB_NOTES_SELFTEST_WORK="$(mktemp -d "${TMPDIR:-/tmp}/motuslab-notes-selftest.XXXXXX")"
  trap 'rm -rf "$MOTUSLAB_NOTES_SELFTEST_WORK"' EXIT
  work="$MOTUSLAB_NOTES_SELFTEST_WORK"

  ok()  { total=$((total + 1)); printf 'self-test: ok    %s\n' "$1"; }
  bad() { total=$((total + 1)); failed=$((failed + 1)); printf 'self-test: FAIL  %s\n' "$1" >&2; }

  # run_notes <tag> <manifest-version> [changelog-file]
  run_notes() {
    printf '{"name":"@stoneforge/smithy","version":"%s"}\n' "$2" >"$work/package.json"
    local changelog="${3:-$work/CHANGELOG.md}"
    set +e
    out="$("$ROOT/scripts/motuslab-release-notes.sh" "$1" "$changelog" --package-json "$work/package.json" 2>"$work/err")"
    rc=$?
    set -e
  }

  # A realistic changesets changelog: a level-2 heading per version, with
  # level-3 sub-headings inside each section that must NOT end it.
  cat >"$work/CHANGELOG.md" <<'EOF'
# @stoneforge/smithy

## 1.26.0

### Minor Changes

- abc1234: Add the thing.

## 1.25.0

### Minor Changes

- 1160ec0: Add agent disable/enable: park agents from dispatch.

### Patch Changes

- @stoneforge/core@1.25.0
- @stoneforge/storage@1.25.0

## 1.24.0

### Minor Changes

- 823ccb9: Add pollWorkflowAutoTransition().
EOF

  # The spec scenario: a release for v1.25.0-motuslab.2.
  run_notes "v1.25.0-motuslab.2" "1.25.0"
  if [[ $rc -eq 0 ]] &&
    grep -qF '# Stoneforge 1.25.0+motuslab2 (MotusLab build)' <<<"$out" &&
    grep -qF "built from tag \`v1.25.0-motuslab.2\`" <<<"$out" &&
    grep -qF 'sudo apt install ./stoneforge_1.25.0+motuslab2_amd64.deb' <<<"$out" &&
    grep -qF 'sha256sum -c SHA256SUMS' <<<"$out" &&
    grep -qF '## Changes — @stoneforge/smithy 1.25.0' <<<"$out"; then
    ok "notes header names the tag, the Debian version and the install commands"
  else
    bad "header/install block wrong (exit $rc)"
  fi

  if grep -qF '1160ec0: Add agent disable/enable' <<<"$out" &&
    grep -qF '@stoneforge/storage@1.25.0' <<<"$out" &&
    ! grep -qF '823ccb9: Add pollWorkflowAutoTransition' <<<"$out" &&
    ! grep -qF 'abc1234: Add the thing' <<<"$out"; then
    ok "only the matching CHANGELOG section is included"
  else
    bad "changelog section extraction included the wrong versions"
  fi

  if [[ "$(grep -cF '### ' <<<"$out")" -ge 2 ]]; then
    ok "level-3 sub-headings inside the section are preserved"
  else
    bad "sub-headings were dropped from the section body"
  fi

  run_notes "v1.24.0-motuslab.5" "1.24.0"
  if [[ $rc -eq 0 ]] && grep -qF '823ccb9: Add pollWorkflowAutoTransition' <<<"$out" &&
    ! grep -qF '1160ec0' <<<"$out"; then
    ok "an older version's section is picked when the tag names it"
  else
    bad "wrong section for v1.24.0-motuslab.5 (exit $rc)"
  fi

  # No matching section: fail loudly instead of publishing empty notes.
  run_notes "v1.23.0-motuslab.1" "1.23.0"
  if [[ $rc -eq 1 ]] && grep -qF '1.23.0' <"$work/err" &&
    grep -qF '1.26.0' <"$work/err" && grep -qF '1.25.0' <"$work/err"; then
    ok "a version with no changelog section fails, listing the sections that exist"
  else
    bad "missing section should fail with the available sections (exit $rc)"
  fi

  # A missing changelog file is an error, not empty notes.
  run_notes "v1.25.0-motuslab.2" "1.25.0" "$work/nope/CHANGELOG.md"
  if [[ $rc -eq 1 ]] && grep -qF 'no such changelog' <"$work/err"; then
    ok "a missing changelog file fails"
  else
    bad "missing changelog file should fail (exit $rc)"
  fi

  # The tag is validated first, so a mismatch never produces notes.
  run_notes "v1.26.0-motuslab.1" "1.25.0"
  if [[ $rc -eq 1 ]] && grep -qF 'does not match the package version' <"$work/err"; then
    ok "a tag that disagrees with the manifest produces no notes"
  else
    bad "tag/manifest mismatch should be rejected (exit $rc)"
  fi

  # The real repository changelog, at whatever version it is today, using the
  # default manifest and changelog paths.
  local real
  real="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/packages/smithy/package.json")"
  if grep -qF "## ${real}" "$DEFAULT_CHANGELOG"; then
    set +e
    out="$("$ROOT/scripts/motuslab-release-notes.sh" "v${real}-motuslab.1" 2>"$work/err")"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]] && grep -qF "# Stoneforge ${real}+motuslab1 (MotusLab build)" <<<"$out"; then
      ok "the repository's own changelog section renders with defaults"
    else
      bad "default changelog/manifest run failed (exit $rc)"
    fi
  else
    warn "packages/smithy/CHANGELOG.md has no '## ${real}' section yet; skipping the default-path check"
  fi

  printf 'self-test: %d/%d checks passed\n' "$((total - failed))" "$total"
  [[ $failed -eq 0 ]]
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  [[ $# -gt 0 ]] || usage
  local tag="" changelog="$DEFAULT_CHANGELOG" package_json="$ROOT/packages/smithy/package.json"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --package-json)
        [[ $# -ge 2 ]] || usage
        package_json="$2"; shift 2 ;;
      --package-json=*) package_json="${1#*=}"; shift ;;
      --self-test)
        if self_test; then exit 0; else exit 1; fi ;;
      -h | --help)
        usage ;;
      -*) usage ;;
      *) if [[ -z "$tag" ]]; then tag="$1";
         elif [[ "$changelog" == "$DEFAULT_CHANGELOG" ]]; then changelog="$1";
         else usage; fi; shift ;;
    esac
  done

  [[ -n "$tag" ]] || usage

  # Parse and validate the tag (also re-checks the manifest at publish time).
  local version_out app deb deb_file
  version_out="$("$VERSION_SCRIPT" "$tag" --package-json "$package_json" | grep -E '^(app_version|deb_version|deb_file)=')"
  app="$(grep -m1 '^app_version=' <<<"$version_out" | cut -d= -f2-)"
  deb="$(grep -m1 '^deb_version=' <<<"$version_out" | cut -d= -f2-)"
  deb_file="$(grep -m1 '^deb_file=' <<<"$version_out" | cut -d= -f2-)"
  [[ -n "$app" && -n "$deb" && -n "$deb_file" ]] || die "unexpected output from $VERSION_SCRIPT"

  [[ -f "$changelog" ]] || die "no such changelog: $changelog"

  local body
  body="$(changelog_section "$changelog" "$app")"
  if [[ -z "$body" ]]; then
    {
      printf 'motuslab-release-notes: error: %s has no "## %s" section for this release\n' "$changelog" "$app"
      printf '    sections present:\n'
      grep -E '^## ' "$changelog" | head -n 10 | sed 's/^/      /'
      printf 'Run "pnpm changeset version" (and merge the version commit) before tagging,\n'
      printf 'or add the missing changelog section.\n'
    } >&2
    exit 1
  fi

  render_notes "$tag" "$app" "$deb" "$deb_file" <<<"$body"
}

main "$@"
