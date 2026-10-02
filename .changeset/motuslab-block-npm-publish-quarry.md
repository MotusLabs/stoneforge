---
"@stoneforge/quarry": patch
---

Remove npm publishing. All workspace packages are now `private`, `publishConfig` is gone, and `scripts/release.ts` only bumps versions and pushes a `v<version>-motuslab.<n>` tag — it never publishes to npm or creates a GitHub release. Accidental third-party publishes are guarded by `scripts/check-no-third-party-publish.sh`.
