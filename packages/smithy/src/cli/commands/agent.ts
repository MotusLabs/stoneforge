/**
 * Agent Commands - CLI operations for orchestrator agents
 *
 * Provides commands for agent management:
 * - agent list: List all registered agents
 * - agent show <id>: Show agent details
 * - agent register <name>: Register a new agent
 * - agent start <id>: Start (spawn) a Claude Code process for an agent
 * - agent stop <id>: Stop an agent session
 * - agent stream <id>: Get agent channel for streaming
 */

import type { Command, GlobalOptions, CommandResult, CommandOption } from '@stoneforge/quarry/cli';
import { success, failure, ExitCode, getFormatter, getOutputMode, OPERATOR_ENTITY_ID } from '@stoneforge/quarry/cli';
import type { EntityId, ElementId } from '@stoneforge/core';
import type { AgentRole, WorkerMode, StewardFocus, AgentMetadata } from '../../types/index.js';
import { isValidAgentTier } from '../../types/index.js';
import type { OrchestratorAPI, AgentEntity } from '../../api/index.js';
import { isAgentDisabled } from '../../services/agent-registry.js';
import type { AgentProvider } from '../../providers/types.js';

// ============================================================================
// Shared Helpers
// ============================================================================

/**
 * Creates orchestrator API client
 */
async function createOrchestratorClient(options: GlobalOptions): Promise<{
  api: OrchestratorAPI | null;
  error?: string;
}> {
  try {
    const { createStorage, initializeSchema, findStoneforgeDir } = await import('@stoneforge/quarry');
    const { createOrchestratorAPI } = await import('../../api/index.js');

    const stoneforgeDir = findStoneforgeDir(process.cwd());
    if (!stoneforgeDir) {
      return {
        api: null,
        error: 'No .stoneforge directory found. Run "sf init" first.',
      };
    }

    const dbPath = options.db ?? `${stoneforgeDir}/stoneforge.db`;
    const backend = createStorage({ path: dbPath, create: true });
    initializeSchema(backend);
    const api = createOrchestratorAPI(backend);

    return { api };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { api: null, error: `Failed to initialize API: ${message}` };
  }
}

/**
 * Gets agent metadata from agent entity
 */
function getAgentMeta(agent: AgentEntity): Record<string, unknown> {
  return (agent.metadata?.agent ?? {}) as unknown as Record<string, unknown>;
}

/**
 * Result of parsing a tier argument: either a resolved tier (null = clear) or
 * an error message explaining why the value is invalid.
 */
type ParsedTier = { tier: number | null; error?: undefined } | { tier?: undefined; error: string };

/**
 * Parses a tier value coming from the CLI (`--tier <n>` or the
 * `sf agent set-tier <id> <n|none>` argument).
 *
 * `none` (case-insensitive) clears the tier and resolves to null. Any other
 * value must be a positive integer (1 = most preferred), matching
 * `isValidAgentTier()`. The integer syntax is checked strictly (digits only)
 * so values like `0x2`, `1e3` or `+2` are rejected instead of being silently
 * coerced by `Number()`.
 */
function parseTierArgument(raw: string): ParsedTier {
  const value = raw.trim();
  if (value.toLowerCase() === 'none') {
    return { tier: null };
  }
  if (!/^\d+$/.test(value) || !isValidAgentTier(parseInt(value, 10))) {
    return {
      error: `Invalid tier: ${value}. Tier must be a positive integer (1 = most preferred) or "none" to clear it.`,
    };
  }
  return { tier: parseInt(value, 10) };
}

/**
 * Result of resolving the effective provider/model for `sf agent start`.
 */
export interface AgentStartOverrides {
  /** Effective provider name (--provider flag wins over agent metadata). Undefined = spawner default. */
  readonly providerName?: string;
  /** Effective model (--model flag wins over agent metadata). Undefined = provider default. */
  readonly model?: string;
  /** Validation error message when a flag value is invalid. */
  readonly error?: string;
}

/**
 * Resolves the effective provider and model for an `sf agent start` spawn.
 *
 * Precedence (matching SessionManager.startSession on the server side):
 *   CLI flag > agent's registered metadata > provider/spawner default.
 *
 * Flag values that are empty or whitespace-only are rejected with an error so
 * the command fails loudly instead of silently falling back. Metadata values
 * that are empty/whitespace are treated as unset.
 *
 * Exported for unit testing the flag-to-spawner propagation path.
 */
export function resolveAgentStartOverrides(
  flags: { provider?: string; model?: string },
  agentMeta: Record<string, unknown>
): AgentStartOverrides {
  const providerFlag = flags.provider?.trim();
  if (flags.provider !== undefined && !providerFlag) {
    return {
      error:
        'Invalid provider: value must be a non-empty provider name (e.g., claude-code, opencode).',
    };
  }

  const modelFlag = flags.model?.trim();
  if (flags.model !== undefined && !modelFlag) {
    return {
      error:
        'Invalid model: value must be a non-empty model identifier (e.g., claude-sonnet-4-5-20250929).',
    };
  }

  const metaProvider =
    typeof agentMeta.provider === 'string' ? agentMeta.provider.trim() : undefined;
  const metaModel =
    typeof agentMeta.model === 'string' ? agentMeta.model.trim() : undefined;

  return {
    providerName: providerFlag ?? (metaProvider || undefined),
    model: modelFlag ?? (metaModel || undefined),
  };
}

/**
 * Default orchestrator server URL (same default as the daemon commands and
 * tryReconcileAgentPatchViaServer).
 */
const DEFAULT_ORCHESTRATOR_URL = 'http://localhost:3457';

/**
 * Default spawn/init timeout (ms) the spawner applies when --timeout is not
 * given — mirrors SpawnerService's default. The server spawn request only
 * answers after the spawn settles, so the HTTP abort budget must cover it.
 */
const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;

/**
 * Extra budget on top of the spawn timeout for the HTTP round trip itself
 * (worktree creation, prompt assembly, response serialisation).
 */
const SERVER_REQUEST_OVERHEAD_MS = 10_000;

/**
 * Parses a positive-integer CLI option (--timeout, --cols, --rows).
 * Undefined input passes through as undefined. Anything that is not a
 * positive integer is rejected — silently coercing (e.g. "120.5" -> 120)
 * would ignore what the user actually typed.
 */
function parsePositiveIntOption(
  name: string,
  raw: string | undefined
): { value?: number; error?: string } {
  if (raw === undefined) {
    return {};
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || parseInt(trimmed, 10) <= 0) {
    return { error: `Invalid ${name}: ${raw}. Must be a positive integer.` };
  }
  return { value: parseInt(trimmed, 10) };
}

/**
 * Parses a --env KEY=VALUE assignment into a single-entry record. An entry
 * without '=' (or with an empty key) is rejected instead of silently
 * dropping the variable.
 */
function parseEnvAssignment(raw: string): { entry?: Record<string, string>; error?: string } {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    return { error: `Invalid --env: ${raw}. Must be KEY=VALUE.` };
  }
  return { entry: { [raw.slice(0, eq)]: raw.slice(eq + 1) } };
}

/**
 * Resolves the orchestrator server URL: --server option, then the
 * STONEFORGE_API_URL environment variable, then the default.
 */
function getOrchestratorUrl(options: { server?: string }): string {
  return (options.server ?? process.env.STONEFORGE_API_URL ?? DEFAULT_ORCHESTRATOR_URL).replace(/\/$/, '');
}

/**
 * Connect-phase error codes: failures that happen BEFORE the request is
 * delivered to any server, proving no spawn can have started. Bun uses
 * 'ConnectionRefused'; Node/undici uses 'ECONNREFUSED' (on err.cause).
 */
const CONNECT_PHASE_CODES = new Set([
  'ECONNREFUSED',
  'ConnectionRefused',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EACCES',
  'EAFNOSUPPORT',
]);

/**
 * Classifies a fetch failure from a spawn submission.
 *
 * Returns true only for connect-phase failures (DNS, refused, unreachable) —
 * the request was never delivered, so no server can have acted on it and a
 * local spawn cannot duplicate anything. Everything else (our abort timer
 * firing after submission, a connection reset mid-flight, a body read cut
 * short) is ambiguous: the server may have already accepted and spawned the
 * session. Falling back locally in that window would duplicate the spawn or
 * resurrect the phantom-success path, so ambiguous outcomes must surface as
 * explicit errors instead.
 *
 * Exported for unit testing.
 */
export function isConnectPhaseFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && CONNECT_PHASE_CODES.has(candidate.code)) {
      return true;
    }
    // Our abort timer: the request may already have been submitted.
    if (candidate.name === 'AbortError') {
      return false;
    }
    // Last resort for runtimes that surface the OS error only in the message.
    if (typeof candidate.message === 'string' && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** Shape of the spawn endpoints' (start and resume) JSON responses. */
interface ServerSpawnResponse {
  error?: { code?: string; message?: string };
  session?: {
    id?: string;
    providerSessionId?: string;
    status?: string;
    mode?: string;
    provider?: string;
    model?: string;
    pid?: number;
  };
  assignedTask?: { id?: string; title?: string };
}

/**
 * A spawn submission to the orchestrator server.
 */
interface ServerSpawnRequest {
  /** 'start' for a fresh session, 'resume' for --resume. */
  kind: 'start' | 'resume';
  /** JSON body for the endpoint. */
  body: Record<string, unknown>;
  /**
   * Abort budget for the HTTP request. The server only answers after the
   * spawn settles (init wait included), so this must cover the spawn timeout
   * the server will apply — not a short fixed probe.
   */
  requestTimeoutMs: number;
}

/** Result of a spawn attempt through the server. */
export interface ServerSpawnOutcome {
  /** The CommandResult to return from the handler (success OR explicit failure). */
  result: CommandResult;
  /** Session ID when the spawn succeeded (used for post-spawn task assignment). */
  sessionId?: string;
}

/**
 * Submits a supervised spawn to the running orchestrator server
 * (POST /api/agents/:id/start or /resume) instead of spawning locally.
 *
 * Why: a local spawn is owned by *this CLI process*. It prints "running",
 * then the CLI exits and the session dies with it — the server never logs
 * it, never updates agent metadata, and during a dispatch pause the whole
 * thing looks like a silently dropped spawn (incident 2026-10-04). A
 * server-owned spawn is supervised, logged by the session manager, and —
 * critically — when the server refuses (e.g. the agent's account is
 * rate-limited) the CLI surfaces the explicit error instead of a phantom
 * success.
 *
 * Outcomes:
 * - `{ result }` when the server answered (explicit success OR explicit
 *   failure such as 429 RATE_LIMITED / AGENT_DISABLED / SESSION_EXISTS), or
 *   when the submission outcome is ambiguous (timeout/connection loss after
 *   submission — the spawn may be running; reported as an error, never
 *   silently retried locally), or when a "successful" response carries no
 *   valid session.
 * - `undefined` ONLY when no server could be reached at all (connect-phase
 *   failure: connection refused, DNS, unreachable) so the caller may fall
 *   back to a local spawn without duplicating anything.
 *
 * Exported for unit testing the outcome classification.
 */
export async function trySpawnViaServer(
  id: string,
  request: ServerSpawnRequest,
  options: GlobalOptions & { taskId?: string; server?: string }
): Promise<ServerSpawnOutcome | undefined> {
  const endpoint = request.kind === 'resume' ? 'resume' : 'start';
  const url = `${getOrchestratorUrl(options)}/api/agents/${encodeURIComponent(id)}/${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });

    const data = (await response.json().catch(() => ({}))) as ServerSpawnResponse;

    if (!response.ok) {
      // The server answered — surface its explicit refusal. Never fall back
      // to a local spawn here: that is exactly the phantom-success path.
      const err = data.error;
      const detail = err?.message ?? `Server returned ${response.status}`;
      const code = err?.code ? ` (code: ${err.code})` : '';
      return {
        result: failure(
          `Failed to ${request.kind} agent ${id}: ${detail}${code}`,
          ExitCode.GENERAL_ERROR
        ),
      };
    }

    const session = data.session ?? {};
    if (typeof session.id !== 'string' || session.id.length === 0) {
      // The server answered "ok" but produced no session — a broken contract
      // is an explicit error, never a success and never a local fallback
      // (the server may still have spawned something).
      return {
        result: failure(
          `Failed to ${request.kind} agent ${id}: the orchestrator server returned success but no session (HTTP ${response.status}). Check 'sf agent show ${id}' before retrying.`,
          ExitCode.GENERAL_ERROR
        ),
      };
    }

    const outputMode = getOutputMode(options);

    if (outputMode === 'json') {
      return {
        sessionId: session.id,
        result: success({
          sessionId: session.id,
          providerSessionId: session.providerSessionId,
          agentId: id,
          status: session.status,
          mode: session.mode,
          provider: session.provider,
          model: session.model,
          pid: session.pid,
          taskId: options.taskId,
          spawnedVia: 'server',
        }),
      };
    }

    if (outputMode === 'quiet') {
      return { sessionId: session.id, result: success(session.id) };
    }

    const lines = [
      `Spawned agent ${id} (via orchestrator server)`,
      `  Session ID:  ${session.id}`,
      `  Provider ID: ${session.providerSessionId ?? '-'}`,
      `  Status:      ${session.status ?? '-'}`,
      `  Mode:        ${session.mode ?? '-'}`,
    ];
    if (session.provider || session.model) {
      lines.push(`  Provider:    ${session.provider ?? '-'}`);
      if (session.model) {
        lines.push(`  Model:       ${session.model}`);
      }
    }
    lines.push(`  PID:         ${session.pid ?? '-'}`);
    if (options.taskId) {
      lines.push(`  Task ID:     ${options.taskId}`);
    }
    return { sessionId: session.id, result: success(session, lines.join('\n')) };
  } catch (err) {
    if (isConnectPhaseFailure(err)) {
      // The request was never delivered — no server is running, so a local
      // spawn is legitimate. Signal the caller to fall back.
      return undefined;
    }
    // Ambiguous: the request may have been submitted and the server may have
    // accepted the spawn before the connection died or the timer fired.
    // Report it explicitly; do NOT fall back (that could spawn a duplicate
    // session alongside the possibly-running server one).
    const reason = err instanceof Error ? err.message : String(err);
    return {
      result: failure(
        `Failed to ${request.kind} agent ${id}: the orchestrator server request outcome is unknown (${reason}). ` +
          `The session may already be running server-side — check 'sf agent show ${id}' or GET /api/sessions?agentId=${encodeURIComponent(id)} ` +
          `before retrying. No local spawn was attempted to avoid a duplicate session.`,
        ExitCode.GENERAL_ERROR
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams output from a spawned session's event emitter
 * This is a long-running operation that continues until the session ends
 */
async function streamSpawnedSession(
  events: import('node:events').EventEmitter,
  sessionMode: 'headless' | 'interactive'
): Promise<void> {
  return new Promise((resolve) => {
    const onInterrupt = () => {
      console.log('\n[Stream interrupted]');
      cleanup();
      resolve();
    };

    const cleanup = () => {
      process.off('SIGINT', onInterrupt);
      events.off('event', onEvent);
      events.off('pty-data', onPtyData);
      events.off('exit', onExit);
      events.off('error', onError);
    };

    const onEvent = (event: { type: string; message?: string; tool?: { name?: string } }) => {
      if (event.type === 'assistant' && event.message) {
        process.stdout.write(event.message);
      } else if (event.type === 'tool_use' && event.tool?.name) {
        console.log(`\n[Tool: ${event.tool.name}]`);
      } else if (event.type === 'result' && event.message) {
        console.log(`\n[Result: ${event.message}]`);
      }
    };

    const onPtyData = (data: string) => {
      process.stdout.write(data);
    };

    const onExit = (code: number | null, signal: string | null) => {
      // User-friendly message for normal exit, show exit code for debugging on errors
      const exitMessage = code === 0
        ? 'The agent has stopped the session'
        : `The agent session ended unexpectedly (exit code ${code})${signal ? ` (signal: ${signal})` : ''}`;
      console.log(`\n[${exitMessage}]`);
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      console.error(`\n[Error: ${error.message}]`);
    };

    process.on('SIGINT', onInterrupt);

    if (sessionMode === 'headless') {
      events.on('event', onEvent);
    } else {
      events.on('pty-data', onPtyData);
    }

    events.on('exit', onExit);
    events.on('error', onError);
  });
}

// ============================================================================
// Agent List Command
// ============================================================================

interface AgentListOptions {
  role?: string;
  status?: string;
  workerMode?: string;
  focus?: string;
  reportsTo?: string;
  hasSession?: boolean;
}

const agentListOptions: CommandOption[] = [
  {
    name: 'role',
    short: 'r',
    description: 'Filter by role (director, worker, steward)',
    hasValue: true,
  },
  {
    name: 'status',
    short: 's',
    description: 'Filter by session status (idle, running, suspended, terminated)',
    hasValue: true,
  },
  {
    name: 'workerMode',
    short: 'm',
    description: 'Filter by worker mode (ephemeral, persistent)',
    hasValue: true,
  },
  {
    name: 'focus',
    short: 'f',
    description: 'Filter by steward focus (merge, docs, recovery, custom)',
    hasValue: true,
  },
  {
    name: 'reportsTo',
    description: 'Filter by manager entity ID',
    hasValue: true,
  },
  {
    name: 'hasSession',
    description: 'Filter to agents with active sessions',
  },
];

async function agentListHandler(
  _args: string[],
  options: GlobalOptions & AgentListOptions
): Promise<CommandResult> {
  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) {
    return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);
  }

  try {
    let agents: AgentEntity[];

    // Filter by role if specified
    if (options.role) {
      const validRoles = ['director', 'worker', 'steward'];
      if (!validRoles.includes(options.role)) {
        return failure(
          `Invalid role: ${options.role}. Must be one of: ${validRoles.join(', ')}`,
          ExitCode.VALIDATION
        );
      }
      agents = await api.getAgentsByRole(options.role as AgentRole);
    } else {
      agents = await api.listAgents();
    }

    // Additional filter by status
    if (options.status) {
      const validStatuses = ['idle', 'running', 'suspended', 'terminated'];
      if (!validStatuses.includes(options.status)) {
        return failure(
          `Invalid status: ${options.status}. Must be one of: ${validStatuses.join(', ')}`,
          ExitCode.VALIDATION
        );
      }
      agents = agents.filter((a) => {
        const meta = getAgentMeta(a);
        return meta.sessionStatus === options.status;
      });
    }

    // Filter by worker mode
    if (options.workerMode) {
      const validModes = ['ephemeral', 'persistent'];
      if (!validModes.includes(options.workerMode)) {
        return failure(
          `Invalid workerMode: ${options.workerMode}. Must be one of: ${validModes.join(', ')}`,
          ExitCode.VALIDATION
        );
      }
      agents = agents.filter((a) => {
        const meta = getAgentMeta(a);
        return meta.workerMode === options.workerMode;
      });
    }

    // Filter by steward focus
    if (options.focus) {
      const validFocuses = ['merge', 'docs', 'recovery', 'custom'];
      if (!validFocuses.includes(options.focus)) {
        return failure(
          `Invalid focus: ${options.focus}. Must be one of: ${validFocuses.join(', ')}`,
          ExitCode.VALIDATION
        );
      }
      agents = agents.filter((a) => {
        const meta = getAgentMeta(a);
        return meta.stewardFocus === options.focus;
      });
    }

    // Filter by manager
    if (options.reportsTo) {
      agents = agents.filter((a) => a.reportsTo === options.reportsTo);
    }

    // Filter by has session
    if (options.hasSession) {
      agents = agents.filter((a) => {
        const meta = getAgentMeta(a);
        return meta.sessionId !== undefined;
      });
    }

    const mode = getOutputMode(options);
    const formatter = getFormatter(mode);

    if (mode === 'json') {
      return success(agents);
    }

    if (mode === 'quiet') {
      return success(agents.map((a) => a.id).join('\n'));
    }

    if (agents.length === 0) {
      return success(null, 'No agents found');
    }

    const headers = ['ID', 'NAME', 'ROLE', 'TIER', 'STATUS', 'SESSION'];
    const rows = agents.map((agent) => {
      const meta = getAgentMeta(agent);
      const baseStatus = (meta.sessionStatus as string) ?? 'idle';
      const status = meta.disabled === true ? `${baseStatus} (disabled)` : baseStatus;
      return [
        agent.id,
        agent.name ?? '-',
        (meta.agentRole as string) ?? '-',
        isValidAgentTier(meta.tier) ? String(meta.tier) : '-',
        status,
        (meta.sessionId as string)?.slice(0, 8) ?? '-',
      ];
    });

    const table = formatter.table(headers, rows);
    return success(agents, `${table}\n${agents.length} agent(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to list agents: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

export const agentListCommand: Command = {
  name: 'list',
  description: 'List registered agents',
  usage: 'sf agent list [options]',
  help: `List all registered orchestrator agents.

Columns: ID, NAME, ROLE, TIER (dispatch tier, "-" when unset), STATUS, SESSION.

Options:
  -r, --role <role>        Filter by role (director, worker, steward)
  -s, --status <status>    Filter by session status (idle, running, suspended, terminated)
  -m, --workerMode <mode>  Filter by worker mode (ephemeral, persistent)
  -f, --focus <focus>      Filter by steward focus (merge, docs, recovery, custom)
  --reportsTo <id>         Filter by manager entity ID
  --hasSession             Filter to agents with active sessions

Examples:
  sf agent list
  sf agent list --role worker
  sf agent list --role worker --workerMode ephemeral
  sf agent list --status running
  sf agent list --role steward --focus merge
  sf agent list --hasSession`,
  options: agentListOptions,
  handler: agentListHandler as Command['handler'],
};

// ============================================================================
// Agent Show Command
// ============================================================================

async function agentShowHandler(
  args: string[],
  options: GlobalOptions
): Promise<CommandResult> {
  const [id] = args;

  if (!id) {
    return failure('Usage: sf agent show <id>\nExample: sf agent show el-abc123', ExitCode.INVALID_ARGUMENTS);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) {
    return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);
  }

  try {
    const agent = await api.getAgent(id as EntityId);
    if (!agent) {
      return failure(`Agent not found: ${id}`, ExitCode.NOT_FOUND);
    }

    const mode = getOutputMode(options);

    if (mode === 'json') {
      return success(agent);
    }

    if (mode === 'quiet') {
      return success(agent.id);
    }

    const meta = getAgentMeta(agent);
    const lines = [
      `ID:       ${agent.id}`,
      `Name:     ${agent.name ?? '-'}`,
      `Role:     ${meta.agentRole ?? '-'}`,
      `Status:   ${meta.sessionStatus ?? 'idle'}`,
      `Session:  ${meta.sessionId ?? '-'}`,
      `Channel:  ${meta.channelId ?? '-'}`,
      `Created:  ${agent.createdAt}`,
    ];

    if (meta.agentRole === 'director') {
      lines.push(`Target Branch: ${meta.targetBranch ?? '(auto-detect)'}`);
    }
    if (meta.workerMode) {
      lines.push(`Mode:     ${meta.workerMode}`);
    }
    if (meta.stewardFocus) {
      lines.push(`Focus:    ${meta.stewardFocus}`);
    }
    if (isValidAgentTier(meta.tier)) {
      lines.push(`Tier:     ${meta.tier}`);
    }

    return success(agent, lines.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to show agent: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

export const agentShowCommand: Command = {
  name: 'show',
  description: 'Show agent details',
  usage: 'sf agent show <id>',
  help: `Show detailed information about an agent.

Arguments:
  id    Agent identifier

Examples:
  sf agent show el-abc123`,
  options: [],
  handler: agentShowHandler as Command['handler'],
};

// ============================================================================
// Agent Register Command
// ============================================================================

interface AgentRegisterOptions {
  role?: string;
  mode?: string;
  focus?: string;
  maxTasks?: string;
  tags?: string;
  reportsTo?: string;
  roleDef?: string;
  trigger?: string;
  provider?: string;
  model?: string;
  targetBranch?: string;
  tier?: string;
}

const agentRegisterOptions: CommandOption[] = [
  {
    name: 'role',
    short: 'r',
    description: 'Agent role (worker, director, steward)',
    hasValue: true,
    required: true,
  },
  {
    name: 'mode',
    short: 'm',
    description: 'Worker mode (ephemeral, persistent)',
    hasValue: true,
  },
  {
    name: 'focus',
    short: 'f',
    description: 'Steward focus (merge, docs, recovery, custom)',
    hasValue: true,
  },
  {
    name: 'maxTasks',
    short: 't',
    description: 'Maximum concurrent tasks (default: 1)',
    hasValue: true,
  },
  {
    name: 'tags',
    description: 'Comma-separated tags',
    hasValue: true,
  },
  {
    name: 'reportsTo',
    description: 'Manager entity ID',
    hasValue: true,
  },
  {
    name: 'roleDef',
    description: 'Role definition document ID',
    hasValue: true,
  },
  {
    name: 'trigger',
    description: 'Steward cron trigger (e.g., "0 2 * * *")',
    hasValue: true,
  },
  {
    name: 'provider',
    description: 'Agent provider (e.g., claude-code, opencode)',
    hasValue: true,
  },
  {
    name: 'model',
    description: 'LLM model to use (e.g., claude-sonnet-4-5-20250929)',
    hasValue: true,
  },
  {
    name: 'targetBranch',
    description: 'Target branch for merge (director only, default: auto-detect)',
    hasValue: true,
  },
  {
    name: 'tier',
    description: 'Dispatch tier for workers: positive integer, 1 = most preferred (default: none)',
    hasValue: true,
  },
];

async function agentRegisterHandler(
  args: string[],
  options: GlobalOptions & AgentRegisterOptions
): Promise<CommandResult> {
  const [name] = args;

  if (!name) {
    return failure('Usage: sf agent register <name> --role <role> [options]\nExample: sf agent register MyWorker --role worker', ExitCode.INVALID_ARGUMENTS);
  }

  if (!options.role) {
    return failure('--role is required', ExitCode.INVALID_ARGUMENTS);
  }

  const validRoles = ['director', 'worker', 'steward'];
  if (!validRoles.includes(options.role)) {
    return failure(
      `Invalid role: ${options.role}. Must be one of: ${validRoles.join(', ')}`,
      ExitCode.VALIDATION
    );
  }

  // Resolve the dispatch tier before touching the registry so an invalid value
  // fails without leaving a half-registered agent behind.
  let tier: number | undefined;
  if (options.tier !== undefined) {
    if (options.role !== 'worker') {
      return failure('--tier can only be set on worker agents', ExitCode.VALIDATION);
    }
    const parsed = parseTierArgument(options.tier);
    if (parsed.error !== undefined) {
      return failure(parsed.error, ExitCode.VALIDATION);
    }
    tier = parsed.tier ?? undefined;
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) {
    return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);
  }

  try {
    // Use the default operator entity for CLI operations
    const createdBy = (options.actor ?? OPERATOR_ENTITY_ID) as EntityId;
    const maxConcurrentTasks = options.maxTasks ? parseInt(options.maxTasks, 10) : 1;
    const tags = options.tags ? options.tags.split(',').map(t => t.trim()) : undefined;
    const reportsTo = options.reportsTo as EntityId | undefined;
    const roleDefinitionRef = options.roleDef as ElementId | undefined;

    let agent: AgentEntity;

    switch (options.role as AgentRole) {
      case 'director':
        agent = await api.registerDirector({
          name,
          createdBy,
          maxConcurrentTasks,
          tags,
          roleDefinitionRef,
          provider: options.provider,
          model: options.model,
          targetBranch: options.targetBranch,
        });
        break;

      case 'worker': {
        const workerMode = (options.mode as WorkerMode) ?? 'ephemeral';
        const validModes = ['ephemeral', 'persistent'];
        if (!validModes.includes(workerMode)) {
          return failure(
            `Invalid mode: ${workerMode}. Must be one of: ${validModes.join(', ')}`,
            ExitCode.VALIDATION
          );
        }
        agent = await api.registerWorker({
          name,
          createdBy,
          workerMode,
          maxConcurrentTasks,
          tags,
          reportsTo,
          roleDefinitionRef,
          provider: options.provider,
          model: options.model,
          tier,
        });
        break;
      }

      case 'steward': {
        const stewardFocus = (options.focus as StewardFocus) ?? 'merge';
        const validFocuses = ['merge', 'docs', 'recovery', 'custom'];
        if (!validFocuses.includes(stewardFocus)) {
          return failure(
            `Invalid focus: ${stewardFocus}. Must be one of: ${validFocuses.join(', ')}`,
            ExitCode.VALIDATION
          );
        }
        // Parse trigger if provided
        const triggers: Array<{ type: 'cron'; schedule: string }> = [];
        if (options.trigger) {
          triggers.push({ type: 'cron', schedule: options.trigger });
        }
        agent = await api.registerSteward({
          name,
          createdBy,
          stewardFocus,
          triggers,
          maxConcurrentTasks,
          tags,
          reportsTo,
          roleDefinitionRef,
          provider: options.provider,
          model: options.model,
        });
        break;
      }

      default:
        return failure(`Unknown role: ${options.role}`, ExitCode.VALIDATION);
    }

    const mode = getOutputMode(options);

    if (mode === 'json') {
      return success(agent);
    }

    if (mode === 'quiet') {
      return success(agent.id);
    }

    return success(agent, `Registered ${options.role} agent: ${agent.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to register agent: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

export const agentRegisterCommand: Command = {
  name: 'register',
  description: 'Register a new agent',
  usage: 'sf agent register <name> --role <role> [options]',
  help: `Register a new orchestrator agent.

Arguments:
  name    Agent name

Options:
  -r, --role <role>       Agent role: director, worker, steward (required)
  -m, --mode <mode>       Worker mode: ephemeral, persistent (default: ephemeral)
  -f, --focus <focus>     Steward focus: merge, docs, recovery, custom
  -t, --maxTasks <n>      Maximum concurrent tasks (default: 1)
  --tags <tags>           Comma-separated tags (e.g., "frontend,urgent")
  --reportsTo <id>        Manager entity ID (for workers/stewards)
  --roleDef <id>          Role definition document ID
  --trigger <cron>        Steward cron trigger (e.g., "0 2 * * *")
  --provider <name>       Agent provider (e.g., claude-code, opencode)
  --model <model>         LLM model to use (e.g., claude-sonnet-4-5-20250929)
  --target-branch <branch> Target branch for merge (director only, default: auto-detect)
  --tier <n>              Dispatch tier for workers: positive integer, 1 = most preferred.
                          Workers without a tier are dispatched last. Use "sf agent set-tier"
                          to change it later.

Examples:
  sf agent register MyWorker --role worker --mode ephemeral
  sf agent register MainDirector --role director
  sf agent register MainDirector --role director --target-branch staging
  sf agent register MergeSteward --role steward --focus merge
  sf agent register MyWorker --role worker --tags "frontend,urgent"
  sf agent register TeamWorker --role worker --reportsTo el-director123
  sf agent register DocsSteward --role steward --focus docs --trigger "0 9 * * *"
  sf agent register OcWorker --role worker --provider opencode
  sf agent register MyWorker --role worker --model claude-sonnet-4-5-20250929
  sf agent register CheapWorker --role worker --tier 1
  sf agent register OverflowWorker --role worker --tier 3`,
  options: agentRegisterOptions,
  handler: agentRegisterHandler as Command['handler'],
};

// ============================================================================
// Agent Stop Command
// ============================================================================

interface AgentStopOptions {
  graceful?: boolean;
  reason?: string;
}

const agentStopOptions: CommandOption[] = [
  {
    name: 'graceful',
    short: 'g',
    description: 'Graceful shutdown (default: true)',
  },
  {
    name: 'no-graceful',
    description: 'Force immediate shutdown',
  },
  {
    name: 'reason',
    short: 'r',
    description: 'Reason for stopping the agent',
    hasValue: true,
  },
];

async function agentStopHandler(
  args: string[],
  options: GlobalOptions & AgentStopOptions & { 'no-graceful'?: boolean }
): Promise<CommandResult> {
  const [id] = args;

  if (!id) {
    return failure('Usage: sf agent stop <id> [options]\nExample: sf agent stop el-abc123', ExitCode.INVALID_ARGUMENTS);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) {
    return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);
  }

  try {
    // Determine graceful mode (default true unless --no-graceful is set)
    const graceful = options['no-graceful'] !== true;

    const agent = await api.updateAgentSession(
      id as EntityId,
      undefined,
      'idle'
    );

    const mode = getOutputMode(options);

    if (mode === 'json') {
      return success({
        ...agent,
        graceful,
        reason: options.reason,
      });
    }

    if (mode === 'quiet') {
      return success(agent.id);
    }

    let message = `Stopped agent ${id}`;
    if (!graceful) {
      message += ' (forced)';
    }
    if (options.reason) {
      message += `: ${options.reason}`;
    }

    return success(agent, message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to stop agent: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

export const agentStopCommand: Command = {
  name: 'stop',
  description: 'Stop an agent session',
  usage: 'sf agent stop <id> [options]',
  help: `Stop an agent session.

Arguments:
  id    Agent identifier

Options:
  -g, --graceful        Graceful shutdown (default: true)
  --no-graceful         Force immediate shutdown
  -r, --reason <text>   Reason for stopping the agent

Examples:
  sf agent stop el-abc123
  sf agent stop el-abc123 --reason "Task completed"
  sf agent stop el-abc123 --no-graceful`,
  options: agentStopOptions,
  handler: agentStopHandler as Command['handler'],
};

// ============================================================================
// Agent Stream Command
// ============================================================================

async function agentStreamHandler(
  args: string[],
  options: GlobalOptions
): Promise<CommandResult> {
  const [id] = args;

  if (!id) {
    return failure('Usage: sf agent stream <id>\nExample: sf agent stream el-abc123', ExitCode.INVALID_ARGUMENTS);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) {
    return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);
  }

  try {
    const channelId = await api.getAgentChannel(id as EntityId);
    if (!channelId) {
      return failure(`No channel found for agent: ${id}`, ExitCode.NOT_FOUND);
    }

    const mode = getOutputMode(options);

    if (mode === 'json') {
      return success({ channelId, agentId: id });
    }

    return success(
      { channelId },
      `Agent ${id} channel: ${channelId}\nUse "sf channel stream ${channelId}" to watch messages`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to get agent stream: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

export const agentStreamCommand: Command = {
  name: 'stream',
  description: 'Get agent channel for streaming',
  usage: 'sf agent stream <id>',
  help: `Get the channel ID for an agent to stream messages.

Arguments:
  id    Agent identifier

Examples:
  sf agent stream el-abc123`,
  options: [],
  handler: agentStreamHandler as Command['handler'],
};

// ============================================================================
// Agent Start Command
// ============================================================================

interface AgentStartOptions {
  prompt?: string;
  mode?: string;
  resume?: string;
  workdir?: string;
  cols?: string;
  rows?: string;
  timeout?: string;
  /** KEY=VALUE assignments; repeatable (array when parsed from argv). */
  env?: string | string[];
  taskId?: string;
  stream?: boolean;
  provider?: string;
  model?: string;
  server?: string;
}

const agentStartOptions: CommandOption[] = [
  {
    name: 'prompt',
    short: 'p',
    description: 'Initial prompt to send to the agent',
    hasValue: true,
  },
  {
    name: 'mode',
    short: 'm',
    description: 'Spawn mode (headless, interactive)',
    hasValue: true,
  },
  {
    name: 'resume',
    short: 'r',
    description: 'Provider session ID to resume',
    hasValue: true,
  },
  {
    name: 'workdir',
    short: 'w',
    description: 'Working directory for the agent',
    hasValue: true,
  },
  {
    name: 'cols',
    description: 'Terminal columns for interactive mode (default: 120)',
    hasValue: true,
  },
  {
    name: 'rows',
    description: 'Terminal rows for interactive mode (default: 30)',
    hasValue: true,
  },
  {
    name: 'timeout',
    description: 'Timeout in milliseconds (default: 120000)',
    hasValue: true,
  },
  {
    name: 'env',
    short: 'e',
    description: 'Environment variables (KEY=VALUE, can repeat)',
    hasValue: true,
    array: true,
  },
  {
    name: 'taskId',
    short: 't',
    description: 'Task ID to assign to this agent',
    hasValue: true,
  },
  {
    name: 'stream',
    description: 'Stream agent output after spawning',
  },
  {
    name: 'provider',
    description: 'Agent provider for this session (overrides the agent default; e.g., claude-code, opencode)',
    hasValue: true,
  },
  {
    name: 'model',
    description:
      'Model for this session (overrides the agent default; format is provider-specific — opencode uses composite <provider>/<model> IDs)',
    hasValue: true,
  },
  {
    name: 'server',
    short: 's',
    description: `Orchestrator server URL (default: ${DEFAULT_ORCHESTRATOR_URL}, or \$STONEFORGE_API_URL)`,
    hasValue: true,
  },
];

async function agentStartHandler(
  args: string[],
  options: GlobalOptions & AgentStartOptions
): Promise<CommandResult> {
  const [id] = args;

  if (!id) {
    return failure('Usage: sf agent start <id> [options]\nExample: sf agent start el-abc123 --prompt "Begin working"', ExitCode.INVALID_ARGUMENTS);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) {
    return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);
  }

  try {
    // Get the agent to verify it exists and get its role
    const agent = await api.getAgent(id as EntityId);
    if (!agent) {
      return failure(`Agent not found: ${id}`, ExitCode.NOT_FOUND);
    }

    if (isAgentDisabled(agent)) {
      return failure(
        `Agent ${id} is disabled. Run 'sf agent enable ${id}' first to bring it back online.`,
        ExitCode.VALIDATION
      );
    }

    const meta = getAgentMeta(agent);
    const agentRole = (meta.agentRole as AgentRole) ?? 'worker';

    // Determine spawn mode. Validated before any spawn attempt (server or
    // local) so an invalid value fails deterministically.
    let spawnMode: 'headless' | 'interactive' | undefined;
    if (options.mode) {
      if (options.mode !== 'headless' && options.mode !== 'interactive') {
        return failure(
          `Invalid mode: ${options.mode}. Must be 'headless' or 'interactive'`,
          ExitCode.VALIDATION
        );
      }
      spawnMode = options.mode as 'headless' | 'interactive';
    }

    // Resolve provider/model: CLI flags win over the agent's registered
    // defaults; anything invalid fails loudly instead of being silently
    // ignored (previously neither flag reached the spawner). Validated
    // before any spawn attempt (server or local).
    const overrides = resolveAgentStartOverrides(
      { provider: options.provider, model: options.model },
      meta
    );
    if (overrides.error) {
      return failure(overrides.error, ExitCode.VALIDATION);
    }

    const { getProviderRegistry } = await import('../../runtime/index.js');
    const registry = getProviderRegistry();

    // Resolve the effective provider instance up front (flag > registered
    // metadata > spawner default). Unknown or unavailable providers fail
    // loudly here — before any spawn attempt (server or local) — instead of
    // falling back silently. The instance is reused by the local spawn below.
    let providerOverride: AgentProvider | undefined;
    if (overrides.providerName) {
      try {
        providerOverride = await registry.getOrThrow(overrides.providerName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return failure(`Failed to start agent ${id}: ${message}`, ExitCode.VALIDATION);
      }
    }

    // Format-validate the effective model against the effective provider
    // BEFORE the (slower) availability probe, so a malformed value fails
    // deterministically with a clear error instead of being silently
    // dropped by the provider at runtime — where the session would report
    // the requested model while actually running the provider default
    // (e.g. a bare model name for opencode, which only understands
    // composite '<provider>/<model>' IDs). An unknown provider name skips
    // this and surfaces through getOrThrow's richer error below.
    if (overrides.model) {
      const modelProvider = overrides.providerName
        ? registry.get(overrides.providerName)
        : undefined;
      const validator = modelProvider ?? registry.getDefault();
      const modelError = validator.validateModel?.(overrides.model);
      if (modelError) {
        return failure(modelError, ExitCode.VALIDATION);
      }
    }

    // Parse the remaining spawn-shaping flags up front so both spawn paths
    // (supervised server spawn and local fallback) share validated values —
    // an invalid value must fail before anything is spawned anywhere.
    const timeoutParse = parsePositiveIntOption('--timeout', options.timeout);
    if (timeoutParse.error) {
      return failure(timeoutParse.error, ExitCode.VALIDATION);
    }
    const timeoutMs = timeoutParse.value;

    // --env is repeatable: parsed from argv it arrives as an array; direct
    // handler invocation (tests, programmatic use) may pass a single string.
    const envFlags = Array.isArray(options.env)
      ? options.env
      : options.env !== undefined
        ? [options.env]
        : [];
    const environmentVariables: Record<string, string> = {};
    for (const rawEnv of envFlags) {
      const envParsed = parseEnvAssignment(rawEnv);
      if (envParsed.error) {
        return failure(envParsed.error, ExitCode.VALIDATION);
      }
      Object.assign(environmentVariables, envParsed.entry);
    }

    const colsParse = parsePositiveIntOption('--cols', options.cols);
    if (colsParse.error) {
      return failure(colsParse.error, ExitCode.VALIDATION);
    }
    const rowsParse = parsePositiveIntOption('--rows', options.rows);
    if (rowsParse.error) {
      return failure(rowsParse.error, ExitCode.VALIDATION);
    }

    // Prefer the orchestrator server for every non-streaming start: the
    // session is then owned and supervised by the server (logged, metadata-
    // tracked, visible to the dispatch daemon) and explicit refusals — e.g.
    // 429 RATE_LIMITED during a dispatch pause — surface as CLI errors. A
    // non-streaming local spawn is CLI-process-owned: it prints "running",
    // the CLI exits, and the session dies with it, leaving no server-side
    // trace — the phantom-success path (incident 2026-10-04). --stream keeps
    // the local path on purpose: it is a foreground session whose output
    // this process consumes until it ends, so nothing is silently dropped.
    if (!options.stream) {
      const request = options.resume !== undefined
        ? {
            kind: 'resume' as const,
            body: {
              providerSessionId: options.resume,
              workingDirectory: options.workdir,
              resumePrompt: options.prompt,
              // Start-only options ride along so a reachable server can
              // refuse them explicitly (400 UNSUPPORTED_FOR_RESUME) instead
              // of the CLI silently dropping them. Without a server, the
              // local spawn below still honours them.
              ...(spawnMode !== undefined && { interactive: spawnMode === 'interactive' }),
              ...(colsParse.value !== undefined && { cols: colsParse.value }),
              ...(rowsParse.value !== undefined && { rows: rowsParse.value }),
              ...(Object.keys(environmentVariables).length > 0 && { environmentVariables }),
              ...(options.provider !== undefined && { provider: options.provider }),
              ...(options.model !== undefined && { model: options.model }),
              ...(timeoutMs !== undefined && { timeout: timeoutMs }),
            },
            requestTimeoutMs: DEFAULT_SPAWN_TIMEOUT_MS + SERVER_REQUEST_OVERHEAD_MS,
          }
        : {
            kind: 'start' as const,
            body: {
              initialPrompt: options.prompt,
              taskId: options.taskId,
              workingDirectory: options.workdir,
              // undefined (omitted) when --mode was not given: the server
              // then picks the mode from the agent's role, like the local
              // spawner does.
              interactive: spawnMode !== undefined ? spawnMode === 'interactive' : undefined,
              ...(colsParse.value !== undefined && { cols: colsParse.value }),
              ...(rowsParse.value !== undefined && { rows: rowsParse.value }),
              ...(Object.keys(environmentVariables).length > 0 && { environmentVariables }),
              provider: overrides.providerName,
              model: overrides.model,
              ...(timeoutMs !== undefined && { timeout: timeoutMs }),
            },
            requestTimeoutMs: (timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS) + SERVER_REQUEST_OVERHEAD_MS,
          };

      const viaServer = await trySpawnViaServer(id, request, options);
      if (viaServer) {
        // The supervised resume endpoint does not assign tasks itself;
        // mirror the local path so --resume --taskId behaves the same on
        // both paths.
        if (request.kind === 'resume' && options.taskId && viaServer.sessionId) {
          await api.assignTaskToAgent(
            options.taskId as ElementId,
            id as EntityId,
            { sessionId: viaServer.sessionId }
          );
        }
        return viaServer.result; // server answered — real success or explicit failure
      }
      // Connect-phase failure (no server reachable) → local spawn below.
    }

    // Import the spawner service
    const { createSpawnerService } = await import('../../runtime/index.js');
    const { findStoneforgeDir } = await import('@stoneforge/quarry');

    const stoneforgeDir = findStoneforgeDir(process.cwd());
    const spawner = createSpawnerService({
      workingDirectory: options.workdir ?? process.cwd(),
      stoneforgeRoot: stoneforgeDir ?? undefined,
      timeout: timeoutMs,
      environmentVariables: Object.keys(environmentVariables).length > 0 ? environmentVariables : undefined,
    });

    // Spawn the agent
    const result = await spawner.spawn(id as EntityId, agentRole, {
      initialPrompt: options.prompt,
      mode: spawnMode,
      resumeSessionId: options.resume,
      workingDirectory: options.workdir,
      cols: colsParse.value,
      rows: rowsParse.value,
      provider: providerOverride,
      model: overrides.model,
    });

    // If task ID is provided, assign the task to this agent
    if (options.taskId) {
      await api.assignTaskToAgent(
        options.taskId as ElementId,
        id as EntityId,
        { sessionId: result.session.id }
      );
    }

    // If --stream is set, stream the session output
    if (options.stream) {
      console.log(`Spawned agent ${id}`);
      console.log(`  Session ID:  ${result.session.id}`);
      console.log(`  Mode:        ${result.session.mode}`);
      console.log('\nStreaming output (Press Ctrl+C to stop):\n');

      await streamSpawnedSession(result.events, result.session.mode);

      return success(result.session, 'Stream ended');
    }

    const mode = getOutputMode(options);

    if (mode === 'json') {
      return success({
        sessionId: result.session.id,
        providerSessionId: result.session.providerSessionId,
        agentId: id,
        status: result.session.status,
        mode: result.session.mode,
        provider: result.session.provider,
        model: result.session.model,
        pid: result.session.pid,
        taskId: options.taskId,
      });
    }

    if (mode === 'quiet') {
      return success(result.session.id);
    }

    const lines = [
      `Spawned agent ${id}`,
      `  Session ID:  ${result.session.id}`,
      `  Provider ID: ${result.session.providerSessionId ?? '-'}`,
      `  Status:      ${result.session.status}`,
      `  Mode:        ${result.session.mode}`,
      `  Provider:    ${result.session.provider}`,
      `  Model:       ${result.session.model ?? '(provider default)'}`,
      `  PID:         ${result.session.pid ?? '-'}`,
    ];
    if (options.taskId) {
      lines.push(`  Task ID:     ${options.taskId}`);
    }

    return success(result.session, lines.join('\n'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`Failed to start agent: ${message}`, ExitCode.GENERAL_ERROR);
  }
}

export const agentStartCommand: Command = {
  name: 'start',
  description: 'Start an agent process',
  usage: 'sf agent start <id> [options]',
  help: `Start a new agent process.

When an orchestrator server is running (default ${DEFAULT_ORCHESTRATOR_URL}, override with
--server or \$STONEFORGE_API_URL), the session is started through the server so it is
supervised, logged and visible to the dispatch daemon — and refusals (e.g. a
rate-limited account or a dispatch pause) are reported explicitly instead of a
phantom success. All options except --stream are forwarded: --mode, --cols,
--rows, --env, --provider, --model and --timeout shape the supervised spawn,
and --resume routes through the server's resume endpoint (start-only options
combined with --resume are refused explicitly by the server, not dropped).
--stream always spawns locally in the foreground — the CLI stays attached and
streams until the session ends. Without a reachable server the session is
spawned locally instead; a non-streaming local spawn is owned by this CLI
process and ends when it exits. If the server request outcome is unknown
(timeout or connection loss after submission), the command reports an
explicit error rather than risking a duplicate spawn.

Arguments:
  id    Agent identifier

Options:
  -p, --prompt <text>      Initial prompt to send to the agent
  -m, --mode <mode>        Start mode: headless, interactive
  -r, --resume <id>        Resume a previous session
  -w, --workdir <path>     Working directory for the agent
  --cols <n>               Terminal columns for interactive mode (default: 120)
  --rows <n>               Terminal rows for interactive mode (default: 30)
  --timeout <ms>           Timeout in milliseconds (default: 120000)
  -e, --env <KEY=VALUE>    Environment variables to set (repeatable)
  -t, --taskId <id>        Task ID to assign to this agent
  --stream                 Stream agent output locally (foreground; keeps the
                           CLI attached, never routed through the server)
  --provider <name>        Agent provider for this session. Overrides the
                           agent's registered provider; without it, the
                           registered provider (or the claude-code default)
                           is used. Unknown or unavailable providers fail
                           with an error instead of falling back silently.
  --model <model>          Model for this session. Overrides the agent's
                           registered model; without it, the registered model
                           (or the provider default) is used. Model IDs are
                           provider-specific: opencode expects composite
                           '<provider>/<model>' IDs (e.g.,
                           anthropic/claude-sonnet-4-5-20250929). Values that
                           are malformed for the effective provider fail with
                           a validation error instead of silently falling
                           back to the provider default.
  -s, --server <url>       Orchestrator server URL (default: ${DEFAULT_ORCHESTRATOR_URL})

Examples:
  sf agent start el-abc123
  sf agent start el-abc123 --mode interactive
  sf agent start el-abc123 --mode interactive --cols 160 --rows 40
  sf agent start el-abc123 --prompt "Start working on your assigned tasks"
  sf agent start el-abc123 --resume prev-session-id
  sf agent start el-abc123 --env MY_VAR=value
  sf agent start el-abc123 --taskId el-task456
  sf agent start el-abc123 --stream
  sf agent start el-abc123 --provider opencode
  sf agent start el-abc123 --model claude-opus-4-6
  sf agent start el-abc123 --provider opencode --model anthropic/claude-sonnet-4-5-20250929`,
  options: agentStartOptions,
  handler: agentStartHandler as Command['handler'],
};

// ============================================================================
// Agent Disable Command
// ============================================================================

/**
 * Tries to apply a metadata change through the running orchestrator's
 * PATCH /api/agents/:id endpoint so an active scheduler/dispatch daemon can
 * reconcile immediately (e.g. unregister a steward's cron jobs, or pick up a
 * new worker dispatch tier). Returns true on success, false on any failure
 * (server unreachable, non-2xx, network error, timeout) so the caller can fall
 * back to a direct DB write. The CLI must produce a consistent end state
 * whether the orchestrator is up or not.
 */
async function tryReconcileAgentPatchViaServer(
  id: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const apiUrl = (process.env.STONEFORGE_API_URL || 'http://localhost:3457').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${apiUrl}/api/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function agentDisableHandler(
  args: string[],
  options: GlobalOptions
): Promise<CommandResult> {
  const [id] = args;
  if (!id) {
    return failure('Usage: sf agent disable <id>', ExitCode.INVALID_ARGUMENTS);
  }

  // Try the running server first so an active scheduler reconciles steward
  // triggers immediately. If unreachable, fall back to direct DB write.
  const reconciled = await tryReconcileAgentPatchViaServer(id, { disabled: true });
  if (reconciled) {
    return success({ id, disabled: true }, `Agent ${id} disabled. It will be skipped by dispatch and the scheduler.`);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);

  const agent = await api.getAgent(id as EntityId);
  if (!agent) return failure(`Agent not found: ${id}`, ExitCode.NOT_FOUND);

  await api.updateAgentMetadata(id as EntityId, { disabled: true } as Partial<AgentMetadata>);
  return success({ id, disabled: true }, `Agent ${id} disabled. Scheduler will pick up the change on next start.`);
}

export const agentDisableCommand: Command = {
  name: 'disable',
  description: 'Disable an agent (skipped by dispatch and scheduler, kept in the list)',
  usage: 'sf agent disable <id>',
  help: `Mark an agent as disabled. The agent stays visible in 'sf agent list' but is skipped by the dispatch daemon and steward scheduler. In-flight sessions are NOT terminated; only future work is blocked. Re-enable with 'sf agent enable <id>'.

Arguments:
  id    Agent identifier`,
  handler: agentDisableHandler as Command['handler'],
};

// ============================================================================
// Agent Enable Command
// ============================================================================

async function agentEnableHandler(
  args: string[],
  options: GlobalOptions
): Promise<CommandResult> {
  const [id] = args;
  if (!id) {
    return failure('Usage: sf agent enable <id>', ExitCode.INVALID_ARGUMENTS);
  }

  // Try the running server first so an active scheduler re-registers a
  // steward's triggers immediately. If unreachable, fall back to direct DB write.
  const reconciled = await tryReconcileAgentPatchViaServer(id, { disabled: false });
  if (reconciled) {
    return success({ id, disabled: false }, `Agent ${id} enabled.`);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);

  const agent = await api.getAgent(id as EntityId);
  if (!agent) return failure(`Agent not found: ${id}`, ExitCode.NOT_FOUND);

  await api.updateAgentMetadata(id as EntityId, { disabled: undefined } as Partial<AgentMetadata>);
  return success({ id, disabled: false }, `Agent ${id} enabled. Scheduler will pick up the change on next start.`);
}

export const agentEnableCommand: Command = {
  name: 'enable',
  description: 'Enable a previously disabled agent',
  usage: 'sf agent enable <id>',
  help: `Re-enable a disabled agent so it is considered again by dispatch and the scheduler.

Arguments:
  id    Agent identifier`,
  handler: agentEnableHandler as Command['handler'],
};

// ============================================================================
// Agent Set-Tier Command
// ============================================================================

async function agentSetTierHandler(
  args: string[],
  options: GlobalOptions
): Promise<CommandResult> {
  const [id, tierArg] = args;
  if (!id || !tierArg) {
    return failure(
      'Usage: sf agent set-tier <id> <n|none>\nExample: sf agent set-tier el-abc123 1\nExample: sf agent set-tier el-abc123 none',
      ExitCode.INVALID_ARGUMENTS
    );
  }

  // Validate before touching anything so an invalid value leaves the agent
  // unchanged.
  const parsed = parseTierArgument(tierArg);
  if (parsed.error !== undefined) {
    return failure(parsed.error, ExitCode.VALIDATION);
  }
  const tier = parsed.tier;
  const message = tier === null
    ? `Cleared dispatch tier for agent ${id}. It now ranks after every tiered worker.`
    : `Set dispatch tier ${tier} for agent ${id}.`;

  // Try the running server first so a live dispatch daemon sees the new tier
  // on its next poll. If unreachable, fall back to a direct DB write.
  const reconciled = await tryReconcileAgentPatchViaServer(id, { tier });
  if (reconciled) {
    return success({ id, tier }, message);
  }

  const { api, error } = await createOrchestratorClient(options);
  if (error || !api) return failure(error ?? 'Failed to create API', ExitCode.GENERAL_ERROR);

  const agent = await api.getAgent(id as EntityId);
  if (!agent) return failure(`Agent not found: ${id}`, ExitCode.NOT_FOUND);

  const meta = getAgentMeta(agent);
  if (meta.agentRole !== 'worker') {
    return failure(
      `Agent ${id} is not a worker (role: ${meta.agentRole ?? 'unknown'}). Dispatch tiers apply to workers only.`,
      ExitCode.VALIDATION
    );
  }

  await api.updateAgentMetadata(
    id as EntityId,
    // undefined drops the key so the absent-means-untiered contract holds in
    // the JSON-serialised metadata.
    { tier: tier ?? undefined } as Partial<AgentMetadata>
  );

  return success({ id, tier }, message);
}

export const agentSetTierCommand: Command = {
  name: 'set-tier',
  description: 'Set or clear a worker dispatch tier (1 = most preferred)',
  usage: 'sf agent set-tier <id> <n|none>',
  help: `Set the dispatch tier of a worker agent. The dispatch daemon offers ready tasks to idle workers in ascending tier order (tier 1 first); workers without a tier are dispatched last. Within a tier, the least recently dispatched worker is picked first.

Arguments:
  id    Agent identifier
  n     Positive integer tier (1 = most preferred), or "none" to clear the tier

Examples:
  sf agent set-tier el-abc123 1
  sf agent set-tier el-abc123 3
  sf agent set-tier el-abc123 none`,
  handler: agentSetTierHandler as Command['handler'],
};

// ============================================================================
// Main Agent Command
// ============================================================================

export const agentCommand: Command = {
  name: 'agent',
  description: 'Manage orchestrator agents',
  usage: 'sf agent <subcommand> [options]',
  help: `Manage orchestrator agents.

Subcommands:
  list      List all registered agents
  show      Show agent details
  register  Register a new agent
  start     Start an agent process
  stop      Stop an agent session
  stream    Get agent channel for streaming
  disable   Disable an agent (skipped by dispatch and scheduler)
  enable    Re-enable a previously disabled agent
  set-tier  Set or clear a worker dispatch tier (1 = most preferred)

Examples:
  sf agent list
  sf agent register MyWorker --role worker
  sf agent register CheapWorker --role worker --tier 1
  sf agent set-tier el-abc123 2
  sf agent set-tier el-abc123 none
  sf agent start el-abc123
  sf agent start el-abc123 --mode interactive`,
  subcommands: {
    list: agentListCommand,
    show: agentShowCommand,
    register: agentRegisterCommand,
    start: agentStartCommand,
    stop: agentStopCommand,
    stream: agentStreamCommand,
    disable: agentDisableCommand,
    enable: agentEnableCommand,
    'set-tier': agentSetTierCommand,
    // Aliases (hidden from --help via dedup in getCommandHelp)
    create: agentRegisterCommand,
    ls: agentListCommand,
    get: agentShowCommand,
    view: agentShowCommand,
  },
  handler: agentListCommand.handler, // Default to list
  options: [],
};
