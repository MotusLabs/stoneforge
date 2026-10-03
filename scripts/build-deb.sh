#!/usr/bin/env bash
# build-deb.sh — assemble the MotusLab self-contained Ubuntu package.
#
# Usage: scripts/build-deb.sh <deb-version> <outdir>
#   deb-version  Debian version string, e.g. 1.25.0+motuslab1
#   outdir       Directory that receives stoneforge_<ver>_amd64.deb and SHA256SUMS
#
# Design: MotusLab Ubuntu Release Spec D1-D4 (workspace doc el-12jf6c).
# Nothing is uploaded to third-party services. Build inputs (npm dependencies
# via pnpm, the Node.js runtime from nodejs.org) are downloaded only.
#
# Works on Ubuntu 22.04 CI runners and Debian 12 developer workspaces.
# Requires: bash, curl, tar, xz, sha256sum, dpkg-deb, pnpm, and a working
# C toolchain (python3, make, g++) if a native module has to be source-built.

set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage: scripts/build-deb.sh <deb-version> <outdir>

  deb-version  Debian version, e.g. 1.25.0+motuslab1
  outdir       Output directory for stoneforge_<ver>_amd64.deb and SHA256SUMS
EOF
  exit 1
}

if [[ $# -ne 2 ]]; then
  usage
fi

DEB_VERSION="$1"
OUTDIR="$2"

if [[ ! "$DEB_VERSION" =~ ^[0-9][A-Za-z0-9.+~:-]*$ ]]; then
  echo "error: invalid Debian version: $DEB_VERSION" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_VERSION="$(tr -d '[:space:]' < "$ROOT/packaging/deb/NODE_VERSION")"
if [[ -z "$NODE_VERSION" ]]; then
  echo "error: packaging/deb/NODE_VERSION is empty" >&2
  exit 1
fi

NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
SHASUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v pnpm >/dev/null 2>&1 || die "pnpm is required (corepack enable / pnpm 8.15.5)"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/stoneforge-deb.XXXXXX")"
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

STAGE="$WORK/stage"
PKG_ROOT="$WORK/pkg"
mkdir -p "$STAGE" "$PKG_ROOT" "$OUTDIR"

# Resolve OUTDIR to an absolute path before we change directories.
OUTDIR="$(cd "$OUTDIR" && pwd)"

log "Debian version: ${DEB_VERSION}"
log "Bundled Node.js: v${NODE_VERSION}"
log "Work directory: ${WORK}"

# ── 1. Build workspace and web UI ───────────────────────────────────────────

log "Building workspace packages (pnpm build)"
pnpm build

log "Building smithy web UI (build:web)"
pnpm --filter @stoneforge/smithy-web run build:web

# ── 2. Stage the app (D1: pnpm deploy) ──────────────────────────────────────

log "Staging production app with pnpm deploy"
rm -rf "$STAGE/app"
pnpm --filter @stoneforge/smithy deploy --prod "$STAGE/app"

[[ -f "$STAGE/app/dist/bin/sf.js" ]] || die "deploy did not produce app/dist/bin/sf.js"

# ── 2b. Prune artifacts that can never run on the target platform ───────────
# The target is linux/amd64 (glibc). Two kinds of dead weight arrive via
# `pnpm deploy`:
#   * @anthropic-ai/claude-agent-sdk ships glibc and musl builds of the agent
#     binary. The SDK resolves `...-linux-x64` first and only falls back to
#     `...-linux-x64-musl` when the glibc build is absent, so the musl build
#     (~222 MB) is never executed. Other platforms (darwin/win32/arm64) are
#     excluded by npm's platform filters already; prune them defensively.
#   * node-pty ships win32/darwin `prebuilds/` (~58 MB). On Linux the loader
#     uses build/Release/pty.node (rebuilt in step 4), never those prebuilds.
log "Pruning non-target platform artifacts (musl/win32/darwin)"
find "$STAGE/app/node_modules/.pnpm" -mindepth 1 -maxdepth 1 -type d \
  -name '@anthropic-ai+claude-agent-sdk-*' \
  ! -name '@anthropic-ai+claude-agent-sdk-linux-x64@*' \
  -exec rm -rf {} +
for pty_prebuilds in "$STAGE/app/node_modules/.pnpm"/node-pty@*/node_modules/node-pty/prebuilds; do
  [[ -d "$pty_prebuilds" ]] || continue
  find "$pty_prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name 'linux-*' \
    -exec rm -rf {} +
done
# Pruned package dirs may still be symlinked from sibling node_modules;
# dangling links confuse nothing at runtime but are unclean — drop them too.
find "$STAGE/app" -xtype l -delete

# ── 3. Download and verify the bundled Node.js runtime (D2) ────────────────

# --retry-all-errors: transient DNS/TLS failures (common on shared CI networks)
# are retried too, not just HTTP 5xx/timeouts.
fetch() {
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 15 \
    -o "$2" "$1"
}

log "Downloading ${NODE_TARBALL} from nodejs.org"
fetch "$NODE_URL" "$WORK/$NODE_TARBALL"
fetch "$SHASUMS_URL" "$WORK/SHASUMS256.txt"

log "Verifying tarball against SHASUMS256.txt"
# SHASUMS256.txt lines look like "<hash>  <file>" or "<hash> *<file>".
grep -F "$NODE_TARBALL" "$WORK/SHASUMS256.txt" \
  | awk '{ fn=$2; sub(/^\*/, "", fn); print $1 "  " fn }' \
  > "$WORK/check.sum" || true
[[ -s "$WORK/check.sum" ]] || die "SHASUMS256.txt has no entry for $NODE_TARBALL"
(cd "$WORK" && sha256sum -c check.sum)

log "Unpacking Node.js runtime"
tar -xJf "$WORK/$NODE_TARBALL" -C "$WORK"
[[ -d "$WORK/$NODE_DIST" ]] || die "tarball did not unpack to $NODE_DIST"
mkdir -p "$STAGE/node"
# Copy contents rather than moving the renamed dir, so paths stay predictable.
cp -a "$WORK/$NODE_DIST/." "$STAGE/node/"

NODE_BIN="$STAGE/node/bin/node"
NPM_BIN="$STAGE/node/bin/npm"
[[ -x "$NODE_BIN" ]] || die "bundled node binary missing: $NODE_BIN"
[[ -x "$NPM_BIN" ]] || die "bundled npm missing: $NPM_BIN"

# ── 4. Rebuild native modules against the bundled runtime ──────────────────

APP_DIR="$STAGE/app"

# Locate every installed copy of the native modules (top-level and nested).
find_native() {
  local name="$1"
  find "$APP_DIR/node_modules" -type d -name "$name" \
    ! -path '*/node_modules/*/node_modules/.pnpm/*' 2>/dev/null \
    ! -path '*/prebuilds/*' | sort -u
}

rebuild_one() {
  local dir="$1"
  log "Rebuilding $(basename "$dir") in ${dir#"$APP_DIR"/}"
  # D2: the rebuild must target the *bundled* runtime's ABI. The bundled npm
  # is a `#!/usr/bin/env node` script, and every lifecycle child it spawns
  # (node-gyp, prebuild-install, `node scripts/*.js` install hooks) resolves
  # `node` from PATH the same way. Put the bundled node/bin in front of PATH
  # for both attempts below and everything they spawn; otherwise a host Node
  # of a different major rebuilds the modules against the host ABI, and the
  # bundled runtime cannot load them. Scoped to this function so the build
  # and deploy steps above keep using the host toolchain.
  local PATH="$STAGE/node/bin:$PATH"
  # Fail loudly instead of silently producing host-ABI binaries if the PATH
  # prepend above ever stops working.
  local rebuild_node
  rebuild_node="$(command -v node)" || true
  [[ "$rebuild_node" == "$STAGE/node/bin/node" ]] \
    || die "native rebuild would run under '${rebuild_node:-no node found}', expected the bundled $STAGE/node/bin/node"
  # Prefer prebuilt binaries for the bundled Node ABI; fall back to source.
  # npm_config_build_from_source=false is the portable form of --build-from-source=false.
  if ! (cd "$dir" && npm_config_build_from_source=false "$NPM_BIN" rebuild --no-audit --no-fund); then
    log "  prebuild path failed; rebuilding from source"
    (cd "$dir" && npm_config_build_from_source=true "$NPM_BIN" rebuild --build-from-source --no-audit --no-fund)
  fi
}

NATIVE_DIRS=()
while IFS= read -r d; do
  [[ -n "$d" ]] && NATIVE_DIRS+=("$d")
done < <( { find_native better-sqlite3; find_native node-pty; } )

if [[ ${#NATIVE_DIRS[@]} -eq 0 ]]; then
  die "no better-sqlite3 or node-pty directories found under $APP_DIR/node_modules"
fi

for dir in "${NATIVE_DIRS[@]}"; do
  rebuild_one "$dir"
done

# node-pty permission fix (spawn-helper execute bit).
# node-pty ships spawn-helper only in some prebuilds (darwin) and in
# build/Release after a mac source build; Linux builds may not have it.
# Always re-apply the execute bit on whatever copies exist.
log "Applying node-pty spawn-helper permission fix"
if [[ -f "$APP_DIR/scripts/fix-node-pty-permissions.cjs" ]]; then
  "$NODE_BIN" "$APP_DIR/scripts/fix-node-pty-permissions.cjs" || true
fi
while IFS= read -r helper; do
  chmod 755 "$helper"
  log "  chmod 755 ${helper#"$APP_DIR"/}"
done < <(find "$APP_DIR" -type f -name spawn-helper -path '*node-pty*' 2>/dev/null)

# Sanity: native modules must load under the bundled Node.
# better-sqlite3 is a dependency of @stoneforge/storage (not of smithy), so
# resolve it from the storage package. node-pty is a direct smithy dependency.
log "Checking native modules load under bundled Node"
"$NODE_BIN" -e '
  const Module = require("module");
  const path = require("path");
  const fs = require("fs");
  const app = process.argv[1];
  const appReq = Module.createRequire(path.join(app, "package.json"));
  let ok = true;

  function load(label, req, name) {
    try {
      req(name);
      console.log("  loaded " + label);
      return true;
    } catch (e) {
      console.error("  FAILED to load " + label + ": " + e.message);
      return false;
    }
  }

  // node-pty: direct dependency of the deployed app.
  ok = load("node-pty (app root)", appReq, "node-pty") && ok;

  // better-sqlite3: resolve through @stoneforge/storage.
  let storageReq = null;
  try {
    storageReq = Module.createRequire(appReq.resolve("@stoneforge/storage/package.json"));
    ok = load("better-sqlite3 (via @stoneforge/storage)", storageReq, "better-sqlite3") && ok;
  } catch (e) {
    console.error("  FAILED to resolve @stoneforge/storage: " + e.message);
    ok = false;
  }

  // Explicitly exercise the compiled bindings so ABI mismatches fail here.
  const bindingPaths = [
    ["better-sqlite3", "better_sqlite3.node"],
    ["node-pty", "pty.node"],
  ];
  for (const [name, file] of bindingPaths) {
    let found = null;
    const walk = (dir, depth) => {
      if (depth > 8 || found) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory() || e.isSymbolicLink()) {
          if (e.name === name || e.name === "node_modules" || e.name === ".pnpm" || e.name.startsWith("@")) {
            walk(p, depth + 1);
          }
          const candidate = path.join(p, "build", "Release", file);
          if (e.name === name && fs.existsSync(candidate)) found = candidate;
        }
      }
    };
    walk(path.join(app, "node_modules"), 0);
    if (found) {
      try {
        process.dlopen({ exports: {} }, found);
        console.log("  loaded binding " + path.relative(app, found));
      } catch (e) {
        console.error("  FAILED binding " + path.relative(app, found) + ": " + e.message);
        ok = false;
      }
    } else {
      console.log("  note: no build/Release/" + file + " (prebuilds may be in use)");
    }
  }

  if (!ok) process.exit(1);
' "$APP_DIR"

# ── 5. Assemble package layout (D4) ────────────────────────────────────────

log "Assembling package layout"
mkdir -p "$PKG_ROOT/opt/stoneforge" "$PKG_ROOT/usr/bin" "$PKG_ROOT/DEBIAN"

mv "$STAGE/node" "$PKG_ROOT/opt/stoneforge/node"
mv "$STAGE/app" "$PKG_ROOT/opt/stoneforge/app"

install -m 0755 "$ROOT/packaging/deb/sf-launcher" "$PKG_ROOT/usr/bin/sf"
install -m 0755 "$ROOT/packaging/deb/sf-launcher" "$PKG_ROOT/usr/bin/stoneforge"

# Substitute the placeholders in the control template. Installed-Size is the
# KiB dpkg convention for the data files (everything except DEBIAN/).
INSTALLED_SIZE_KB="$(du -sk "$PKG_ROOT/opt" "$PKG_ROOT/usr" | awk '{s+=$1} END {print s+0}')"
sed -e "s/@VERSION@/${DEB_VERSION}/g" -e "s/@INSTALLED_SIZE@/${INSTALLED_SIZE_KB}/g" \
  "$ROOT/packaging/deb/control.in" > "$PKG_ROOT/DEBIAN/control"
install -m 0755 "$ROOT/packaging/deb/postinst" "$PKG_ROOT/DEBIAN/postinst"

# ── 6. Build the .deb and write SHA256SUMS ─────────────────────────────────

DEB_NAME="stoneforge_${DEB_VERSION}_amd64.deb"
log "Building ${DEB_NAME} (xz, root-owner-group)"
dpkg-deb --build --root-owner-group -Zxz "$PKG_ROOT" "$OUTDIR/$DEB_NAME"

log "Writing SHA256SUMS"
(
  cd "$OUTDIR"
  sha256sum "$DEB_NAME" > SHA256SUMS
)

log "Done"
ls -lh "$OUTDIR/$DEB_NAME" "$OUTDIR/SHA256SUMS"
cat "$OUTDIR/SHA256SUMS"
