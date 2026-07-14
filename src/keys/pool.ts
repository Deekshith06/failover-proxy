/**
 * Failover-Proxy v4.0 — Key Pool Manager
 *
 * Manages a pool of API keys across providers with multiple
 * selection strategies, cooldown awareness, and health scoring.
 */

import type { KeyState, KeyConfig, KeySelectionStrategy, RateLimitInfo } from '../types';
import {
  createKeyState, markSuccess as stateMarkSuccess,
  markFailure as stateMarkFailure, keySuffix, getAverageLatency, getSuccessRate,
} from './state';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';

export class KeyPool {
  private readonly _keys: KeyState[];
  private _rrPointer = 0;
  private readonly _baseCooldownMs: number;
  private readonly _maxCooldownMs: number;
  private readonly _strategy: KeySelectionStrategy;

  constructor(
    keyConfigs: KeyConfig[],
    baseCooldownMs: number,
    maxCooldownMs: number,
    strategy: KeySelectionStrategy = 'round-robin',
  ) {
    this._keys = keyConfigs.map((cfg, i) => createKeyState(cfg, i));
    this._baseCooldownMs = baseCooldownMs;
    this._maxCooldownMs = maxCooldownMs;
    this._strategy = strategy;
  }

  get size(): number { return this._keys.length; }

  getAllStates(): readonly KeyState[] { return this._keys; }

  /**
   * Pick the next available key, excluding already-tried indices.
   * Returns null if all keys are exhausted or in cooldown.
   */
  pickKey(exclude: Set<number>, provider?: string): KeyState | null {
    switch (this._strategy) {
      case 'round-robin':
        return this._pickRoundRobin(exclude, provider);
      case 'least-used':
        return this._pickLeastUsed(exclude, provider);
      case 'weighted-health':
        return this._pickWeightedHealth(exclude, provider);
      default:
        return this._pickRoundRobin(exclude, provider);
    }
  }

  /**
   * Round-robin selection with cooldown awareness.
   */
  private _pickRoundRobin(exclude: Set<number>, provider?: string): KeyState | null {
    const now = Date.now();
    for (let i = 0; i < this._keys.length; i++) {
      const idx = (this._rrPointer + i) % this._keys.length;
      const k = this._keys[idx];
      if (exclude.has(idx)) continue;
      if (k.cooldownUntil > now) continue;
      if (provider && k.provider !== provider) continue;
      this._rrPointer = (idx + 1) % this._keys.length;
      return k;
    }
    return null;
  }

  /**
   * Least-used selection: pick the key with the fewest requests today.
   */
  private _pickLeastUsed(exclude: Set<number>, provider?: string): KeyState | null {
    const now = Date.now();
    let best: KeyState | null = null;
    for (const k of this._keys) {
      if (exclude.has(k.index)) continue;
      if (k.cooldownUntil > now) continue;
      if (provider && k.provider !== provider) continue;
      if (!best || k.dailyCount < best.dailyCount) {
        best = k;
      }
    }
    return best;
  }

  /**
   * Weighted health selection: pick the key with the highest health score.
   */
  private _pickWeightedHealth(exclude: Set<number>, provider?: string): KeyState | null {
    const now = Date.now();
    let best: KeyState | null = null;
    for (const k of this._keys) {
      if (exclude.has(k.index)) continue;
      if (k.cooldownUntil > now) continue;
      if (provider && k.provider !== provider) continue;
      if (!best || k.healthScore > best.healthScore) {
        best = k;
      }
    }
    return best;
  }

  /**
   * Mark a key as having succeeded.
   */
  markSuccess(keyIndex: number, latencyMs: number): void {
    const k = this._keys[keyIndex];
    if (!k) return;
    stateMarkSuccess(k, latencyMs);
    logger.debug(`Key ${keySuffix(k)} succeeded`, {
      keySuffix: keySuffix(k),
      provider: k.provider,
      durationMs: latencyMs,
      healthScore: k.healthScore,
      sessionRequests: k.requestsHandled,
      dailyRequests: k.dailyCount,
    });
  }

  /**
   * Mark a key as having failed.
   */
  markFailure(
    keyIndex: number,
    reason: string,
    statusCode?: number,
    rateLimitHeaders?: RateLimitInfo | null,
  ): void {
    const k = this._keys[keyIndex];
    if (!k) return;
    stateMarkFailure(k, this._baseCooldownMs, this._maxCooldownMs, reason, statusCode, rateLimitHeaders);
    metrics.recordKeyRotation();

    const cooldownSec = Math.round((k.cooldownUntil - Date.now()) / 1000);
    logger.warn(`Key ${keySuffix(k)} failed: ${reason}`, {
      keySuffix: keySuffix(k),
      provider: k.provider,
      statusCode,
      consecutiveFailures: k.consecutiveFailures,
      cooldownSec,
      healthScore: k.healthScore,
    });
  }

  /**
   * Get keys filtered by provider.
   */
  getKeysByProvider(provider: string): KeyState[] {
    return this._keys.filter(k => k.provider === provider);
  }

  /**
   * Check if any key is available (not in cooldown, not excluded).
   */
  hasAvailableKey(exclude: Set<number>, provider?: string): boolean {
    return this.pickKey(new Set(exclude), provider) !== null;
  }

  /**
   * Get display info for a key.
   */
  getKeyInfo(k: KeyState) {
    const now = Date.now();
    return {
      keySuffix: keySuffix(k),
      provider: k.provider,
      available: k.cooldownUntil <= now,
      healthScore: k.healthScore,
      cooldownRemainingSec: Math.max(0, Math.round((k.cooldownUntil - now) / 1000)),
      requestsHandledSession: k.requestsHandled,
      requestsToday: k.dailyCount,
      avgLatencyMs: getAverageLatency(k),
      successRate: getSuccessRate(k),
      lastUsedAt: k.lastUsedAt,
      lastRateLimit: k.lastRateLimit,
      creditUsage: k.usageCache,
    };
  }
}
