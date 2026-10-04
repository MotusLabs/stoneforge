/**
 * Browser tests for OSC 52 clipboard copy in the web terminal
 * (openspec change: web-terminal-osc52-clipboard).
 *
 * Mounting strategy: the /popout/terminal route renders a bare <XTerminal>
 * (no AppShell) and tolerates a nonexistent agent when ?name= is given, so
 * these tests never touch the director-panel/workspace selectors that
 * el-55jl50 is currently refreshing.
 *
 * The page's WebSocket is replaced with a recording stub before app load.
 * That keeps the terminal view empty (no connection-error text) and lets the
 * read-request test assert that no `input` frame ever reaches the PTY —
 * while a recorded `subscribe` frame proves the capture path itself works.
 */

import { test, expect, type Page } from '@playwright/test';

/** ST and BEL OSC terminators. */
const ST = '\x1b\\';
const BEL = '\x07';

/** Grant clipboard access so assertions can read/write the real clipboard. */
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** Base64-encode UTF-8 text the way an OSC 52 emitter would. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Install a WebSocket stub that records every frame sent by the app. */
async function stubWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CONNECTING = 0;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = 1; // OPEN — so the terminal's send() path is live
      onopen: ((ev?: unknown) => void) | null = null;
      onmessage: ((ev?: unknown) => void) | null = null;
      onclose: ((ev?: unknown) => void) | null = null;
      onerror: ((ev?: unknown) => void) | null = null;
      constructor(url: string) {
        this.url = url;
        // Fire onopen on the next tick, after the app has assigned its
        // handlers — the real terminal's subscribe frame is what proves
        // this stub captures everything the app sends.
        setTimeout(() => this.onopen?.(), 0);
      }
      send(data: string): void {
        (window as unknown as { __wsFrames: string[] }).__wsFrames.push(String(data));
      }
      close(): void {
        this.readyState = 3;
      }
      addEventListener(): void {
        /* no-op */
      }
      removeEventListener(): void {
        /* no-op */
      }
    }
    (window as unknown as { __wsFrames: string[] }).__wsFrames = [];
    (window as unknown as Record<string, unknown>).WebSocket = FakeWebSocket;
  });
}

/** Open the popout terminal and wait for the XTerminal test hook. */
async function openTerminal(page: Page, extraParams = ''): Promise<void> {
  await page.goto(
    `/popout/terminal?agent=osc52-probe&name=osc52-probe&type=terminal${extraParams}`
  );
  await page.waitForFunction(
    () => typeof (window as unknown as { __xterminal?: { write: unknown } }).__xterminal?.write === 'function',
    undefined,
    { timeout: 15_000 }
  );
}

/** Write an OSC 52 sequence into the terminal's parser. */
async function emitOsc52(page: Page, target: string, payload: string, terminator: string): Promise<void> {
  await page.evaluate(
    ({ seq }) => {
      (window as unknown as { __xterminal: { write: (d: string) => void } }).__xterminal.write(seq);
    },
    { seq: `\x1b]52;${target};${payload}${terminator}` }
  );
}

/** Place a sentinel on the clipboard so "unchanged" assertions are meaningful. */
async function setClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('Web terminal OSC 52 clipboard', () => {
  test.beforeEach(async ({ page }) => {
    await stubWebSocket(page);
  });

  test.describe('copy requests', () => {
    test('copies an ST-terminated payload to the system clipboard', async ({ page }) => {
      await openTerminal(page);
      await setClipboard(page, 'sentinel-st');

      await emitOsc52(page, 'c', b64('Hello, OSC 52!'), ST);

      await expect.poll(() => readClipboard(page)).toBe('Hello, OSC 52!');
    });

    test('preserves multi-byte UTF-8 selections exactly', async ({ page }) => {
      await openTerminal(page);
      const selection = 'héllo wörld — 日本語 ✓ 🚀 👨‍👩‍👧‍👦';
      await setClipboard(page, 'sentinel-utf8');

      await emitOsc52(page, 'c', b64(selection), ST);

      await expect.poll(() => readClipboard(page)).toBe(selection);
    });

    test('accepts a BEL terminator', async ({ page }) => {
      await openTerminal(page);
      await setClipboard(page, 'sentinel-bel');

      await emitOsc52(page, 'c', b64('BEL terminated'), BEL);

      await expect.poll(() => readClipboard(page)).toBe('BEL terminated');
    });

    test('writes primary-selection (p) targets to the system clipboard', async ({ page }) => {
      await openTerminal(page);
      await setClipboard(page, 'sentinel-primary');

      await emitOsc52(page, 'p', b64('primary selection'), ST);

      await expect.poll(() => readClipboard(page)).toBe('primary selection');
    });

    test('re-registers the handler after a page reload', async ({ page }) => {
      await openTerminal(page);
      await setClipboard(page, 'sentinel-reload');

      await page.reload();
      await openTerminal(page);
      await emitOsc52(page, 'c', b64('after reload'), ST);

      await expect.poll(() => readClipboard(page)).toBe('after reload');
    });
  });

  test.describe('guardrails', () => {
    test('ignores oversized payloads and stays responsive', async ({ page }) => {
      await openTerminal(page);
      await setClipboard(page, 'sentinel-oversize');

      // Decoded size is 100,001 bytes — one over the cap.
      const oversized = b64('A'.repeat(100_001));
      await emitOsc52(page, 'c', oversized, ST);
      await page.waitForTimeout(300);

      expect(await readClipboard(page)).toBe('sentinel-oversize');

      // The handler is still alive: a follow-up valid copy lands.
      await emitOsc52(page, 'c', b64('still responsive'), BEL);
      await expect.poll(() => readClipboard(page)).toBe('still responsive');
    });

    test('ignores clipboard read requests without sending PTY input', async ({ page }) => {
      await openTerminal(page);
      await setClipboard(page, 'sentinel-read');

      await emitOsc52(page, 'c', '?', ST);
      await emitOsc52(page, 'p', '?', BEL);
      await page.waitForTimeout(300);

      // Clipboard untouched...
      expect(await readClipboard(page)).toBe('sentinel-read');

      // ...and no input frame ever reached the PTY. The subscribe frame
      // proves the stub actually captures what the terminal sends.
      const frames = await page.evaluate(
        () => (window as unknown as { __wsFrames: string[] }).__wsFrames
      );
      expect(frames.some((f) => f.includes('"subscribe"'))).toBeTruthy();
      const inputFrames = frames
        .map((f) => {
          try {
            return JSON.parse(f) as { type?: string };
          } catch {
            return null;
          }
        })
        .filter((m) => m?.type === 'input');
      expect(inputFrames).toHaveLength(0);
    });

    test('ignores invalid base64 silently with a console warning', async ({ page }) => {
      const warnings: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'warning') warnings.push(msg.text());
      });

      await openTerminal(page);
      await setClipboard(page, 'sentinel-invalid');

      const textBefore = await page.evaluate(() =>
        document.querySelector('.xterm-screen')?.textContent ?? ''
      );

      await emitOsc52(page, 'c', '!!!not-base64!!!', ST);
      await page.waitForTimeout(300);

      expect(await readClipboard(page)).toBe('sentinel-invalid');
      // No error text appears in the terminal view.
      const textAfter = await page.evaluate(() =>
        document.querySelector('.xterm-screen')?.textContent ?? ''
      );
      expect(textAfter).toBe(textBefore);
      // The failure is surfaced non-intrusively instead.
      expect(warnings.some((w) => w.includes('OSC 52'))).toBeTruthy();
    });

    test('skips clipboard writes when OSC 52 copy is disabled', async ({ page }) => {
      await openTerminal(page, '&osc52=0');
      await setClipboard(page, 'sentinel-disabled');

      await emitOsc52(page, 'c', b64('must not copy'), ST);
      await emitOsc52(page, 'c', b64('must not copy'), BEL);
      await page.waitForTimeout(300);

      expect(await readClipboard(page)).toBe('sentinel-disabled');
    });
  });
});
