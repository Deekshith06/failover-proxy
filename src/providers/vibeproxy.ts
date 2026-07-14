/**
 * Failover-Proxy v4.0 — VibeProxy Provider
 *
 * VibeProxy provider implementation. Assumes an OpenAI-compatible
 * API format. Path forwarding is direct (no /api prefix needed).
 */

import https from 'https';
import http from 'http';
import type { Provider, ProviderConfig, RateLimitInfo, KeyUsageInfo, ModelInfo } from '../types';

export class VibeProxyProvider implements Provider {
  readonly name = 'vibeproxy';
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * VibeProxy uses standard OpenAI-compatible paths.
   * No transformation needed.
   */
  transformPath(incomingPath: string): string {
    // Prepend the API path prefix if configured (e.g., if base URL has a path)
    const prefix = this.config.apiPathPrefix;
    if (prefix && prefix !== '/v1' && incomingPath.startsWith('/v1/')) {
      return prefix + incomingPath.slice(3); // Replace /v1 with the prefix
    }
    return incomingPath;
  }

  /**
   * No request body transformation needed for VibeProxy.
   */
  transformRequestBody(body: Buffer, _model: string): Buffer {
    return body;
  }

  /**
   * Parse standard rate limit headers.
   */
  parseRateLimitHeaders(headers: Record<string, string | string[] | undefined>): RateLimitInfo | null {
    const limit = headers['x-ratelimit-limit'];
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];

    if (!limit && !remaining && !reset) return null;

    return {
      limit: typeof limit === 'string' ? limit : null,
      remaining: typeof remaining === 'string' ? remaining : null,
      reset: typeof reset === 'string' ? reset : null,
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * VibeProxy may not have a /key endpoint — return stub.
   */
  getUsage(_apiKey: string): Promise<KeyUsageInfo> {
    return Promise.resolve({
      isFreeTier: null,
      usage: null,
      limit: null,
      limitRemaining: null,
      fetchError: 'Usage API not available for VibeProxy',
    });
  }

  /**
   * Fetch available models from VibeProxy.
   */
  fetchModels(apiKey: string): Promise<ModelInfo[]> {
    return new Promise((resolve) => {
      const transport = this.config.useTls ? https : http;
      const req = transport.get({
        hostname: this.config.hostname,
        port: this.config.port,
        path: this.transformPath('/v1/models'),
        headers: apiKey !== 'none' ? { authorization: `Bearer ${apiKey}` } : {},
        timeout: 15000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            const models: ModelInfo[] = (json.data || []).map((m: Record<string, unknown>) => ({
              id: m.id as string,
              name: (m.name as string) || (m.id as string),
              provider: 'vibeproxy',
            }));
            resolve(models);
          } catch {
            resolve([]);
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.on('error', () => resolve([]));
    });
  }
}
