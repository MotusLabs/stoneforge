# Changelog

## Unreleased — MotusLab release path

### Breaking changes

- MotusLab builds now ship as self-contained Ubuntu 22.04/24.04 amd64 `.deb`
  assets with `SHA256SUMS` on GitHub Releases in `MotusLabs/stoneforge`.
  Install and upgrade downloaded files with apt; npm releases have stopped.
- Removed npm publishing and Cloudflare docs/website deployment workflows.
  Workspace packages are private; Changesets still versions them and writes
  changelogs. Release tags use `v<x.y.z>-motuslab.<n>`.
- Existing npm-installed commands earlier on `PATH` can shadow `/usr/bin/sf`;
  remove them or adjust `PATH` when migrating. See the
  [release and install how-to](docs/motuslab-release.md).

## 0.1.0 (Unreleased)

Initial public release of Stoneforge.

### Packages

- `@stoneforge/core` - Core types, errors, ID generation, utilities
- `@stoneforge/storage` - SQLite storage with multi-runtime support (Bun, Node, browser)
- `@stoneforge/quarry` - SDK with API, services, sync engine, and CLI
- `@stoneforge/smithy` - AI agent orchestration (Director, Worker, Steward roles)
- `@stoneforge/ui` - Shared React UI components and design tokens
- `@stoneforge/shared-routes` - Shared Hono route factories
