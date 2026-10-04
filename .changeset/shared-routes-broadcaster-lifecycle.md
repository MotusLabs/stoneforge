---
"@stoneforge/shared-routes": minor
---

Make the `EventBroadcaster` lifecycle race-safe and add `resetBroadcaster()`. Previously, `stop()` called while `start()` was still awaiting its database initialization was a no-op (`pollInterval` not yet set), and `start()` then resumed and armed the poll interval anyway — leaving a poller running against torn-down resources. `start()` now tracks its in-flight startup (concurrent calls share one startup) and a generation guard prevents arming the interval after a racing `stop()`. `stop()` is now async and awaits in-flight startup before clearing the interval, so awaiting it guarantees no broadcaster async work is left running.

The new `resetBroadcaster(instance?)` export clears the module singleton (stopping it first if still polling), so a later `initializeBroadcaster()` in the same process creates a fresh instance instead of reusing a stopped broadcaster bound to a closed database — the pattern integration tests hit when creating and tearing down apps sequentially. Passing an instance only clears the singleton when it is that exact instance.
