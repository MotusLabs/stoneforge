/**
 * Shared fixture helpers for browser specs that drive the document detail
 * panel and editor (toolbar-polish, inline-formatting, inline-embeds,
 * slash-commands, drag-drop-blocks, tb94c-2-drag-drop-markdown,
 * block-editor, document-versions, document-display).
 *
 * The API contract these specs kept getting wrong (el-kh2yfo — six
 * byte-identical local copies of `enterDocumentEditMode` all died at
 * `documents[0].id` before any UI was exercised):
 *
 * - GET /api/documents answers with the paginated envelope
 *   {items, total, offset, limit, hasMore} (packages/shared-routes/src/
 *   documents.ts -> api.listPaginated), NOT a bare array. On the raw body,
 *   `documents.length` is undefined, so an `if (documents.length === 0)`
 *   guard NEVER fires and `documents[0].id` throws a TypeError. Unwrap
 *   `.items` before indexing — never trust `?? []` without asserting the
 *   envelope shape, or the coverage disappears silently.
 * - GET /api/libraries and GET /api/libraries/:id/documents answer with
 *   bare arrays (packages/shared-routes/src/libraries.ts) — the opposite
 *   convention. They still go through the fail-loud helpers below so an
 *   error body never flows into UI navigation.
 * - GET /api/documents/:id returns the bare document object.
 * - POST /api/documents requires `createdBy` (any non-empty string passes
 *   route validation; el-0000 is the operator entity that
 *   tests/global-setup.ts seeds before the server starts) and accepts an
 *   optional `libraryId` to file the document in a library.
 * - PATCH rejects content updates on immutable documents. The only document
 *   a fresh test DB guarantees is global-setup's immutable MESSAGE_CONTENT
 *   seed, so editor/PATCH fixtures must select a non-immutable document
 *   (findEditableDocument) or create their own.
 * - /documents accepts ?selected=<id> URL state: the detail panel opens
 *   directly, regardless of which library owns the document or where it
 *   sits in the virtualized list. Editor specs navigate this way instead of
 *   clicking list items (see the regression test in slash-commands.spec.ts
 *   for the same pattern).
 *
 * Fixtures seed rather than skip: an empty documents list in the shared test
 * DB means setup broke (global-setup seeds one document), and a skip would
 * hide that. Every helper asserts what it fetches or creates, so a broken
 * request fails red with the response body in the message (el-49ra:
 * browser-test fixtures must fail red, not skip).
 */

import { expect, type Page } from '@playwright/test';

/** The subset of a document element these fixtures read. */
export interface FixtureDocument {
  id: string;
  title?: string;
  content?: string;
  contentType?: string;
  version?: number;
  immutable?: boolean;
}

/** The subset of a library element these fixtures read. */
export interface FixtureLibrary {
  id: string;
  name: string;
  parentId: string | null;
}

/**
 * GET a JSON API route, failing loud on any HTTP error with the response
 * body in the failure message.
 *
 * This is the shared unwrap primitive el-4bjca5 is extracting for the
 * ListResult envelope class (el-119bz5, el-3etj44, el-3duiut, el-1tgx9y,
 * el-kh2yfo): fail-loud status assert + `Array.isArray(body.items)` shape
 * assert. If that primitive lands, adopt/move this instead of forking a
 * fourth shape.
 */
export async function getApiJson(page: Page, path: string): Promise<unknown> {
  const response = await page.request.get(path);
  const body = await response.json().catch(() => null);
  expect(
    response.ok(),
    `GET ${path} failed (${response.status()}): ${JSON.stringify(body)}`
  ).toBe(true);
  return body;
}

/**
 * Unwrap a ListResult envelope ({items, total, offset, limit, hasMore}) to
 * its items, failing loud if the endpoint stops answering with the envelope.
 */
export function envelopeItems(path: string, body: unknown): unknown[] {
  expect(
    Array.isArray((body as { items?: unknown[] })?.items),
    `GET ${path} did not return the paginated envelope {items, ...}: ${JSON.stringify(body)?.slice(0, 300)}`
  ).toBe(true);
  return (body as { items: unknown[] }).items;
}

/** Unwrap an endpoint that answers with a bare array (libraries routes). */
function bareArray(path: string, body: unknown): unknown[] {
  expect(
    Array.isArray(body),
    `GET ${path} did not return an array: ${JSON.stringify(body)?.slice(0, 300)}`
  ).toBe(true);
  return body;
}

/** Unique-enough title for parallel workers seeding fixtures concurrently. */
function fixtureTitle(prefix: string): string {
  return `e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** GET /api/documents, unwrapped from the paginated envelope to its items. */
export async function listDocuments(
  page: Page,
  limit = 50
): Promise<FixtureDocument[]> {
  const path = `/api/documents?limit=${limit}`;
  return envelopeItems(path, await getApiJson(page, path)) as FixtureDocument[];
}

/** GET /api/libraries — bare array, not the envelope. */
export async function listLibraries(page: Page): Promise<FixtureLibrary[]> {
  const path = '/api/libraries';
  return bareArray(path, await getApiJson(page, path)) as FixtureLibrary[];
}

/** GET /api/libraries/:id/documents — bare array, not the envelope. */
export async function listLibraryDocuments(
  page: Page,
  libraryId: string
): Promise<FixtureDocument[]> {
  const path = `/api/libraries/${libraryId}/documents`;
  return bareArray(path, await getApiJson(page, path)) as FixtureDocument[];
}

/**
 * Create a document via POST /api/documents and assert the create. The
 * caller owns the fixture; `options.contentType`/`options.content` control
 * the editor flavor (defaults: text, empty).
 */
export async function createDocumentFixture(
  page: Page,
  title: string,
  options: { contentType?: string; content?: string } = {}
): Promise<FixtureDocument> {
  const response = await page.request.post('/api/documents', {
    data: {
      title,
      createdBy: 'el-0000',
      contentType: options.contentType ?? 'text',
      content: options.content ?? '',
    },
  });
  const body = await response.json().catch(() => null);
  expect(
    response.status(),
    `POST /api/documents failed for fixture "${title}": ${JSON.stringify(body)}`
  ).toBe(201);
  expect(body?.id, `created document "${title}" must have an id`).toBeDefined();
  return body;
}

/**
 * The `documents[0]` replacement for read-only fixtures: the first document
 * of the default (updated_at desc) listing, seeding one when the list is
 * empty instead of skipping — global-setup guarantees at least one document,
 * so an empty list means setup broke and must not be papered over with a
 * skip.
 */
export async function getOrCreateFirstDocument(
  page: Page
): Promise<FixtureDocument> {
  const documents = await listDocuments(page);
  return documents[0] ?? createDocumentFixture(page, fixtureTitle('document'));
}

/**
 * The newest editable (non-immutable) document, seeding one when none of the
 * newest documents is editable. Editor and PATCH fixtures must use this:
 * PATCH rejects content updates on immutable documents, and the immutable
 * MESSAGE_CONTENT documents created by every sent message tend to dominate
 * the newest-documents window.
 */
export async function findEditableDocument(
  page: Page
): Promise<FixtureDocument> {
  const documents = await listDocuments(page);
  const editable = documents.find((doc) => !doc.immutable);
  return editable ?? createDocumentFixture(page, fixtureTitle('editor'));
}

/**
 * Create a document that is guaranteed to have version history (created,
 * then content-PATCHed once), asserting the history exists. Replaces the
 * "find a document with version > 1, else skip" pattern, which silently
 * skipped whenever no document in the shared DB had been edited yet.
 */
export async function createVersionedDocumentFixture(
  page: Page
): Promise<FixtureDocument> {
  const doc = await createDocumentFixture(page, fixtureTitle('versioned'), {
    content: 'version-history fixture, first revision',
  });
  const response = await page.request.patch(`/api/documents/${doc.id}`, {
    data: { content: 'version-history fixture, second revision' },
  });
  const body = await response.json().catch(() => null);
  expect(
    response.ok(),
    `PATCH /api/documents/${doc.id} failed while building a version-history fixture: ${JSON.stringify(body)}`
  ).toBe(true);
  expect(
    Number(body?.version ?? 0),
    'version-history fixture must be at version >= 2 after one content edit'
  ).toBeGreaterThanOrEqual(2);
  return { ...doc, ...body };
}

/**
 * Open the document detail panel for `docId` (resolved with
 * getOrCreateFirstDocument when omitted) via /documents?selected=<id>.
 *
 * Navigating by URL state instead of clicking a list item keeps editor
 * suites independent of the virtualized list's scroll position; the
 * list-click interaction itself is covered by document-display.spec.ts.
 */
export async function openDocumentDetail(
  page: Page,
  docId?: string
): Promise<string> {
  const id = docId ?? (await getOrCreateFirstDocument(page)).id;
  await page.goto(`/documents?selected=${id}`);
  // Generous timeouts: under a fully-parallel run the vite dev server's
  // first on-demand transform of the documents route can take a while.
  await expect(page.getByTestId('documents-page')).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByTestId('document-detail-panel')).toBeVisible({
    timeout: 10000,
  });
  return id;
}

/**
 * Navigate into a document's edit mode and return the document's id. Shared
 * by the six editor suites (previously six byte-identical local copies that
 * all died at `documents[0].id`). Never returns null and never skips: the
 * target document is resolved (or seeded) up front and every step asserts,
 * so a broken fixture fails red at the cause.
 */
export async function enterDocumentEditMode(page: Page): Promise<string> {
  const document = await findEditableDocument(page);
  await openDocumentDetail(page, document.id);
  await page.getByTestId('document-edit-button').click();
  await expect(page.getByTestId('block-editor')).toBeVisible({
    timeout: 10000,
  });
  return document.id;
}
