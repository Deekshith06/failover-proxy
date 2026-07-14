/**
 * Failover-Proxy v4.0 — Centralized Configuration
 *
 * Single source of truth for all configuration values.
 * Loads from environment variables with validation and sensible defaults.
 */

import type { ProxyConfig, ProviderConfig, KeyConfig, LogLevel } from './types';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

function envStr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`[CONFIG] Invalid integer for ${name}: "${raw}"`);
  }
  return parsed;
}



function parseKeys(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(',').map(k => k.trim()).filter(Boolean);
}

function parseLogLevel(raw: string): LogLevel {
  const normalized = raw.toLowerCase().trim() as LogLevel;
  if (LOG_LEVELS.includes(normalized)) return normalized;
  return 'info';
}

/**
 * Build provider configurations from environment variables.
 *
 * OpenRouter: Always configured if OPENROUTER_KEYS is set.
 * VibeProxy: Configured if VIBEPROXY_BASE_URL is set.
 */
function buildProviders(): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // OpenRouter (secondary in priority, but always available)
  const openrouterKeys = parseKeys(process.env.OPENROUTER_KEYS);
  if (openrouterKeys.length > 0) {
    providers.push({
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai',
      hostname: 'openrouter.ai',
      port: 443,
      useTls: true,
      apiPathPrefix: '/api/v1',
      priority: 2,
      enabled: true,
      apiKeys: openrouterKeys,
    });
  }

  // VibeProxy (primary if configured)
  const vibeproxyUrl = process.env.VIBEPROXY_BASE_URL?.trim();
  if (vibeproxyUrl) {
    const url = new URL(vibeproxyUrl);
    const vibeproxyKeys = parseKeys(process.env.VIBEPROXY_API_KEY || process.env.VIBEPROXY_KEYS);
    providers.push({
      name: 'vibeproxy',
      baseUrl: vibeproxyUrl,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
      useTls: url.protocol === 'https:',
      apiPathPrefix: url.pathname.replace(/\/$/, '') || '/v1',
      priority: 1,
      enabled: true,
      apiKeys: vibeproxyKeys.length > 0 ? vibeproxyKeys : ['none'],
    });
  }

  // Sort by priority (lower = higher priority)
  providers.sort((a, b) => a.priority - b.priority);
  return providers;
}

/**
 * Build the flat key list across all providers.
 */
function buildKeyList(providers: ProviderConfig[]): KeyConfig[] {
  const keys: KeyConfig[] = [];
  for (const p of providers) {
    for (const k of p.apiKeys) {
      keys.push({ key: k, provider: p.name });
    }
  }
  return keys;
}

/**
 * Load and validate the complete configuration.
 * Throws on fatal misconfigurations.
 */
export function loadConfig(): ProxyConfig {
  const providers = buildProviders();

  if (providers.length === 0) {
    throw new Error(
      '[FATAL] No providers configured. Set OPENROUTER_KEYS or VIBEPROXY_BASE_URL in environment.'
    );
  }

  const keys = buildKeyList(providers);
  if (keys.length === 0) {
    throw new Error(
      '[FATAL] No API keys found across any provider. Set OPENROUTER_KEYS or VIBEPROXY_KEYS.'
    );
  }

  const config: ProxyConfig = {
    port: envInt('PORT', 9000),
    requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 30000),
    cooldownMs: envInt('COOLDOWN_MS', 30000),
    maxCooldownMs: envInt('MAX_COOLDOWN_MS', 300000), // 5 minutes
    usageCacheMs: envInt('USAGE_CACHE_MS', 15000),
    maxBodyBytes: envInt('MAX_BODY_BYTES', 10 * 1024 * 1024), // 10 MB
    maxRetries: envInt('MAX_RETRIES', 10),
    bodyTimeoutMs: envInt('BODY_TIMEOUT_MS', 30000),
    modelFilterRegex: envStr('MODEL_FILTER_REGEX', 'claude'),
    shutdownGracePeriodMs: envInt('SHUTDOWN_GRACE_PERIOD_MS', 10000),
    logLevel: parseLogLevel(envStr('LOG_LEVEL', 'info')),
    providers,
    keys,
  };

  return config;
}

/** Global singleton config — initialized once at startup. */
let _config: ProxyConfig | null = null;

export function initConfig(): ProxyConfig {
  _config = loadConfig();
  return _config;
}

export function getConfig(): ProxyConfig {
  if (!_config) throw new Error('[BUG] Config not initialized. Call initConfig() first.');
  return _config;
}
