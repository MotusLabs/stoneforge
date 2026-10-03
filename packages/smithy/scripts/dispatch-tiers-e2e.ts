#!/usr/bin/env bun
/**
 * Dispatch Tiers end-to-end verification (task el-47va4m)
 *
 * Scripted orchestration test for the Worker Dispatch Tiers spec
 * (workspace document el-3tr7oc), run against the real service stack
 * (agent registry, dispatch daemon, dispatch service, worktree manager,
 * SQLite storage) with the mock session manager from
 * `src/testing/test-context.ts` — the same harness the orchestration
 * E2E suite uses (see "How to Run Orchestration Tests", el-3fx9).
 *
 * Scenario (mirrors the task acceptance criteria):
 *
 *   Phase A — tier-ordered assignment
 *     1. Register e1, e2 (ephemeral, tier 1, executablePath = stub
 *        `claude-glm` wrapper) and e3 (ephemeral, tier 2, provider
 *        default `claude`).
 *     2. Create 3 ready tasks with distinct priorities.
 *     3. One dispatch cycle assigns all three: the two tier-1 workers
 *        receive the two highest-priority tasks, e3 receives the third.
 *
 *   Phase B — rate-limit fail-over
 *     4. Complete the tasks, end the sessions (all workers idle again).
 *     5. Simulate a claude-glm rate limit (the explicit detection path
 *        the spawner forwards `rate_limited` events through).
 *     6. Create one more task: it must go to e3 in the same cycle,
 *        skipping the idle-but-limited tier-1 workers.
 *     7. `claude` stays unlimited and `getRateLimitStatus()` reports
 *        dispatch as ACTIVE (partial limit, design D7).
 *
 * Evidence captured for the task notes: dispatch order, task→worker
 * mapping with per-session account keys, `sf agent list` output against
 * the test workspace database, and operation-log excerpts.
 *
 * Usage:
 *   cd packages/smithy && bun run scripts/dispatch-tiers-e2e.ts
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EntityId, Task } from '@stoneforge/core';
import { TaskStatus } from '@stoneforge/core';
import { createStorage } from '@stoneforge/quarry';

import { setupTestContext, waitFor, sleep, createTestTask } from '../src/testing/index.js';
import type { TestContext } from '../src/testing/index.js';
import { DispatchDaemonImpl } from '../src/services/dispatch-daemon.js';
import type { DispatchDaemon } from '../src/services/dispatch-daemon.js';
import { createOperationLogService } from '../src/services/operation-log-service.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { normalizeExecutableKey } from '../src/utils/account-key.js';
import { getOrchestratorTaskMeta } from '../src/types/task-meta.js';
import type { AgentEntity } from '../src/api/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Reporting helpers
// ============================================================================

const report: string[] = [];
const failures: string[] = [];

function section(title: string): void {
  const line = `\n=== ${title} ===`;
  console.log(line);
  report.push(line);
}

function info(message: string): void {
  console.log(message);
  report.push(message);
}

function check(label: string, ok: boolean, detail?: string): boolean {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  report.push(line);
  if (!ok) failures.push(label + (detail ? ` — ${detail}` : ''));
  return ok;
}

function excerpt(title: string, body: string): void {
  const block = [`--- ${title} ---`, ...body.split('\n').map((l) => `  ${l}`), '---'].join('\n');
  console.log(block);
  report.push(block);
}

// ============================================================================
// Main scenario
// ============================================================================

interface DispatchEvent {
  taskId: string;
  agentId: string;
  seq: number;
}

// Dispatch order evidence: the daemon emits task:dispatched in the exact
// order it hands tasks to workers within a cycle.
const dispatchOrder: DispatchEvent[] = [];
let dispatchSeq = 0;

async function main(): Promise<number> {
  const ctx: TestContext = await setupTestContext({
    verbose: true,
    tempPrefix: 'dispatch-tiers-e2e-',
    skipDaemonStart: true, // we run our own daemon with op-log + settings attached
  });

  // Second storage handle for the operation log + settings services
  // (same SQLite file the test context initialized).
  const auxStorage = createStorage({ path: ctx.dbPath });
  const settingsService = createSettingsService(auxStorage);
  const operationLog = createOperationLogService(auxStorage);

  const daemon: DispatchDaemon = new DispatchDaemonImpl(
    ctx.stoneforgeApi,
    ctx.agentRegistry,
    ctx.sessionManager,
    ctx.dispatchService,
    ctx.worktreeManager,
    ctx.taskAssignment,
    ctx.stewardScheduler,
    ctx.inboxService,
    {
      // Manual polls only — deterministic cycles driven by this script.
      pollIntervalMs: 60 * 60 * 1000,
      workerAvailabilityPollEnabled: true,
      inboxPollEnabled: true,
      stewardTriggerPollEnabled: false,
      workflowTaskPollEnabled: false,
      workflowAutoTransitionEnabled: false,
      orphanRecoveryPollEnabled: false,
    },
    undefined, // poolService
    settingsService,
    operationLog
  );

  // Dispatch order evidence captured at module scope (see dispatchOrder).
  daemon.on('task:dispatched', (taskId, agentId) => {
    dispatchOrder.push({ taskId: String(taskId), agentId: String(agentId), seq: dispatchSeq++ });
  });

  await daemon.start();

  let exitCode = 1;
  try {
    exitCode = await runScenario(ctx, daemon, operationLog);
  } finally {
    await daemon.stop();
    await ctx.cleanup();
    try {
      auxStorage.close();
    } catch {
      // ignore — process is exiting anyway
    }
  }
  return exitCode;
}

async function runScenario(
  ctx: TestContext,
  daemon: DispatchDaemon,
  operationLog: ReturnType<typeof createOperationLogService>
): Promise<number> {
  // One dispatch cycle = inbox poll (marks task-dispatch notifications
  // read) followed by the worker-availability assignment poll.
  const cycle = async (): Promise<void> => {
    await daemon.pollInboxes();
    await daemon.pollWorkerAvailability();
  };

  const nameOf = (agentId: string): string => {
    const found = [e1, e2, e3].find((w) => String(w.id) === agentId);
    return found ? found.name : agentId;
  };

  section('Setup: stub claude-glm wrapper + tiered workers');

  // A stub `claude-glm` wrapper: an executable script standing in for the
  // real CLI wrapper. The mock session manager never runs it; what matters
  // is that e1/e2 name it as their executablePath, which defines their
  // rate-limit account key (spec: provider-rate-limits / account key).
  const binDir = join(ctx.tempWorkspace, 'bin');
  mkdirSync(binDir, { recursive: true });
  const claudeGlmPath = join(binDir, 'claude-glm');
  writeFileSync(
    claudeGlmPath,
    '#!/bin/sh\n# Stub GLM-plan wrapper for the dispatch tiers e2e (el-47va4m).\nexec claude "$@"\n',
    { mode: 0o755 }
  );
  chmodSync(claudeGlmPath, 0o755);
  info(`Stub wrapper: ${claudeGlmPath}`);

  const register = (name: string, tier: number | undefined, executablePath?: string) =>
    ctx.api.registerWorker({
      name,
      workerMode: 'ephemeral',
      createdBy: ctx.systemEntityId,
      maxConcurrentTasks: 1,
      tier,
      executablePath,
      tags: ['dispatch-tiers-e2e'],
    });

  const e1 = await register('e1', 1, claudeGlmPath);
  const e2 = await register('e2', 1, claudeGlmPath);
  const e3 = await register('e3', 2); // provider default executable (claude)
  info(`Registered e1=${e1.id} (tier 1, claude-glm)`);
  info(`Registered e2=${e2.id} (tier 1, claude-glm)`);
  info(`Registered e3=${e3.id} (tier 2, default claude)`);

  // The account keys the spec talks about, derived exactly like production.
  const glmKey = normalizeExecutableKey(claudeGlmPath);
  const claudeKey = normalizeExecutableKey('claude');
  info(`claude-glm account key: ${glmKey}`);
  info(`claude account key:     ${claudeKey}`);

  // ---------------------------------------------------------------------
  section('Phase A: 3 ready tasks → tier-1 workers dispatched before e3');

  const mkTask = (title: string, priority: number) =>
    createTestTask(ctx, title, { priority, tags: ['dispatch-tiers-e2e'] });

  const t1 = await mkTask('Tier e2e task 1 (highest priority)', 1);
  const t2 = await mkTask('Tier e2e task 2', 2);
  const t3 = await mkTask('Tier e2e task 3', 3);
  info(`Tasks: ${t1.id} (p1), ${t2.id} (p2), ${t3.id} (p3)`);

  const phaseAStart = Date.now();
  await cycle();

  // Wait for all three assignments.
  const assigned = await waitFor(
    async () => {
      const tasks = await Promise.all([t1, t2, t3].map((t) => ctx.api.get<Task>(t.id)));
      return tasks.every((t) => t?.assignee) ? tasks : null;
    },
    { timeout: 30_000, interval: 500, description: 'all three tasks assigned' }
  );

  const assignee = (t: Task) => String(t.assignee);
  const a1 = assigned ? assignee(assigned[0]!) : '';
  const a2 = assigned ? assignee(assigned[1]!) : '';
  const a3 = assigned ? assignee(assigned[2]!) : '';

  excerpt(
    'dispatch order (task:dispatched events, in-cycle order)',
    dispatchOrder
      .slice(0, 3)
      .map((d) => `#${d.seq + 1} task ${d.taskId} → ${nameOf(d.agentId)} (${d.agentId})`)
      .join('\n')
  );
  excerpt('task → assignee', `p1 ${t1.id} → ${nameOf(a1)}\np2 ${t2.id} → ${nameOf(a2)}\np3 ${t3.id} → ${nameOf(a3)}`);

  const tier1Ids = new Set([String(e1.id), String(e2.id)]);
  check('all three tasks assigned in one cycle', Boolean(assigned));
  check(
    'two highest-priority tasks went to the tier-1 workers',
    tier1Ids.has(a1) && tier1Ids.has(a2) && a1 !== a2,
    `p1→${nameOf(a1)}, p2→${nameOf(a2)}`
  );
  check('third task went to the tier-2 worker e3', a3 === String(e3.id), `p3→${nameOf(a3)}`);
  check(
    'tier-1 workers dispatched before e3 (event order)',
    dispatchOrder.length >= 3 &&
      tier1Ids.has(dispatchOrder[0]!.agentId) &&
      tier1Ids.has(dispatchOrder[1]!.agentId) &&
      dispatchOrder[2]!.agentId === String(e3.id),
    dispatchOrder.slice(0, 3).map((d) => nameOf(d.agentId)).join(' → ')
  );

  // Per-session account keys recorded on the tasks (design D5): tier-1
  // sessions must show the claude-glm key, e3's session the claude key.
  const sessionExecutableOf = async (taskId: string): Promise<string | undefined> => {
    const task = await ctx.api.get<Task>(taskId as Task['id']);
    const meta = task ? getOrchestratorTaskMeta(task.metadata as Record<string, unknown>) : undefined;
    const history = meta?.sessionHistory ?? [];
    return history[history.length - 1]?.executable;
  };
  const execT1 = await sessionExecutableOf(t1.id);
  const execT2 = await sessionExecutableOf(t2.id);
  const execT3 = await sessionExecutableOf(t3.id);
  check(
    'tier-1 sessions recorded the claude-glm account key',
    execT1 === glmKey && execT2 === glmKey,
    `p1 session executable=${execT1}, p2 session executable=${execT2}`
  );
  check(
    "e3's session recorded the claude account key",
    execT3 === claudeKey,
    `p3 session executable=${execT3}`
  );

  // lastDispatchedAt persisted on the dispatched workers (design D3).
  const lastDispatchedAt = async (w: AgentEntity): Promise<string | undefined> => {
    const reloaded = await ctx.agentRegistry.getAgent(w.id as unknown as EntityId);
    const meta = (reloaded as { metadata?: { agent?: { lastDispatchedAt?: unknown } } })
      ?.metadata?.agent;
    return typeof meta?.lastDispatchedAt === 'string' ? meta.lastDispatchedAt : undefined;
  };
  const ld1 = await lastDispatchedAt(e1);
  const ld2 = await lastDispatchedAt(e2);
  const ld3 = await lastDispatchedAt(e3);
  check(
    'lastDispatchedAt recorded on all dispatched workers',
    Boolean(ld1 && ld2 && ld3),
    `e1=${ld1 ?? '-'}, e2=${ld2 ?? '-'}, e3=${ld3 ?? '-'}`
  );

  // ---------------------------------------------------------------------
  section('Phase B: claude-glm rate limit → next task fails over to e3');

  // Free the workers: complete the tasks (as a real worker would with
  // `sf task complete` → closed), then end the mock sessions. Closing
  // first keeps orphan recovery from touching the tasks.
  for (const t of [t1, t2, t3]) {
    await ctx.api.update<Task>(t.id, { status: TaskStatus.CLOSED });
  }
  info('Closed tasks 1-3');

  // Stay above the rapid-exit threshold (10s) so ending the sessions is
  // not mistaken for a silent rate limit.
  const elapsed = Date.now() - phaseAStart;
  if (elapsed < 11_000) await sleep(11_000 - elapsed);

  for (const w of [e1, e2, e3]) {
    const session = ctx.sessionManager.getActiveSession(w.id as unknown as EntityId);
    if (session) {
      await ctx.sessionManager.stopSession(session.id, { graceful: false });
      info(`Ended session of ${w.name} (${session.id})`);
    }
  }
  await cycle(); // marks dispatch notifications read; workers idle again

  const stillBusy = [e1, e2, e3].filter(
    (w) => ctx.sessionManager.getActiveSession(w.id as unknown as EntityId) != null
  );
  check('all workers idle again', stillBusy.length === 0, stillBusy.map((w) => w.name).join(',') || 'none busy');

  // Simulate the claude-glm rate limit: the explicit detection path that
  // spawner `rate_limited` events take (same entry point the server uses).
  const resetsAt = new Date(Date.now() + 30 * 60 * 1000);
  daemon.handleRateLimitDetected(claudeGlmPath, resetsAt);
  info(`Marked ${glmKey} limited until ${resetsAt.toISOString()}`);

  const status = await daemon.getRateLimitStatus();
  excerpt(
    'getRateLimitStatus() after the claude-glm limit',
    JSON.stringify(status, null, 2)
  );
  check(
    'dispatch reported ACTIVE (partial limit does not pause, D7)',
    status.isPaused === false
  );
  check(
    'the claude-glm account is listed as limited',
    status.limits.some((l) => l.executable === glmKey),
    status.limits.map((l) => l.executable).join(', ')
  );
  check(
    "the claude account is NOT limited (e3's account stays unlimited)",
    !status.limits.some((l) => l.executable === claudeKey)
  );

  // The fail-over: with e1/e2 idle-but-limited, the next task must go to
  // e3 in the same cycle.
  const t4 = await mkTask('Tier e2e task 4 (after claude-glm limit)', 1);
  info(`Task 4: ${t4.id} (p1)`);
  await cycle();

  const assigned4 = await waitFor(
    async () => {
      const task = await ctx.api.get<Task>(t4.id);
      return task?.assignee ? task : null;
    },
    { timeout: 30_000, interval: 500, description: 'task 4 assignment' }
  );
  const a4 = assigned4 ? String(assigned4.assignee) : '';

  excerpt(
    'dispatch order after the limit',
    dispatchOrder
      .slice(0, 6)
      .map((d) => `#${d.seq + 1} task ${d.taskId} → ${nameOf(d.agentId)} (${d.agentId})`)
      .join('\n')
  );

  check('task 4 assigned despite the tier-1 limit', Boolean(assigned4));
  check(
    'task 4 went to e3 (limited tier-1 workers skipped)',
    a4 === String(e3.id),
    `p1→${nameOf(a4)}`
  );
  check(
    'e1/e2 received nothing after the limit',
    dispatchOrder.slice(3).every((d) => d.agentId === String(e3.id)),
    dispatchOrder.slice(3).map((d) => nameOf(d.agentId)).join(', ')
  );

  // Defense in depth from the spec's selection scope: no limited worker
  // was even offered the task. Confirmed indirectly — e1/e2 have no new
  // assigned tasks.
  const agentTasks = async (w: AgentEntity): Promise<number> => {
    const tasks = await ctx.taskAssignment.getAgentTasks(w.id as unknown as EntityId, {
      taskStatus: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.REVIEW],
    });
    return tasks.length;
  };
  check('e1 has no assigned open tasks', (await agentTasks(e1)) === 0);
  check('e2 has no assigned open tasks', (await agentTasks(e2)) === 0);

  // ---------------------------------------------------------------------
  section('Evidence: sf agent list + operation log');

  // Run the real CLI against the test workspace database.
  const sfBin = resolve(__dirname, '..', 'src', 'bin', 'sf.ts');
  const agentList = spawnSync(
    process.execPath,
    [sfBin, '--db', ctx.dbPath, 'agent', 'list'],
    { encoding: 'utf8', timeout: 60_000 }
  );
  excerpt(
    'sf agent list (TIER column)',
    (agentList.stdout || agentList.stderr || '(no output)').trim()
  );
  // Rows: ID NAME ROLE TIER STATUS SESSION — read the TIER cell per worker.
  const tierCell = (name: string): string | undefined => {
    const row = agentList.stdout
      .split('\n')
      .find((l) => l.trim().split(/\s+/)[1] === name);
    return row?.trim().split(/\s+/)[3];
  };
  check(
    'sf agent list shows the TIER column with e1/e2 tier 1 and e3 tier 2',
    agentList.stdout.includes('TIER') &&
      tierCell('e1') === '1' &&
      tierCell('e2') === '1' &&
      tierCell('e3') === '2',
    `e1=${tierCell('e1') ?? '?'}, e2=${tierCell('e2') ?? '?'}, e3=${tierCell('e3') ?? '?'}`
  );

  const opLogEntries = operationLog.query({ limit: 10 });
  excerpt(
    'operation log (latest entries)',
    opLogEntries
      .map((e) => `${e.timestamp} [${e.level}] ${e.category}: ${e.message}`)
      .join('\n') || '(empty)'
  );
  check(
    "operation log records the claude-glm rate limit (category 'rate-limit')",
    opLogEntries.some(
      (e) => e.category === 'rate-limit' && e.message.includes('claude-glm')
    )
  );

  // ---------------------------------------------------------------------
  section('Result');
  if (failures.length === 0) {
    info('ALL CHECKS PASSED');
    return 0;
  }
  info(`${failures.length} check(s) FAILED:`);
  for (const f of failures) info(` - ${f}`);
  return 1;
}

if (import.meta.main) {
  main()
    .then((code) => {
      if (code !== 0) {
        console.error('\nDispatch tiers e2e FAILED');
      }
      process.exit(code);
    })
    .catch((error) => {
      console.error('Dispatch tiers e2e crashed:', error);
      process.exit(1);
    });
}
