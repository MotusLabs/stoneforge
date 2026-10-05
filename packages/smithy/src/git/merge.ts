/**
 * Git Merge Utilities
 *
 * Shared squash-merge-in-temp-worktree logic used by both the Merge Steward
 * and the Docs Steward services.
 *
 * Pattern:
 *  1. Fetch origin (skipped when local-only / no remote)
 *  2. (Optional) Pre-flight conflict detection via git merge-tree
 *  3. Create temp worktree with detached HEAD at origin/<target> or local <target>
 *  4. Squash merge (or regular merge) source branch
 *  5. Commit with provided message
 *  6. Push HEAD:<target> to remote (skipped when local-only)
 *  7. Remove temp worktree (always, in finally)
 *  8. (Optional) Sync local target branch via fast-forward
 *
 * Local-only mode is auto-detected when no 'origin' remote exists, or can
 * be forced via the `localOnly` option in MergeBranchOptions.
 *
 * @module
 */

import { exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { withSyncExportLock } from '@stoneforge/quarry';

const execAsync = promisify(exec);

/** Well-known default branch names that should never be auto-created */
const MAIN_BRANCH_NAMES = new Set(['main', 'master']);

// ============================================================================
// Types
// ============================================================================

export interface MergeBranchOptions {
  /** Workspace root (the main repo checkout) */
  workspaceRoot: string;
  /** Branch to merge from */
  sourceBranch: string;
  /** Branch to merge into (auto-detected if omitted) */
  targetBranch?: string;
  /** 'squash' (default) or 'merge' (--no-ff) */
  mergeStrategy?: 'squash' | 'merge';
  /** Push to remote after merge (default: true) */
  autoPush?: boolean;
  /** Commit message (required for squash, auto-generated for merge) */
  commitMessage?: string;
  /** Run pre-flight conflict detection via merge-tree (default: true) */
  preflight?: boolean;
  /** Fast-forward local target branch after push (default: true) */
  syncLocal?: boolean;
  /**
   * When true, skip all remote operations (fetch, push).
   * Auto-detected when no remote named 'origin' is configured.
   */
  localOnly?: boolean;
}

export interface MergeBranchResult {
  /** Whether the merge succeeded */
  success: boolean;
  /** Merge/squash commit hash if successful */
  commitHash?: string;
  /** Whether a conflict was detected */
  hasConflict: boolean;
  /** Error message if merge failed */
  error?: string;
  /** Files with conflicts, if any */
  conflictFiles?: string[];
  /** Whether the source branch was already fully merged into the target (zero commits ahead) */
  alreadyMerged?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run a git command in a worktree directory.
 * Refuses to run in the workspace root to prevent corrupting the main repo HEAD.
 */
export async function execGitSafe(
  command: string,
  worktreePath: string,
  workspaceRoot: string
): Promise<{ stdout: string; stderr: string }> {
  if (path.resolve(worktreePath) === path.resolve(workspaceRoot)) {
    throw new Error(
      `SAFETY: Refusing to run "git ${command}" in main repo. Use a worktree.`
    );
  }
  return execAsync(`git ${command}`, { cwd: worktreePath, encoding: 'utf8' });
}

/**
 * Check whether a named remote exists in the repo.
 *
 * Runs `git remote get-url <remoteName>` which exits 0 when the remote
 * exists and non-zero otherwise.
 */
export async function hasRemote(
  workspaceRoot: string,
  remoteName = 'origin'
): Promise<boolean> {
  try {
    await execAsync(`git remote get-url ${remoteName}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical branch detection function.
 *
 * All consumers in the codebase should delegate to this single function
 * to ensure consistent default-branch detection everywhere. The unified
 * fallback order is:
 *
 *  1. `configBaseBranch` (if provided — from user configuration)
 *  2. `git symbolic-ref refs/remotes/origin/HEAD` (most reliable remote indicator)
 *  3. `git remote show origin` HEAD branch (slower but authoritative)
 *  4. Check existence of origin/main, then origin/master
 *  5. Check existence of local main, then local master
 *  6. Fallback: "main"
 *
 * @param workspaceRoot - The git repository root directory
 * @param configBaseBranch - Optional config-provided base branch name (checked first)
 */
export async function detectTargetBranch(
  workspaceRoot: string,
  configBaseBranch?: string
): Promise<string> {
  // 1. Config value takes priority — if set, trust it unconditionally
  if (configBaseBranch) {
    return configBaseBranch;
  }

  const remoteExists = await hasRemote(workspaceRoot);

  if (remoteExists) {
    // 2. Try origin/HEAD symref (most reliable)
    try {
      const { stdout } = await execAsync('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
      if (match) return match[1];
    } catch {
      // Fall through
    }

    // 3. Try `git remote show origin` HEAD branch
    try {
      const { stdout } = await execAsync('git remote show origin', {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      const match = stdout.match(/HEAD branch: (.+)/);
      if (match) {
        const branch = match[1].trim();
        if (branch && branch !== '(unknown)') return branch;
      }
    } catch {
      // Fall through
    }

    // 4. Check existence of origin/main, then origin/master
    for (const name of ['main', 'master']) {
      try {
        await execAsync(`git rev-parse --verify origin/${name}`, {
          cwd: workspaceRoot,
          encoding: 'utf8',
        });
        return name;
      } catch {
        // Fall through
      }
    }
  }

  // 5. No remote or remote detection failed — try local branches
  for (const name of ['main', 'master']) {
    try {
      await execAsync(`git rev-parse --verify refs/heads/${name}`, {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
      return name;
    } catch {
      // Fall through
    }
  }

  // 6. Ultimate fallback
  return 'main';
}

// ============================================================================
// Review Branch Auto-Creation
// ============================================================================

/**
 * Ensures the target branch exists when it is a non-main branch (e.g.
 * `stoneforge/review`). If the branch does not exist locally or on the
 * remote, it is created from the current main branch HEAD and pushed.
 *
 * This is a no-op when the target branch is `main` or `master`.
 *
 * @param workspaceRoot - The git repository root directory
 * @param targetBranch - The branch to ensure exists
 * @param localOnly - Whether the repo has no remote (skip push)
 */
export async function ensureTargetBranchExists(
  workspaceRoot: string,
  targetBranch: string,
  localOnly = false
): Promise<void> {
  // Never auto-create main/master — they should already exist
  if (MAIN_BRANCH_NAMES.has(targetBranch)) {
    return;
  }

  // Check if the branch exists locally
  const localExists = await branchExistsLocally(workspaceRoot, targetBranch);

  // Check if the branch exists on the remote
  let remoteExists = false;
  if (!localOnly) {
    remoteExists = await branchExistsOnRemote(workspaceRoot, targetBranch);
  }

  // If the branch already exists somewhere, nothing to do
  if (localExists || remoteExists) {
    return;
  }

  // Detect the main branch to create from
  const mainBranch = await detectTargetBranch(workspaceRoot);
  const hasOrigin = await hasRemote(workspaceRoot);

  // Determine the base ref: prefer remote main when available
  const baseRef = hasOrigin && !localOnly ? `origin/${mainBranch}` : mainBranch;

  // When using a remote ref, ensure it exists locally by fetching.
  // The remote tracking ref (e.g. origin/main) may not exist if no
  // fetch has been performed yet in this session.
  if (hasOrigin && !localOnly) {
    try {
      await execAsync(`git fetch origin ${mainBranch}`, {
        cwd: workspaceRoot,
        encoding: 'utf8',
      });
    } catch {
      // If fetch fails (e.g. network issues), fall through and try
      // to use whatever ref is available — git branch will fail with
      // a clear error if the ref truly doesn't exist.
    }
  }

  // Create the branch locally from the main branch HEAD
  await execAsync(`git branch ${targetBranch} ${baseRef}`, {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });

  // Push to remote if we have one
  if (!localOnly && hasOrigin) {
    await execAsync(`git push -u origin ${targetBranch}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
  }
}

/**
 * Check whether a branch exists locally.
 */
async function branchExistsLocally(
  workspaceRoot: string,
  branchName: string
): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify refs/heads/${branchName}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a branch exists on origin.
 */
async function branchExistsOnRemote(
  workspaceRoot: string,
  branchName: string
): Promise<boolean> {
  try {
    await execAsync(`git rev-parse --verify refs/remotes/origin/${branchName}`, {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

/**
 * Perform a merge of `sourceBranch` into `targetBranch` using a temporary
 * worktree. This never touches the main repo's HEAD or index.
 */
export async function mergeBranch(options: MergeBranchOptions): Promise<MergeBranchResult> {
  const {
    workspaceRoot,
    sourceBranch,
    mergeStrategy = 'squash',
    autoPush = true,
    commitMessage,
    preflight = true,
    syncLocal = true,
  } = options;

  // Auto-detect local-only mode when no remote is configured
  const localOnly = options.localOnly ?? !(await hasRemote(workspaceRoot));

  const targetBranch = options.targetBranch ?? await detectTargetBranch(workspaceRoot);

  // 1. Fetch latest remote state (skip when local-only)
  // Must happen before ensureTargetBranchExists so that origin/<mainBranch>
  // is available as a valid ref when creating new branches from remote HEAD.
  if (!localOnly) {
    await execAsync('git fetch origin', { cwd: workspaceRoot, encoding: 'utf8' });
  }

  // Ensure the target branch exists (auto-creates review branches from main)
  await ensureTargetBranchExists(workspaceRoot, targetBranch, localOnly);

  // Build commit message
  const message = commitMessage
    ?? (mergeStrategy === 'squash'
      ? `Squash merge ${sourceBranch} into ${targetBranch}`
      : `Merge branch '${sourceBranch}'`);

  // 1b. Check if source branch has any commits ahead of target.
  // If count is 0, the branch is already fully merged — nothing to do.
  try {
    const targetRef = localOnly ? targetBranch : `origin/${targetBranch}`;
    // Always use local source ref — the actual merge (squash or no-ff) at line ~416
    // operates on the local sourceBranch, so the pre-check must match.
    // Using origin/${sourceBranch} would miss unpushed local commits.
    const sourceRef = sourceBranch;
    const { stdout: countStr } = await execAsync(
      `git rev-list --count ${targetRef}..${sourceRef}`,
      { cwd: workspaceRoot, encoding: 'utf8' }
    );
    const commitsAhead = parseInt(countStr.trim(), 10);
    if (commitsAhead === 0) {
      return {
        success: true,
        hasConflict: false,
        alreadyMerged: true,
      };
    }
  } catch {
    // If rev-list fails (e.g. branch doesn't exist on remote), continue
    // with the normal merge flow which will produce a proper error.
  }

  // 2. Pre-flight conflict detection via merge-tree
  // When local-only, use the local targetBranch ref instead of origin/<targetBranch>
  if (preflight) {
    const preflightRef = localOnly ? targetBranch : `origin/${targetBranch}`;
    try {
      const { stdout: mergeBase } = await execAsync(
        `git merge-base ${preflightRef} ${sourceBranch}`,
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      const dryRun = await execAsync(
        `git merge-tree ${mergeBase.trim()} ${preflightRef} ${sourceBranch}`,
        { cwd: workspaceRoot, encoding: 'utf8' }
      ).catch((e: { stdout?: string }) => e);
      if (/^<{7} .+/m.test((dryRun as { stdout?: string }).stdout ?? '')) {
        const dryRunOutput = (dryRun as { stdout: string }).stdout;
        const conflictFiles = [...dryRunOutput.matchAll(/\+\+\+ b\/(.+)/g)].map(m => m[1]);
        return {
          success: false,
          hasConflict: true,
          error: 'Pre-flight: merge conflicts detected',
          conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
        };
      }
    } catch {
      // merge-base can fail if branches have no common ancestor; continue to worktree merge
    }
  }

  // 3. Create temp worktree
  const safeName = sourceBranch.replace(/[^a-zA-Z0-9-]/g, '-');
  const mergeDirName = `_merge-${safeName}-${Date.now()}`;
  const mergeDir = path.join(workspaceRoot, '.stoneforge/.worktrees', mergeDirName);

  // Clean up leftover worktree from a previously crashed run
  if (fs.existsSync(mergeDir)) {
    await execAsync(`git worktree remove --force "${mergeDir}"`, {
      cwd: workspaceRoot, encoding: 'utf8',
    });
  }

  // Create with detached HEAD at the target ref.
  // When remote exists, use origin/<target> for the latest remote state;
  // when local-only, use the local <target> branch directly.
  const worktreeStartRef = localOnly ? targetBranch : `origin/${targetBranch}`;
  await execAsync(`git worktree add --detach "${mergeDir}" ${worktreeStartRef}`, {
    cwd: workspaceRoot, encoding: 'utf8',
  });

  let mergeResult: MergeBranchResult = { success: false, hasConflict: false, error: 'Merge did not complete' };

  try {
    let commitHash = '';

    // Live sync-state snapshots (machine-local .stoneforge/sync/*.jsonl) are
    // untracked on the target branch. Branches cut before that untracking may
    // still carry modifications to them, producing modify/delete conflicts.
    // A branch-side snapshot of machine-local state is never authoritative,
    // so such conflicts are resolved by deletion instead of failing the merge.
    let resolvedLiveStateConflicts = false;

    const mergeCommand = mergeStrategy === 'squash'
      ? `merge --squash ${sourceBranch}`
      : `merge --no-ff -m "${message.replace(/"/g, '\\"')}" ${sourceBranch}`;

    try {
      await execGitSafe(mergeCommand, mergeDir, workspaceRoot);
    } catch (mergeError) {
      const mergeOut = execOutput(mergeError);
      if (!mergeOut.includes('CONFLICT') && !mergeOut.includes('Automatic merge failed')) {
        throw mergeError;
      }

      const conflictFiles = extractConflictPaths(mergeOut);
      const realConflicts = conflictFiles.filter((f) => !isLiveSyncStatePath(f));
      if (conflictFiles.length === 0 || realConflicts.length > 0) {
        throw mergeError;
      }

      // Only resolvable when the TARGET no longer tracks these paths (the
      // worktree starts at the target ref). If the target still tracks a
      // conflicting live-state file, this is a genuine content conflict —
      // never auto-resolve it.
      const trackedOnTarget: string[] = [];
      for (const f of conflictFiles) {
        if (await worktreeRefHasPath(mergeDir, workspaceRoot, `HEAD:${f}`)) {
          trackedOnTarget.push(f);
        }
      }
      if (trackedOnTarget.length > 0) {
        throw mergeError;
      }

      // Every conflict is live sync state the target no longer tracks:
      // resolve by deletion, then conclude the merge commit below.
      for (const f of conflictFiles) {
        await execGitSafe(`rm -f -- "${f}"`, mergeDir, workspaceRoot);
      }
      resolvedLiveStateConflicts = true;
    }

    if (mergeStrategy === 'squash' || resolvedLiveStateConflicts) {
      try {
        await execGitSafe(`commit -m "${message.replace(/"/g, '\\"')}"`, mergeDir, workspaceRoot);
      } catch (commitError) {
        const commitOut = execOutput(commitError);
        if (!(resolvedLiveStateConflicts && /nothing to commit/.test(commitOut))) {
          throw commitError;
        }
        // The source branch carried only live sync-state changes: after
        // resolving them to deletions there is nothing left to merge.
        mergeResult = { success: true, hasConflict: false, alreadyMerged: true };
      }
    }

    if (!mergeResult.alreadyMerged) {
      const { stdout: hash } = await execGitSafe('rev-parse HEAD', mergeDir, workspaceRoot);
      commitHash = hash.trim();
    }

    // 6. Push to remote (skip when local-only, push disabled, or nothing to push)
    let pushFailed = false;
    if (autoPush && !localOnly && !mergeResult.alreadyMerged) {
      try {
        await execGitSafe(`push origin HEAD:${targetBranch}`, mergeDir, workspaceRoot);

        // Verify push landed on remote
        try {
          await execAsync(`git fetch origin ${targetBranch}`, { cwd: workspaceRoot, encoding: 'utf8' });
          // git merge-base --is-ancestor exits 0 if commitHash is ancestor of origin/targetBranch
          await execAsync(`git merge-base --is-ancestor ${commitHash} origin/${targetBranch}`, {
            cwd: workspaceRoot, encoding: 'utf8',
          });
        } catch {
          pushFailed = true;
          mergeResult = {
            success: false,
            commitHash,
            hasConflict: false,
            error: `Merge succeeded locally and push appeared to succeed, but post-push verification failed: commit ${commitHash} is not on origin/${targetBranch}. The merge commit may not have been delivered to the remote. Retry the push or re-merge.`,
          };
        }
      } catch (pushError) {
        const pushErrorMsg = pushError instanceof Error ? pushError.message : String(pushError);
        pushFailed = true;
        mergeResult = {
          success: false,
          commitHash,
          hasConflict: false,
          error: `Merge succeeded locally but push to origin failed: ${pushErrorMsg}. The merge commit (${commitHash}) was not delivered to the remote. Retry the push or re-merge.`,
        };
      }
    }

    if (!pushFailed && !mergeResult.alreadyMerged) {
      mergeResult = { success: true, commitHash, hasConflict: false };
    }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    const output = (execError.stdout ?? '') + (execError.stderr ?? '') + (execError.message ?? '');

    if (output.includes('CONFLICT') || output.includes('Automatic merge failed')) {
      // Abort the merge to clean up
      try {
        if (mergeStrategy === 'squash') {
          await execGitSafe('reset --hard HEAD', mergeDir, workspaceRoot);
        } else {
          await execGitSafe('merge --abort', mergeDir, workspaceRoot);
        }
      } catch {
        // Ignore abort errors
      }

      const conflictFiles = extractConflictPaths(output);

      mergeResult = {
        success: false,
        hasConflict: true,
        error: 'Merge conflict detected',
        conflictFiles,
      };
    } else {
      mergeResult = {
        success: false,
        hasConflict: false,
        error: output || 'Merge failed',
      };
    }
  } finally {
    // 7. Always remove temp worktree
    try {
      await execAsync(`git worktree remove --force "${mergeDir}"`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    } catch {
      // Ignore cleanup errors
    }
  }

  // 8. Sync local target branch
  // In local-only mode, fast-forward the local target branch to the merge commit.
  // With a remote, sync local branch after push (best-effort).
  if (mergeResult.success && syncLocal) {
    if (localOnly) {
      await syncLocalBranchFromCommit(workspaceRoot, targetBranch, mergeResult.commitHash!);
    } else if (autoPush) {
      await syncLocalBranch(workspaceRoot, targetBranch);
    }
  }

  return mergeResult;
}

/**
 * Extract the most useful diagnostic text from an execAsync rejection.
 * promisify(exec) errors carry stderr (preferred) plus a message that
 * embeds the failed command and captured output.
 */
function gitErrorDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === 'string' && e.stderr.trim()) return e.stderr.trim();
    if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  }
  return String(err);
}

/**
 * Concatenate all output carried by an execAsync rejection.
 */
function execOutput(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return `${typeof e.stdout === 'string' ? e.stdout : ''}` +
    `${typeof e.stderr === 'string' ? e.stderr : ''}` +
    `${typeof e.message === 'string' ? e.message : ''}`;
}

/**
 * Whether a repo path is a live orchestration sync-state file
 * (machine-local JSONL export under `.stoneforge/sync/`).
 *
 * These files hold per-checkout live daemon state. Workspaces that run a
 * live daemon against the main checkout untrack them (see
 * `.stoneforge/.gitignore`); committed snapshots of them are never
 * authoritative, so merges resolve conflicts on them by deletion.
 */
export function isLiveSyncStatePath(repoPath: string): boolean {
  const normalized = repoPath.replace(/\\/g, '/');
  return normalized.startsWith('.stoneforge/sync/') && normalized.endsWith('.jsonl');
}

/**
 * Extract conflicted paths from `git merge` output.
 *
 * Covers both content conflicts ("CONFLICT (content): Merge conflict in <path>")
 * and structural conflicts such as modify/delete
 * ("CONFLICT (modify/delete): <path> deleted in HEAD and modified in <branch>").
 */
export function extractConflictPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const m of output.matchAll(/CONFLICT \([^)]+\): Merge conflict in (.+)/g)) {
    if (m[1]) paths.add(m[1].trim());
  }
  for (const m of output.matchAll(/CONFLICT \([^)]+\): (\S+) (?:deleted|added) in /g)) {
    if (m[1]) paths.add(m[1]);
  }
  return [...paths];
}

/**
 * Parse the file list out of git's overwrite-protection refusal:
 *
 *   error: Your local changes to the following files would be overwritten by merge:
 *   	<path>
 *   	<path>
 *   Please commit your changes or stash them before you merge.
 *
 * Returns [] when the error is not an overwrite-protection refusal.
 */
export function parseOverwrittenFiles(errOutput: string): string[] {
  const match = errOutput.match(
    /local changes to the following files would be overwritten by merge:\n((?:\t.+\n?)+)/
  );
  if (!match) return [];
  return match[1]
    .split('\n')
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

/**
 * Whether a path exists in a git ref's tree (`git cat-file -e <ref>:<path>`).
 */
async function refHasPath(workspaceRoot: string, ref: string, filePath: string): Promise<boolean> {
  try {
    await execAsync(`git cat-file -e "${ref}:${filePath}"`, {
      cwd: workspaceRoot, encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `<ref>:<path>` exists, run inside a (temp) worktree via
 * execGitSafe rather than directly in the workspace root.
 */
async function worktreeRefHasPath(
  worktreePath: string,
  workspaceRoot: string,
  refPath: string
): Promise<boolean> {
  try {
    await execGitSafe(`cat-file -e "${refPath}"`, worktreePath, workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

/** Quote a path for interpolation into a shell command. */
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Fast-forward the branch checked out in `workspaceRoot` to `targetRef`,
 * safely stepping over git's overwrite-protection refusal when the only
 * blocking files are machine-local live sync state that the target ref no
 * longer tracks (the main checkout's `.stoneforge/sync/*.jsonl` across the
 * commit that untracked them).
 *
 * Dance: snapshot the blocking files, restore them to their committed
 * content so the checkout is clean, fast-forward (which deletes them from
 * the working tree), then write the snapshots back — the files are
 * untracked and gitignored from that point on, so no future sync touches
 * them again.
 *
 * Safety properties:
 *
 * - **Writer exclusion.** The entire operation (first attempt included)
 *   runs while holding the sync-export write lock for
 *   `<workspaceRoot>/.stoneforge/sync` (`withSyncExportLock`). Every
 *   in-process export writer (auto-export ticks, HTTP/API-triggered
 *   `SyncService.export` calls) takes the same lock, so no export can land
 *   between the snapshot and the restore — a write in that window would be
 *   silently destroyed by the restore while its dirty marks were already
 *   cleared. Out-of-process writers (e.g. `sf sync export` from a shell)
 *   cannot be excluded by an in-memory lock; the SQLite DB is authoritative
 *   and a full export heals, which is why external procedures end with one.
 * - **Abort before mutation.** If any blocking file cannot be snapshotted
 *   for preservation (unreadable for a reason other than being locally
 *   deleted, or the backup copy cannot be written), nothing is mutated:
 *   no `git checkout --`, no merge. Losing live state is worse than staying
 *   one merge behind.
 * - **Explicit absence.** A blocking file that was deleted locally is
 *   recorded as absent and stays absent afterwards — on success and on
 *   retry failure alike (`git checkout --` resurrects it temporarily).
 * - **Durable backup.** Snapshots are also copied to a temp directory
 *   before any mutation. If the restore-after-success fails, the branch has
 *   already moved: the backup is retained and its path is reported loudly
 *   rather than silently dropping live state.
 *
 * Only engages when EVERY blocking file is a known live-sync-state path
 * (`isLiveSyncStatePath` — `.stoneforge/sync/*.jsonl`) AND absent from the
 * target ref's tree (i.e. the fast-forward deletes it). Anything else —
 * genuine divergence, hand-edited tracked files, `config.yaml` (which stays
 * tracked and must be reconciled deliberately), other files under
 * `.stoneforge/` — keeps the warn-and-return behavior.
 */
async function fastForwardTargetInCheckout(
  workspaceRoot: string,
  targetRef: string,
  targetBranch: string
): Promise<void> {
  // Hold the sync-export write lock for the whole operation: in-flight
  // exports are awaited out, and no new one can start until the live files
  // are back in place. Not reentrant — nothing here may call export().
  const syncDir = path.join(workspaceRoot, '.stoneforge', 'sync');
  await withSyncExportLock(syncDir, async () => {
    let firstError: unknown;
    try {
      await execAsync(`git merge --ff-only ${targetRef}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
      return;
    } catch (err) {
      firstError = err;
    }

    const detail = gitErrorDetail(firstError);
    const blocking = parseOverwrittenFiles(detail);

    let danceable = blocking.length > 0;
    for (const f of blocking) {
      // Known live-sync paths only. In particular config.yaml — tracked,
      // locally modified by the daemon's config upgrades — is deliberately
      // NOT danceable: its changes must be reconciled by a human procedure,
      // not stepped over.
      if (!isLiveSyncStatePath(f)) {
        danceable = false;
        break;
      }
      // The target ref must no longer track the file (the fast-forward
      // deletes it); anything still tracked needs a real reconcile instead.
      if (await refHasPath(workspaceRoot, targetRef, f)) {
        danceable = false;
        break;
      }
    }

    if (!danceable) {
      console.warn(
        `[git/merge] Failed to fast-forward local target branch '${targetBranch}' in ${workspaceRoot}. Git error: ${detail}` +
        ' Cause: locally-modified tracked files in that checkout block the fast-forward (there is no divergence; `git pull` fails the same way). Snapshot/reconcile those files, then fast-forward manually.'
      );
      return;
    }

    // ---- Snapshot phase: preserve live state BEFORE any mutation. ----
    // A null entry records "locally absent" so absence can be restored.
    const snapshots = new Map<string, Buffer | null>();
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-live-state-'));

    for (const f of blocking) {
      const abs = path.join(workspaceRoot, f);
      let content: Buffer | null;
      try {
        content = fs.readFileSync(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          content = null;
        } else {
          // Unreadable for another reason (permissions, I/O error). Abort
          // before any mutation — proceeding would let git discard state
          // we failed to preserve.
          console.warn(
            `[git/merge] Not fast-forwarding local target branch '${targetBranch}' in ${workspaceRoot}: live state file ${f} could not be read for preservation (${(err as NodeJS.ErrnoException).code ?? err}). No files were modified.`
          );
          fs.rmSync(backupDir, { recursive: true, force: true });
          return;
        }
      }
      snapshots.set(f, content);

      // Durable copy: survives even if this process dies mid-dance, and is
      // reportable if the in-memory restore later fails.
      if (content !== null) {
        try {
          fs.writeFileSync(path.join(backupDir, path.basename(f)), content);
        } catch (backupErr) {
          console.warn(
            `[git/merge] Not fast-forwarding local target branch '${targetBranch}' in ${workspaceRoot}: could not back up live state file ${f} (${(backupErr as NodeJS.ErrnoException).code ?? backupErr}). No files were modified.`
          );
          fs.rmSync(backupDir, { recursive: true, force: true });
          return;
        }
      }
    }

    /**
     * Put the live state back exactly as it was: content for files that
     * existed, absence for files that did not. Restores every file it can
     * and reports the ones it could not instead of throwing mid-way.
     */
    const restoreSnapshots = (): string[] => {
      const failures: string[] = [];
      for (const [f, content] of snapshots) {
        const abs = path.join(workspaceRoot, f);
        try {
          if (content === null) {
            fs.rmSync(abs, { force: true });
          } else {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
          }
        } catch (restoreErr) {
          failures.push(`${f} (${(restoreErr as NodeJS.ErrnoException).code ?? restoreErr})`);
        }
      }
      return failures;
    };

    try {
      await execAsync(
        `git checkout -- ${blocking.map(shellQuote).join(' ')}`,
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      await execAsync(`git merge --ff-only ${targetRef}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    } catch (retryError) {
      // Fast-forward still refused: put the live state back exactly as it
      // was (including absence) and leave the branch where it was.
      const failures = restoreSnapshots();
      if (failures.length > 0) {
        console.error(
          `[git/merge] CRITICAL: failed to restore live state files after an aborted fast-forward of '${targetBranch}' in ${workspaceRoot}: ${failures.join('; ')}. Snapshots retained at ${backupDir}. Restore them manually or regenerate with 'sf sync export --full' (the SQLite DB is authoritative).`
        );
      } else {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
      console.warn(
        `[git/merge] Failed to fast-forward local target branch '${targetBranch}' in ${workspaceRoot} even after setting aside live state files (${blocking.join(', ')}). Git error: ${gitErrorDetail(retryError)}`
      );
      return;
    }

    // Fast-forward succeeded — the branch has moved, so the restore is now
    // mandatory, not best-effort.
    const failures = restoreSnapshots();
    if (failures.length > 0) {
      // Keep the durable backup and say where it is; the live files on disk
      // may be missing or stale. The DB is authoritative; full export heals.
      console.error(
        `[git/merge] CRITICAL: fast-forwarded '${targetBranch}' in ${workspaceRoot} but failed to restore machine-local live state files: ${failures.join('; ')}. Snapshots retained at ${backupDir}. Restore them or regenerate with 'sf sync export --full' (the SQLite DB is authoritative).`
      );
      return;
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
    console.warn(
      `[git/merge] Fast-forwarded '${targetBranch}' in ${workspaceRoot}; restored ${snapshots.size} machine-local live-state file(s) (${blocking.join(', ')}) that the target no longer tracks, with sync exports excluded for the duration.`
    );
  });
}

/**
 * Fast-forward the local target branch ref to match origin, without
 * the dangerous checkout dance.
 *
 * - When NOT on the target branch: `git fetch origin target:target`
 *   updates the local ref without touching the working tree at all.
 * - When ON the target branch: `git merge --ff-only origin/target`
 *   fast-forwards in place (unavoidably touches working tree files).
 *   If git's overwrite protection refuses because the only blocking
 *   files are machine-local live state that the target no longer tracks
 *   (live `.stoneforge/sync/*.jsonl` across the untracking commit), the
 *   files are snapshotted, the fast-forward is retried on a clean
 *   checkout, and the live content is restored afterwards — with
 *   in-process sync exports excluded for the duration (see
 *   fastForwardTargetInCheckout).
 * - Any other failure: logs a warning including the real git error and
 *   returns silently. The merge is already pushed to remote.
 */
export async function syncLocalBranch(
  workspaceRoot: string,
  targetBranch: string
): Promise<void> {
  try {
    // Determine current branch (may be detached HEAD in worktrees)
    let currentBranch: string | undefined;
    try {
      const { stdout } = await execAsync(
        'git symbolic-ref --short HEAD',
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      currentBranch = stdout.trim();
    } catch {
      // Detached HEAD — not on any branch
    }

    if (!currentBranch) {
      console.warn('[git/merge] WARNING: workspace is in detached HEAD state during syncLocalBranch. Skipping sync. Run `git checkout master` to fix.');
      return;
    }

    if (currentBranch === targetBranch) {
      // We're on the target branch — fast-forward in place (with the
      // live-state snapshot dance when overwrite protection refuses)
      await fastForwardTargetInCheckout(workspaceRoot, `origin/${targetBranch}`, targetBranch);
    } else {
      // Not on target branch — update the ref without touching the worktree
      await execAsync(`git fetch origin ${targetBranch}:${targetBranch}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    }
  } catch (err) {
    // Non-fatal: local branch sync is best-effort.
    // The merge is already pushed to remote. Log the REAL git error — the
    // old fixed-text guess ("non-ff divergence or missing ref") was a false
    // diagnosis on clean fast-forwards: the actual recurring cause is git's
    // overwrite-protection refusal when the main checkout has locally-modified
    // tracked files (live .stoneforge/sync state), which `git pull` cannot fix.
    const detail = gitErrorDetail(err);
    const blockedByLocalChanges = detail.includes('would be overwritten by merge');
    console.warn(
      `[git/merge] Failed to fast-forward local target branch '${targetBranch}' in ${workspaceRoot}. Git error: ${detail}` +
        (blockedByLocalChanges
          ? ' Cause: locally-modified tracked files in that checkout block the fast-forward (there is no divergence; `git pull` fails the same way). Snapshot/reconcile those files, then fast-forward manually.'
          : ' Manual sync may be needed (e.g. `git pull --ff-only`).')
    );
  }
}

/**
 * Fast-forward the local target branch to a specific commit hash.
 *
 * Used in local-only mode where there is no remote to sync from.
 * Updates the branch ref directly using `git branch -f` when not on
 * the target branch, or `git merge --ff-only <hash>` when on it (with
 * the live-state snapshot dance for machine-local files the target no
 * longer tracks, as in syncLocalBranch).
 */
export async function syncLocalBranchFromCommit(
  workspaceRoot: string,
  targetBranch: string,
  commitHash: string
): Promise<void> {
  try {
    // Determine current branch
    let currentBranch: string | undefined;
    try {
      const { stdout } = await execAsync(
        'git symbolic-ref --short HEAD',
        { cwd: workspaceRoot, encoding: 'utf8' }
      );
      currentBranch = stdout.trim();
    } catch {
      // Detached HEAD
    }

    if (currentBranch === targetBranch) {
      // On the target branch — fast-forward in place
      await fastForwardTargetInCheckout(workspaceRoot, commitHash, targetBranch);
    } else {
      // Not on target branch — force-update the ref to point at the merge commit
      await execAsync(`git branch -f ${targetBranch} ${commitHash}`, {
        cwd: workspaceRoot, encoding: 'utf8',
      });
    }
  } catch (err) {
    console.warn(
      `[git/merge] Failed to update local target branch '${targetBranch}' to ${commitHash} in ${workspaceRoot}. Git error: ${gitErrorDetail(err)}`
    );
  }
}
