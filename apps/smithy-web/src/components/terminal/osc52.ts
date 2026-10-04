/**
 * OSC 52 clipboard support for the web terminal.
 *
 * Programs running inside the terminal (claude's TUI, tmux with
 * `set-clipboard on`, ...) emit `ESC ] 52 ; <selection> ; <base64> ST/BEL`
 * to copy a selection to the system clipboard. xterm.js ignores OSC 52 by
 * default; `XTerminal` registers a parser hook (ident 52) that routes the
 * sequence through the helpers in this module.
 *
 * The xterm.js OSC parser strips `52 ;` (and the ST/BEL terminator) before
 * dispatch, so the handler receives the raw string `<selection>;<payload>`
 * — e.g. `c;aGVsbG8=`. All functions here are pure or environment-guarded
 * so they can be unit-tested without xterm.js or a DOM.
 */

/** Maximum decoded payload size (in bytes) accepted for a clipboard write. */
export const OSC52_MAX_DECODED_BYTES = 100_000;

/** A parsed OSC 52 data string (the part after `52 ;`). */
export interface Osc52Data {
  /** Raw selection target field: `c` (clipboard), `p` (primary), `p+c`, ... */
  target: string;
  /** Base64 payload, or `?` for a clipboard read request. */
  payload: string;
  /** True when the program asked to READ the clipboard (`?` payload). */
  isReadRequest: boolean;
}

/**
 * Parse the data portion of an OSC 52 sequence (`<selection>;<payload>`).
 *
 * The terminator (ST/BEL) and the leading `52 ;` are already consumed by
 * the xterm.js parser. Returns `null` for malformed input: missing `;`,
 * empty selection, or empty payload.
 */
export function parseOsc52Data(data: string): Osc52Data | null {
  if (typeof data !== 'string') return null;
  const separator = data.indexOf(';');
  if (separator < 1) return null; // no payload separator, or empty selection
  const target = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (target.length === 0 || payload.length === 0) return null;
  return { target, payload, isReadRequest: payload === '?' };
}

/** Typed outcome of decoding an OSC 52 payload. */
export type Osc52DecodeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'read-request' | 'invalid-base64' | 'too-large' };

const utf8Decoder = new TextDecoder('utf-8');

/**
 * Decode an OSC 52 payload to UTF-8 text, refusing clipboard read requests
 * (`?`), invalid base64, and payloads whose decoded size exceeds
 * {@link OSC52_MAX_DECODED_BYTES} bytes.
 */
export function decodeOsc52Payload(payload: string): Osc52DecodeResult {
  if (payload === '?') {
    // Read request: never send clipboard contents back to the program.
    return { ok: false, reason: 'read-request' };
  }
  if (payload.length === 0) {
    return { ok: false, reason: 'invalid-base64' };
  }
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return { ok: false, reason: 'invalid-base64' };
  }
  if (binary.length > OSC52_MAX_DECODED_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  // `atob` yields a byte string; re-wrap and decode so multi-byte UTF-8
  // sequences survive the round-trip exactly.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { ok: true, text: utf8Decoder.decode(bytes) };
}

/**
 * Write text to the system clipboard.
 *
 * Tries the async Clipboard API first (secure contexts only — the dashboard
 * is served over plain HTTP on the LAN, where `navigator.clipboard` is
 * unavailable), then falls back to a hidden textarea + `execCommand('copy')`.
 * The textarea is removed even when `execCommand` throws. Resolves `false`
 * when both paths fail; never rejects.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: Clipboard } }).navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Rejection (permissions, document not focused, ...) — try the legacy path.
    }
  }
  return legacyCopyText(text);
}

/** Legacy copy: hidden textarea appended to the DOM, selected, then removed. */
function legacyCopyText(text: string): boolean {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') {
    return false;
  }
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // Positioned outside the visible layout so nothing flickers.
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  try {
    doc.body.appendChild(textarea);
    textarea.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/** Clipboard write function used by the OSC 52 handler (injectable for tests). */
export type Osc52ClipboardWriter = (text: string) => Promise<boolean>;

/**
 * Create the OSC 52 handler passed to `terminal.parser.registerOscHandler(52, ...)`.
 *
 * - Well-formed copy requests are decoded and written to the clipboard.
 * - Read requests (`?` payload) are ignored silently — the terminal never
 *   sends clipboard contents into the PTY.
 * - Malformed / invalid / oversized payloads are ignored with a single
 *   console warning per handler (per terminal instance); nothing is ever
 *   written into the terminal view.
 *
 * Returns `true` (sequence handled) so no other handler misinterprets it.
 */
export function createOsc52ClipboardHandler(
  writeClipboard: Osc52ClipboardWriter = writeClipboardText,
  warn: (message: string) => void = console.warn
): (data: string) => boolean {
  let warned = false;
  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  return (data: string): boolean => {
    const parsed = parseOsc52Data(data);
    if (!parsed) {
      warnOnce('[XTerminal] Ignoring malformed OSC 52 clipboard sequence');
      return true;
    }
    if (parsed.isReadRequest) {
      return true; // refused by design — never answer clipboard reads
    }
    const decoded = decodeOsc52Payload(parsed.payload);
    if (!decoded.ok) {
      warnOnce(`[XTerminal] Ignoring OSC 52 clipboard request (${decoded.reason})`);
      return true;
    }
    void writeClipboard(decoded.text)
      .then((written) => {
        if (!written) {
          warnOnce('[XTerminal] OSC 52 clipboard copy failed (clipboard unavailable)');
        }
      })
      .catch(() => {
        warnOnce('[XTerminal] OSC 52 clipboard copy failed (clipboard unavailable)');
      });
    return true;
  };
}
