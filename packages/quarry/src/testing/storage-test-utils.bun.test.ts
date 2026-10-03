import { afterEach, describe, expect, test } from 'bun:test';
import { createStorage } from '@stoneforge/storage';
import { createBackendTracker } from './storage-test-utils.js';

const backends = createBackendTracker();

afterEach(() => {
  backends.closeAll();
});

describe('test backend cleanup', () => {
  test('retains every opened handle when test work throws', () => {
    const first = backends.track(createStorage(':memory:'));
    let second: typeof first | undefined;
    expect(() => {
      second = backends.track(createStorage(':memory:'));
      throw new Error('test failed');
    }).toThrow('test failed');

    backends.closeAll();

    expect(() => first.exec('SELECT 1')).toThrow('Database is closed');
    expect(() => second!.exec('SELECT 1')).toThrow('Database is closed');
  });

  test('supports early closes and repeated cleanup', () => {
    const backend = backends.track(createStorage(':memory:'));
    backend.close();
    backends.closeAll();
    backends.closeAll();
    expect(() => backend.exec('SELECT 1')).toThrow('Database is closed');
  });

  test('attempts other closes when one close fails and retains it for retry', () => {
    const first = backends.track(createStorage(':memory:'));
    const second = backends.track(createStorage(':memory:'));
    const close = first.close.bind(first);
    first.close = () => {
      throw new Error('close failed');
    };

    try {
      expect(() => backends.closeAll()).toThrow(AggregateError);
      expect(() => second.exec('SELECT 1')).toThrow('Database is closed');
    } finally {
      first.close = close;
    }

    backends.closeAll();
    expect(() => first.exec('SELECT 1')).toThrow('Database is closed');
  });
});
