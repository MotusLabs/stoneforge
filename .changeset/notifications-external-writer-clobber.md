---
"@stoneforge/smithy-web": patch
---

Fix `useNotifications` clobbering externally-written notifications in localStorage (root cause of the intermittent `badge shows 99+` e2e flake). The save-on-change effect no longer persists on mount, every mutating callback (add, markRead, markAllAsRead, dismiss) merges with the current localStorage contents by id before saving so same-tab external writes survive, and a `storage` event listener adopts cross-tab/external writes into state. `clearAll` still wipes deliberately. The unread-count cap on add now has a floor of the merged list size, so a list seeded larger than 100 by an external writer no longer shrinks on the next app-added notification. The notifications e2e spec seeds localStorage via `addInitScript` before any app code runs (replacing the racy `goto → evaluate → reload` pattern in eight tests) and gains a regression test asserting an external write survives an app-side state change — verified to fail against the old hook.
