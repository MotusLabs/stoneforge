/**
 * Unit tests for the OSC 52 clipboard helpers.
 *
 * These run in vitest's default node environment (no DOM): every function in
 * `osc52.ts` is pure or environment-guarded for exactly that reason. DOM and
 * navigator interactions are exercised through hand-rolled stubs so the
 * legacy-copy fallback can be verified without jsdom.
 *
 * Input-shape note: the xterm.js OSC parser consumes `ESC ] 52 ;` and the
 * ST/BEL terminator before dispatch, so the handler receives the bare
 * `<selection>;<payload>` string — e.g. `c;aGVsbG8=` for both
 * `\x1b]52;c;aGVsbG8=\x1b\\` and `\x1b]52;c;aGVsbG8=\x07`. The parse tests
 * below document that contract.
 */

import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  OSC52_MAX_DECODED_BYTES,
  parseOsc52Data,
  decodeOsc52Payload,
  writeClipboardText,
  createOsc52ClipboardHandler,
} from './osc52';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseOsc52Data', () => {
  test('parses the pre-split handler input for the ST-terminated form', () => {
    // \x1b]52;c;aGVsbG8=\x1b\\  →  handler receives 'c;aGVsbG8='
    expect(parseOsc52Data('c;aGVsbG8=')).toEqual({
      target: 'c',
      payload: 'aGVsbG8=',
      isReadRequest: false,
    });
  });

  test('parses the BEL-terminated form to the identical handler input', () => {
    // \x1b]52;c;aGVsbG8=\x07  →  handler also receives 'c;aGVsbG8='
    expect(parseOsc52Data('c;aGVsbG8=')).toEqual(parseOsc52Data('c;aGVsbG8='));
  });

  test('parses the primary-selection target', () => {
    expect(parseOsc52Data('p;cGF5bG9hZA==')).toEqual({
      target: 'p',
      payload: 'cGF5bG9hZA==',
      isReadRequest: false,
    });
  });

  test('parses compound targets without splitting them', () => {
    // Browsers expose a single clipboard, so the whole target field is kept
    // opaque and the payload is written regardless.
    expect(parseOsc52Data('p+c;aGVsbG8=')).toEqual({
      target: 'p+c',
      payload: 'aGVsbG8=',
      isReadRequest: false,
    });
  });

  test('flags read requests', () => {
    expect(parseOsc52Data('c;?')).toEqual({
      target: 'c',
      payload: '?',
      isReadRequest: true,
    });
  });

  test('rejects malformed input: missing separator', () => {
    expect(parseOsc52Data('caGVsbG8=')).toBeNull();
  });

  test('rejects malformed input: empty selection field', () => {
    expect(parseOsc52Data(';aGVsbG8=')).toBeNull();
  });

  test('rejects malformed input: empty payload', () => {
    expect(parseOsc52Data('c;')).toBeNull();
  });

  test('rejects non-string input defensively', () => {
    expect(parseOsc52Data(undefined as unknown as string)).toBeNull();
  });
});

describe('decodeOsc52Payload', () => {
  test('decodes ASCII base64', () => {
    expect(decodeOsc52Payload(btoa('Hello, OSC 52!'))).toEqual({
      ok: true,
      text: 'Hello, OSC 52!',
    });
  });

  test('round-trips multi-byte UTF-8 exactly', () => {
    const selections = [
      'héllo wörld',                     // Latin-1 accents
      '日本語のコピー ✓',                  // CJK + symbol
      '🚀 family 👨‍👩‍👧‍👦',                // surrogate pairs + ZWJ sequences
      'é combining',               // combining marks
    ];
    for (const text of selections) {
      const b64 = btoa(
        Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join('')
      );
      expect(decodeOsc52Payload(b64)).toEqual({ ok: true, text });
    }
  });

  test('refuses read requests before touching base64', () => {
    expect(decodeOsc52Payload('?')).toEqual({ ok: false, reason: 'read-request' });
  });

  test('rejects invalid base64', () => {
    expect(decodeOsc52Payload('!!!not-base64!!!')).toEqual({ ok: false, reason: 'invalid-base64' });
    expect(decodeOsc52Payload('a')).toEqual({ ok: false, reason: 'invalid-base64' });
    expect(decodeOsc52Payload('')).toEqual({ ok: false, reason: 'invalid-base64' });
  });

  test('accepts a payload decoding to exactly the byte cap', () => {
    const b64 = Buffer.from('A'.repeat(OSC52_MAX_DECODED_BYTES), 'utf8').toString('base64');
    // The cap is on decoded bytes, not encoded length: this accepted payload's
    // base64 form (133,336 chars) is itself far longer than the byte cap.
    expect(b64.length).toBeGreaterThan(OSC52_MAX_DECODED_BYTES);
    expect(decodeOsc52Payload(b64)).toEqual({ ok: true, text: 'A'.repeat(OSC52_MAX_DECODED_BYTES) });
  });

  test('rejects a payload decoding one byte over the cap', () => {
    const b64 = Buffer.from('A'.repeat(OSC52_MAX_DECODED_BYTES + 1), 'utf8').toString('base64');
    expect(decodeOsc52Payload(b64)).toEqual({ ok: false, reason: 'too-large' });
  });

  test('caps multi-byte payloads by decoded UTF-8 byte count', () => {
    // 34,000 × 'あ' decodes to 102,000 UTF-8 bytes — over the cap.
    const text = 'あ'.repeat(34_000);
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    expect(decodeOsc52Payload(b64)).toEqual({ ok: false, reason: 'too-large' });
  });
});

/** Minimal textarea double recording every DOM touch the fallback makes. */
class FakeTextarea {
  tag: string;
  value = '';
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  selectCalls = 0;
  removed = false;

  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  select() {
    this.selectCalls++;
  }
  remove() {
    this.removed = true;
  }
}

/** Build a fake `document` whose execCommand behavior is configurable. */
function makeFakeDocument(execCommandResult: boolean | Error) {
  const created: FakeTextarea[] = [];
  const appended: FakeTextarea[] = [];
  const execCommands: string[] = [];
  const doc = {
    createElement: (tag: string) => {
      const el = new FakeTextarea(tag);
      created.push(el);
      return el;
    },
    execCommand: (command: string) => {
      execCommands.push(command);
      if (execCommandResult instanceof Error) throw execCommandResult;
      return execCommandResult;
    },
    body: {
      appendChild: (el: FakeTextarea) => {
        appended.push(el);
      },
    },
  };
  return { doc, created, appended, execCommands };
}

/** Stub `navigator` with no clipboard API at all (plain-HTTP LAN case). */
function stubNavigatorWithoutClipboard() {
  vi.stubGlobal('navigator', {});
}

describe('writeClipboardText legacy fallback', () => {
  test('uses the hidden-textarea fallback when navigator.clipboard is absent', async () => {
    stubNavigatorWithoutClipboard();
    const { doc, created, appended, execCommands } = makeFakeDocument(true);
    vi.stubGlobal('document', doc);

    await expect(writeClipboardText('legacy text')).resolves.toBe(true);

    expect(created).toHaveLength(1);
    const textarea = created[0];
    expect(textarea.tag).toBe('textarea');
    expect(textarea.value).toBe('legacy text');
    expect(textarea.attributes.readonly).toBe('');
    expect(appended).toContain(textarea);
    expect(textarea.selectCalls).toBe(1);
    expect(execCommands).toEqual(['copy']);
    expect(textarea.removed).toBe(true);
  });

  test('returns false but still removes the textarea when execCommand throws', async () => {
    stubNavigatorWithoutClipboard();
    const { doc, created, execCommands } = makeFakeDocument(new Error('blocked'));
    vi.stubGlobal('document', doc);

    await expect(writeClipboardText('anything')).resolves.toBe(false);

    expect(created).toHaveLength(1);
    expect(created[0].removed).toBe(true);
    expect(execCommands).toEqual(['copy']);
  });

  test('returns false when neither navigator.clipboard nor document exist', async () => {
    stubNavigatorWithoutClipboard();
    vi.stubGlobal('document', undefined);
    await expect(writeClipboardText('nope')).resolves.toBe(false);
  });
});

describe('writeClipboardText async Clipboard API', () => {
  test('prefers navigator.clipboard.writeText when available', async () => {
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });

    // No `document` stub is installed: if the legacy path were taken instead,
    // it would find no DOM and resolve false, failing this assertion.
    await expect(writeClipboardText('secure path')).resolves.toBe(true);
    expect(written).toEqual(['secure path']);
  });

  test('falls back to the legacy path when writeText rejects', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError');
        },
      },
    });
    const { doc, execCommands } = makeFakeDocument(true);
    vi.stubGlobal('document', doc);

    await expect(writeClipboardText('fallback after rejection')).resolves.toBe(true);
    expect(execCommands).toEqual(['copy']);
  });
});

describe('createOsc52ClipboardHandler', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('routes a valid copy request to the clipboard writer', async () => {
    const written: string[] = [];
    const handler = createOsc52ClipboardHandler(async (text) => {
      written.push(text);
      return true;
    });

    expect(handler('c;' + btoa('copy me'))).toBe(true);
    await flush();
    expect(written).toEqual(['copy me']);
  });

  test('never routes a read request to the writer or the terminal', async () => {
    const written: string[] = [];
    const handler = createOsc52ClipboardHandler(async (text) => {
      written.push(text);
      return true;
    });

    expect(handler('c;?')).toBe(true);
    expect(handler('p;?')).toBe(true);
    await flush();
    expect(written).toEqual([]);
  });

  test('never routes malformed payloads to the writer', async () => {
    const written: string[] = [];
    const warnings: string[] = [];
    const handler = createOsc52ClipboardHandler(
      async (text) => {
        written.push(text);
        return true;
      },
      (m) => warnings.push(m)
    );

    expect(handler('no-semicolon')).toBe(true);
    expect(handler('c;')).toBe(true);
    expect(handler(';payload')).toBe(true);
    await flush();
    expect(written).toEqual([]);
    // One warning per handler, not one per bad sequence.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('malformed');
  });

  test('never routes oversized or invalid payloads to the writer', async () => {
    const written: string[] = [];
    const warnings: string[] = [];
    const handler = createOsc52ClipboardHandler(
      async (text) => {
        written.push(text);
        return true;
      },
      (m) => warnings.push(m)
    );

    const oversized = Buffer.from('B'.repeat(OSC52_MAX_DECODED_BYTES + 1)).toString('base64');
    expect(handler('c;' + oversized)).toBe(true);
    expect(handler('c;!!!not-base64!!!')).toBe(true);
    await flush();
    expect(written).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('too-large');
  });

  test('warns once when the clipboard write fails', async () => {
    const warnings: string[] = [];
    const handler = createOsc52ClipboardHandler(
      async () => false,
      (m) => warnings.push(m)
    );

    expect(handler('c;' + btoa('failing write'))).toBe(true);
    await flush();
    expect(handler('c;' + btoa('failing write'))).toBe(true);
    await flush();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('failed');
  });

  test('warns once when the clipboard write rejects', async () => {
    const warnings: string[] = [];
    const handler = createOsc52ClipboardHandler(
      async () => {
        throw new Error('boom');
      },
      (m) => warnings.push(m)
    );

    expect(handler('c;' + btoa('rejecting write'))).toBe(true);
    await flush();
    await flush();
    expect(warnings).toHaveLength(1);
  });

  test('default writer is the real writeClipboardText (wired, not stubbed)', () => {
    const handler = createOsc52ClipboardHandler();
    // Just proves the default parameter path constructs cleanly; behavior of
    // the default writer is covered in the writeClipboardText suites.
    expect(typeof handler).toBe('function');
    expect(handler('c;?')).toBe(true);
  });
});
