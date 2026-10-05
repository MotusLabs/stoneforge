---
"@stoneforge/quarry-web": patch
---

Make the block editor's compact toolbar overflow menu reachable and testable. Overflow `MenuItem`s now carry the same `toolbar-${id}` testid the action has as a top-level button (previously they had none, so actions like Insert Emoji were unaddressable in overflow mode), and `DropdownMenu.Content` is capped to `--radix-dropdown-menu-content-available-height` with internal scrolling — the ~19-item menu previously rendered uncapped (~870px tall), pushing its tail (Insert Image / Insert Emoji) below the viewport where it could not be clicked at common window sizes. tb97 Emoji Picker Modal spec updated to open the overflow menu when present and to target the real `emoji-picker-modal-{content,close,backdrop}` testids derived by `ResponsiveModal`.
