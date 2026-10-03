# Quarry Playwright triage — el-2y9h5w (incomplete)

## Interrupted baseline

2026-10-03: `pnpm install --frozen-lockfile` succeeded in the assigned fresh
worktree. Ran `bun run --cwd apps/quarry-web test:e2e --workers=1`, without
`--max-failures`, with `/usr/local/bin` excluded from PATH. A private bin directory
symlinked only Node, alongside `/home/coder/.local/bin:/usr/bin:/bin`.
The actual suite has **2,340 tests**, across approximately 131 spec files.
Two workspace server restarts killed the runner. The first log in `/tmp` was lost;
the second log was retained inside the worktree. The second attempt completed
**155 tests: 103 passed, 35 failed, 17 skipped**, with **2,185 tests unrun**.
These are partial baseline counts, not final full-suite counts.
After an interrupted run, remove only the dedicated `.stoneforge-test/` scratch
directory before retrying: its leftover operator causes global setup to fail.

## Every recorded failure from the second attempt

Classification below is provisional where investigation has not finished.

### Intentional paginated API response changes (fixed reads; verification below)

- ✘     1 [chromium] › tests/block-editor.spec.ts:8:3 › TB22: Block Editor › PATCH /api/documents/:id endpoint updates document content (69ms)
- ✘     2 [chromium] › tests/block-editor.spec.ts:39:3 › TB22: Block Editor › PATCH /api/documents/:id endpoint updates document title (59ms)
- ✘     4 [chromium] › tests/block-editor.spec.ts:75:3 › TB22: Block Editor › PATCH /api/documents/:id validates contentType (39ms)
- ✘     5 [chromium] › tests/block-editor.spec.ts:92:3 › TB22: Block Editor › PATCH /api/documents/:id validates JSON content when contentType is json (52ms)
- ✘     6 [chromium] › tests/block-editor.spec.ts:116:3 › TB22: Block Editor › document detail panel has edit button (4.0s)
- ✘     7 [chromium] › tests/block-editor.spec.ts:154:3 › TB22: Block Editor › clicking edit button shows editor and save/cancel buttons (1.8s)
- ✘     8 [chromium] › tests/block-editor.spec.ts:209:3 › TB22: Block Editor › clicking cancel button exits edit mode (1.8s)
- ✘     9 [chromium] › tests/block-editor.spec.ts:264:3 › TB22: Block Editor › title input is shown in edit mode (1.8s)
- ✘    10 [chromium] › tests/block-editor.spec.ts:318:3 › TB22: Block Editor › block editor toolbar is visible in edit mode (1.9s)
- ✘    11 [chromium] › tests/block-editor.spec.ts:373:3 › TB22: Block Editor › editor content area is focusable (1.8s)
- ✘    12 [chromium] › tests/block-editor.spec.ts:435:3 › TB22: Block Editor › saving document updates persists changes (1.8s)
- ✘    13 [chromium] › tests/block-editor.spec.ts:508:3 › TB22: Block Editor › save error is displayed when update fails (1.9s)
- ✘    28 [chromium] › tests/channels.spec.ts:4:3 › TB16: Channel List › GET /api/channels endpoint returns channels (36ms)
- ✘    29 [chromium] › tests/channels.spec.ts:11:3 › TB16: Channel List › GET /api/channels/:id endpoint returns channel (56ms)
- ✘    35 [chromium] › tests/channels.spec.ts:73:3 › TB16: Channel List › clicking channel shows channel view (696ms)
- ✘    36 [chromium] › tests/channels.spec.ts:95:3 › TB16: Channel List › channel item shows correct info (726ms)
- ✘    37 [chromium] › tests/channels.spec.ts:113:3 › TB16: Channel List › group channels are separated from direct messages (49ms)
- ✘    39 [chromium] › tests/channels.spec.ts:147:3 › TB16: Channel List › selected channel is highlighted (701ms)

### Intentional UI changes and related pagination (partly fixed; dialog updates pending)

- ✘    47 [chromium] › tests/command-palette.spec.ts:105:3 › TB10: Command Palette › command palette filters results on search (6.0s)
- ✘    49 [chromium] › tests/command-palette.spec.ts:140:3 › TB10: Command Palette › command palette keyboard navigation works (5.9s)
- ✘    66 [chromium] › tests/create-channel.spec.ts:8:3 › TB31: Create Channel › POST /api/channels endpoint creates a group channel (38ms)
- ✘    67 [chromium] › tests/create-channel.spec.ts:47:3 › TB31: Create Channel › POST /api/channels endpoint creates a direct channel (49ms)
- ✘    69 [chromium] › tests/create-channel.spec.ts:118:3 › TB31: Create Channel › POST /api/channels endpoint validates direct channel entities (44ms)
- ✘    72 [chromium] › tests/create-channel.spec.ts:177:3 › TB31: Create Channel › create channel modal has required fields for group channel (5.7s)
- ✘    77 [chromium] › tests/create-channel.spec.ts:263:3 › TB31: Create Channel › can create a group channel from modal (6.4s)
- ✘    78 [chromium] › tests/create-channel.spec.ts:303:3 › TB31: Create Channel › submit button is disabled without required fields (30.0s)
- ✘    80 [chromium] › tests/create-channel.spec.ts:357:3 › TB31: Create Channel › channel appears in list after creation (6.4s)
- ✘    81 [chromium] › tests/create-library.spec.ts:8:3 › TB29: Create Library › POST /api/libraries endpoint creates a library (61ms)
- ✘    84 [chromium] › tests/create-library.spec.ts:103:3 › TB29: Create Library › POST /api/libraries endpoint rejects invalid parent (38ms)
- ✘    87 [chromium] › tests/create-library.spec.ts:152:3 › TB29: Create Library › create library modal has required fields (6.1s)
- ✘    92 [chromium] › tests/create-library.spec.ts:252:3 › TB29: Create Library › submit button is disabled without required fields (30.0s)

### Unclassified failures requiring investigation; do not assume app bugs

- ✘    60 [chromium] › tests/core-components.spec.ts:179:5 › TB73: Core Component Styling › Select/Dropdown Component › dropdown menus open and show options (1.3s)
- ✘   108 [chromium] › tests/dark-light-mode.spec.ts:179:5 › TB72: Dark/Light Mode Overhaul › Notification Types Padding Fix › notification types list has horizontal padding (801ms)
- ✘   133 [chromium] › tests/data-preloader.spec.ts:17:5 › TB67: Upfront Data Loading Strategy › Loading Spinner › error state shows retry button on API failure (10.7s)
- ✘   142 [chromium] › tests/data-preloader.spec.ts:218:5 › TB67: Upfront Data Loading Strategy › Error Recovery › clicking retry after error reloads data (12.6s)

## Changes and verification

Only tests changed. Stale array reads of `/api/documents`, `/api/entities`, and
`/api/channels` now consume the paginated response's `items` property. Existing
envelope-aware consumers and collection/detail endpoints are unchanged. No skips
were added; existing conditional skips still depend on available fixture data.

- Block-editor + channels targeted check: **10 passed, 16 skipped, 0 failed**.
  Empty document/channel fixtures mean the skipped UI cases were not exercised.
- `tb146-responsive-dashboard.spec.ts --repeat-each=3 --workers=1`:
  **54 passed, 0 failed**. The reported navigation timeout did not reproduce;
  record it as flaky/environment. Responsive dependency graph tests from
  **el-29w9r3** were included and passed unchanged.
- Final API checks across all 18 changed specs (grep `GET /api|POST /api|PATCH /api|endpoint`):
  **45 passed, 8 skipped, 0 failed**.
  The first such check found five attachment failures at one shared fixture.
  Fixed its group-channel name (no spaces) and supplied a second member; all five
  attachment API tests then passed independently and in the combined check.
  Existing `permissions` input shape was not changed in this partial patch.

Logs from this session are preserved at `test-results/triage-el-2y9h5w/` in the
assigned worktree (ignored by Git). This report preserves every baseline failure
in Git even if the worktree or ignored logs are removed.

## Next worker

Run a complete baseline/final suite in a workspace stable long enough for 2,340
single-worker tests. Complete the remaining stale-selector and intentional-UI
updates, then investigate remaining failures and file one task per distinct
confirmed app bug. No app bug has been confirmed or filed in this partial pass.
Creation dialogs intentionally use the current user rather than a Created by
selector. Command palette Task Flow was replaced by Tasks at `/tasks`.
Do not change application behavior to satisfy those old expectations.

Leave playbook-only workflow creation to **el-1dquh0** (workflows.spec.ts,
playbooks.spec.ts, tb77, tb122, tb148); those files were not changed here.
Leave responsive dependency graph coverage to **el-29w9r3**.
Full pass/fail counts and complete root-cause grouping remain outstanding.
