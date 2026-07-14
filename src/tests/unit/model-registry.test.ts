/**
 * Failover-Proxy v4.0 — Model Registry Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from '../../models/registry';

describe('ModelRegistry', () => {
  it('resolves default model mappings as passthrough', () => {
    const registry = new ModelRegistry();
    const result = registry.resolveModel('nvidia/nemotron-3-super-120b-a12b:free');

    assert.equal(result.model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.equal(result.remapped, false);
  });

  it('remaps Claude opus aliases', () => {
    const registry = new ModelRegistry();
    const result = registry.resolveModel('claude-3-opus-20240229');

    assert.equal(result.model, 'moonshotai/kimi-k2.6:free');
    assert.equal(result.remapped, true);
    assert.ok(result.reason.includes('Claude alias'));
  });

  it('remaps Claude sonnet aliases', () => {
    const registry = new ModelRegistry();
    const result = registry.resolveModel('claude-3-5-sonnet-20241022');

    assert.equal(result.model, 'minimax/m2-5:free');
    assert.equal(result.remapped, true);
  });

  it('remaps Claude haiku aliases', () => {
    const registry = new ModelRegistry();
    const result = registry.resolveModel('claude-3-haiku-20240307');

    assert.equal(result.model, 'deepseek/deepseek-v4-flash:free');
    assert.equal(result.remapped, true);
  });

  it('passes through unknown models', () => {
    const registry = new ModelRegistry();
    const result = registry.resolveModel('some/custom-model');

    assert.equal(result.model, 'some/custom-model');
    assert.equal(result.remapped, false);
    assert.equal(result.reason, 'passthrough');
  });

  it('filters models by regex', () => {
    const registry = new ModelRegistry('claude');
    registry.setAvailableModels([
      { id: 'claude-3-opus', name: 'Claude 3 Opus', provider: 'openrouter' },
      { id: 'gpt-4', name: 'GPT-4', provider: 'openrouter' },
      { id: 'claude-3-sonnet', name: 'Claude 3 Sonnet', provider: 'openrouter' },
    ]);

    const filtered = registry.getFilteredModels();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'gpt-4');
  });

  it('returns all models when no filter set', () => {
    const registry = new ModelRegistry();
    registry.setAvailableModels([
      { id: 'model-a', name: 'A', provider: 'openrouter' },
      { id: 'model-b', name: 'B', provider: 'openrouter' },
    ]);

    assert.equal(registry.getFilteredModels().length, 2);
  });

  it('validates model mappings against available models', () => {
    const registry = new ModelRegistry();
    registry.setAvailableModels([
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron', provider: 'openrouter' },
      // Other configured models are NOT in the list
    ]);

    const warnings = registry.validateMappings();
    // Should warn about missing models
    assert.ok(warnings.length > 0);
  });

  it('addAlias creates new custom mappings', () => {
    const registry = new ModelRegistry();
    registry.addAlias('my-fast-model', 'nvidia/nemotron-3-super-120b-a12b:free');

    const result = registry.resolveModel('my-fast-model');
    assert.equal(result.model, 'nvidia/nemotron-3-super-120b-a12b:free');
    assert.equal(result.remapped, true);
  });

  it('isModelAvailable checks against loaded models', () => {
    const registry = new ModelRegistry();
    assert.equal(registry.isModelAvailable('any-model'), false);

    registry.setAvailableModels([
      { id: 'test-model', name: 'Test', provider: 'test' },
    ]);

    assert.equal(registry.isModelAvailable('test-model'), true);
    assert.equal(registry.isModelAvailable('missing-model'), false);
  });

  it('getAllMappings returns configured mappings', () => {
    const registry = new ModelRegistry();
    const mappings = registry.getAllMappings();

    assert.ok(mappings.length >= 5); // At least the 5 default mappings
    assert.ok(mappings.some(m => m.description.includes('Nemotron')));
  });

  it('handles invalid filter regex gracefully', () => {
    // Should not throw — just ignores the invalid regex
    const registry = new ModelRegistry('[invalid(regex');
    registry.setAvailableModels([
      { id: 'model-a', name: 'A', provider: 'test' },
    ]);

    // Without a valid filter, all models should be returned
    assert.equal(registry.getFilteredModels().length, 1);
  });
});
