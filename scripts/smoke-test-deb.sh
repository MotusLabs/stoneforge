#!/usr/bin/env bash
# smoke-test-deb.sh — functional smoke test for the MotusLab Stoneforge .deb.
#
# Usage: scripts/smoke-test-deb.sh <deb> [--expect-version <v>] [--extract]
#        scripts/smoke-test-deb.sh --self-test
#
# Two modes:
#   default    CI mode (needs sudo): apt-get install the .deb, verify the
#              installed package works, purge it, and check that user data
#              survived. Assumes a disposable machine — it purges stoneforge.
#   --extract  No-root mode: dpkg-deb -x into a temp root and run the same
#              functional checks through STONEFORGE_HOME and the extracted
#              launchers. Skips install/purge. The outbound-connection strace
#              audit runs only when strace is available.
#
# Verified behaviour (MotusLab Ubuntu Release Spec, el-12jf6c / design D7):
#   * Self-contained runtime — sf runs on the bundled Node, never a PATH node;
#     native modules load (better-sqlite3 via sf init, node-pty via a PTY
#     spawn); GET / serves the smithy web UI; /api/health returns ok.
#   * No outbound uploads — sf serve runs under strace -f -e trace=connect and
#     the test fails on any connect() to a non-loopback address.
#   * Upgrade and removal preserve user data — after apt-get purge,
#     /opt/stoneforge and the launchers are gone but the workspace created by
#     sf init is untouched (default mode only; needs root).
#
# Options:
#   --expect-version <v>  Expected version, as the app version (1.25.0), the
#                         Debian version (1.25.0+motuslab1) or a release tag
#                         (v1.25.0-motuslab.2). Default: derived from the
#                         deb's Version field.
#   --self-test           Run the script's unit tests (the pure helper
#                         functions below) and exit. Needs no .deb, root or
#                         strace; use this to guard parser regressions.
#
# Environment overrides:
#   SMOKE_PORT              port for sf serve (default 3457)
#   SMOKE_STARTUP_TIMEOUT   seconds to wait for /api/health (default 90)
#   SMOKE_KEEP=1            keep the temp dir for debugging (path is printed)
#
# Exit codes: 0 pass, 1 test failure, 2 usage error.
#
# This script is also sourceable: the pure helpers `audit_connects` and
# `check_version_output` can be unit-tested by sourcing the file (main only
# runs when the file is executed directly), or in place via --self-test.

set -euo pipefail

print_help() {
  # Print the leading comment block of this file (everything before `set -e`).
  awk 'NR > 1 && /^set -e/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

usage() {
  print_help >&2
  exit 2
}

log() { printf '==> %s\n' "$*"; }
warn() { printf 'smoke-test: WARNING: %s\n' "$*" >&2; }
die() { printf 'smoke-test: error: %s\n' "$*" >&2; exit 2; }
fail() { printf 'smoke-test: FAIL: %s\n' "$*" >&2; exit 1; }
step() { STEP=$((STEP + 1)); printf '\n=== [%d] %s\n' "$STEP" "$*"; }

STEP=0
SRV_PID=""
WORK=""
KEEP=0

# Run a command with output captured to a log file; on failure, dump the tail.
run_logged() { # run_logged <logfile> <command> [args...]
  local logfile="$1"
  shift
  local rc=0
  "$@" >"$logfile" 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then
    printf 'smoke-test: command failed (exit %d): %s\n' "$rc" "$*" >&2
    printf -- '---- last 40 lines of %s ----\n' "$logfile" >&2
    tail -n 40 "$logfile" >&2 || true
    printf -- '---- end of log ----\n' >&2
    return "$rc"
  fi
}

# Print every connect() from an strace -e trace=connect log that targeted a
# non-loopback address. Input format (any strace of the last decade):
#   1234  connect(3, {sa_family=AF_INET, sin_port=htons(443),
#         sin_addr=inet_addr("93.184.216.34")}, 16) = -1 EINPROGRESS
#   1235  connect(4, {sa_family=AF_INET6, sin6_port=htons(443),
#         inet_pton(AF_INET6, "2606:4700::1", &sin6_addr)}, 28) = 0
#   1236  connect(5, {sa_family=AF_UNIX}, 110) = 0
# AF_UNIX (local IPC) and loopback/unspecified addresses are fine; anything
# else is printed to stdout and counted by the caller.
audit_connects() { # audit_connects <strace-log>
  local tracefile="$1"
  local line addr
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    while IFS= read -r addr; do
      case "$addr" in
        127.* | ::1 | ::ffff:127.* | 0.0.0.0 | ::) ;; # loopback / unspecified
        *) printf 'non-loopback connect() to %s\n    %s\n' "$addr" "$line" ;;
      esac
    done < <(printf '%s\n' "$line" \
      | grep -oE 'inet_addr\("[^"]*"|inet_pton\(AF_INET6, "[^"]*"' \
      | sed -e 's/.*"\([^"]*\)".*/\1/')
  done < <(grep -- 'connect(' "$tracefile" 2>/dev/null || true)
}

# Check `sf --version` output against the expected app version. The version
# token after "stoneforge v" is parsed out whole and compared with exact
# string equality — deliberately NOT a grep pattern match, where
# "stoneforge v1.25.0" would also accept output "stoneforge v1.25.01" and
# the dots would act as wildcards. Diagnoses go to stderr; returns non-zero
# on any mismatch.
check_version_output() { # check_version_output <sf --version output> <expected app version>
  local output="$1" expected="$2" line reported=""
  while IFS= read -r line; do
    if [[ "$line" =~ stoneforge[[:space:]]+v([^[:space:]]+) ]]; then
      reported="${BASH_REMATCH[1]}"
      break
    fi
  done <<<"$output"
  if [[ -z "$reported" ]]; then
    printf 'smoke-test: found no "stoneforge v<version>" token in sf --version output:\n%s\n' "$output" >&2
    return 1
  fi
  if [[ "$reported" != "$expected" ]]; then
    printf 'smoke-test: sf --version reported v%s, expected exactly v%s\n' "$reported" "$expected" >&2
    return 1
  fi
}

# Unit tests for the pure helpers above (run via --self-test). Covers the
# version comparison both ways — including that expecting 1.25.0 must reject
# reported v1.25.01 — and the strace connect() classifier.
self_test() {
  local total=0 failed=0
  local expect desc out ver trace
  # Each case: <ok|fail>|<description>|<sf --version output>|<expected version>.
  # The output field takes %b escapes, e.g. \n to place the version line among
  # other banner output.
  while IFS='|' read -r expect desc out ver; do
    [[ -n "$expect" ]] || continue
    total=$((total + 1))
    if check_version_output "$(printf '%b' "$out")" "$ver" >/dev/null 2>&1; then
      if [[ "$expect" == ok ]]; then
        printf 'self-test: ok    %s\n' "$desc"
      else
        printf 'self-test: FAIL  %s (expected failure)\n' "$desc" >&2
        failed=$((failed + 1))
      fi
    elif [[ "$expect" == fail ]]; then
      printf 'self-test: ok    %s\n' "$desc"
    else
      printf 'self-test: FAIL  %s (expected success)\n' "$desc" >&2
      failed=$((failed + 1))
    fi
  done <<'EOF'
ok|version: exact match|stoneforge v1.25.0|1.25.0
ok|version: match on its own line among other output|stoneforge 1.25.0\nother banner text\nstoneforge v1.25.0|1.25.0
fail|version: expecting 1.25.0 must reject v1.25.01|stoneforge v1.25.01|1.25.0
fail|version: expecting 1.25.0 must reject v1.25.0.1|stoneforge v1.25.0.1|1.25.0
fail|version: dots must not act as wildcards|stoneforge v1x25y0|1.25.0
fail|version: wrong version reported|stoneforge v1.24.9|1.25.0
fail|version: no stoneforge v<token> in output|some entirely different banner|1.25.0
fail|version: suffixed Debian version is not the bare app version|stoneforge v1.25.0+motuslab1|1.25.0
EOF

  trace="$(mktemp "${TMPDIR:-/tmp}/sf-smoke-selftest.XXXXXX")"
  cat >"$trace" <<'EOF'
1234  connect(3, {sa_family=AF_UNIX}, 110) = 0
1235  connect(4, {sa_family=AF_INET, sin_port=htons(3457), sin_addr=inet_addr("127.0.0.1")}, 16) = 0
1236  connect(5, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "::1", &sin6_addr)}, 28) = 0
1237  connect(6, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("93.184.216.34")}, 16) = -1 EINPROGRESS
1238  connect(7, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2606:4700::1111", &sin6_addr)}, 28) = 0
EOF
  local -a violations=()
  mapfile -t violations < <(audit_connects "$trace")
  # audit_connects prints two lines per violation (address + strace line);
  # count the header lines, and require exactly the two public addresses.
  local n_violations
  n_violations="$(printf '%s\n' "${violations[@]-}" | grep -c '^non-loopback connect' || true)"
  total=$((total + 1))
  if [[ "$n_violations" -eq 2 ]] \
    && [[ "${violations[*]-}" == *'93.184.216.34'* ]] \
    && [[ "${violations[*]-}" == *'2606:4700::1111'* ]]; then
    printf 'self-test: ok    strace audit flags exactly the two non-loopback connects\n'
  else
    printf 'self-test: FAIL  strace audit flagged %s violation(s) (expected exactly 2): %s\n' \
      "$n_violations" "${violations[*]-}" >&2
    failed=$((failed + 1))
  fi
  rm -f "$trace"

  printf 'self-test: %d/%d checks passed\n' "$((total - failed))" "$total"
  [[ "$failed" -eq 0 ]]
}

stop_server() {
  [[ -n "$SRV_PID" ]] || return 0
  # The server was launched with setsid, so $SRV_PID is a process-group
  # leader: signal the whole group so both strace and node go away.
  kill -TERM -- "-$SRV_PID" 2>/dev/null || kill -TERM "$SRV_PID" 2>/dev/null || true
  local watchdog=""
  (sleep 15; kill -KILL -- "-$SRV_PID" 2>/dev/null || true) & watchdog=$!
  wait "$SRV_PID" 2>/dev/null || true
  kill -TERM "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  SRV_PID=""
}

main() {
  local deb="" expect_version="" extract=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --extract) extract=1; shift ;;
      --self-test)
        if self_test; then exit 0; else exit 1; fi
        ;;
      --expect-version)
        [[ $# -ge 2 ]] || die "--expect-version requires a value"
        expect_version="$2"; shift 2 ;;
      --expect-version=*) expect_version="${1#*=}"; shift ;;
      -h | --help) print_help; exit 0 ;;
      -*) die "unknown option: $1 (see --help)" ;;
      *) [[ -z "$deb" ]] || die "unexpected extra argument: $1"; deb="$1"; shift ;;
    esac
  done
  [[ -n "$deb" ]] || usage
  [[ -f "$deb" ]] || die "no such file: $deb"

  local port="${SMOKE_PORT:-3457}"
  local startup_timeout="${SMOKE_STARTUP_TIMEOUT:-90}"
  KEEP="${SMOKE_KEEP:-0}"

  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v setsid >/dev/null 2>&1 || die "setsid is required (util-linux)"

  # Fail before touching the machine if the serve port is already taken,
  # otherwise the health poll below could pass against the wrong server.
  if curl -fsS -m 3 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    die "something already answers on 127.0.0.1:$port; set SMOKE_PORT to a free port"
  fi

  # Absolutise so later steps are immune to cwd changes.
  deb="$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")"

  local sudo_cmd=()
  if [[ $extract -eq 0 ]]; then
    command -v apt-get >/dev/null 2>&1 || die "default mode requires apt-get (use --extract for no-root testing)"
    if [[ $(id -u) -eq 0 ]]; then
      sudo_cmd=()
    else
      command -v sudo >/dev/null 2>&1 || die "default mode requires root or sudo (use --extract for no-root testing)"
      sudo_cmd=(sudo)
    fi
  fi

  local mode="default (apt install + purge, sudo)"
  if [[ $extract -eq 1 ]]; then mode="--extract (dpkg-deb -x, no root)"; fi

  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/sf-smoke.XXXXXX")"
  WORK="$work" # global: read by the cleanup trap after main returns
  cleanup() {
    if [[ -n "$SRV_PID" ]]; then
      kill -KILL -- "-$SRV_PID" 2>/dev/null || kill -KILL "$SRV_PID" 2>/dev/null || true
    fi
    if [[ "$KEEP" == "1" ]]; then
      printf 'smoke-test: kept temp dir: %s\n' "$WORK"
    else
      rm -rf "$WORK"
    fi
  }
  trap cleanup EXIT

  printf 'smoke-test: mode=%s\nsmoke-test: deb=%s\n' "$mode" "$deb"
  sha256sum "$deb"

  # ── [1] Package metadata ──────────────────────────────────────────────────
  step "Inspecting package metadata"
  local pkg version arch maintainer app_version
  pkg="$(dpkg-deb -f "$deb" Package)"
  version="$(dpkg-deb -f "$deb" Version)"
  arch="$(dpkg-deb -f "$deb" Architecture)"
  maintainer="$(dpkg-deb -f "$deb" Maintainer)"
  [[ "$pkg" == "stoneforge" ]] || fail "Package field is '$pkg', expected 'stoneforge' (the purge step relies on it)"
  [[ "$arch" == "amd64" ]] || fail "Architecture field is '$arch', expected 'amd64'"
  [[ "$maintainer" == *MotusLabs* ]] || fail "Maintainer '$maintainer' does not identify MotusLabs"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+motuslab[0-9]+$ ]]; then
    warn "Version '$version' is not of the form <x.y.z>+motuslab<n> (release tags must be; local test builds need not)"
  fi

  app_version="${version%%+*}" # 1.25.0+motuslab1 -> 1.25.0
  if [[ -n "$expect_version" ]]; then
    local expected="$expect_version"
    expected="${expected#v}"                 # v1.25.0 -> 1.25.0
    expected="${expected/-motuslab./+motuslab}" # tag form -> Debian form
    if [[ "$expected" == *"+"* ]]; then
      [[ "$expected" == "$version" ]] \
        || fail "deb Version is '$version' but --expect-version says '$expected'"
      app_version="${expected%%+*}"
    else
      app_version="$expected"
    fi
  fi
  [[ "$app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "could not determine a x.y.z app version (deb Version '$version', --expect-version '$expect_version')"
  log "Package: $pkg $version ($arch), maintainer: $maintainer"
  log "Expecting 'sf --version' to report: stoneforge v$app_version"

  # ── [2] Install (default) or extract ─────────────────────────────────────
  local install_root sf_bin app_dir bundled_node extract_root="$work/root"
  if [[ $extract -eq 1 ]]; then
    step "Extracting package (no-root mode)"
    run_logged "$work/dpkg-deb-x.log" dpkg-deb -x "$deb" "$extract_root" \
      || fail "dpkg-deb -x failed"
    install_root="$extract_root/opt/stoneforge"
    sf_bin="$extract_root/usr/bin/sf"
    app_dir="$install_root/app"
    bundled_node="$install_root/node/bin/node"
    [[ -d "$install_root" ]] || fail "extracted tree has no opt/stoneforge/"
    [[ -x "$bundled_node" ]] || fail "extracted tree has no bundled node at opt/stoneforge/node/bin/node"
    [[ -f "$app_dir/dist/bin/sf.js" ]] || fail "extracted tree has no app/dist/bin/sf.js"
    [[ -x "$sf_bin" ]] || fail "extracted tree has no executable usr/bin/sf"
    [[ -x "$extract_root/usr/bin/stoneforge" ]] || fail "extracted tree has no executable usr/bin/stoneforge"
    log "Extracted to $extract_root (STONEFORGE_HOME=$install_root)"
  else
    step "Installing package (sudo apt-get install)"
    # The purge step at the end removes stoneforge; refuse to run on a machine
    # where that would destroy a deliberate installation.
    if dpkg -s stoneforge >/dev/null 2>&1; then
      die "stoneforge is already installed; this test purges it at the end, refusing to run"
    fi
    if [[ -e /opt/stoneforge ]]; then
      die "/opt/stoneforge exists without a registered stoneforge package; clean it up first"
    fi
    run_logged "$work/apt-install.log" "${sudo_cmd[@]}" apt-get install -y "$deb" \
      || fail "apt-get install failed"
    tail -n 12 "$work/apt-install.log"
    dpkg -s stoneforge >/dev/null 2>&1 || fail "dpkg does not know about stoneforge after install"
    install_root="/opt/stoneforge"
    sf_bin="/usr/bin/sf"
    app_dir="$install_root/app"
    bundled_node="$install_root/node/bin/node"
  fi

  # Every sf invocation goes through this, so the two modes stay equivalent.
  local sf_env=()
  if [[ $extract -eq 1 ]]; then
    sf_env=(env "STONEFORGE_HOME=$install_root" "$sf_bin")
  else
    sf_env=(env -u STONEFORGE_HOME "$sf_bin")
  fi
  sfrun() { "${sf_env[@]}" "$@"; }

  # ── [3] Launchers use the bundled runtime ────────────────────────────────
  step "Checking that the launcher uses the bundled Node runtime"
  if [[ $extract -eq 0 ]]; then
    [[ "$(command -v sf || true)" == "/usr/bin/sf" ]] \
      || fail "sf resolves to '$(command -v sf || echo nowhere)', expected /usr/bin/sf"
    [[ "$(command -v stoneforge || true)" == "/usr/bin/stoneforge" ]] \
      || fail "stoneforge resolves to '$(command -v stoneforge || echo nowhere)', expected /usr/bin/stoneforge"
  fi
  [[ -L "$sf_bin" ]] && fail "$sf_bin must be a launcher script, not a symlink"
  [[ "$(head -n 1 "$sf_bin")" == '#!/bin/sh' ]] \
    || fail "$sf_bin is not a #!/bin/sh launcher script"
  grep -q 'node/bin/node' "$sf_bin" \
    || fail "$sf_bin does not reference the bundled node/bin/node"

  log "Bundled node: $("$bundled_node" --version) ($bundled_node)"

  # Spec scenario "System Node present with a different version": poison PATH
  # with a node that always fails. If sf execs it, this step fails loudly.
  local fake_bin="$work/fake-bin"
  mkdir -p "$fake_bin"
  cat >"$fake_bin/node" <<'EOF'
#!/bin/sh
echo "smoke-test: PATH node was invoked — the launcher must use the bundled runtime" >&2
exit 97
EOF
  chmod 755 "$fake_bin/node"
  PATH="$fake_bin:$PATH" sfrun --version >"$work/version-poisoned.log" 2>&1 \
    || fail "sf used a node from PATH (see $work/version-poisoned.log); it must exec the bundled runtime"

  # ── [4] Version check ─────────────────────────────────────────────────────
  step "Checking sf --version"
  local version_out
  version_out="$(sfrun --version)"
  printf '%s\n' "$version_out"
  check_version_output "$version_out" "$app_version" \
    || fail "sf --version did not report exactly 'stoneforge v$app_version'"
  if [[ $extract -eq 1 ]]; then
    STONEFORGE_HOME="$install_root" "$extract_root/usr/bin/stoneforge" --version >"$work/stoneforge-cmd.log" 2>&1 \
      || fail "usr/bin/stoneforge failed (see $work/stoneforge-cmd.log)"
  else
    env -u STONEFORGE_HOME /usr/bin/stoneforge --version >"$work/stoneforge-cmd.log" 2>&1 \
      || fail "/usr/bin/stoneforge failed (see $work/stoneforge-cmd.log)"
  fi

  # ── [5] sf init in a temporary workspace ──────────────────────────────────
  step "Running sf init in a temporary workspace"
  local workspace="$work/workspace"
  mkdir -p "$workspace"
  sfrun_init() { (cd "$workspace" && sfrun init --preset auto --name smoke-test); }
  run_logged "$work/init.log" sfrun_init || fail "sf init failed"
  tail -n 5 "$work/init.log"
  [[ -d "$workspace/.stoneforge" ]] || fail "sf init created no .stoneforge/ directory"
  [[ -f "$workspace/.stoneforge/stoneforge.db" ]] \
    || fail "sf init created no .stoneforge/stoneforge.db (better-sqlite3 is not working)"
  [[ -f "$workspace/.stoneforge/config.yaml" ]] || fail "sf init created no .stoneforge/config.yaml"
  printf 'smoke-test sentinel\n' >"$workspace/.stoneforge/SMOKE-SENTINEL"
  log "Workspace initialised at $workspace/.stoneforge"

  # ── [6] sf serve: health, web UI, outbound-connection audit ───────────────
  step "Starting sf serve and probing http://127.0.0.1:$port"

  local use_strace=0
  if command -v strace >/dev/null 2>&1; then
    use_strace=1
  elif [[ $extract -eq 0 ]]; then
    log "strace not found; installing it (required for the outbound-connection audit)"
    run_logged "$work/strace-install.log" "${sudo_cmd[@]}" apt-get install -y strace \
      || fail "installing strace failed; the outbound-connection audit cannot run without it"
    command -v strace >/dev/null 2>&1 || fail "strace still unavailable after install"
    use_strace=1
  else
    warn "strace is unavailable; skipping the outbound-connection audit (install strace to enable it)"
  fi

  local serve_log="$work/serve.log" trace_file="$work/serve.strace"
  if [[ $use_strace -eq 1 ]]; then
    log "starting under strace -f -e trace=connect"
    (
      cd "$workspace" &&
        exec setsid strace -f -e trace=connect -o "$trace_file" \
          "${sf_env[@]}" serve --host 127.0.0.1 --port "$port"
    ) >"$serve_log" 2>&1 &
  else
    (
      cd "$workspace" &&
        exec setsid "${sf_env[@]}" serve --host 127.0.0.1 --port "$port"
    ) >"$serve_log" 2>&1 &
  fi
  SRV_PID=$!

  local health_url="http://127.0.0.1:$port/api/health"
  local code deadline=$((SECONDS + startup_timeout))
  while :; do
    if ! kill -0 "$SRV_PID" 2>/dev/null; then
      printf -- '---- sf serve exited early; tail of %s ----\n' "$serve_log" >&2
      tail -n 40 "$serve_log" >&2 || true
      [[ -s "$trace_file" ]] && { printf -- '---- tail of %s ----\n' "$trace_file" >&2; tail -n 20 "$trace_file" >&2 || true; }
      fail "sf serve died before answering $health_url"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$health_url" || true)"
    [[ "$code" == "200" ]] && break
    if ((SECONDS >= deadline)); then
      stop_server
      printf -- '---- timed out after %ss; tail of %s ----\n' "$startup_timeout" "$serve_log" >&2
      tail -n 40 "$serve_log" >&2 || true
      fail "sf serve did not answer $health_url (last status: ${code:-none})"
    fi
    sleep 1
  done
  log "GET /api/health -> 200: $(curl -fsS -m 5 "$health_url")"

  local headers="$work/root.headers" body="$work/root.html"
  curl -sS -D "$headers" -o "$body" -m 10 "http://127.0.0.1:$port/" || fail "GET / failed"
  local root_status root_ct
  root_status="$(awk 'NR==1 {print $2}' "$headers")"
  root_ct="$(awk 'tolower($1) == "content-type:" {print $2}' "$headers")"
  [[ "$root_status" == "200" ]] || fail "GET / returned status ${root_status:-none}"
  if [[ "$root_ct" != text/html* ]] && ! grep -qiE '<(!doctype|html)[[:space:]]' "$body"; then
    fail "GET / did not return the web UI (content-type: '${root_ct:-none}', body: $(head -c 120 "$body"))"
  fi
  log "GET / -> 200 ${root_ct:-} ($(wc -c <"$body") bytes)"
  stop_server

  if [[ $use_strace -eq 1 ]]; then
    step "Auditing outbound connections from sf serve"
    local -a violations=()
    mapfile -t violations < <(audit_connects "$trace_file")
    local total_connects n_violations
    total_connects="$(grep -c -- 'connect(' "$trace_file" || true)"
    log "connect() attempts traced: ${total_connects:-0} (loopback and AF_UNIX are allowed)"
    if [[ ${#violations[@]} -gt 0 ]]; then
      # Each violation is reported as two lines (address + strace line), so
      # count the header lines rather than array elements.
      n_violations="$(printf '%s\n' "${violations[@]}" | grep -c '^non-loopback connect' || true)"
      printf '%s\n' "${violations[@]}" >&2
      fail "sf serve attempted ${n_violations} non-loopback connect(s) — the packaged app must not talk to external services"
    fi
    log "no non-loopback connect() attempts"
  fi

  # ── [7] node-pty: load and spawn a real PTY ───────────────────────────────
  step "Spawning a PTY through the bundled runtime (node-pty)"
  cat >"$work/pty-check.js" <<'EOF'
// Smoke check: node-pty must load from the packaged tree and actually spawn
// a PTY that echoes output back. Loading fails outright if the native binary
// (build/Release/pty.node) is missing or has the wrong ABI.
const path = require('path');
const Module = require('module');
const appDir = process.argv[2];
const appRequire = Module.createRequire(path.join(appDir, 'package.json'));
const MARKER = 'sf-pty-smoke-ok';
let pty;
try {
  pty = appRequire('node-pty');
} catch (err) {
  console.error('node-pty failed to load: ' + (err && err.message ? err.message : err));
  process.exit(1);
}
const proc = pty.spawn('/bin/sh', ['-c', 'echo ' + MARKER], {
  name: 'xterm', cols: 80, rows: 24, env: process.env, cwd: appDir,
});
let out = '';
const timer = setTimeout(() => {
  console.error('timed out waiting for PTY output');
  try { proc.kill(); } catch { /* already gone */ }
  process.exit(1);
}, 30000);
proc.onData((d) => { out += d; });
proc.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (out.indexOf(MARKER) === -1) {
    console.error('PTY spawned but the marker never came back; output=' + JSON.stringify(out));
    process.exit(1);
  }
  if (exitCode !== 0) {
    console.error('PTY child exited with code ' + exitCode);
    process.exit(1);
  }
  console.log('node-pty loaded and spawned a PTY (marker echoed back)');
  process.exit(0);
});
EOF
  run_logged "$work/pty.log" timeout 60 "$bundled_node" "$work/pty-check.js" "$app_dir" \
    || fail "node-pty check failed"
  tail -n 2 "$work/pty.log"

  # ── [8] Purge preserves user data (default mode only) ─────────────────────
  if [[ $extract -eq 0 ]]; then
    step "Purging package and checking that user data survives"
    run_logged "$work/apt-purge.log" "${sudo_cmd[@]}" apt-get purge -y stoneforge \
      || fail "apt-get purge failed"
    tail -n 12 "$work/apt-purge.log"
    if dpkg -s stoneforge >/dev/null 2>&1; then
      fail "dpkg still reports stoneforge as installed after purge"
    fi
    [[ ! -e /opt/stoneforge ]] || fail "/opt/stoneforge still exists after purge"
    [[ ! -e /usr/bin/sf ]] || fail "/usr/bin/sf still exists after purge"
    [[ ! -e /usr/bin/stoneforge ]] || fail "/usr/bin/stoneforge still exists after purge"
    if command -v sf >/dev/null 2>&1; then
      fail "sf still resolves on PATH after purge: $(command -v sf)"
    fi
    [[ -f "$workspace/.stoneforge/stoneforge.db" ]] \
      || fail "purge removed .stoneforge/stoneforge.db — user workspaces must never be touched"
    [[ -f "$workspace/.stoneforge/config.yaml" ]] \
      || fail "purge removed .stoneforge/config.yaml — user workspaces must never be touched"
    [[ -f "$workspace/.stoneforge/SMOKE-SENTINEL" ]] \
      || fail "purge removed a file created inside the user workspace"
    log "user workspace intact at $workspace/.stoneforge"
  fi

  printf '\nSMOKE TEST PASSED (%s mode, stoneforge v%s)\n' "$mode" "$app_version"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
