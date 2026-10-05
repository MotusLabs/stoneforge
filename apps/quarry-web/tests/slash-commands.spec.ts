import { test, expect } from '@playwright/test';
import { enterDocumentEditMode } from './helpers/document-edit';

test.describe('TB55: Slash Commands', () => {

  // ============================================================================
  // Basic Slash Command Menu Tests
  // ============================================================================

  // Regression (el-pdy082): DocumentSearchBar's global "/"-to-focus-search
  // listener used to preventDefault the "/" typed into the block editor (a
  // contenteditable div, not an input) and steal focus, so the slash-command
  // menu could never open on the documents page. This test creates its own
  // document so it never skips, and covers the editor half of the contract:
  // "/" in the editor opens the menu and the search input does not steal
  // focus. The other half — the shortcut still focusing search when pressed
  // outside any editable region — is covered by tb95-document-search.spec.ts
  // ("pressing / focuses the search input").
  test('typing "/" in the editor opens the menu even with the search bar mounted (regression: search bar must not steal "/")', async ({ page }) => {
    // Create a fresh document via the API so this test never depends on
    // pre-existing data (and never silently skips).
    const librariesResponse = await page.request.get('/api/libraries');
    const libraries = await librariesResponse.json();
    let libraryId = libraries[0]?.id;
    if (!libraryId) {
      const created = await page.request.post('/api/libraries', {
        data: { name: `Slash Regression Library ${Date.now()}`, createdBy: 'test-user' },
      });
      const lib = await created.json();
      libraryId = lib.id;
    }
    const docResponse = await page.request.post('/api/documents', {
      data: {
        title: `Slash Regression ${Date.now()}`,
        content: '',
        contentType: 'markdown',
        createdBy: 'test-user',
        libraryId,
      },
    });
    expect(docResponse.ok()).toBe(true);
    const doc = await docResponse.json();

    await page.goto(`/documents?library=${libraryId}&selected=${doc.id}`);
    await expect(page.getByTestId('document-detail-panel')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('document-edit-button').click();
    await expect(page.getByTestId('block-editor')).toBeVisible({ timeout: 10000 });

    // The search bar is mounted in the library tree; "/" in the editor must
    // reach the editor, not focus the search input.
    const searchInput = page.getByTestId('document-search-input');
    await expect(searchInput).toBeVisible();

    const editor = page.getByTestId('block-editor-content');
    await editor.click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu'), { timeout: 5000 }).toBeVisible();
    await expect(searchInput).not.toBeFocused();

    // Cleanup: leave edit mode without saving the "/" text.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('slash-command-menu')).not.toBeVisible();
  });

  test('typing "/" opens slash command menu', async ({ page }) => {
    await enterDocumentEditMode(page);

    // Focus the editor and type /
    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    // Slash command menu should appear
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });
  });

  test('slash command menu shows categories', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Check for category sections
    await expect(page.getByTestId('slash-command-category-headings')).toBeVisible();
    await expect(page.getByTestId('slash-command-category-lists')).toBeVisible();
    await expect(page.getByTestId('slash-command-category-blocks')).toBeVisible();
  });

  test('slash command menu shows command items', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Check for specific command items
    await expect(page.getByTestId('slash-command-item-heading1')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-heading2')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-heading3')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-bullet')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-numbered')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-quote')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-code')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-divider')).toBeVisible();
  });

  // ============================================================================
  // Fuzzy Search Tests
  // ============================================================================

  test('typing after "/" filters commands', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/head');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Should show heading commands
    await expect(page.getByTestId('slash-command-item-heading1')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-heading2')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-heading3')).toBeVisible();

    // Should NOT show bullet list
    await expect(page.getByTestId('slash-command-item-bullet')).not.toBeVisible();
  });

  test('typing "/bul" shows only bullet list', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/bul');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Should show bullet list
    await expect(page.getByTestId('slash-command-item-bullet')).toBeVisible();

    // Should NOT show headings
    await expect(page.getByTestId('slash-command-item-heading1')).not.toBeVisible();
  });

  test('typing non-matching text shows "No matching commands"', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/xyznonexistent');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Should show no matching commands message
    const menuText = await page.getByTestId('slash-command-menu').textContent();
    expect(menuText).toContain('No matching commands');
  });

  // ============================================================================
  // Keyboard Navigation Tests
  // ============================================================================

  test('arrow down moves selection to next item', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // First item should be selected (has blue background)
    const firstItem = page.getByTestId('slash-command-item-heading1');
    await expect(firstItem).toHaveClass(/bg-blue-50/);

    // Press down arrow
    await page.keyboard.press('ArrowDown');

    // Second item should now be selected
    const secondItem = page.getByTestId('slash-command-item-heading2');
    await expect(secondItem).toHaveClass(/bg-blue-50/);
    await expect(firstItem).not.toHaveClass(/bg-blue-50/);
  });

  test('arrow up moves selection to previous item', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Move down first
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');

    // Third item should be selected
    const thirdItem = page.getByTestId('slash-command-item-heading3');
    await expect(thirdItem).toHaveClass(/bg-blue-50/);

    // Press up arrow
    await page.keyboard.press('ArrowUp');

    // Second item should now be selected
    const secondItem = page.getByTestId('slash-command-item-heading2');
    await expect(secondItem).toHaveClass(/bg-blue-50/);
  });

  test('pressing Escape closes menu', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Press escape
    await page.keyboard.press('Escape');

    // Menu should be hidden
    await expect(page.getByTestId('slash-command-menu')).not.toBeVisible();
  });

  // ============================================================================
  // Command Execution Tests
  // ============================================================================

  test('pressing Enter executes selected command', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Press Enter to select Heading 1 (first item)
    await page.keyboard.press('Enter');

    // Menu should close
    await expect(page.getByTestId('slash-command-menu')).not.toBeVisible();

    // Check that heading 1 was inserted (h1 element in content)
    const h1Element = page.locator('[data-testid="block-editor-content"] h1');
    await expect(h1Element).toBeVisible({ timeout: 2000 });
  });

  test('clicking command item executes command', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Navigate to Heading 2 with hover first (to ensure correct selection), then click
    const heading2Item = page.getByTestId('slash-command-item-heading2');
    await heading2Item.hover();
    await page.waitForTimeout(100); // Small delay to ensure hover state updates
    await heading2Item.click();

    // Menu should close
    await expect(page.getByTestId('slash-command-menu')).not.toBeVisible({ timeout: 3000 });

    // Check that heading 2 was inserted
    const h2Element = page.locator('[data-testid="block-editor-content"] h2');
    await expect(h2Element).toBeVisible({ timeout: 3000 });
  });

  test('/bullet inserts bullet list', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/bul');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Select bullet list
    await page.keyboard.press('Enter');

    // Check that ul was inserted
    const ulElement = page.locator('[data-testid="block-editor-content"] ul');
    await expect(ulElement).toBeVisible({ timeout: 2000 });
  });

  test('/numbered inserts ordered list', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/num');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Select numbered list
    await page.keyboard.press('Enter');

    // Check that ol was inserted
    const olElement = page.locator('[data-testid="block-editor-content"] ol');
    await expect(olElement).toBeVisible({ timeout: 2000 });
  });

  test('/quote inserts blockquote', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/quo');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Select quote
    await page.keyboard.press('Enter');

    // Check that blockquote was inserted
    const blockquoteElement = page.locator('[data-testid="block-editor-content"] blockquote');
    await expect(blockquoteElement).toBeVisible({ timeout: 2000 });
  });

  test('/code inserts code block', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/code');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Select code block
    await page.keyboard.press('Enter');

    // Check that pre/code was inserted
    const codeBlockElement = page.locator('[data-testid="block-editor-content"] pre');
    await expect(codeBlockElement).toBeVisible({ timeout: 2000 });
  });

  test('/divider inserts horizontal rule', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/div');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Select divider
    await page.keyboard.press('Enter');

    // Check that hr was inserted
    const hrElement = page.locator('[data-testid="block-editor-content"] hr');
    await expect(hrElement).toBeVisible({ timeout: 2000 });
  });

  // ============================================================================
  // Mouse Hover Selection Tests
  // ============================================================================

  test('hovering over item changes selection', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // First item is selected
    const firstItem = page.getByTestId('slash-command-item-heading1');
    await expect(firstItem).toHaveClass(/bg-blue-50/);

    // Hover over another item
    const quoteItem = page.getByTestId('slash-command-item-quote');
    await quoteItem.hover();

    // Quote item should now be selected
    await expect(quoteItem).toHaveClass(/bg-blue-50/);
    await expect(firstItem).not.toHaveClass(/bg-blue-50/);
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  test('slash command works after text', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('Some text ');
    await page.keyboard.type('/');

    // Menu should still appear
    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });
  });

  test('embeds category shows task and document options', async ({ page }) => {
    await enterDocumentEditMode(page);

    await page.getByTestId('block-editor-content').click();
    await page.keyboard.type('/');

    await expect(page.getByTestId('slash-command-menu')).toBeVisible({ timeout: 3000 });

    // Check for embeds category
    await expect(page.getByTestId('slash-command-category-embeds')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-task')).toBeVisible();
    await expect(page.getByTestId('slash-command-item-doc')).toBeVisible();
  });
});
