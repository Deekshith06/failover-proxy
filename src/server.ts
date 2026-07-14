/**
 * Failover-Proxy v4.0 — HTTP Server & Routing
 *
 * Clean request routing, graceful shutdown with in-flight request draining,
 * body buffering with size/timeout limits, and all API endpoints.
 *
 * Fixes Bug #5: Configurable port.
 * Fixes Bug #9: Graceful shutdown.
 */

import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyConfig } from './types';
import type { KeyPool } from './keys/pool';
import type { ProviderRegistry } from './providers/registry';
import type { CircuitBreakerManager } from './resilience/circuit-breaker';
import type { ModelRegistry } from './models/registry';
import { forwardRequest, bufferRequestBody } from './proxy/forward';
import { buildHealthStatus } from './observability/health';
import { metrics } from './observability/metrics';
import { renderDashboard } from './dashboard/render';
import { logger } from './observability/logger';
import type {
  DashboardData, DashboardKeyInfo, DashboardProviderInfo,
  DashboardEvent,
} from './types';

// ── Event log for dashboard ──────────────────────────────────────────────────

const MAX_EVENTS = 100;
const recentEvents: DashboardEvent[] = [];

export function addEvent(type: DashboardEvent['type'], message: string): void {
  recentEvents.push({ timestamp: new Date().toISOString(), type, message });
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_EVENTS);
  }
}

// ── Server Factory ───────────────────────────────────────────────────────────

export function createServer(
  config: ProxyConfig,
  keyPool: KeyPool,
  providerRegistry: ProviderRegistry,
  circuitBreakers: CircuitBreakerManager,
  modelRegistry: ModelRegistry,
): http.Server {
  let activeConnections = 0;
  let shuttingDown = false;

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (shuttingDown) {
      res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' });
      res.end('{"error":"Server is shutting down"}');
      return;
    }

    activeConnections++;
    const url = req.url || '/';
    const method = req.method || 'GET';

    try {
      // ── GET routes ─────────────────────────────────────────────────

      if (method === 'GET') {
        if (url.startsWith('/health/deep')) {
          return await handleDeepHealth(res, keyPool, circuitBreakers, providerRegistry);
        }
        if (url.startsWith('/health')) {
          return handleHealth(res, keyPool, circuitBreakers);
        }
        if (url.startsWith('/dashboard')) {
          return await handleDashboard(res, keyPool, circuitBreakers, modelRegistry);
        }
        if (url.startsWith('/metrics')) {
          return handleMetrics(req, res);
        }
        if (url.startsWith('/providers')) {
          return handleProviders(res, providerRegistry, circuitBreakers);
        }
        if (url.startsWith('/models') || url.startsWith('/v1/models')) {
          return handleModels(res, modelRegistry);
        }
        if (url.startsWith('/keys') || url.startsWith('/statistics')) {
          return await handleKeys(res, keyPool, providerRegistry);
        }
      }

      // ── Proxy routes (POST, etc.) ──────────────────────────────────

      // Buffer request body with size limit and timeout
      let rawBody: Buffer;
      try {
        rawBody = await bufferRequestBody(req, config.maxBodyBytes, config.bodyTimeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Request body error';
        logger.warn(`Body buffering failed: ${message}`);
        if (!res.headersSent) {
          const statusCode = message.includes('too large') ? 413 : 408;
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message, type: 'proxy_error' } }));
        }
        return;
      }

      await forwardRequest(req, res, rawBody, keyPool, providerRegistry, circuitBreakers, modelRegistry);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal proxy error';
      logger.error(`Unhandled route error: ${message}`, { error: message, url, method });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal proxy error', type: 'proxy_error' } }));
      }
    } finally {
      activeConnections--;
    }
  });

  // ── Graceful Shutdown ──────────────────────────────────────────────────

  function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}, starting graceful shutdown...`, {
      activeConnections,
      gracePeriodMs: config.shutdownGracePeriodMs,
    });

    addEvent('info', `Graceful shutdown initiated (${signal})`);

    // Stop accepting new connections
    server.close(() => {
      logger.info('All connections closed, exiting');
      process.exit(0);
    });

    // Force exit after grace period
    const forceTimer = setTimeout(() => {
      logger.warn(`Grace period expired with ${activeConnections} active connections, forcing exit`);
      process.exit(1);
    }, config.shutdownGracePeriodMs);

    // Don't let the timer keep the process alive if it exits naturally
    forceTimer.unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return server;
}

// ── Route Handlers ───────────────────────────────────────────────────────────

function handleHealth(
  res: ServerResponse,
  keyPool: KeyPool,
  circuitBreakers: CircuitBreakerManager,
): void {
  const health = buildHealthStatus(keyPool, circuitBreakers);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(health, null, 2));
}

async function handleDeepHealth(
  res: ServerResponse,
  keyPool: KeyPool,
  circuitBreakers: CircuitBreakerManager,
  providerRegistry: ProviderRegistry,
): Promise<void> {
  const health = buildHealthStatus(keyPool, circuitBreakers);

  // Test provider connectivity
  const providerChecks: Record<string, string> = {};
  for (const provider of providerRegistry.getAll()) {
    try {
      const firstKey = keyPool.getKeysByProvider(provider.name)[0];
      if (firstKey) {
        const usage = await provider.getUsage(firstKey.key);
        providerChecks[provider.name] = usage.fetchError || 'reachable';
      } else {
        providerChecks[provider.name] = 'no keys';
      }
    } catch {
      providerChecks[provider.name] = 'unreachable';
    }
  }

  const response = { ...health, providerConnectivity: providerChecks };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response, null, 2));
}

function handleMetrics(req: IncomingMessage, res: ServerResponse): void {
  const accept = req.headers.accept || '';
  const snap = metrics.snapshot();

  // Return Prometheus format if requested, otherwise JSON
  if (accept.includes('text/plain') || accept.includes('text/plain; version=0.0.4')) {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metrics.toPrometheus());
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snap, null, 2));
  }
}

function handleProviders(
  res: ServerResponse,
  providerRegistry: ProviderRegistry,
  circuitBreakers: CircuitBreakerManager,
): void {
  const providers = providerRegistry.getAll().map(p => ({
    name: p.name,
    hostname: p.config.hostname,
    priority: p.config.priority,
    enabled: p.config.enabled,
    circuitState: circuitBreakers.getState(p.name),
    keyCount: p.config.apiKeys.length,
  }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ providers }, null, 2));
}

function handleModels(res: ServerResponse, modelRegistry: ModelRegistry): void {
  const filteredModels = modelRegistry.getFilteredModels();
  const response = {
    data: filteredModels,
    object: 'list',
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response));
}

async function handleKeys(
  res: ServerResponse,
  keyPool: KeyPool,
  providerRegistry: ProviderRegistry,
): Promise<void> {
  const keyInfos: DashboardKeyInfo[] = [];
  for (const k of keyPool.getAllStates()) {
    const info = keyPool.getKeyInfo(k);

    // Fetch usage if available
    const provider = providerRegistry.get(k.provider);
    if (provider && !info.creditUsage) {
      const usage = await provider.getUsage(k.key);
      // Update cache in key state
      k.usageCache = usage;
      k.usageCacheAt = Date.now();
    }

    keyInfos.push({
      ...info,
      creditUsage: k.usageCache,
    });
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: keyInfos }, null, 2));
}

async function handleDashboard(
  res: ServerResponse,
  keyPool: KeyPool,
  circuitBreakers: CircuitBreakerManager,
  modelRegistry: ModelRegistry,
): Promise<void> {
  const health = buildHealthStatus(keyPool, circuitBreakers);
  const snap = metrics.snapshot();

  const keys: DashboardKeyInfo[] = keyPool.getAllStates().map(k => keyPool.getKeyInfo(k));

  const providers: DashboardProviderInfo[] = health.providers.map(p => {
    const providerRequests = snap.requestsByProvider[p.name] || 0;
    return {
      name: p.name,
      circuitState: p.circuitState,
      totalRequests: providerRequests,
      successRate: providerRequests > 0 ? 100 : 0, // Simplified; real rate tracked in metrics
      avgLatencyMs: snap.latency.avg,
    };
  });

  const data: DashboardData = {
    health,
    metrics: snap,
    keys,
    models: modelRegistry.getAllMappings(),
    providers,
    recentEvents: recentEvents.slice(-20),
  };

  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(renderDashboard(data));
}
