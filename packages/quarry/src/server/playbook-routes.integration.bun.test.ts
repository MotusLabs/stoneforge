/**
 * Integration tests for the file-based playbook CRUD endpoints
 * (POST /api/playbooks, PATCH /api/playbooks/:name, DELETE /api/playbooks/:name)
 * in the Quarry server.
 *
 * Quarry playbooks are discovered from `.stoneforge/playbooks` and `playbooks/`
 * relative to the server's working directory, so the app is created inside a
 * temporary directory (with an in-memory database) to keep the tests hermetic.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuarryApp } from './index.js';
import type { QuarryApp } from './index.js';
import { discoverPlaybookFiles, loadPlaybookFromFile } from '@stoneforge/core';

let originalCwd: string;
let tempRoot: string;
let quarryApp: QuarryApp;

// The broadcaster is process-wide, so use one server/database for this suite.
beforeAll(async () => {
  originalCwd = process.cwd();
  tempRoot = mkdtempSync(join(tmpdir(), 'sf-playbook-routes-'));
  process.chdir(tempRoot);
  quarryApp = createQuarryApp({ dbPath: ':memory:' });
  await quarryApp.ready;
});

beforeEach(() => {
  rmSync(join(tempRoot, PRIMARY_PLAYBOOKS_DIR), { recursive: true, force: true });
  rmSync(join(tempRoot, 'playbooks'), { recursive: true, force: true });
});

afterAll(() => {
  quarryApp.autoExportService.stop();
  quarryApp.broadcaster.stop();
  quarryApp.storageBackend.close();
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(method: string, path: string, body?: unknown): Promise<Response> {
  return quarryApp.app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The payload WorkflowEditorModal sends through useCreatePlaybook */
function templatePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'release-checklist',
    title: 'Release Checklist',
    steps: [
      {
        id: 'review',
        title: 'Review the changelog',
        taskType: 'task',
        priority: 2,
        complexity: 2,
      },
      {
        id: 'tag',
        title: 'Tag the release',
        taskType: 'chore',
        priority: 2,
        dependsOn: ['review'],
      },
    ],
    variables: [
      {
        name: 'version',
        type: 'string',
        required: true,
        description: 'Version being released',
      },
    ],
    ...overrides,
  };
}

const PRIMARY_PLAYBOOKS_DIR = '.stoneforge/playbooks';
const PRIMARY_PLAYBOOK_PATH = `${PRIMARY_PLAYBOOKS_DIR}/release-checklist.playbook.yaml`;

// ---------------------------------------------------------------------------
// POST /api/playbooks
// ---------------------------------------------------------------------------

describe('POST /api/playbooks', () => {
  test('persists a playbook file and returns the { playbook } envelope', async () => {
    const res = await req('POST', '/api/playbooks', templatePayload());

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.playbook).toBeDefined();
    expect(body.playbook.name).toBe('release-checklist');
    // The playbook name is the stable identifier for file-based playbooks
    expect(body.playbook.id).toBe('release-checklist');
    expect(body.playbook.title).toBe('Release Checklist');
    expect(body.playbook.steps).toHaveLength(2);
    expect(body.playbook.filePath).toBe(join(tempRoot, PRIMARY_PLAYBOOK_PATH));

    // The YAML file exists on disk
    expect(existsSync(join(tempRoot, PRIMARY_PLAYBOOK_PATH))).toBe(true);
  });

  test('created template appears in the grid API and loads through the detail API', async () => {
    const created = await req('POST', '/api/playbooks', templatePayload());
    expect(created.status).toBe(201);
    const { playbook } = await created.json();

    const list = await req('GET', '/api/playbooks');
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.total).toBe(1);
    expect(body.playbooks).toHaveLength(1);
    expect(body.playbooks[0].id).toBe(playbook.id);
    expect(body.playbooks[0].title).toBe('Release Checklist');
    expect(body.playbooks[0].steps).toHaveLength(2);

    const detail = await req('GET', `/api/playbooks/${playbook.id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).playbook.steps).toHaveLength(2);
  });

  test('created file round-trips through loadPlaybookFromFile (instantiable)', async () => {
    await req('POST', '/api/playbooks', templatePayload());

    const input = loadPlaybookFromFile(
      join(tempRoot, PRIMARY_PLAYBOOK_PATH),
      'el-0000' as never
    );
    expect(input.name).toBe('release-checklist');
    expect(input.title).toBe('Release Checklist');
    expect(input.steps).toHaveLength(2);
    expect(input.steps[1].dependsOn).toEqual(['review']);
    expect(input.variables).toHaveLength(1);
    expect(input.variables[0].name).toBe('version');
  });

  test('can be instantiated through the UI playbook route', async () => {
    const created = await req('POST', '/api/playbooks', templatePayload());
    const { playbook } = await created.json();

    const res = await req('POST', `/api/playbooks/${playbook.id}/instantiate`, {
      variables: { version: '1.2.3' },
      createdBy: 'el-0000',
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.workflow).toBeDefined();
    expect(body.tasks).toHaveLength(2);
  });

  test('writes into the first existing search path', async () => {
    // Only the secondary `playbooks/` directory exists
    mkdirSync(join(tempRoot, 'playbooks'), { recursive: true });

    const res = await req('POST', '/api/playbooks', templatePayload());

    expect(res.status).toBe(201);
    expect(existsSync(join(tempRoot, 'playbooks/release-checklist.playbook.yaml'))).toBe(true);
    expect(existsSync(join(tempRoot, PRIMARY_PLAYBOOK_PATH))).toBe(false);
  });

  test('rejects a duplicate playbook name with 409', async () => {
    await req('POST', '/api/playbooks', templatePayload());

    const res = await req('POST', '/api/playbooks', templatePayload());

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_EXISTS');
  });

  test('rejects invalid payloads with 400', async () => {
    const missingName = await req('POST', '/api/playbooks', templatePayload({ name: undefined }));
    expect(missingName.status).toBe(400);

    const missingTitle = await req('POST', '/api/playbooks', templatePayload({ title: undefined }));
    expect(missingTitle.status).toBe(400);

    const badSteps = await req('POST', '/api/playbooks', templatePayload({ steps: 'nope' }));
    expect(badSteps.status).toBe(400);

    const badVariables = await req(
      'POST',
      '/api/playbooks',
      templatePayload({ variables: [{ name: 'x', type: 'tensor', required: false }] })
    );
    expect(badVariables.status).toBe(400);
  });

  test('rejects names that would escape the playbook directories', async () => {
    for (const name of ['../evil', 'has space', 'a/b']) {
      const res = await req('POST', '/api/playbooks', templatePayload({ name }));
      expect(res.status).toBe(400);
    }

    // Nothing was written anywhere
    const discovered = discoverPlaybookFiles(
      [join(tempRoot, PRIMARY_PLAYBOOKS_DIR), join(tempRoot, 'playbooks')],
      { recursive: true }
    );
    expect(discovered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/playbooks/:name
// ---------------------------------------------------------------------------

describe('PATCH /api/playbooks/:name', () => {
  test('rewrites the file in place and bumps the version', async () => {
    await req('POST', '/api/playbooks', templatePayload());

    const res = await req('PATCH', '/api/playbooks/release-checklist', {
      title: 'Release Checklist v2',
      steps: [{ id: 'review', title: 'Review the changelog again', taskType: 'task' }],
      variables: [],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playbook).toBeDefined();
    expect(body.playbook.title).toBe('Release Checklist v2');
    expect(body.playbook.version).toBe(2);
    expect(body.playbook.steps).toHaveLength(1);
    expect(body.playbook.id).toBe('release-checklist');

    // Same file rewritten (no duplicate created)
    const fileContent = readFileSync(join(tempRoot, PRIMARY_PLAYBOOK_PATH), 'utf-8');
    expect(fileContent).toContain('Release Checklist v2');
    const input = loadPlaybookFromFile(join(tempRoot, PRIMARY_PLAYBOOK_PATH), 'el-0000' as never);
    expect(input.steps).toHaveLength(1);
    expect(input.steps[0].title).toBe('Review the changelog again');
  });

  test('preserves the original file name including alternate extensions', async () => {
    // A playbook using the alternate .playbook.yml extension in the
    // secondary directory, written by hand like any external tool would
    mkdirSync(join(tempRoot, 'playbooks'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'playbooks/legacy.playbook.yml'),
      [
        '# Legacy',
        'name: legacy',
        'title: Legacy Playbook',
        'steps:',
        '  - id: only',
        '    title: The only step',
        '',
      ].join('\n'),
      'utf-8'
    );

    const res = await req('PATCH', '/api/playbooks/legacy', {
      title: 'Legacy Playbook (edited)',
    });

    expect(res.status).toBe(200);
    // The .yml file was rewritten in place, no .yaml twin was created
    expect(existsSync(join(tempRoot, 'playbooks/legacy.playbook.yml'))).toBe(true);
    expect(existsSync(join(tempRoot, 'playbooks/legacy.playbook.yaml'))).toBe(false);
    expect(existsSync(join(tempRoot, PRIMARY_PLAYBOOKS_DIR, 'legacy.playbook.yaml'))).toBe(false);

    const input = loadPlaybookFromFile(join(tempRoot, 'playbooks/legacy.playbook.yml'), 'el-0000' as never);
    expect(input.title).toBe('Legacy Playbook (edited)');
    expect(input.steps).toHaveLength(1);
  });

  test('returns 404 for an unknown playbook', async () => {
    const res = await req('PATCH', '/api/playbooks/nope', { title: 'X' });
    expect(res.status).toBe(404);
  });

  test('rejects invalid updates with 400', async () => {
    await req('POST', '/api/playbooks', templatePayload());

    const badSteps = await req('PATCH', '/api/playbooks/release-checklist', {
      steps: [{ title: 'missing id' }],
    });
    expect(badSteps.status).toBe(400);

    const selfExtend = await req('PATCH', '/api/playbooks/release-checklist', {
      extends: ['release-checklist'],
    });
    expect(selfExtend.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/playbooks/:name
// ---------------------------------------------------------------------------

describe('DELETE /api/playbooks/:name', () => {
  test('unlinks the playbook file', async () => {
    await req('POST', '/api/playbooks', templatePayload());

    const res = await req('DELETE', '/api/playbooks/release-checklist');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(existsSync(join(tempRoot, PRIMARY_PLAYBOOK_PATH))).toBe(false);

    // No longer discoverable, and repeated deletes 404
    const discovered = discoverPlaybookFiles(
      [join(tempRoot, PRIMARY_PLAYBOOKS_DIR), join(tempRoot, 'playbooks')],
      { recursive: true }
    );
    expect(discovered).toHaveLength(0);

    const again = await req('DELETE', '/api/playbooks/release-checklist');
    expect(again.status).toBe(404);
  });

  test('returns 404 for an unknown playbook', async () => {
    const res = await req('DELETE', '/api/playbooks/nope');
    expect(res.status).toBe(404);
  });
});
