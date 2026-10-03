# MotusLab Ubuntu `.deb` packaging

Files used by [`scripts/build-deb.sh`](../../scripts/build-deb.sh) to build the
self-contained Ubuntu package (design D1–D4 of the MotusLab Ubuntu Release
spec, workspace document `el-12jf6c`).

| File             | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `NODE_VERSION`   | Pinned Node.js `22.x.y` bundled into the package. One place to bump.       |
| `control.in`     | `dpkg` control template. `@VERSION@` / `@INSTALLED_SIZE@` are substituted at build time. |
| `postinst`       | Re-applies the node-pty `spawn-helper` execute bit. Nothing else.          |
| `sf-launcher`    | Installed as `/usr/bin/sf` and `/usr/bin/stoneforge`.                      |

## Installed layout

```
/opt/stoneforge/node/…            official Node.js runtime (linux-x64 tarball)
/opt/stoneforge/app/…             pnpm deploy output: dist/, web/, node_modules/
/usr/bin/sf, /usr/bin/stoneforge  shell launchers, exec the bundled node
```

The launchers are shell scripts rather than symlinks so `sf` always runs on
the bundled runtime even when another Node.js is on `PATH`. They honour
`STONEFORGE_HOME` (default `/opt/stoneforge`) so an extracted package can be
tested without installing it:

```sh
dpkg-deb -x stoneforge_<ver>_amd64.deb /tmp/sftest
STONEFORGE_HOME=/tmp/sftest/opt/stoneforge /tmp/sftest/usr/bin/sf --version
```

## Verify a built package

```sh
# no root needed; set SMOKE_PORT if 3457 is already taken on this machine
SMOKE_PORT=3477 scripts/smoke-test-deb.sh dist-deb/stoneforge_<ver>_amd64.deb --extract

# CI / disposable machines: installs with sudo apt-get, purges afterwards
sudo scripts/smoke-test-deb.sh dist-deb/stoneforge_<ver>_amd64.deb --expect-version 1.25.0
```

The smoke test (design D7) checks package metadata, the bundled runtime (with
a poisoned-`PATH` `node` trap), `sf --version` (the reported version token
must equal the expected one exactly — `1.25.0` rejects a reported
`v1.25.01`), `sf init` (exercises better-sqlite3), `sf serve` health + web
UI + an outbound-connection strace audit, a node-pty PTY spawn, and — in
default mode — that `apt-get purge` removes only the package while user
workspaces survive. Its pure helpers (version comparison, strace classifier)
have built-in unit tests: `scripts/smoke-test-deb.sh --self-test` (needs no
.deb). See `scripts/smoke-test-deb.sh --help`.


## Build

```sh
scripts/build-deb.sh <deb-version> <outdir>   # e.g. 1.25.0+motuslab1 dist-deb/
```

The script builds the workspace (`pnpm build`, `build:web`), stages the app
with `pnpm --filter @stoneforge/smithy deploy --prod`, prunes artifacts that
cannot run on linux/amd64 glibc (the claude-agent-sdk musl build, node-pty
win32/darwin prebuilds), downloads and checksum-verifies the pinned Node.js
tarball from nodejs.org, rebuilds `better-sqlite3` and `node-pty` against the
bundled runtime, and runs `dpkg-deb --build --root-owner-group -Zxz`.

The native rebuild prepends the bundled `node/bin` to `PATH`: the bundled
npm's `#!/usr/bin/env node` shebang and its lifecycle children (node-gyp,
prebuild-install, install hooks) otherwise resolve the *host* Node and rebuild
against its ABI. `better-sqlite3` is ABI-pinned, so a host-ABI binary fails to
load under the bundled runtime. The build fails loudly if `node` does not
resolve to the bundled binary at rebuild time.

Releases are built on Ubuntu 22.04 (spec D3) so native binaries never require
a glibc newer than the oldest supported target. `SHA256SUMS` is written next
to the `.deb`.

Nothing here uploads to third-party services; downloads are limited to npm
dependencies (via pnpm) and the Node.js runtime from nodejs.org.
