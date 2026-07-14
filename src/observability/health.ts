/**
 * Failover-Proxy v4.0 — Health Check Endpoints
 *
 * /health — Lightweight liveness probe (no upstream calls)
 * /health/deep — Readiness probe with provider connectivity checks
 */

import type { HealthStatus, ProviderHealth, KeyHealthSummary } from '../types';
import type { KeyPool } from '../keys/pool';
import type { CircuitBreakerManager } from '../resilience/circuit-breaker';
import { getConfig } from '../config';

const VERSION = '4.0.0';

export function buildHealthStatus(
  keyPool: KeyPool,
  circuitBreakers: CircuitBreakerManager,
): HealthStatus {
  const config = getConfig();
  const now = Date.now();
  const startTime = process.uptime();

  // Provider health
  const providerHealthList: ProviderHealth[] = config.providers.map(p => {
    const cbState = circuitBreakers.getState(p.name);
    return {
      name: p.name,
      circuitState: cbState,
      available: cbState !== 'open',
    };
  });

  // Key summary
  const allKeys = keyPool.getAllStates();
  const keySummary: KeyHealthSummary = {
    total: allKeys.length,
    available: allKeys.filter(k => k.cooldownUntil <= now).length,
    inCooldown: allKeys.filter(k => k.cooldownUntil > now).length,
  };

  // Overall status
  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (keySummary.available === 0 || providerHealthList.every(p => !p.available)) {
    status = 'unhealthy';
  } else if (keySummary.inCooldown > 0 || providerHealthList.some(p => !p.available)) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  return {
    status,
    version: VERSION,
    uptime: Math.round(startTime),
    timestamp: new Date().toISOString(),
    providers: providerHealthList,
    keys: keySummary,
  };
}
