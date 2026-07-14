/**
 * Failover-Proxy v4.0 — Bootstrap Entry Point
 *
 * Initializes all components in dependency order:
 *   1. Configuration
 *   2. Logger
 *   3. Key Pool
 *   4. Circuit Breakers
 *   5. Provider Registry
 *   6. Model Registry
 *   7. HTTP Server
 *
 * Sets up global error handlers that log but never crash the process.
 */

import { initConfig } from './config';
import { setLogLevel, logger } from './observability/logger';
import { KeyPool } from './keys/pool';
import { CircuitBreakerManager } from './resilience/circuit-breaker';
import { ProviderRegistry } from './providers/registry';
import { OpenRouterProvider } from './providers/openrouter';
import { VibeProxyProvider } from './providers/vibeproxy';
import { ModelRegistry } from './models/registry';
import { createServer, addEvent } from './server';

async function main(): Promise<void> {
  // ── 1. Configuration ───────────────────────────────────────────────
  const config = initConfig();
  setLogLevel(config.logLevel);

  logger.info('Failover-Proxy v4.0 starting...', {
    port: config.port,
    providers: config.providers.map(p => p.name),
    totalKeys: config.keys.length,
  });

  // ── 2. Key Pool ────────────────────────────────────────────────────
  const keyPool = new KeyPool(
    config.keys,
    config.cooldownMs,
    config.maxCooldownMs,
    'round-robin',
  );
  logger.info(`Key pool initialized: ${keyPool.size} key(s)`);

  // ── 3. Circuit Breakers ────────────────────────────────────────────
  const circuitBreakers = new CircuitBreakerManager();
  for (const p of config.providers) {
    circuitBreakers.register(p.name);
  }
  logger.info(`Circuit breakers registered for ${config.providers.length} provider(s)`);

  // ── 4. Provider Registry ───────────────────────────────────────────
  const providerRegistry = new ProviderRegistry();
  for (const p of config.providers) {
    switch (p.name) {
      case 'openrouter':
        providerRegistry.register(new OpenRouterProvider(p));
        break;
      case 'vibeproxy':
        providerRegistry.register(new VibeProxyProvider(p));
        break;
      default:
        logger.warn(`Unknown provider type: ${p.name}, skipping`);
    }
  }

  // ── 5. Model Registry ─────────────────────────────────────────────
  const modelRegistry = new ModelRegistry(config.modelFilterRegex);

  // Fetch models from providers at startup (best-effort)
  logger.info('Fetching available models from providers...');
  const allModels = [];
  for (const provider of providerRegistry.getAll()) {
    try {
      const firstKey = keyPool.getKeysByProvider(provider.name)[0];
      if (firstKey) {
        const models = await provider.fetchModels(firstKey.key);
        allModels.push(...models);
        logger.info(`Loaded ${models.length} models from ${provider.name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to fetch models from ${provider.name}: ${msg}`);
    }
  }
  modelRegistry.setAvailableModels(allModels);

  // Validate configured model mappings
  const warnings = modelRegistry.validateMappings();
  for (const w of warnings) {
    addEvent('info', w);
  }

  // ── 6. HTTP Server ─────────────────────────────────────────────────
  const server = createServer(config, keyPool, providerRegistry, circuitBreakers, modelRegistry);

  server.listen(config.port, () => {
    logger.info(`Proxy listening on :${config.port}`, {
      dashboardUrl: `http://localhost:${config.port}/dashboard`,
      healthUrl: `http://localhost:${config.port}/health`,
      metricsUrl: `http://localhost:${config.port}/metrics`,
    });
    addEvent('info', `Proxy started on port ${config.port}`);
  });

  server.on('error', (err) => {
    logger.fatal(`Server error: ${err.message}`, { error: err.message });
    if ('code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      logger.fatal(`Port ${config.port} is already in use`);
      process.exit(1);
    }
  });

  // ── 7. Global Error Handlers ───────────────────────────────────────
  // These MUST never crash the process. Log and continue.
  process.on('uncaughtException', (err) => {
    logger.error(`[uncaughtException] ${err.message}`, {
      error: err.message,
      stack: err.stack,
    });
    addEvent('error', `Uncaught exception: ${err.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error(`[unhandledRejection] ${message}`, { error: message });
    addEvent('error', `Unhandled rejection: ${message}`);
  });
}

main().catch((err) => {
  console.error('[FATAL] Failed to start proxy:', err);
  process.exit(1);
});
