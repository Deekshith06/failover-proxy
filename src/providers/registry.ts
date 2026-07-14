/**
 * Failover-Proxy v4.0 — Provider Registry
 *
 * Central registry for upstream AI providers. Providers register
 * with a priority ordering. The proxy tries providers in priority
 * order, skipping those whose circuit breaker is open.
 */

import type { Provider } from '../types';
import { logger } from '../observability/logger';

export class ProviderRegistry {
  private readonly _providers = new Map<string, Provider>();
  private _sortedNames: string[] = [];

  /**
   * Register a provider implementation.
   */
  register(provider: Provider): void {
    this._providers.set(provider.name, provider);
    // Re-sort by priority
    this._sortedNames = [...this._providers.values()]
      .sort((a, b) => a.config.priority - b.config.priority)
      .map(p => p.name);
    logger.info(`Provider registered: ${provider.name}`, { provider: provider.name, priority: provider.config.priority });
  }

  /**
   * Get a provider by name.
   */
  get(name: string): Provider | undefined {
    return this._providers.get(name);
  }

  /**
   * Get all provider names sorted by priority.
   */
  getOrderedNames(): readonly string[] {
    return this._sortedNames;
  }

  /**
   * Get all registered providers.
   */
  getAll(): Provider[] {
    return this._sortedNames.map(n => this._providers.get(n)!);
  }

  /**
   * Check if a provider is registered.
   */
  has(name: string): boolean {
    return this._providers.has(name);
  }
}
