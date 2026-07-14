/**
 * Failover-Proxy v4.0 — Config Unit Tests
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../config';

describe('Config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env
    delete process.env.OPENROUTER_KEYS;
    delete process.env.VIBEPROXY_BASE_URL;
    delete process.env.PORT;
    delete process.env.REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when no providers are configured', () => {
    assert.throws(() => loadConfig(), /No providers configured/);
  });

  it('loads config with OpenRouter keys', () => {
    process.env.OPENROUTER_KEYS = 'key1,key2,key3';
    const config = loadConfig();

    assert.equal(config.keys.length, 3);
    assert.equal(config.providers.length, 1);
    assert.equal(config.providers[0].name, 'openrouter');
    assert.equal(config.port, 9000); // default
  });

  it('respects PORT env var', () => {
    process.env.OPENROUTER_KEYS = 'key1';
    process.env.PORT = '8080';
    const config = loadConfig();

    assert.equal(config.port, 8080);
  });

  it('respects timeout env vars', () => {
    process.env.OPENROUTER_KEYS = 'key1';
    process.env.REQUEST_TIMEOUT_MS = '60000';
    const config = loadConfig();

    assert.equal(config.requestTimeoutMs, 60000);
  });

  it('trims whitespace from keys', () => {
    process.env.OPENROUTER_KEYS = ' key1 , key2 , ';
    const config = loadConfig();

    assert.equal(config.keys.length, 2);
    assert.equal(config.keys[0].key, 'key1');
    assert.equal(config.keys[1].key, 'key2');
  });

  it('throws on invalid integer env var', () => {
    process.env.OPENROUTER_KEYS = 'key1';
    process.env.PORT = 'not-a-number';

    assert.throws(() => loadConfig(), /Invalid integer/);
  });

  it('assigns correct provider to keys', () => {
    process.env.OPENROUTER_KEYS = 'orkey1,orkey2';
    const config = loadConfig();

    assert.equal(config.keys[0].provider, 'openrouter');
    assert.equal(config.keys[1].provider, 'openrouter');
  });

  it('sets sensible defaults for all values', () => {
    process.env.OPENROUTER_KEYS = 'key1';
    const config = loadConfig();

    assert.equal(config.requestTimeoutMs, 30000);
    assert.equal(config.cooldownMs, 30000);
    assert.equal(config.maxCooldownMs, 300000);
    assert.equal(config.maxBodyBytes, 10 * 1024 * 1024);
    assert.equal(config.maxRetries, 10);
    assert.equal(config.bodyTimeoutMs, 30000);
    assert.equal(config.modelFilterRegex, 'claude');
    assert.equal(config.logLevel, 'info');
  });
});
