---
"@stoneforge/smithy": patch
---

`syncLocalBranch` (the merge steward's post-merge fast-forward of the local target branch) no longer reports a fixed-text "non-ff divergence or missing ref" guess when the fast-forward fails. On clean fast-forwards the recurring real cause is git's overwrite-protection refusal — the main checkout holds live orchestration state in locally-modified tracked files (`.stoneforge/sync/*.jsonl`), so `git merge --ff-only origin/master` aborts with "Your local changes ... would be overwritten by merge", and the old advice to run `git pull` failed identically. The warning now includes the target branch, the checkout path, and the real git stderr, and when the refusal is the local-changes case it says explicitly that there is no divergence and that `git pull` will not help. `syncLocalBranchFromCommit` logs its underlying git error too. Behavior is unchanged (best-effort, non-fatal).
