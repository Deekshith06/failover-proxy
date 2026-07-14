/**
 * Failover-Proxy v4.0 — Centralized Model Registry
 *
 * Single source of truth for model mappings, aliases, and validation.
 * Never hardcode model names in multiple places — all mapping goes through here.
 *
 * Responsibilities:
 * - Map Claude Code model env vars to provider-specific model IDs
 * - Support model aliases (e.g., "claude-3-5-sonnet" → configured sonnet model)
 * - Validate model existence against provider model lists
 * - Log all remapping decisions
 * - Reject unsupported mappings with clear diagnostics
 */

import type { ModelMapping, ModelInfo } from '../types';
import { logger } from '../observability/logger';

/**
 * Default model configuration for Claude Code integration.
 *
 * These map the model names that Claude Code sends to the actual
 * free models available on OpenRouter.
 */
const DEFAULT_MODEL_MAPPINGS: ModelMapping[] = [
  // Default model (ANTHROPIC_MODEL)
  {
    alias: 'nvidia/nemotron-3-super-120b-a12b:free',
    target: 'nvidia/nemotron-3-super-120b-a12b:free',
    provider: 'openrouter',
    description: 'Default model — NVIDIA Nemotron Super 120B (free)',
  },
  // Opus fallback (ANTHROPIC_DEFAULT_OPUS_MODEL)
  {
    alias: 'moonshotai/kimi-k2.6:free',
    target: 'moonshotai/kimi-k2.6:free',
    provider: 'openrouter',
    description: 'Opus fallback — Moonshot Kimi K2.6 (free)',
  },
  // Sonnet fallback (ANTHROPIC_DEFAULT_SONNET_MODEL)
  {
    alias: 'minimax/m2-5:free',
    target: 'minimax/m2-5:free',
    provider: 'openrouter',
    description: 'Sonnet fallback — MiniMax M2.5 (free)',
  },
  // Haiku fallback (ANTHROPIC_DEFAULT_HAIKU_MODEL)
  {
    alias: 'deepseek/deepseek-v4-flash:free',
    target: 'deepseek/deepseek-v4-flash:free',
    provider: 'openrouter',
    description: 'Haiku fallback — DeepSeek V4 Flash (free)',
  },
  // Subagent model (CLAUDE_CODE_SUBAGENT_MODEL)
  {
    alias: 'openai/gpt-oss-120b:free',
    target: 'openai/gpt-oss-120b:free',
    provider: 'openrouter',
    description: 'Subagent model — OpenAI GPT-OSS 120B (free)',
  },
];

/**
 * Common Claude model aliases → remapped to configured models.
 * When Claude Code sends a Claude model name, we remap it.
 */
const CLAUDE_ALIASES: Record<string, string> = {
  // Opus aliases
  'claude-3-opus-20240229': 'moonshotai/kimi-k2.6:free',
  'claude-3-opus': 'moonshotai/kimi-k2.6:free',
  'claude-opus-4-20250514': 'moonshotai/kimi-k2.6:free',
  'claude-opus-4': 'moonshotai/kimi-k2.6:free',
  // Sonnet aliases
  'claude-3-5-sonnet-20241022': 'minimax/m2-5:free',
  'claude-3-5-sonnet': 'minimax/m2-5:free',
  'claude-sonnet-4-20250514': 'minimax/m2-5:free',
  'claude-sonnet-4': 'minimax/m2-5:free',
  'claude-3-7-sonnet-20250219': 'minimax/m2-5:free',
  // Haiku aliases
  'claude-3-haiku-20240307': 'deepseek/deepseek-v4-flash:free',
  'claude-3-haiku': 'deepseek/deepseek-v4-flash:free',
  'claude-3-5-haiku-20241022': 'deepseek/deepseek-v4-flash:free',
  'claude-3-5-haiku': 'deepseek/deepseek-v4-flash:free',
};

export class ModelRegistry {
  private readonly _mappings: Map<string, ModelMapping> = new Map();
  private readonly _aliases: Map<string, string> = new Map();
  private _availableModels: Map<string, ModelInfo> = new Map();
  private _filterRegex: RegExp | null = null;

  constructor(filterRegex?: string) {
    // Load default mappings
    for (const m of DEFAULT_MODEL_MAPPINGS) {
      this._mappings.set(m.alias, m);
    }

    // Load Claude aliases
    for (const [alias, target] of Object.entries(CLAUDE_ALIASES)) {
      this._aliases.set(alias, target);
    }

    // Compile filter regex
    if (filterRegex) {
      try {
        this._filterRegex = new RegExp(filterRegex, 'i');
      } catch (e) {
        logger.warn(`Invalid MODEL_FILTER_REGEX: "${filterRegex}", ignoring`, { error: String(e) });
      }
    }
  }

  /**
   * Register available models fetched from providers.
   */
  setAvailableModels(models: ModelInfo[]): void {
    this._availableModels.clear();
    for (const m of models) {
      this._availableModels.set(m.id, m);
    }
    logger.info(`Model registry loaded ${models.length} models from providers`);
  }

  /**
   * Resolve a model name to its target model ID.
   *
   * Resolution order:
   * 1. Check Claude aliases (e.g., "claude-3-opus" → configured opus model)
   * 2. Check explicit mappings
   * 3. Pass through as-is (model is used directly)
   *
   * Logs all remapping decisions.
   */
  resolveModel(requestedModel: string): { model: string; remapped: boolean; reason: string } {
    // 1. Check Claude aliases
    const aliasTarget = this._aliases.get(requestedModel);
    if (aliasTarget) {
      logger.info(`Model remapped: "${requestedModel}" → "${aliasTarget}" (Claude alias)`, {
        requestedModel,
        resolvedModel: aliasTarget,
        reason: 'claude_alias',
      });
      return { model: aliasTarget, remapped: true, reason: `Claude alias → ${aliasTarget}` };
    }

    // 2. Check explicit mappings
    const mapping = this._mappings.get(requestedModel);
    if (mapping && mapping.target !== requestedModel) {
      logger.info(`Model remapped: "${requestedModel}" → "${mapping.target}" (${mapping.description})`, {
        requestedModel,
        resolvedModel: mapping.target,
        reason: 'explicit_mapping',
      });
      return { model: mapping.target, remapped: true, reason: mapping.description };
    }

    // 3. Pass through
    return { model: requestedModel, remapped: false, reason: 'passthrough' };
  }

  /**
   * Get the list of available models, optionally filtered.
   */
  getFilteredModels(): ModelInfo[] {
    const models = [...this._availableModels.values()];
    if (!this._filterRegex) return models;
    return models.filter(m => !this._filterRegex!.test(m.id));
  }

  /**
   * Check if a model exists in the available models list.
   */
  isModelAvailable(modelId: string): boolean {
    return this._availableModels.has(modelId);
  }

  /**
   * Get all configured model mappings for display.
   */
  getAllMappings(): ModelMapping[] {
    return [...this._mappings.values()];
  }

  /**
   * Add a custom alias.
   */
  addAlias(alias: string, target: string): void {
    this._aliases.set(alias, target);
    logger.info(`Model alias added: "${alias}" → "${target}"`);
  }

  /**
   * Validate all configured model mappings against available models.
   * Returns a list of warnings for unavailable target models.
   */
  validateMappings(): string[] {
    const warnings: string[] = [];
    if (this._availableModels.size === 0) {
      warnings.push('No models loaded from providers — cannot validate mappings');
      return warnings;
    }

    for (const [alias, mapping] of this._mappings) {
      if (!this._availableModels.has(mapping.target)) {
        const warning = `Configured model "${mapping.target}" (alias: "${alias}") not found in provider model list`;
        warnings.push(warning);
        logger.warn(warning, { alias, target: mapping.target });
      }
    }

    return warnings;
  }
}
