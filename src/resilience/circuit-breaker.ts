/**
 * Failover-Proxy v4.0 — Circuit Breaker
 *
 * Per-provider circuit breaker with three states:
 *   Closed  → normal traffic flows
 *   Open    → all requests fail fast, no upstream calls
 *   Half-Open → one probe request allowed; success → Closed, failure → Open
 *
 * State machine:
 *   Closed  → (failures exceed threshold) → Open
 *   Open    → (reset timeout elapsed)     → Half-Open
 *   Half-Open → (probe succeeds)          → Closed
 *   Half-Open → (probe fails)             → Open
 */

import type { CircuitState, CircuitBreakerConfig, CircuitBreakerState } from '../types';
import { logger } from '../observability/logger';
import { metrics } from '../observability/metrics';

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureRateThreshold: 0.5,
  resetTimeoutMs: 30000,
  halfOpenMaxAttempts: 1,
  windowMs: 60000,
};

class CircuitBreaker {
  readonly providerName: string;
  private readonly _config: CircuitBreakerConfig;
  private _state: CircuitBreakerState;

  constructor(providerName: string, config?: Partial<CircuitBreakerConfig>) {
    this.providerName = providerName;
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._state = {
      state: 'closed',
      failureCount: 0,
      successCount: 0,
      lastFailureAt: 0,
      lastStateChange: Date.now(),
      consecutiveSuccessesInHalfOpen: 0,
      windowStart: Date.now(),
    };
  }

  get state(): CircuitState {
    // Check if open circuit should transition to half-open
    if (this._state.state === 'open') {
      const elapsed = Date.now() - this._state.lastStateChange;
      if (elapsed >= this._config.resetTimeoutMs) {
        this._transition('half-open');
      }
    }
    return this._state.state;
  }

  /**
   * Check if a request is allowed through the circuit.
   */
  allowRequest(): boolean {
    const current = this.state; // triggers timeout-based transitions
    switch (current) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half-open':
        // Allow limited probe requests
        return this._state.consecutiveSuccessesInHalfOpen < this._config.halfOpenMaxAttempts;
    }
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    this._resetWindow();

    switch (this._state.state) {
      case 'closed':
        this._state.successCount++;
        // Reset failure count on success
        this._state.failureCount = 0;
        break;
      case 'half-open':
        this._state.consecutiveSuccessesInHalfOpen++;
        if (this._state.consecutiveSuccessesInHalfOpen >= this._config.halfOpenMaxAttempts) {
          this._transition('closed');
        }
        break;
      case 'open':
        // Shouldn't happen, but handle gracefully
        break;
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this._resetWindow();

    switch (this._state.state) {
      case 'closed':
        this._state.failureCount++;
        this._state.lastFailureAt = Date.now();
        if (this._shouldTrip()) {
          this._transition('open');
        }
        break;
      case 'half-open':
        // Probe failed — back to open
        this._transition('open');
        break;
      case 'open':
        // Already open
        this._state.lastFailureAt = Date.now();
        break;
    }
  }

  /**
   * Check if the circuit should trip from closed to open.
   */
  private _shouldTrip(): boolean {
    // Threshold-based trip
    if (this._state.failureCount >= this._config.failureThreshold) {
      return true;
    }
    // Rate-based trip (only if we have enough samples)
    const total = this._state.failureCount + this._state.successCount;
    if (total >= 10) {
      const failureRate = this._state.failureCount / total;
      if (failureRate >= this._config.failureRateThreshold) {
        return true;
      }
    }
    return false;
  }

  /**
   * Reset the sliding window if it has expired.
   */
  private _resetWindow(): void {
    const now = Date.now();
    if (now - this._state.windowStart >= this._config.windowMs) {
      this._state.failureCount = 0;
      this._state.successCount = 0;
      this._state.windowStart = now;
    }
  }

  /**
   * Transition to a new state.
   */
  private _transition(newState: CircuitState): void {
    const oldState = this._state.state;
    if (oldState === newState) return;

    logger.info(`Circuit breaker [${this.providerName}]: ${oldState} → ${newState}`, {
      provider: this.providerName,
      oldState,
      newState,
      failureCount: this._state.failureCount,
    });

    if (newState === 'open') {
      metrics.recordCircuitBreakerTrip();
    }

    this._state.state = newState;
    this._state.lastStateChange = Date.now();

    if (newState === 'closed') {
      this._state.failureCount = 0;
      this._state.successCount = 0;
      this._state.consecutiveSuccessesInHalfOpen = 0;
      this._state.windowStart = Date.now();
    }

    if (newState === 'half-open') {
      this._state.consecutiveSuccessesInHalfOpen = 0;
    }
  }

  /**
   * Force-reset the circuit breaker (for admin use).
   */
  reset(): void {
    this._transition('closed');
    this._state.failureCount = 0;
    this._state.successCount = 0;
  }
}

/**
 * Manages circuit breakers for all providers.
 */
export class CircuitBreakerManager {
  private readonly _breakers = new Map<string, CircuitBreaker>();

  /**
   * Register a circuit breaker for a provider.
   */
  register(providerName: string, config?: Partial<CircuitBreakerConfig>): void {
    if (!this._breakers.has(providerName)) {
      this._breakers.set(providerName, new CircuitBreaker(providerName, config));
    }
  }

  /**
   * Get the current state of a provider's circuit breaker.
   */
  getState(providerName: string): CircuitState {
    const cb = this._breakers.get(providerName);
    return cb ? cb.state : 'closed';
  }

  /**
   * Check if a request to the provider is allowed.
   */
  allowRequest(providerName: string): boolean {
    const cb = this._breakers.get(providerName);
    return cb ? cb.allowRequest() : true;
  }

  /**
   * Record a successful request to the provider.
   */
  recordSuccess(providerName: string): void {
    this._breakers.get(providerName)?.recordSuccess();
  }

  /**
   * Record a failed request to the provider.
   */
  recordFailure(providerName: string): void {
    this._breakers.get(providerName)?.recordFailure();
  }

  /**
   * Force-reset a provider's circuit breaker.
   */
  reset(providerName: string): void {
    this._breakers.get(providerName)?.reset();
  }

  /**
   * Get all circuit breaker states for dashboard display.
   */
  getAllStates(): Record<string, CircuitState> {
    const result: Record<string, CircuitState> = {};
    for (const [name, cb] of this._breakers) {
      result[name] = cb.state;
    }
    return result;
  }
}
