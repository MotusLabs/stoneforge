import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { LocalEmbeddingProvider } from './local-provider.js';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Scratch model dir lives in the OS temp dir (NOT next to the sources) so an
// interrupted run — crash, CI timeout, Ctrl+C — can never leave a
// __test_model_dir__ artifact inside src/. The provider only checks directory
// existence (placeholder implementation — no model download, no files
// written), so an empty mkdtemp dir is all that is needed.
let TEST_MODEL_DIR: string;

beforeEach(() => {
  TEST_MODEL_DIR = mkdtempSync(join(tmpdir(), 'stoneforge-local-embed-test-'));
});

afterEach(() => {
  if (TEST_MODEL_DIR) {
    rmSync(TEST_MODEL_DIR, { recursive: true, force: true });
  }
});

describe('LocalEmbeddingProvider', () => {

  test('same text produces same embedding (deterministic)', async () => {
    const provider = new LocalEmbeddingProvider(TEST_MODEL_DIR);
    const a = await provider.embed('test content');
    const b = await provider.embed('test content');
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  test('embeddings are normalized (unit length ≈ 1.0)', async () => {
    const provider = new LocalEmbeddingProvider(TEST_MODEL_DIR);
    const embedding = await provider.embed('normalize me');
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    expect(norm).toBeCloseTo(1.0, 3);
  });

  test('embeddings have correct dimensions (768)', async () => {
    const provider = new LocalEmbeddingProvider(TEST_MODEL_DIR);
    const embedding = await provider.embed('dimension check');
    expect(embedding.length).toBe(768);
  });

  test('embedBatch consistent with individual embed calls', async () => {
    const provider = new LocalEmbeddingProvider(TEST_MODEL_DIR);
    const texts = ['hello', 'world', 'test'];
    const batch = await provider.embedBatch(texts);
    for (let t = 0; t < texts.length; t++) {
      const individual = await provider.embed(texts[t]);
      expect(batch[t].length).toBe(individual.length);
      for (let i = 0; i < individual.length; i++) {
        expect(batch[t][i]).toBe(individual[i]);
      }
    }
  });

  test('isAvailable returns false for nonexistent model directory', async () => {
    const provider = new LocalEmbeddingProvider('/nonexistent/path/model');
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  test('isAvailable returns true when directory exists', async () => {
    const provider = new LocalEmbeddingProvider(TEST_MODEL_DIR);
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });
});
