"@stoneforge/quarry-web": patch
---

Fix two axe critical/serious accessibility defects on `/dashboard/timeline` (tb119).

- The `ViewModeToggle` icon buttons (`view-mode-list` / `view-mode-horizontal`) computed an empty accessible name: their only text lives in `hidden xs:inline` spans, and `xs:` is not a real Tailwind v4 variant in this app (the `--breakpoint-*` tokens in `src/styles/tokens.css` are in a plain `:root` block, not `@theme`), so the span is `display: none` at every viewport — excluded from accessible-name computation. Both buttons now carry an `aria-label` ("List view" / "Timeline view") that contains the visible label (WCAG 2.5.3 label-in-name), matching the `task/ViewToggle` convention. No visual change: the label span stays hidden.
- The timeline `events-list` scrollable region had no `tabindex`, so keyboard users could not reach or scroll it (axe `scrollable-region-focusable`). It now has `tabIndex={0}`, `role="region"` and `aria-label="Events list"` — the same pattern as the Plans content region — making it focusable, keyboard-scrollable, and announced when focused.
