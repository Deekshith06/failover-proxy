/**
 * Failover-Proxy v4.0 — OpenRouter Provider
 *
 * OpenRouter-specific implementation: path mapping, rate limit parsing,
 * usage fetching, and model listing.
 */

import https from 'https';
import type { Provider, ProviderConfig, RateLimitInfo, KeyUsageInfo, ModelInfo } from '../types';

export class OpenRouterProvider implements Provider {
  readonly name = 'openrouter';
  readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * Transform incoming API paths to OpenRouter's path format.
   *
   * /v1/messages       → /api/v1/messages
   * /v1/chat/completions → /api/v1/chat/completions
   * /v1/models         → /api/v1/models
   * /v1/*              → /api/v1/*
   */
  transformPath(incomingPath: string): string {
    // Strip query string for matching, re-attach after
    const [pathPart, queryPart] = incomingPath.split('?');
    let transformed = pathPart;

    // OpenRouter prefixes all API paths with /api
    if (transformed.startsWith('/v1/')) {
      transformed = '/api' + transformed;
    } else if (!transformed.startsWith('/api/')) {
      transformed = '/api/v1' + transformed;
    }

    return queryPart ? `${transformed}?${queryPart}` : transformed;
  }

  /**
   * OpenRouter uses standard request bodies — no transformation needed.
   */
  transformRequestBody(body: Buffer, _model: string): Buffer {
    return body;
  }

  /**
   * Parse OpenRouter rate limit headers from the response.
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
   * Fetch API key usage info from OpenRouter.
   */
  getUsage(apiKey: string): Promise<KeyUsageInfo> {
    return new Promise((resolve) => {
      const req = https.get({
        hostname: this.config.hostname,
        port: this.config.port,
        path: '/api/v1/key',
        headers: { authorization: `Bearer ${apiKey}` },
        timeout: 8000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              resolve({ isFreeTier: null, usage: null, limit: null, limitRemaining: null, fetchError: `HTTP ${res.statusCode}` });
              return;
            }
            const data = JSON.parse(Buffer.concat(chunks).toString()).data || {};
            resolve({
              isFreeTier: data.is_free_tier ?? null,
              usage: data.usage ?? null,
              limit: data.limit ?? null,
              limitRemaining: data.limit_remaining ?? null,
              fetchError: null,
            });
          } catch {
            resolve({ isFreeTier: null, usage: null, limit: null, limitRemaining: null, fetchError: 'Failed to parse /key response' });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ isFreeTier: null, usage: null, limit: null, limitRemaining: null, fetchError: 'Timed out' }); });
      req.on('error', (e) => resolve({ isFreeTier: null, usage: null, limit: null, limitRemaining: null, fetchError: e.message }));
    });
  }

  /**
   * Fetch available models from OpenRouter.
   */
  fetchModels(apiKey: string): Promise<ModelInfo[]> {
    return new Promise((resolve) => {
      const req = https.get({
        hostname: this.config.hostname,
        port: this.config.port,
        path: '/api/v1/models',
        headers: { authorization: `Bearer ${apiKey}` },
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
              provider: 'openrouter',
              contextLength: (m.context_length as number) || undefined,
              pricing: m.pricing ? {
                prompt: (m.pricing as Record<string, number>).prompt || 0,
                completion: (m.pricing as Record<string, number>).completion || 0,
              } : undefined,
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
