---
"@stoneforge/smithy": minor
---

Scope the agent-defaults `fallbackChain` to workers without an explicit `executablePath` (worker dispatch tiers, design D6). A worker that names its own executable — typically a wrapper such as `claude-glm` — is now always spawned with it and rate-limit-checked against its own account key, instead of being rewritten to the first available chain entry. Workers without one keep the existing chain behaviour. **Behaviour change:** if you relied on the chain overriding a wrapper worker's executable, clear that worker's `executablePath`.

Also fix the no-chain path of `resolveExecutableWithFallback` to key the rate-limit check with `resolveAccountKey` instead of the provider name: a default `claude-code` worker previously checked `'claude-code'`, which never matched limits reported by sessions for the `claude` binary the provider actually spawns, so rate-limited default workers kept being dispatched.
