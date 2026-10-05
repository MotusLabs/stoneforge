import { test, expect, type Page } from '@playwright/test';
import {
  listDocuments,
  listLibraries,
  listLibraryDocuments,
  getOrCreateFirstDocument,
  createDocumentFixture,
} from './helpers/document-edit';

// Navigate to /documents and click a specific document in the all-documents
// view (the default main content, whether or not libraries exist — it lists
// every document). `target` should be recently created/updated so it sits at
// the top of the updatedAt-desc list and is visible in the virtualized list.
async function openDocumentByListClick(page: Page, targetId: string) {
  await page.goto('/documents');
  await expect(page.getByTestId('documents-page')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('all-documents-view')).toBeVisible({ timeout: 5000 });
  await page.getByTestId(`document-item-${targetId}`).click();
  await expect(page.getByTestId('document-detail-panel')).toBeVisible({ timeout: 5000 });
}

test.describe('TB21: Document Display', () => {
  // ============================================================================
  // API Endpoint Tests
  // ============================================================================

  test('GET /api/documents/:id endpoint returns a document', async ({ page }) => {
    const doc = await getOrCreateFirstDocument(page);

    // Get a single document
    const response = await page.request.get(`/api/documents/${doc.id}`);
    expect(response.ok()).toBe(true);
    const document = await response.json();

    expect(document.id).toBe(doc.id);
    expect(document.type).toBe('document');
    expect(document.contentType).toBeDefined();
    expect(document.createdAt).toBeDefined();
    expect(document.updatedAt).toBeDefined();
  });

  test('GET /api/documents/:id returns 404 for invalid ID', async ({ page }) => {
    const response = await page.request.get('/api/documents/el-invalid999999');
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('GET /api/documents returns documents with required fields', async ({ page }) => {
    // Guarantee at least one document exists so the field loop below is real
    // coverage, not a vacuous pass over an empty list.
    await getOrCreateFirstDocument(page);

    const documents = await listDocuments(page);
    expect(documents.length).toBeGreaterThan(0);

    // Check each document has required fields
    for (const doc of documents) {
      expect(doc.type).toBe('document');
      expect(doc.contentType).toBeDefined();
      expect(['text', 'markdown', 'json']).toContain(doc.contentType);
      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
      expect(doc.createdBy).toBeDefined();
    }
  });

  // ============================================================================
  // UI Tests - Document Selection
  // ============================================================================

  test('clicking a document opens the detail panel', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Detail panel should appear (asserted by the helper)
    await expect(page.getByTestId('document-detail-panel')).toBeVisible();
  });

  test('document detail panel shows document title', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Check title is displayed
    await expect(page.getByTestId('document-detail-title')).toBeVisible();
    const title = targetDoc.title || `Document ${targetDoc.id}`;
    await expect(page.getByTestId('document-detail-title')).toContainText(title);
  });

  test('document detail panel shows content type badge', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Check content type badge is displayed
    await expect(page.getByTestId('document-detail-type')).toBeVisible();
    const contentTypeMap: Record<string, string> = {
      text: 'Plain Text',
      markdown: 'Markdown',
      json: 'JSON',
    };
    await expect(page.getByTestId('document-detail-type')).toContainText(
      contentTypeMap[targetDoc.contentType || 'text'] || 'Plain Text'
    );
  });

  test('document detail panel shows document ID', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Check document ID is displayed
    await expect(page.getByTestId('document-detail-id')).toBeVisible();
    await expect(page.getByTestId('document-detail-id')).toContainText(targetDoc.id);
  });

  test('document detail panel close button works', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Click close button
    await page.getByTestId('document-detail-close').click();

    // Panel should close
    await expect(page.getByTestId('document-detail-panel')).not.toBeVisible({ timeout: 5000 });
  });

  test('document content is displayed', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Check that content area exists
    await expect(page.getByTestId('document-content')).toBeVisible();
  });

  test('selected document shows selection state in list', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);
    await openDocumentByListClick(page, targetDoc.id);

    // Check that the selected item has the selected style (blue background)
    const docItem = page.getByTestId(`document-item-${targetDoc.id}`);
    await expect(docItem).toHaveClass(/bg-blue-50/);
  });

  // ============================================================================
  // Content Type Rendering Tests
  // ============================================================================

  test('text content renders correctly', async ({ page }) => {
    // Create the fixture instead of hunting for a text document (and
    // skipping when the shared DB happens to have none).
    const textDoc = await createDocumentFixture(
      page,
      `e2e-text-render-${Date.now()}`,
      { content: 'Plain text fixture content' }
    );
    await openDocumentByListClick(page, textDoc.id);

    // DocumentRenderer has no `document-content-text` testid: contentType
    // 'text' falls through to the markdown renderer branch
    // (apps/quarry-web/src/routes/documents/components/DocumentRenderer.tsx),
    // so plain text renders inside `document-content-markdown`.
    const rendered = page.getByTestId('document-content-markdown');
    await expect(rendered).toBeVisible();
    await expect(rendered).toContainText('Plain text fixture content');
  });

  test('markdown content renders correctly', async ({ page }) => {
    const markdownDoc = await createDocumentFixture(
      page,
      `e2e-markdown-render-${Date.now()}`,
      { contentType: 'markdown', content: '# Heading\n\nSome **bold** text' }
    );
    await openDocumentByListClick(page, markdownDoc.id);

    await expect(page.getByTestId('document-content-markdown')).toBeVisible();
  });

  test('json content renders correctly', async ({ page }) => {
    const jsonDoc = await createDocumentFixture(
      page,
      `e2e-json-render-${Date.now()}`,
      { contentType: 'json', content: '{"fixture": true}' }
    );
    await openDocumentByListClick(page, jsonDoc.id);

    await expect(page.getByTestId('document-content-json')).toBeVisible();
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================

  test('document detail panel handles loading state', async ({ page }) => {
    const targetDoc = await getOrCreateFirstDocument(page);

    await page.goto('/documents');
    await expect(page.getByTestId('documents-page')).toBeVisible({ timeout: 10000 });
    await page.getByTestId(`document-item-${targetDoc.id}`).click();

    // Either loading or panel should be visible
    const loading = page.getByTestId('document-detail-loading');
    const panel = page.getByTestId('document-detail-panel');
    await expect(loading.or(panel)).toBeVisible({ timeout: 5000 });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  test('changing library clears document selection', async ({ page }) => {
    const libraries = await listLibraries(page);

    if (libraries.length < 2) {
      test.skip();
      return;
    }

    // Find two libraries with documents
    const librariesWithDocs: { id: string; docs: { id: string }[] }[] = [];
    for (const library of libraries) {
      const docs = await listLibraryDocuments(page, library.id);
      if (docs.length > 0) {
        librariesWithDocs.push({ id: library.id, docs });
      }
      if (librariesWithDocs.length >= 2) break;
    }

    if (librariesWithDocs.length < 2) {
      test.skip();
      return;
    }

    await page.goto('/documents');
    await expect(page.getByTestId('documents-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('library-tree')).toBeVisible({ timeout: 5000 });

    // Select first library and document
    await page.getByTestId(`library-tree-item-${librariesWithDocs[0].id}`).click();
    await expect(page.getByTestId('library-view')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`document-item-${librariesWithDocs[0].docs[0].id}`).click();
    await expect(page.getByTestId('document-detail-panel')).toBeVisible({ timeout: 5000 });

    // Select second library
    await page.getByTestId(`library-tree-item-${librariesWithDocs[1].id}`).click();

    // Document panel should close (selection cleared)
    await expect(page.getByTestId('document-detail-panel')).not.toBeVisible({ timeout: 5000 });
  });

  test('documents page is navigable via sidebar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-page')).toBeVisible({ timeout: 10000 });

    // Click on Documents in sidebar
    await page.getByTestId('nav-documents').click();

    // Should navigate to documents page
    await expect(page.getByTestId('documents-page')).toBeVisible({ timeout: 5000 });
    expect(page.url()).toContain('/documents');
  });
});
