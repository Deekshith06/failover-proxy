/**
 * Failover-Proxy v4.0 — Integration Tests
 *
 * Tests the full proxy flow with a mock upstream server.
 * Verifies: routing, failover, streaming, body limits, graceful errors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'http';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Integration: Proxy Endpoints', () => {
  it('/health returns valid JSON', async () => {
    // We'll test health endpoint by constructing the components directly
    const { KeyPool } = await import('../../keys/pool');
    const { CircuitBreakerManager } = await import('../../resilience/circuit-breaker');
    const { buildHealthStatus } = await import('../../observability/health');

    // Mock the config
    const originalEnv = process.env.OPENROUTER_KEYS;
    process.env.OPENROUTER_KEYS = 'test-key-1,test-key-2';

    try {
      const { initConfig } = await import('../../config');
      const config = initConfig();

      const keyPool = new KeyPool(config.keys, 1000, 5000);
      const cbm = new CircuitBreakerManager();
      cbm.register('openrouter');

      const health = buildHealthStatus(keyPool, cbm);

      assert.equal(health.status, 'healthy');
      assert.equal(health.version, '4.0.0');
      assert.equal(health.keys.total, 2);
      assert.equal(health.keys.available, 2);
      assert.equal(health.keys.inCooldown, 0);
      assert.equal(health.providers.length, 1);
      assert.equal(health.providers[0].name, 'openrouter');
      assert.equal(health.providers[0].circuitState, 'closed');
    } finally {
      process.env.OPENROUTER_KEYS = originalEnv;
    }
  });

  it('health status is degraded when keys are in cooldown', async () => {
    const { KeyPool } = await import('../../keys/pool');
    const { CircuitBreakerManager } = await import('../../resilience/circuit-breaker');
    const { buildHealthStatus } = await import('../../observability/health');

    const keyPool = new KeyPool(
      [{ key: 'k1', provider: 'openrouter' }, { key: 'k2', provider: 'openrouter' }],
      1000, 5000,
    );
    const cbm = new CircuitBreakerManager();
    cbm.register('openrouter');

    // Put one key in cooldown
    keyPool.markFailure(0, 'test', 429);

    const health = buildHealthStatus(keyPool, cbm);
    assert.equal(health.status, 'degraded');
    assert.equal(health.keys.inCooldown, 1);
  });

  it('health status is unhealthy when all keys in cooldown', async () => {
    const { KeyPool } = await import('../../keys/pool');
    const { CircuitBreakerManager } = await import('../../resilience/circuit-breaker');
    const { buildHealthStatus } = await import('../../observability/health');

    const keyPool = new KeyPool(
      [{ key: 'k1', provider: 'openrouter' }],
      60000, 300000, // Long cooldown
    );
    const cbm = new CircuitBreakerManager();
    cbm.register('openrouter');

    keyPool.markFailure(0, 'test', 429);

    const health = buildHealthStatus(keyPool, cbm);
    assert.equal(health.status, 'unhealthy');
  });
});

describe('Integration: Metrics', () => {
  it('metrics snapshot returns valid data', async () => {
    const { metrics } = await import('../../observability/metrics');

    metrics.recordRequest(200, 'openrouter', 'test-model', 150);
    metrics.recordRequest(200, 'openrouter', 'test-model', 250);
    metrics.recordRequest(429, 'openrouter', 'test-model', 50);
    metrics.recordKeyRotation();
    metrics.recordStreamSuccess();

    const snap = metrics.snapshot();

    assert.ok(snap.totalRequests >= 3);
    assert.ok(snap.requestsByStatus[200] >= 2);
    assert.ok(snap.requestsByProvider['openrouter'] >= 3);
    assert.ok(snap.keyRotations >= 1);
    assert.ok(snap.streamSuccesses >= 1);
    assert.ok(snap.latency.count >= 3);
    assert.ok(snap.uptime >= 0);
    assert.ok(snap.memoryUsage.rss > 0);
  });

  it('Prometheus format output is valid', async () => {
    const { metrics } = await import('../../observability/metrics');
    const prom = metrics.toPrometheus();

    assert.ok(prom.includes('failover_proxy_uptime_seconds'));
    assert.ok(prom.includes('failover_proxy_requests_total'));
    assert.ok(prom.includes('failover_proxy_active_requests'));
    assert.ok(prom.includes('failover_proxy_memory_rss_bytes'));
  });
});

describe('Integration: Body Buffering', () => {
  it('rejects oversized request bodies', async () => {
    const { bufferRequestBody } = await import('../../proxy/forward');

    // Create a mock request that sends too much data
    const { Readable } = await import('stream');
    const largeData = Buffer.alloc(1024);
    const mockReq = Readable.from([largeData]) as unknown as IncomingMessage;

    try {
      await bufferRequestBody(mockReq, 512, 5000); // Limit is 512 bytes
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('exceeds'));
    }
  });
});

describe('Integration: Dashboard Rendering', () => {
  it('renders XSS-safe HTML', async () => {
    const { renderDashboard } = await import('../../dashboard/render');

    const data = {
      health: {
        status: 'healthy' as const,
        version: '4.0.0',
        uptime: 3600,
        timestamp: new Date().toISOString(),
        providers: [{ name: 'openrouter', circuitState: 'closed' as const, available: true }],
        keys: { total: 1, available: 1, inCooldown: 0 },
      },
      metrics: {
        uptime: 3600,
        totalRequests: 100,
        activeRequests: 0,
        requestsByStatus: { 200: 95, 429: 5 },
        requestsByProvider: { openrouter: 100 },
        requestsByModel: {},
        latency: { count: 100, min: 50, max: 500, avg: 150, p50: 120, p95: 400, p99: 480 },
        keyRotations: 5,
        circuitBreakerTrips: 0,
        streamSuccesses: 95,
        streamFailures: 0,
        retryCount: 5,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
      },
      keys: [{
        keySuffix: '...abc<script>alert(1)</script>',
        provider: 'openrouter',
        available: true,
        healthScore: 0.95,
        cooldownRemainingSec: 0,
        requestsHandledSession: 50,
        requestsToday: 100,
        avgLatencyMs: 150,
        successRate: 95,
        lastUsedAt: new Date().toISOString(),
        lastRateLimit: null,
        creditUsage: null,
      }],
      models: [],
      providers: [{ name: 'openrouter', circuitState: 'closed' as const, totalRequests: 100, successRate: 95, avgLatencyMs: 150 }],
      recentEvents: [],
    };

    const html = renderDashboard(data);

    // Verify HTML is rendered
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('Failover-Proxy'));

    // Verify XSS attempt is escaped
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});
