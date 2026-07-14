/**
 * Failover-Proxy v4.0 — Shared Type Definitions
 *
 * Central type definitions for the entire AI gateway.
 * No runtime code — pure type declarations.
 */

import type { IncomingMessage, ServerResponse } from 'http';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ProxyConfig {
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
  readonly usageCacheMs: number;
  readonly maxBodyBytes: number;
  readonly maxRetries: number;
  readonly bodyTimeoutMs: number;
  readonly modelFilterRegex: string;
  readonly shutdownGracePeriodMs: number;
  readonly logLevel: LogLevel;
  readonly providers: ProviderConfig[];
  readonly keys: KeyConfig[];
}

export interface ProviderConfig {
  readonly name: string;
  readonly baseUrl: string;
  readonly hostname: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly apiPathPrefix: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly apiKeys: string[];
}

export interface KeyConfig {
  readonly key: string;
  readonly provider: string;
}

// ─── Key State ───────────────────────────────────────────────────────────────

export interface KeyState {
  readonly key: string;
  readonly index: number;
  readonly provider: string;
  cooldownUntil: number;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  requestsHandled: number;
  lastUsedAt: string | null;
  totalLatencyMs: number;
  dailyCount: number;
  dailyDate: string;
  lastRateLimit: RateLimitInfo | null;
  usageCache: KeyUsageInfo | null;
  usageCacheAt: number;
  healthScore: number;
  cooldownMultiplier: number;
  rotationHistory: RotationEvent[];
}

export interface RateLimitInfo {
  readonly limit: string | null;
  readonly remaining: string | null;
  readonly reset: string | null;
  readonly observedAt: string;
}

export interface KeyUsageInfo {
  readonly isFreeTier: boolean | null;
  readonly usage: number | null;
  readonly limit: number | null;
  readonly limitRemaining: number | null;
  readonly fetchError: string | null;
}

export interface RotationEvent {
  readonly timestamp: string;
  readonly reason: string;
  readonly statusCode?: number;
}

export type KeySelectionStrategy = 'round-robin' | 'least-used' | 'weighted-health';

// ─── Circuit Breaker ─────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly failureRateThreshold: number;
  readonly resetTimeoutMs: number;
  readonly halfOpenMaxAttempts: number;
  readonly windowMs: number;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: number;
  lastStateChange: number;
  consecutiveSuccessesInHalfOpen: number;
  windowStart: number;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfig;
  transformPath(incomingPath: string): string;
  transformRequestBody(body: Buffer, model: string): Buffer;
  parseRateLimitHeaders(headers: Record<string, string | string[] | undefined>): RateLimitInfo | null;
  getUsage(apiKey: string): Promise<KeyUsageInfo>;
  fetchModels(apiKey: string): Promise<ModelInfo[]>;
}

// ─── Model ───────────────────────────────────────────────────────────────────

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly contextLength?: number;
  readonly pricing?: {
    readonly prompt: number;
    readonly completion: number;
  };
}

export interface ModelMapping {
  readonly alias: string;
  readonly target: string;
  readonly provider: string;
  readonly description: string;
}

// ─── Proxy Request ───────────────────────────────────────────────────────────

export interface ProxyContext {
  readonly requestId: string;
  readonly startTime: number;
  readonly incomingReq: IncomingMessage;
  readonly outgoingRes: ServerResponse;
  readonly rawBody: Buffer;
  readonly method: string;
  readonly url: string;
  triedKeys: Set<number>;
  attempts: number;
  lastError: string | null;
}

// ─── Observability ───────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  readonly level: LogLevel;
  readonly timestamp: string;
  readonly message: string;
  readonly requestId?: string;
  readonly provider?: string;
  readonly keySuffix?: string;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export interface MetricsSnapshot {
  readonly uptime: number;
  readonly totalRequests: number;
  readonly activeRequests: number;
  readonly requestsByStatus: Record<number, number>;
  readonly requestsByProvider: Record<string, number>;
  readonly requestsByModel: Record<string, number>;
  readonly latency: LatencyStats;
  readonly keyRotations: number;
  readonly circuitBreakerTrips: number;
  readonly streamSuccesses: number;
  readonly streamFailures: number;
  readonly retryCount: number;
  readonly memoryUsage: NodeJS.MemoryUsage;
  readonly cpuUsage: NodeJS.CpuUsage;
}

export interface LatencyStats {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface HealthStatus {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly version: string;
  readonly uptime: number;
  readonly timestamp: string;
  readonly providers: ProviderHealth[];
  readonly keys: KeyHealthSummary;
}

export interface ProviderHealth {
  readonly name: string;
  readonly circuitState: CircuitState;
  readonly available: boolean;
}

export interface KeyHealthSummary {
  readonly total: number;
  readonly available: number;
  readonly inCooldown: number;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardData {
  readonly health: HealthStatus;
  readonly metrics: MetricsSnapshot;
  readonly keys: DashboardKeyInfo[];
  readonly models: ModelMapping[];
  readonly providers: DashboardProviderInfo[];
  readonly recentEvents: DashboardEvent[];
}

export interface DashboardKeyInfo {
  readonly keySuffix: string;
  readonly provider: string;
  readonly available: boolean;
  readonly healthScore: number;
  readonly cooldownRemainingSec: number;
  readonly requestsHandledSession: number;
  readonly requestsToday: number;
  readonly avgLatencyMs: number;
  readonly successRate: number;
  readonly lastUsedAt: string | null;
  readonly lastRateLimit: RateLimitInfo | null;
  readonly creditUsage: KeyUsageInfo | null;
}

export interface DashboardProviderInfo {
  readonly name: string;
  readonly circuitState: CircuitState;
  readonly totalRequests: number;
  readonly successRate: number;
  readonly avgLatencyMs: number;
}

export interface DashboardEvent {
  readonly timestamp: string;
  readonly type: 'key_rotation' | 'circuit_trip' | 'circuit_recovery' | 'error' | 'info';
  readonly message: string;
}
