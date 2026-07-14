/**
 * Failover-Proxy v4.0 — Core Proxy Forwarding
 *
 * ITERATIVE retry loop (fixes Bug #1 — no recursive forward()).
 * Handles streaming with proper error handling (fixes Bug #2, #3).
 * Marks success only after stream completes (fixes Bug #8).
 * Integrates with circuit breaker, key pool, and provider registry.
 *
 * Flow:
 *   1. Pick provider (priority order, skip if circuit open)
 *   2. Pick key for that provider (round-robin/health/least-used)
 *   3. Forward request to upstream
 *   4. If retryable error → mark key failed, try next
 *   5. If success → pipe response, mark success on stream end
 *   6. If all keys/providers exhausted → return 503
 */

import https from 'https';
import http from 'http';
import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ProxyContext, RateLimitInfo } from '../types';
import type { KeyPool } from '../keys/pool';
import type { ProviderRegistry } from '../providers/registry';
import type { CircuitBreakerManager } from '../resilience/circuit-breaker';
import type { ModelRegistry } from '../models/registry';
import { getConfig } from '../config';
import { sanitizeRequestHeaders, buildUpstreamHeaders } from './headers';
import { shouldRetryStatus, shouldRetryError } from '../resilience/retry';
import { createLogger } from '../observability/logger';
import { metrics } from '../observability/metrics';

/**
 * Generate a unique request ID for correlation.
 */
export function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Buffer the incoming request body with size validation and timeout.
 *
 * Fixes Bug #4: No request body size limit.
 * Fixes Bug #14: No body timeout.
 */
export function bufferRequestBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error('Request body timeout'));
      reject(new Error('Request body timed out'));
    }, timeoutMs);

    req.on('data', (chunk: Buffer) => {
      if (timedOut) return;
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        clearTimeout(timer);
        req.destroy(new Error('Request body too large'));
        reject(new Error(`Request body exceeds ${maxBytes} bytes limit`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Extract the model from the request body (best-effort).
 */
function extractModel(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString());
    return parsed.model || '';
  } catch {
    return '';
  }
}

/**
 * Attempt a single upstream request. Returns a promise that resolves
 * when the response headers arrive, or rejects on network error/timeout.
 */
function attemptUpstream(
  ctx: ProxyContext,
  provider: ReturnType<ProviderRegistry['get']>,
  key: ReturnType<KeyPool['pickKey']>,
  requestId: string,
  log: ReturnType<typeof createLogger>,
): Promise<{
  success: boolean;
  statusCode: number;
  rateLimitInfo: RateLimitInfo | null;
  errorMessage?: string;
}> {
  if (!provider || !key) {
    return Promise.resolve({
      success: false,
      statusCode: 0,
      rateLimitInfo: null,
      errorMessage: 'No provider or key available',
    });
  }

  const config = getConfig();

  return new Promise((resolve) => {
    const transformedPath = provider.transformPath(ctx.url);
    const transformedBody = provider.transformRequestBody(ctx.rawBody, extractModel(ctx.rawBody));
    const sanitizedHeaders = sanitizeRequestHeaders(ctx.incomingReq.headers);
    const upstreamHeaders = buildUpstreamHeaders(
      sanitizedHeaders,
      provider.config.hostname,
      key.key,
      transformedBody.length,
      requestId,
    );

    const transport = provider.config.useTls ? https : http;
    const options = {
      hostname: provider.config.hostname,
      port: provider.config.port,
      path: transformedPath,
      method: ctx.method,
      headers: upstreamHeaders,
      timeout: config.requestTimeoutMs,
    };

    let settled = false;
    const settle = (result: Parameters<typeof resolve>[0]) => {
      if (settled) return; // Guard against timeout+error race (Bug #3)
      settled = true;
      resolve(result);
    };

    const proxyReq = transport.request(options, (proxyRes) => {
      const statusCode = proxyRes.statusCode || 0;
      const rateLimitInfo = provider.parseRateLimitHeaders(
        proxyRes.headers as Record<string, string | string[] | undefined>,
      );

      // Check if we should retry based on status code
      const retryDecision = shouldRetryStatus(statusCode, ctx.attempts, config.maxRetries);

      if (retryDecision.shouldRetry) {
        // Drain the error response body to free the socket
        proxyRes.resume();
        settle({
          success: false,
          statusCode,
          rateLimitInfo,
          errorMessage: retryDecision.reason,
        });
        return;
      }

      if (statusCode >= 400) {
        // Non-retryable error — forward the error response to client
        if (!ctx.outgoingRes.headersSent) {
          ctx.outgoingRes.writeHead(statusCode, proxyRes.headers);
          proxyRes.pipe(ctx.outgoingRes);
        }
        settle({
          success: false,
          statusCode,
          rateLimitInfo,
          errorMessage: `Non-retryable status ${statusCode}`,
        });
        return;
      }

      // Success — pipe the response
      log.info(`Upstream responded ${statusCode}`, {
        statusCode,
        provider: provider.name,
      });

      if (!ctx.outgoingRes.headersSent) {
        ctx.outgoingRes.writeHead(statusCode, proxyRes.headers);
      }

      // Pipe with error handling (fixes Bug #2)
      proxyRes.on('error', (err) => {
        log.error(`Stream read error: ${err.message}`, { error: err.message });
        metrics.recordStreamFailure();
        if (!ctx.outgoingRes.writableEnded) {
          ctx.outgoingRes.end();
        }
      });

      ctx.outgoingRes.on('error', (err) => {
        log.error(`Client write error: ${err.message}`, { error: err.message });
        metrics.recordStreamFailure();
        proxyRes.destroy();
      });

      proxyRes.on('end', () => {
        // Mark success only AFTER stream completes (fixes Bug #8)
        metrics.recordStreamSuccess();
        settle({
          success: true,
          statusCode,
          rateLimitInfo,
        });
      });

      proxyRes.pipe(ctx.outgoingRes);
    });

    proxyReq.on('timeout', () => {
      log.warn('Upstream request timed out');
      proxyReq.destroy(); // This will trigger the 'error' event, but `settled` guard prevents double-handling
      settle({
        success: false,
        statusCode: 0,
        rateLimitInfo: null,
        errorMessage: 'Request timeout',
      });
    });

    proxyReq.on('error', (err) => {
      // Guard against timeout+error race condition (Bug #3)
      settle({
        success: false,
        statusCode: 0,
        rateLimitInfo: null,
        errorMessage: err.message,
      });
    });

    proxyReq.write(transformedBody);
    proxyReq.end();
  });
}

/**
 * Main proxy forwarding function — ITERATIVE, NOT RECURSIVE.
 *
 * Tries all available keys across all providers, respecting
 * circuit breaker state and key cooldowns.
 *
 * Fixes Bug #1: Eliminates unbounded recursion.
 */
export async function forwardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  keyPool: KeyPool,
  providerRegistry: ProviderRegistry,
  circuitBreakers: CircuitBreakerManager,
  modelRegistry: ModelRegistry,
): Promise<void> {
  const config = getConfig();
  const requestId = generateRequestId();
  const log = createLogger({ requestId });
  const startTime = Date.now();

  metrics.incrementActive();

  // Resolve model mapping
  const requestedModel = extractModel(rawBody);
  const { model: resolvedModel, remapped, reason } = modelRegistry.resolveModel(requestedModel);

  // If model was remapped, rewrite the body
  let body = rawBody;
  if (remapped && requestedModel) {
    try {
      const parsed = JSON.parse(rawBody.toString());
      parsed.model = resolvedModel;
      body = Buffer.from(JSON.stringify(parsed));
      log.info(`Model remapped: "${requestedModel}" → "${resolvedModel}"`, { reason });
    } catch {
      // Body isn't JSON — pass through unchanged
    }
  }

  const ctx: ProxyContext = {
    requestId,
    startTime,
    incomingReq: req,
    outgoingRes: res,
    rawBody: body,
    method: req.method || 'POST',
    url: req.url || '/',
    triedKeys: new Set(),
    attempts: 0,
    lastError: null,
  };

  log.info(`→ ${ctx.method} ${ctx.url}`, {
    model: resolvedModel || 'unknown',
    bodySize: body.length,
  });

  // Iterative retry loop across providers and keys
  const providerNames = providerRegistry.getOrderedNames();

  for (const providerName of providerNames) {
    // Check circuit breaker
    if (!circuitBreakers.allowRequest(providerName)) {
      log.debug(`Circuit breaker OPEN for ${providerName}, skipping`);
      continue;
    }

    const provider = providerRegistry.get(providerName);
    if (!provider) continue;

    // Try all available keys for this provider
    while (ctx.attempts < config.maxRetries) {
      const key = keyPool.pickKey(ctx.triedKeys, providerName);
      if (!key) {
        log.debug(`No more keys available for ${providerName}`);
        break;
      }

      ctx.triedKeys.add(key.index);
      ctx.attempts++;

      log.debug(`Attempt ${ctx.attempts}: provider=${providerName}, key=...${key.key.slice(-6)}`);

      const result = await attemptUpstream(ctx, provider, key, requestId, log);

      if (result.success) {
        // Stream completed successfully
        const latencyMs = Date.now() - startTime;
        keyPool.markSuccess(key.index, latencyMs);
        circuitBreakers.recordSuccess(providerName);
        metrics.recordRequest(result.statusCode, providerName, resolvedModel, latencyMs);
        metrics.decrementActive();

        log.info(`← ${result.statusCode} (${latencyMs}ms)`, {
          provider: providerName,
          keySuffix: `...${key.key.slice(-6)}`,
          durationMs: latencyMs,
          attempts: ctx.attempts,
        });
        return;
      }

      // Failure — decide whether to retry
      ctx.lastError = result.errorMessage || `Status ${result.statusCode}`;

      if (result.statusCode > 0) {
        // HTTP-level error
        const retryDecision = shouldRetryStatus(result.statusCode, ctx.attempts, config.maxRetries);
        keyPool.markFailure(
          key.index,
          result.errorMessage || `HTTP ${result.statusCode}`,
          result.statusCode,
          retryDecision.applyKeyCooldown ? result.rateLimitInfo : null,
        );
        circuitBreakers.recordFailure(providerName);
        metrics.recordRetry();

        if (!retryDecision.shouldRetry) {
          // Non-retryable status was already forwarded to client in attemptUpstream
          metrics.recordRequest(result.statusCode, providerName, resolvedModel, Date.now() - startTime);
          metrics.decrementActive();
          return;
        }
      } else {
        // Network-level error
        const retryDecision = shouldRetryError(result.errorMessage || 'unknown', ctx.attempts, config.maxRetries);
        keyPool.markFailure(key.index, result.errorMessage || 'network error');
        circuitBreakers.recordFailure(providerName);
        metrics.recordRetry();

        if (!retryDecision.shouldRetry) break;
      }
    }
  }

  // All providers and keys exhausted
  const latencyMs = Date.now() - startTime;
  metrics.recordRequest(503, 'none', resolvedModel, latencyMs);
  metrics.decrementActive();

  log.error('All keys and providers exhausted', {
    attempts: ctx.attempts,
    lastError: ctx.lastError,
    durationMs: latencyMs,
  });

  if (!res.headersSent) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'All API keys and providers are currently unavailable.',
        type: 'proxy_error',
        requestId,
        attempts: ctx.attempts,
        lastError: ctx.lastError,
      },
    }));
  }
}
