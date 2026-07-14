/**
 * Failover-Proxy v4.0 — Key Pool Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool } from '../../keys/pool';

describe('KeyPool', () => {
  function makePool(count: number = 3, strategy: 'round-robin' | 'least-used' | 'weighted-health' = 'round-robin') {
    const keys = Array.from({ length: count }, (_, i) => ({
      key: `test-key-${i}`,
      provider: 'openrouter',
    }));
    return new KeyPool(keys, 1000, 5000, strategy);
  }

  it('initializes with correct number of keys', () => {
    const pool = makePool(3);
    assert.equal(pool.size, 3);
    assert.equal(pool.getAllStates().length, 3);
  });

  it('round-robin picks keys in order', () => {
    const pool = makePool(3);
    const exclude = new Set<number>();

    const k1 = pool.pickKey(exclude);
    assert.equal(k1?.index, 0);

    const k2 = pool.pickKey(exclude);
    assert.equal(k2?.index, 1);

    const k3 = pool.pickKey(exclude);
    assert.equal(k3?.index, 2);

    // Wraps around
    const k4 = pool.pickKey(exclude);
    assert.equal(k4?.index, 0);
  });

  it('skips excluded keys', () => {
    const pool = makePool(3);
    const exclude = new Set([0, 1]);

    const k = pool.pickKey(exclude);
    assert.equal(k?.index, 2);
  });

  it('returns null when all keys excluded', () => {
    const pool = makePool(3);
    const exclude = new Set([0, 1, 2]);

    const k = pool.pickKey(exclude);
    assert.equal(k, null);
  });

  it('skips keys in cooldown', () => {
    const pool = makePool(3);

    // Put first key in cooldown
    pool.markFailure(0, 'test failure', 429);

    const exclude = new Set<number>();
    const k = pool.pickKey(exclude);
    // Should skip key 0 (in cooldown) and pick key 1
    assert.notEqual(k?.index, 0);
  });

  it('markSuccess resets consecutive failures', () => {
    const pool = makePool(1);

    pool.markFailure(0, 'fail', 429);
    const beforeSuccess = pool.getAllStates()[0];
    assert.equal(beforeSuccess.consecutiveFailures, 1);

    pool.markSuccess(0, 100);
    const afterSuccess = pool.getAllStates()[0];
    assert.equal(afterSuccess.consecutiveFailures, 0);
    assert.equal(afterSuccess.totalSuccesses, 1);
    assert.equal(afterSuccess.requestsHandled, 1);
  });

  it('markFailure increments failure counts', () => {
    const pool = makePool(1);

    pool.markFailure(0, 'fail 1', 429);
    pool.markFailure(0, 'fail 2', 500);

    const state = pool.getAllStates()[0];
    assert.equal(state.consecutiveFailures, 2);
    assert.equal(state.totalFailures, 2);
  });

  it('health score starts at 1.0', () => {
    const pool = makePool(1);
    assert.equal(pool.getAllStates()[0].healthScore, 1.0);
  });

  it('health score decreases on failures', () => {
    const pool = makePool(1);

    pool.markFailure(0, 'fail', 429);
    pool.markFailure(0, 'fail', 429);
    pool.markFailure(0, 'fail', 429);

    const state = pool.getAllStates()[0];
    assert.ok(state.healthScore < 1.0, `Health score should decrease, got ${state.healthScore}`);
  });

  it('least-used strategy picks key with fewest requests', () => {
    const pool = makePool(3, 'least-used');

    // Simulate usage: key 0 has 5 requests, key 1 has 2, key 2 has 8
    for (let i = 0; i < 5; i++) pool.markSuccess(0, 100);
    for (let i = 0; i < 2; i++) pool.markSuccess(1, 100);
    for (let i = 0; i < 8; i++) pool.markSuccess(2, 100);

    const k = pool.pickKey(new Set());
    assert.equal(k?.index, 1); // Least used
  });

  it('weighted-health strategy picks healthiest key', () => {
    const pool = makePool(3, 'weighted-health');

    // Damage key 0 and key 2
    pool.markFailure(0, 'fail', 429);
    pool.markFailure(0, 'fail', 429);
    pool.markFailure(2, 'fail', 429);

    // Key 1 is untouched (healthScore = 1.0)
    const k = pool.pickKey(new Set());
    assert.equal(k?.index, 1);
  });

  it('filters by provider', () => {
    const keys = [
      { key: 'or-key-1', provider: 'openrouter' },
      { key: 'vp-key-1', provider: 'vibeproxy' },
      { key: 'or-key-2', provider: 'openrouter' },
    ];
    const pool = new KeyPool(keys, 1000, 5000, 'round-robin');

    const k = pool.pickKey(new Set(), 'vibeproxy');
    assert.equal(k?.index, 1);
    assert.equal(k?.provider, 'vibeproxy');
  });

  it('getKeyInfo returns display-ready data', () => {
    const pool = makePool(1);
    pool.markSuccess(0, 150);

    const info = pool.getKeyInfo(pool.getAllStates()[0]);
    assert.ok(info.keySuffix.startsWith('...'));
    assert.equal(info.provider, 'openrouter');
    assert.equal(info.available, true);
    assert.equal(info.requestsHandledSession, 1);
    assert.equal(info.avgLatencyMs, 150);
    assert.equal(info.successRate, 100);
  });
});
