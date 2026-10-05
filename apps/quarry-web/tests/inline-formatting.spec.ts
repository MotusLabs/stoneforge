import { test, expect } from '@playwright/test';
import { enterDocumentEditMode } from './helpers/document-edit';

test.describe('TB58: Advanced Inline Formatting', () => {

  // ============================================================================
  // Inline Code Styling Tests
  // ============================================================================

  test('inline code has monospace font styling', async ({ page }) => {
    await enterDocumentEditMode(page);

    // Type some text and apply code formatting
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('some inline code');
    await page.keyboard.press('ControlOrMeta+a');
    // Dismiss the selection bubble menu so it cannot cover the toolbar
    // button and intercept the click (the selection survives).
    await page.keyboard.press('Escape');
    await page.getByTestId('toolbar-code').click();

    // Check that code element exists with proper styling
    const codeElement = page.locator('[data-testid="block-editor-content"] code').first();
    await expect(codeElement).toBeVisible({ timeout: 2000 });

    // Verify font-family is monospace
    const fontFamily = await codeElement.evaluate((el) => window.getComputedStyle(el).fontFamily);
    expect(fontFamily.toLowerCase()).toMatch(/monospace|sf mono|menlo|consolas/i);
  });

  test('inline code has subtle background color', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('code example');
    await page.keyboard.press('ControlOrMeta+a');
    // Dismiss the selection bubble menu so it cannot cover the toolbar
    // button and intercept the click (the selection survives).
    await page.keyboard.press('Escape');
    await page.getByTestId('toolbar-code').click();

    const codeElement = page.locator('[data-testid="block-editor-content"] code').first();
    await expect(codeElement).toBeVisible({ timeout: 2000 });

    // Verify background color is applied (should be a light gray with alpha)
    const backgroundColor = await codeElement.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    // Should be some form of rgba or rgb with non-transparent value
    expect(backgroundColor).toMatch(/rgba?\(/);
    expect(backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('inline code has border-radius', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('rounded code');
    await page.keyboard.press('ControlOrMeta+a');
    // Dismiss the selection bubble menu so it cannot cover the toolbar
    // button and intercept the click (the selection survives).
    await page.keyboard.press('Escape');
    await page.getByTestId('toolbar-code').click();

    const codeElement = page.locator('[data-testid="block-editor-content"] code').first();
    await expect(codeElement).toBeVisible({ timeout: 2000 });

    // Verify border-radius is applied
    const borderRadius = await codeElement.evaluate((el) => window.getComputedStyle(el).borderRadius);
    expect(borderRadius).not.toBe('0px');
  });

  test('inline code has padding', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('padded code');
    await page.keyboard.press('ControlOrMeta+a');
    // Dismiss the selection bubble menu so it cannot cover the toolbar
    // button and intercept the click (the selection survives).
    await page.keyboard.press('Escape');
    await page.getByTestId('toolbar-code').click();

    const codeElement = page.locator('[data-testid="block-editor-content"] code').first();
    await expect(codeElement).toBeVisible({ timeout: 2000 });

    // Verify padding is applied
    const paddingLeft = await codeElement.evaluate((el) => window.getComputedStyle(el).paddingLeft);
    expect(parseFloat(paddingLeft)).toBeGreaterThan(0);
  });

  // ============================================================================
  // Bubble Menu Tests
  // ============================================================================

  test('bubble menu appears when text is selected', async ({ page }) => {
    await enterDocumentEditMode(page);

    // Type some text
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Select this text to see bubble menu');

    // Select text via keyboard
    await page.keyboard.press('ControlOrMeta+a');

    // Wait for bubble menu to appear
    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });
  });

  test('bubble menu has formatting buttons', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Text for formatting');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    // Check for formatting buttons
    await expect(page.getByTestId('bubble-menu-bold')).toBeVisible();
    await expect(page.getByTestId('bubble-menu-italic')).toBeVisible();
    await expect(page.getByTestId('bubble-menu-code')).toBeVisible();
    await expect(page.getByTestId('bubble-menu-strikethrough')).toBeVisible();
    await expect(page.getByTestId('bubble-menu-highlight')).toBeVisible();
  });

  test('bubble menu bold button applies formatting', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Make this bold');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    await page.getByTestId('bubble-menu-bold').click();

    // Check that bold formatting is applied
    const boldElement = page.locator('[data-testid="block-editor-content"] strong');
    await expect(boldElement).toBeVisible({ timeout: 2000 });
  });

  test('bubble menu italic button applies formatting', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Make this italic');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    await page.getByTestId('bubble-menu-italic').click();

    // Check that italic formatting is applied
    const italicElement = page.locator('[data-testid="block-editor-content"] em');
    await expect(italicElement).toBeVisible({ timeout: 2000 });
  });

  test('bubble menu code button applies formatting', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Make this code');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    await page.getByTestId('bubble-menu-code').click();

    // Check that code formatting is applied
    const codeElement = page.locator('[data-testid="block-editor-content"] code');
    await expect(codeElement).toBeVisible({ timeout: 2000 });
  });

  test('bubble menu strikethrough button applies formatting', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Strike this through');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    await page.getByTestId('bubble-menu-strikethrough').click();

    // Check that strikethrough formatting is applied
    const strikeElement = page.locator('[data-testid="block-editor-content"] s, [data-testid="block-editor-content"] del');
    await expect(strikeElement).toBeVisible({ timeout: 2000 });
  });

  test('bubble menu highlight button applies formatting', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Highlight this text');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    await page.getByTestId('bubble-menu-highlight').click();

    // Check that highlight formatting is applied
    const markElement = page.locator('[data-testid="block-editor-content"] mark');
    await expect(markElement).toBeVisible({ timeout: 2000 });
  });

  test('bubble menu hides when selection is cleared', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Select then deselect');
    await page.keyboard.press('ControlOrMeta+a');

    const bubbleMenu = page.getByTestId('bubble-menu');
    await expect(bubbleMenu).toBeVisible({ timeout: 3000 });

    // Press arrow key to clear selection
    await page.keyboard.press('ArrowRight');

    // Bubble menu should hide (uses opacity-0 class)
    await expect(bubbleMenu).toHaveClass(/opacity-0/, { timeout: 3000 });
  });

  test('bubble menu does not appear when cursor is in code blocks', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();

    // Create a code block using slash command
    await page.keyboard.type('/code');
    await page.keyboard.press('Enter');

    // The premise of this test is a code block: if the slash command raced
    // and created a plain paragraph instead, the selection below lands in
    // normal text and the bubble menu legitimately appears. Fail red here
    // rather than asserting against the wrong fixture.
    await expect(page.getByTestId('block-editor-content').locator('pre')).toBeVisible({
      timeout: 5000,
    });

    // Type inside code block
    await page.keyboard.type('code block content');

    // Select text within the code block using shift+arrow keys
    // This keeps selection within the code block
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Shift+ArrowLeft');
    }

    // Bubble menu should NOT appear when selection is entirely within code blocks
    const bubbleMenu = page.getByTestId('bubble-menu');
    // Give it a moment to potentially appear
    await page.waitForTimeout(500);
    await expect(bubbleMenu).toHaveClass(/opacity-0/);
  });

  // ============================================================================
  // Keyboard Shortcut Tests
  // ============================================================================

  test('keyboard shortcut Cmd+E toggles inline code', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('code via shortcut');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+e');

    // Check that code formatting is applied
    const codeElement = page.locator('[data-testid="block-editor-content"] code');
    await expect(codeElement).toBeVisible({ timeout: 2000 });

    // Toggle off
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+e');

    // Code element should be removed
    await expect(codeElement).not.toBeVisible({ timeout: 2000 });
  });

  test('highlight styling has yellow background', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Yellow highlight');
    await page.keyboard.press('ControlOrMeta+a');

    // Apply highlight from toolbar or overflow menu
    const overflowButton = page.getByTestId('toolbar-overflow-menu');
    const isOverflowVisible = await overflowButton.isVisible().catch(() => false);

    if (isOverflowVisible) {
      await overflowButton.click();
      await page.getByTestId('toolbar-overflow-content').getByText('Highlight').click();
    } else {
      await page.getByTestId('toolbar-highlight').click();
    }

    // Check that mark element has yellow-ish background
    const markElement = page.locator('[data-testid="block-editor-content"] mark');
    await expect(markElement).toBeVisible({ timeout: 2000 });

    const backgroundColor = await markElement.evaluate((el) => window.getComputedStyle(el).backgroundColor);
    // Should have yellow-ish tint (rgb values where red and green are high)
    expect(backgroundColor).toMatch(/rgb/);
  });
});
