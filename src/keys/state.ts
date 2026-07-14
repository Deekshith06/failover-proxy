/**
 * Failover-Proxy v4.0 — Per-Key State Tracking
 *
 * Tracks per-key metrics: success/failure counts, latency,
 * cooldown, health score, and rotation history.
 */

import type { KeyState, KeyConfig, RateLimitInfo, RotationEvent } from '../types';

const MAX_ROTATION_HISTORY = 50;

function utcDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createKeyState(config: KeyConfig, index: number): KeyState {
  return {
    key: config.key,
    index,
    provider: config.provider,
    cooldownUntil: 0,
    consecutiveFailures: 0,
    totalFailures: 0,
    totalSuccesses: 0,
    requestsHandled: 0,
    lastUsedAt: null,
    totalLatencyMs: 0,
    dailyCount: 0,
    dailyDate: utcDateStr(),
    lastRateLimit: null,
    usageCache: null,
    usageCacheAt: 0,
    healthScore: 1.0,
    cooldownMultiplier: 1,
    rotationHistory: [],
  };
}

/**
 * Bump the daily counter, resetting if the date has changed.
 */
export function bumpDaily(state: KeyState): void {
  const today = utcDateStr();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyCount = 0;
  }
  state.dailyCount++;
}

/**
 * Mark a key as having succeeded. Resets consecutive failures
 * and cooldown multiplier, updates latency and health score.
 */
export function markSuccess(state: KeyState, latencyMs: number): void {
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.cooldownMultiplier = 1;
  state.totalSuccesses++;
  state.requestsHandled++;
  state.lastUsedAt = new Date().toISOString();
  state.totalLatencyMs += latencyMs;
  bumpDaily(state);
  recalculateHealthScore(state);
}

/**
 * Mark a key as having failed. Applies cooldown with exponential backoff.
 */
export function markFailure(
  state: KeyState,
  baseCooldownMs: number,
  maxCooldownMs: number,
  reason: string,
  statusCode?: number,
  rateLimitHeaders?: RateLimitInfo | null,
): void {
  state.consecutiveFailures++;
  state.totalFailures++;

  if (rateLimitHeaders) {
    state.lastRateLimit = rateLimitHeaders;
  }

  // Exponential backoff cooldown: base * 2^(multiplier-1), capped at max
  const cooldownDuration = Math.min(
    baseCooldownMs * Math.pow(2, state.cooldownMultiplier - 1),
    maxCooldownMs,
  );
  state.cooldownUntil = Date.now() + cooldownDuration;
  state.cooldownMultiplier = Math.min(state.cooldownMultiplier + 1, 8); // cap multiplier

  // Record rotation event
  const event: RotationEvent = {
    timestamp: new Date().toISOString(),
    reason,
    statusCode,
  };
  state.rotationHistory.push(event);
  if (state.rotationHistory.length > MAX_ROTATION_HISTORY) {
    state.rotationHistory = state.rotationHistory.slice(-MAX_ROTATION_HISTORY);
  }

  recalculateHealthScore(state);
}

/**
 * Recalculate health score based on success rate, latency, and failure history.
 *
 * Score formula:
 *   healthScore = successRate * 0.4 + latencyScore * 0.3 + stabilityScore * 0.3
 *
 * Where:
 *   successRate = totalSuccesses / (totalSuccesses + totalFailures)
 *   latencyScore = 1 - min(avgLatency / 10000, 1)    (10s = worst)
 *   stabilityScore = 1 - min(consecutiveFailures / 5, 1)
 */
function recalculateHealthScore(state: KeyState): void {
  const total = state.totalSuccesses + state.totalFailures;
  if (total === 0) {
    state.healthScore = 1.0; // No data yet, assume healthy
    return;
  }

  const successRate = state.totalSuccesses / total;
  const avgLatency = state.totalSuccesses > 0
    ? state.totalLatencyMs / state.totalSuccesses
    : 10000;
  const latencyScore = 1 - Math.min(avgLatency / 10000, 1);
  const stabilityScore = 1 - Math.min(state.consecutiveFailures / 5, 1);

  state.healthScore = Math.round(
    (successRate * 0.4 + latencyScore * 0.3 + stabilityScore * 0.3) * 1000,
  ) / 1000;
}

/**
 * Compute the average latency in ms for a key.
 */
export function getAverageLatency(state: KeyState): number {
  if (state.totalSuccesses === 0) return 0;
  return Math.round(state.totalLatencyMs / state.totalSuccesses);
}

/**
 * Get the success rate as a percentage (0-100).
 */
export function getSuccessRate(state: KeyState): number {
  const total = state.totalSuccesses + state.totalFailures;
  if (total === 0) return 100;
  return Math.round((state.totalSuccesses / total) * 10000) / 100;
}

/**
 * Get the key suffix for display (last 6 chars).
 */
export function keySuffix(state: KeyState): string {
  return `...${state.key.slice(-6)}`;
}
