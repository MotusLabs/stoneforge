/**
 * Graceful Process Exit Helpers
 *
 * `process.exit()` stops the process immediately and throws away anything
 * still sitting in the asynchronous stdout/stderr write buffers. When either
 * stream is a pipe (rather than a TTY or a regular file), writes are buffered
 * in userland and flushed by libuv in the background, so exiting right after
 * printing large output silently truncates it. With a 64KB OS pipe buffer this
 * shows up as piped `sf` output being cut off at exactly 65,536 bytes — e.g.
 * `sf show <id> --json | jq` receiving a partial, invalid JSON document, or
 * `sf task list --json | python3 -c 'json.load(...)'` failing with
 * "Unterminated string". Redirecting the same command to a file hides the bug,
 * because file writes are never throttled by a pipe buffer.
 *
 * Never call `process.exit()` while output may still be buffered. Instead:
 *
 *   1. record the exit code with `process.exitCode`
 *   2. wait for stdout and stderr to drain (Node only — see `isBun`)
 *   3. let the process end by itself once the event loop empties
 *
 * Step 3 needs a safety net: an open handle (database connection, listening
 * socket, forgotten timer) would keep the event loop alive forever. An
 * unref'd timer forces the exit instead — unref'd so that it does not keep
 * the loop alive itself, and armed only once the streams are drained so the
 * forced exit can never truncate anything.
 */

/**
 * How long to wait after the streams have drained before forcing the exit.
 * Only reached when another open handle is keeping the event loop alive; a
 * clean process ends by itself long before this fires.
 */
const DRAINED_EXIT_GRACE_MS = 250;

/**
 * Hard ceiling on the drain wait, so a pipe consumer that never reads
 * (or a stream that never flushes) cannot hang the CLI indefinitely.
 */
const DRAIN_TIMEOUT_MS = 10_000;

/**
 * Whether the process runs on Bun rather than Node.
 *
 * The two runtimes flush stdio in opposite ways, and each breaks if handled
 * like the other (measured with a ~280KB single `console.log` to a pipe,
 * 10 runs per variant):
 *
 * - Node: `process.exit()` right after the write truncates at 65,536 bytes
 *   (the OS pipe buffer). Letting the process end by itself — or waiting for
 *   the callback of an empty `write('', cb)` before exiting — delivers
 *   everything.
 * - Bun: `process.exit()` flushes buffered console output completely, while
 *   ending naturally discards whatever the pipe has not taken yet (again
 *   exactly 65,536 bytes). Worse, *merely accessing* `process.stdout` (a
 *   lazy getter) switches `console` from Bun's fast direct-to-fd path onto
 *   the lossy `WriteStream` path, after which every exit loses everything
 *   past the first pipe buffer.
 *
 * So: Node drains the streams and ends naturally; Bun exits hard and never
 * touches `process.stdout`/`process.stderr`.
 */
function isBun(): boolean {
  return (
    typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ||
    Boolean(process.versions?.bun)
  );
}

/**
 * Stream errors that simply mean "the reader on the other side is gone"
 * (`sf ... | head`). More output cannot be delivered, so they are ignored
 * instead of crashing with an unhandled 'error' event.
 */
const STREAM_ERRORS_TO_IGNORE: ReadonlySet<string> = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

const guardedStreams = new WeakSet<object>();

/**
 * Installs the EPIPE guard on both standard streams.
 *
 * Call this once, early, from the CLI entry point — but note that it is a
 * no-op under Bun, where even evaluating `process.stdout` would break the
 * flush-on-exit behaviour (see `isBun`). Bun does not need the guard: it
 * already ignores a vanished pipe reader.
 */
export function installStreamEpipeGuards(): void {
  if (isBun()) {
    return;
  }
  tolerateStreamEpipe(process.stdout);
  tolerateStreamEpipe(process.stderr);
}

/**
 * Prevents a closed downstream pipe (`sf ... | head`) from crashing the
 * process with an unhandled EPIPE once we stop force-exiting while writes
 * may still be in flight.
 *
 * Idempotent per stream. Unexpected stream errors keep Node's default
 * crash-loudly behaviour. Node only — under Bun this must not even be
 * *called* with `process.stdout`, because the argument is evaluated at the
 * call site (see `isBun`).
 */
export function tolerateStreamEpipe(stream: NodeJS.WriteStream): void {
  if (isBun() || guardedStreams.has(stream)) {
    return;
  }
  guardedStreams.add(stream);

  const onError = (err: NodeJS.ErrnoException) => {
    if (err && STREAM_ERRORS_TO_IGNORE.has(err.code ?? '')) {
      return; // Reader went away — nothing left to deliver.
    }
    // Unexpected failure: restore default behaviour (throw) for this error.
    stream.removeListener('error', onError);
    process.nextTick(() => stream.emit('error', err));
  };

  stream.on('error', onError);
}

/**
 * Waits until every byte already written to the stream has been handed to the
 * OS. The callback of an empty write fires once all preceding writes have
 * flushed; on TTYs and files this is immediate, on pipes it resolves when the
 * reader has drained the buffer. `'drain'` covers the case where the buffer
 * was still full when the write was issued.
 *
 * Never rejects and never hangs forever: after `timeoutMs` it resolves anyway.
 * Node only — under Bun this must not be called (see `isBun`).
 */
function drainStream(stream: NodeJS.WriteStream, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve();
    };

    // Safety net: never block the exit on a pipe nobody reads from.
    timeout = setTimeout(done, timeoutMs);
    timeout.unref?.();

    tolerateStreamEpipe(stream);

    const buffered = stream.write('', done);
    if (!buffered) {
      stream.once('drain', done);
    }
  });
}

/**
 * Waits for both stdout and stderr to finish flushing. Node only.
 */
export async function flushStdio(): Promise<void> {
  await Promise.all([
    drainStream(process.stdout, DRAIN_TIMEOUT_MS),
    drainStream(process.stderr, DRAIN_TIMEOUT_MS),
  ]);
}

/**
 * Exits the process without losing buffered output.
 *
 * Records the exit code, drains the streams (Node only) and then lets the
 * process end naturally, with an unref'd fallback timer that forces the exit
 * if some other open handle keeps the event loop alive — so no command can
 * hang, and no command can truncate.
 *
 * Unlike `process.exit()` this returns: callers must not assume the process
 * is gone, since nothing after the call may run if the loop empties first.
 */
export async function exitGracefully(exitCode: number): Promise<void> {
  if (isBun()) {
    // Bun flushes buffered console output on process.exit() — and a natural
    // exit loses it (see isBun) — so the hard exit is the safe path there.
    process.exit(exitCode);
  }

  process.exitCode = exitCode;

  // Guarantees the streams are empty before the fallback exit below, so that
  // exit can never discard pending output.
  await flushStdio();

  // Unref'd: if the event loop has nothing else pending, the process ends on
  // its own with `process.exitCode`; if a stray handle keeps it alive, this
  // timer ends it instead.
  const forceExit = setTimeout(() => process.exit(exitCode), DRAINED_EXIT_GRACE_MS);
  forceExit.unref?.();
}
