---
"@stoneforge/quarry-web": patch
---

Fix the "/"-to-focus-search keyboard shortcut stealing the "/" keystroke from the block editor on the Documents page. DocumentSearchBar's global keydown listener only excluded `HTMLInputElement`/`HTMLTextAreaElement`, but the TipTap editor's editable surface is a contenteditable `<div>` — so typing "/" to open the slash-command menu was `preventDefault()`-ed and focus jumped to the search box, making the menu unreachable. The guard now uses the shared `isEditableTarget()` helper (`apps/quarry-web/src/lib/keyboard.ts`, same check as `KeyboardShortcutManager`), which also covers contenteditable targets. The shortcut still fires when "/" is pressed outside editable regions.
