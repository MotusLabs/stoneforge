import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorageAsync, initializeSchema } from '@stoneforge/storage';
import { createQuarryAPI } from '@stoneforge/quarry';
import {
  ElementType,
  createTimestamp,
  EntityTypeValue,
  createGroupChannel,
  createDocument,
  createMessage,
  DocumentCategory,
} from '@stoneforge/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEST_STONEFORGE_DIR = resolve(PROJECT_ROOT, '.stoneforge-test');
const TEST_DB_PATH = resolve(TEST_STONEFORGE_DIR, 'stoneforge.db');

/**
 * Playbook fixtures served by the test Quarry server.
 *
 * The server discovers playbooks from `.stoneforge/playbooks` relative to its
 * working directory (apps/quarry-server), so the fixtures are written there
 * for the duration of the run and removed again by the global teardown.
 */
export const PLAYBOOK_FIXTURES: Record<string, string> = {
  'e2e-release-flow.playbook.yaml': `name: e2e-release-flow
title: E2E Release Flow
version: 1
variables:
  - name: environment
    type: string
    required: false
    default: staging
    enum: [staging, production]
steps:
  - id: run-tests
    title: Run test suite
    taskType: chore
    priority: 2
  - id: deploy
    title: Deploy to environment
    depends_on: [run-tests]
    condition: "{{environment}} == production"
`,
  'e2e-required-vars.playbook.yaml': `name: e2e-required-vars
title: E2E Required Variables
version: 1
variables:
  - name: project
    type: string
    required: true
steps:
  - id: bootstrap
    title: Bootstrap project
`,
  // No steps: used to assert the TB122 rejection of step-less instantiation
  'e2e-empty-steps.playbook.yaml': `name: e2e-empty-steps
title: E2E Empty Steps
version: 1
steps: []
`,
};

export const PLAYBOOK_FIXTURE_DIR = resolve(
  PROJECT_ROOT,
  'apps/quarry-server/.stoneforge/playbooks'
);

export default async function globalSetup() {
  mkdirSync(TEST_STONEFORGE_DIR, { recursive: true });

  const backend = await createStorageAsync({ path: TEST_DB_PATH, create: true });
  initializeSchema(backend);
  const api = createQuarryAPI(backend);

  // Create default operator entity (same as `sf init`)
  const now = createTimestamp();
  await api.create({
    id: 'el-0000',
    type: ElementType.ENTITY,
    createdAt: now,
    updatedAt: now,
    createdBy: 'el-0000',
    tags: [],
    metadata: {},
    name: 'operator',
    entityType: EntityTypeValue.HUMAN,
  });

  // Messaging fixtures for the messaging specs (message-display, send-message,
  // threading). Group channels require at least two member entities and there
  // is no HTTP endpoint for creating entities, so the second member and the
  // channels must be seeded through the storage API before the server starts.
  // Without these the specs' channel guards skip every messaging path, and the
  // specs then depend on channels left behind by whichever other specs happen
  // to run first (fixture-ordering flakiness).
  await api.create({
    id: 'el-0001',
    type: ElementType.ENTITY,
    createdAt: now,
    updatedAt: now,
    createdBy: 'el-0000',
    tags: [],
    metadata: {},
    name: 'e2e-participant',
    entityType: EntityTypeValue.HUMAN,
  });

  // Channel with one seed message: exercises the "messages exist" read paths.
  // The message content follows the server's POST /api/messages shape (an
  // immutable MESSAGE_CONTENT document referenced by contentRef). Seeding via
  // the storage API deliberately skips the route's inbox side effects so
  // inbox specs keep starting from an empty inbox.
  const seededChannel = await createGroupChannel({
    name: 'e2e-messaging',
    createdBy: 'el-0000',
    members: ['el-0001'],
  });
  await api.create(seededChannel as unknown as Parameters<typeof api.create>[0]);

  const seedDoc = await createDocument({
    contentType: 'text',
    content: 'Seed message for message display specs',
    createdBy: 'el-0000',
    category: DocumentCategory.MESSAGE_CONTENT,
    immutable: true,
  });
  await api.create(seedDoc as unknown as Parameters<typeof api.create>[0]);

  const seedMessage = await createMessage({
    channelId: seededChannel.id,
    sender: 'el-0000',
    contentRef: seedDoc.id,
  });
  await api.create(seedMessage as unknown as Parameters<typeof api.create>[0]);

  // Empty channel: exercises the "no messages" empty-state path.
  const emptyChannel = await createGroupChannel({
    name: 'e2e-messaging-empty',
    createdBy: 'el-0000',
    members: ['el-0001'],
  });
  await api.create(emptyChannel as unknown as Parameters<typeof api.create>[0]);

  // Expose playbook templates through the test server's playbook endpoints
  mkdirSync(PLAYBOOK_FIXTURE_DIR, { recursive: true });
  for (const [filename, content] of Object.entries(PLAYBOOK_FIXTURES)) {
    writeFileSync(resolve(PLAYBOOK_FIXTURE_DIR, filename), content, 'utf8');
  }
}
