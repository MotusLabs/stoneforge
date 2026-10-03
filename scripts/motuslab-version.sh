#!/usr/bin/env bash
# motuslab-version.sh — parse and validate a MotusLab release tag.
#
# Usage: scripts/motuslab-version.sh <tag> [--package-json <path>]
#        scripts/motuslab-version.sh --self-test
#
# A MotusLab release tag (spec el-12jf6c, design D5 / requirement
# "MotusLab release versioning") looks like
#
#     v<x.y.z>-motuslab.<n>     e.g.  v1.25.0-motuslab.2
#
# where x.y.z equals the "version" in packages/smithy/package.json at the
# tagged commit and n is a positive integer. The Debian package version is
#
#     <x.y.z>+motuslab<n>       e.g.  1.25.0+motuslab2
#
# ('+' is a Debian upload-style suffix, so 1.25.0+motuslab2 sorts after both
# 1.25.0 and 1.25.0+motuslab1 under dpkg --compare-versions).
#
# This script parses a tag, refuses malformed ones, and — used as the first
# step of a release — fails the release *before anything is built* when x.y.z
# differs from the manifest version. The failure message names both versions.
#
# Output: KEY=VALUE lines on stdout. When GITHUB_OUTPUT is set (i.e. inside a
# GitHub Actions step), the same lines are appended to it too, so a step with
# id `version` can use ${{ steps.version.outputs.deb_version }}:
#
#     tag=v1.25.0-motuslab.2
#     app_version=1.25.0
#     release_number=2
#     deb_version=1.25.0+motuslab2
#     deb_file=stoneforge_1.25.0+motuslab2_amd64.deb
#
# Exit codes: 0 ok, 1 invalid tag / version mismatch, 2 usage error.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# v<x.y.z>-motuslab.<n>: plain semver core only (no prerelease/build parts —
# those would leak into a Debian version, where '-' sorts *lower* than the
# release itself) and a decimal n with no leading zeros.
TAG_RE='^v([0-9]+\.[0-9]+\.[0-9]+)-motuslab\.([0-9]+)$'

log()  { printf '==> %s\n' "$*"; }
warn() { printf 'motuslab-version: WARNING: %s\n' "$*" >&2; }

usage() {
  cat >&2 <<EOF
Usage: scripts/motuslab-version.sh <tag> [--package-json <path>]
       scripts/motuslab-version.sh --self-test

  tag          MotusLab release tag, e.g. v1.25.0-motuslab.2
  --package-json <path>  manifest whose "version" must match the tag
                         (default: packages/smithy/package.json)
  --self-test  run the built-in unit tests (no repository needed)
EOF
  exit 2
}

# die_v <message>: a validation failure (exit 1), not a usage error.
die_v() { printf 'motuslab-version: error: %s\n' "$*" >&2; exit 1; }

# parse_tag <tag>: sets TAG_APP_VERSION and TAG_RELEASE_NUMBER, or dies.
parse_tag() {
  local tag="$1"

  [[ "$tag" =~ $TAG_RE ]] || die_v "tag '$tag' does not match the MotusLab release form v<x.y.z>-motuslab.<n> (e.g. v1.25.0-motuslab.2); expected the app version from packages/smithy/package.json and a positive integer release number"

  local app="${BASH_REMATCH[1]}" n="${BASH_REMATCH[2]}"

  [[ "$n" != "0" ]] || die_v "release number must be a positive integer, got 0 in '$tag' (start at 1)"
  [[ ! "$n" =~ ^0 ]] || die_v "release number '$n' in '$tag' has a leading zero; write it as '$(printf 'v%s-motuslab.%d' "$app" "$((10#$n))")' so the tag maps to exactly one Debian version"

  TAG_APP_VERSION="$app"
  TAG_RELEASE_NUMBER="$n"
}

# manifest_version <package.json>: print the "version" field.
manifest_version() {
  local file="$1" v=""

  [[ -f "$file" ]] || die_v "manifest not found: $file"

  # Prefer a real JSON parser; fall back to the first "version" key.
  if command -v node >/dev/null 2>&1; then
    v="$(node -e '
      const p = require(process.argv[1]);
      if (typeof p.version !== "string" || !p.version) process.exit(1);
      process.stdout.write(p.version);
    ' "$file" 2>/dev/null || true)"
  elif command -v jq >/dev/null 2>&1; then
    v="$(jq -er '.version // empty' "$file" 2>/dev/null || true)"
  fi
  if [[ -z "$v" ]]; then
    v="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$file" | head -n1)"
  fi

  [[ -n "$v" ]] || die_v "no \"version\" field found in $file"
  printf '%s' "$v"
}

# emit <tag> <app> <n>: the KEY=VALUE contract above, on stdout and, when a
# workflow step is running, in $GITHUB_OUTPUT too.
emit() {
  local tag="$1" app="$2" n="$3"
  local lines
  lines="$(printf 'tag=%s\napp_version=%s\nrelease_number=%s\ndeb_version=%s+motuslab%s\ndeb_file=stoneforge_%s+motuslab%s_amd64.deb\n' \
    "$tag" "$app" "$n" "$app" "$n" "$app" "$n")"

  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$lines" >>"$GITHUB_OUTPUT"
  fi
  printf '%s\n' "$lines"
}

# ── Unit tests (run via --self-test) ────────────────────────────────────────
# No repository, root or network needed: every case runs against a synthetic
# manifest written to a temp directory.
self_test() {
  local total=0 failed=0
  local work out rc
  # Global (not local): the EXIT trap fires after self_test has returned, when
  # this function's locals are gone and `set -u` would reject them.
  MOTUSLAB_VERSION_SELFTEST_WORK="$(mktemp -d "${TMPDIR:-/tmp}/motuslab-version-selftest.XXXXXX")"
  trap 'rm -rf "$MOTUSLAB_VERSION_SELFTEST_WORK"' EXIT
  work="$MOTUSLAB_VERSION_SELFTEST_WORK"

  ok()   { total=$((total + 1)); printf 'self-test: ok    %s\n' "$1"; }
  bad()  { total=$((total + 1)); failed=$((failed + 1)); printf 'self-test: FAIL  %s\n' "$1" >&2; }

  # run_case <tag> <manifest-version>: run the real script as a subprocess
  # against a synthetic manifest; captures stdout, stderr and the exit code.
  # `set +e` because the failing cases must not abort the self-test.
  run_case() {
    printf '{"name":"@stoneforge/smithy","version":"%s"}\n' "$2" >"$work/package.json"
    set +e
    out="$("$ROOT/scripts/motuslab-version.sh" "$1" --package-json "$work/package.json" 2>"$work/err")"
    rc=$?
    set -e
  }

  # expect_ok <desc> <tag> <manifest-version> [substring]...
  # Asserts exit 0 and that every substring appears in stdout+stderr.
  expect_ok() {
    local desc="$1"; shift
    local tag="$1" manifest="$2"; shift 2
    run_case "$tag" "$manifest"
    if [[ $rc -ne 0 ]]; then bad "$desc (exit $rc, expected 0)"; return; fi
    local p all
    all="$out
$(cat "$work/err")"
    for p in "$@"; do
      if ! grep -qF -- "$p" <<<"$all"; then bad "$desc (output missing '$p')"; return; fi
    done
    ok "$desc"
  }

  # expect_fail <desc> <tag> <manifest-version> [substring]...
  # Asserts a validation failure (exit 1, not the usage error 2) whose stderr
  # mentions every substring, so the message actually explains the problem.
  expect_fail() {
    local desc="$1"; shift
    local tag="$1" manifest="$2"; shift 2
    run_case "$tag" "$manifest"
    if [[ $rc -ne 1 ]]; then bad "$desc (exit $rc, expected 1)"; return; fi
    local p
    for p in "$@"; do
      if ! grep -qF -- "$p" <"$work/err"; then bad "$desc (stderr missing '$p')"; return; fi
    done
    ok "$desc"
  }

  # The two mappings the spec pins down (el-12jf6c, scenarios "Matching tag"
  # and "Mismatched tag"): v1.25.0-motuslab.2 -> 1.25.0+motuslab2, and a
  # mismatch fails naming both versions.
  expect_ok "v1.25.0-motuslab.2 maps to 1.25.0+motuslab2" \
    "v1.25.0-motuslab.2" "1.25.0" \
    "app_version=1.25.0" "deb_version=1.25.0+motuslab2" \
    "release_number=2" "deb_file=stoneforge_1.25.0+motuslab2_amd64.deb" \
    "tag=v1.25.0-motuslab.2"

  expect_ok "first release of a version maps to +motuslab1" \
    "v1.26.0-motuslab.1" "1.26.0" "deb_version=1.26.0+motuslab1"

  expect_ok "double-digit release numbers map without separators" \
    "v1.25.0-motuslab.12" "1.25.0" "deb_version=1.25.0+motuslab12" \
    "deb_file=stoneforge_1.25.0+motuslab12_amd64.deb"

  expect_fail "tag newer than manifest fails naming both versions" \
    "v1.26.0-motuslab.1" "1.25.0" "1.26.0" "1.25.0" "$work/package.json"

  expect_fail "tag older than manifest fails naming both versions" \
    "v1.24.9-motuslab.3" "1.25.0" "1.24.9" "1.25.0"

  # Against the real manifest, whatever its version happens to be today: the
  # default --package-json path must work, and a wrong tag must fail naming
  # both versions and the (repo-relative) manifest path.
  local real bumped
  real="$(manifest_version "$ROOT/packages/smithy/package.json")"
  bumped="$(printf '%s' "$real" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')"

  set +e
  out="$("$ROOT/scripts/motuslab-version.sh" "v${real}-motuslab.7" 2>"$work/err")"
  rc=$?
  set -e
  if [[ $rc -eq 0 ]] && grep -qF "deb_version=${real}+motuslab7" <<<"$out"; then
    ok "the repository's own manifest parses with the default --package-json"
  else
    bad "default manifest check failed (exit $rc): $out"
  fi

  set +e
  "$ROOT/scripts/motuslab-version.sh" "v${bumped}-motuslab.1" >/dev/null 2>"$work/err"
  rc=$?
  set -e
  if [[ $rc -eq 1 ]] && grep -qF "$bumped" <"$work/err" && grep -qF "$real" <"$work/err" &&
    grep -qF "packages/smithy/package.json" <"$work/err"; then
    ok "a tag that is one patch ahead of the real manifest fails naming both versions"
  else
    bad "real-manifest mismatch check failed (exit $rc): $(cat "$work/err")"
  fi

  # Malformed tags (all against a matching manifest, so only the form fails).
  local m="1.25.0"
  expect_fail "rejects an upstream-style tag without a motuslab part"    "v1.25.0" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a tag missing the leading v"                      "1.25.0-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a tag missing the release number"                 "v1.25.0-motuslab" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a tag missing the dot before the release number"  "v1.25.0-motuslab2" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects release number 0"                                 "v1.25.0-motuslab.0" "$m" "positive integer"
  expect_fail "rejects a leading-zero release number"                    "v1.25.0-motuslab.02" "$m" "v1.25.0-motuslab.2"
  expect_fail "rejects a compound release number"                        "v1.25.0-motuslab.1.2" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a two-component version"                          "v1.25-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a four-component version"                         "v1.25.0.1-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a prerelease suffix"                              "v1.25.0-beta.1-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a build suffix"                                   "v1.25.0+build.1-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a doubled v"                                      "vv1.25.0-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a non-numeric app version"                        "v1.x.0-motuslab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a case-mangled suffix"                            "v1.25.0-MotusLab.1" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects an empty tag"                                     "" "$m" "v<x.y.z>-motuslab.<n>"
  expect_fail "rejects a v-prefixed but padded version"                  "v1.25.00-motuslab.1" "1.25.0" "1.25.00" "1.25.0"

  # Usage errors exit 2 and never produce output pairs.
  set +e
  out="$("$ROOT/scripts/motuslab-version.sh" 2>"$work/err")"
  rc=$?
  set -e
  if [[ $rc -eq 2 ]]; then ok "missing argument is a usage error (exit 2)"; else bad "missing argument: exit $rc, expected 2"; fi

  # GITHUB_OUTPUT receives the same KEY=VALUE lines (workflow step outputs).
  printf '{"name":"@stoneforge/smithy","version":"1.25.0"}\n' >"$work/package.json"
  rm -f "$work/github_output"
  set +e
  GITHUB_OUTPUT="$work/github_output" \
    "$ROOT/scripts/motuslab-version.sh" "v1.25.0-motuslab.2" --package-json "$work/package.json" >/dev/null
  rc=$?
  set -e
  if [[ $rc -eq 0 && "$(wc -l <"$work/github_output")" -eq 5 ]] &&
    grep -qF 'deb_version=1.25.0+motuslab2' "$work/github_output"; then
    ok "GITHUB_OUTPUT gets the same five KEY=VALUE lines"
  else
    bad "GITHUB_OUTPUT was not written correctly (exit $rc): $(cat "$work/github_output" 2>/dev/null || echo '<absent>')"
  fi

  # Debian ordering (spec scenario "Debian ordering"): the suffix must sort
  # above the bare upstream version and above the previous MotusLab release.
  if command -v dpkg >/dev/null 2>&1; then
    if dpkg --compare-versions "1.25.0+motuslab2" gt "1.25.0+motuslab1" &&
      dpkg --compare-versions "1.25.0+motuslab1" gt "1.25.0"; then
      ok "1.25.0+motuslab2 > 1.25.0+motuslab1 > 1.25.0 under dpkg --compare-versions"
    else
      bad "Debian version ordering is not as the spec requires"
    fi
  else
    warn "dpkg not available; skipping the Debian ordering check"
  fi

  printf 'self-test: %d/%d checks passed\n' "$((total - failed))" "$total"
  [[ $failed -eq 0 ]]
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  [[ $# -gt 0 ]] || usage
  local tag="" package_json="$ROOT/packages/smithy/package.json"

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
      -*) die_v "unknown option: $1" ;;
      *) [[ -z "$tag" ]] || usage; tag="$1"; shift ;;
    esac
  done

  # An explicitly empty tag is a validation error (parse_tag explains the
  # expected form), not a usage error.
  parse_tag "$tag"

  local manifest
  manifest="$(manifest_version "$package_json")"

  if [[ "$TAG_APP_VERSION" != "$manifest" ]]; then
    local display_path="$package_json"
    [[ "$package_json" == "$ROOT"/* ]] && display_path="${package_json#"$ROOT"/}"
    {
      printf 'motuslab-version: error: release tag %s does not match the package version\n' "$tag"
      printf '    tag says      : %s\n' "$TAG_APP_VERSION"
      printf '    manifest says : %s  (%s)\n' "$manifest" "$display_path"
      printf 'A release tag must name the version it is built from. Run "pnpm changeset version"\n'
      printf 'and merge the version commit before tagging, or move the tag to the right commit.\n'
    } >&2
    exit 1
  fi

  log "tag $tag -> Debian version ${TAG_APP_VERSION}+motuslab${TAG_RELEASE_NUMBER}"
  emit "$tag" "$TAG_APP_VERSION" "$TAG_RELEASE_NUMBER"
}

main "$@"
