/**
 * Failover-Proxy v4.0 — Circuit Breaker Unit Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreakerManager } from '../../resilience/circuit-breaker';

describe('CircuitBreaker', () => {
  let cbm: CircuitBreakerManager;

  beforeEach(() => {
    cbm = new CircuitBreakerManager();
    cbm.register('test-provider', {
      failureThreshold: 3,
      resetTimeoutMs: 100, // Short for testing
      halfOpenMaxAttempts: 1,
      failureRateThreshold: 0.5,
      windowMs: 60000,
    });
  });

  it('starts in closed state', () => {
    assert.equal(cbm.getState('test-provider'), 'closed');
    assert.equal(cbm.allowRequest('test-provider'), true);
  });

  it('stays closed on successes', () => {
    cbm.recordSuccess('test-provider');
    cbm.recordSuccess('test-provider');
    cbm.recordSuccess('test-provider');

    assert.equal(cbm.getState('test-provider'), 'closed');
    assert.equal(cbm.allowRequest('test-provider'), true);
  });

  it('trips to open after threshold failures', () => {
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'closed');

    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'open');
    assert.equal(cbm.allowRequest('test-provider'), false);
  });

  it('resets failure count on success', () => {
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    cbm.recordSuccess('test-provider');
    // Failure count should be reset
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'closed');
  });

  it('transitions from open to half-open after timeout', async () => {
    // Trip the breaker
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'open');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 150));

    // Should transition to half-open
    assert.equal(cbm.getState('test-provider'), 'half-open');
    assert.equal(cbm.allowRequest('test-provider'), true);
  });

  it('transitions from half-open to closed on success', async () => {
    // Trip the breaker
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'open');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 150));
    assert.equal(cbm.getState('test-provider'), 'half-open');

    // Probe succeeds
    cbm.recordSuccess('test-provider');
    assert.equal(cbm.getState('test-provider'), 'closed');
  });

  it('transitions from half-open back to open on failure', async () => {
    // Trip the breaker
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 150));
    assert.equal(cbm.getState('test-provider'), 'half-open');

    // Probe fails
    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'open');
  });

  it('returns closed for unregistered provider', () => {
    assert.equal(cbm.getState('unknown'), 'closed');
    assert.equal(cbm.allowRequest('unknown'), true);
  });

  it('force reset works', () => {
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    cbm.recordFailure('test-provider');
    assert.equal(cbm.getState('test-provider'), 'open');

    cbm.reset('test-provider');
    assert.equal(cbm.getState('test-provider'), 'closed');
  });

  it('getAllStates returns all registered breakers', () => {
    cbm.register('another-provider');
    const states = cbm.getAllStates();

    assert.equal(Object.keys(states).length, 2);
    assert.equal(states['test-provider'], 'closed');
    assert.equal(states['another-provider'], 'closed');
  });
});
