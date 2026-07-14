/**
 * Failover-Proxy v4.0 — Header Sanitization Unit Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRequestHeaders, buildUpstreamHeaders } from '../../proxy/headers';

describe('Header Sanitization', () => {
  it('strips hop-by-hop headers', () => {
    const result = sanitizeRequestHeaders({
      'content-type': 'application/json',
      'connection': 'keep-alive',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      'upgrade': 'websocket',
      'te': 'trailers',
      'trailer': 'Max-Forwards',
      'proxy-authorization': 'Basic abc123',
      'proxy-authenticate': 'Basic',
    });

    assert.equal(result['connection'], undefined);
    assert.equal(result['keep-alive'], undefined);
    assert.equal(result['transfer-encoding'], undefined);
    assert.equal(result['upgrade'], undefined);
    assert.equal(result['te'], undefined);
    assert.equal(result['trailer'], undefined);
    assert.equal(result['proxy-authorization'], undefined);
    assert.equal(result['proxy-authenticate'], undefined);
    assert.equal(result['content-type'], 'application/json');
  });

  it('strips managed headers (host, authorization, content-length)', () => {
    const result = sanitizeRequestHeaders({
      'host': 'localhost:9000',
      'authorization': 'Bearer old-key',
      'content-length': '42',
      'content-type': 'application/json',
    });

    assert.equal(result['host'], undefined);
    assert.equal(result['authorization'], undefined);
    assert.equal(result['content-length'], undefined);
    assert.equal(result['content-type'], 'application/json');
  });

  it('rejects headers with newlines (header injection prevention)', () => {
    const result = sanitizeRequestHeaders({
      'x-normal': 'safe-value',
      'x-injected': 'value\r\nInjected-Header: evil',
      'content-type': 'application/json',
    });

    assert.equal(result['x-normal'], 'safe-value');
    assert.equal(result['x-injected'], undefined);
    assert.equal(result['content-type'], 'application/json');
  });

  it('joins array header values', () => {
    const headers: Record<string, string | string[] | undefined> = {
      'accept': ['application/json', 'text/plain'],
    };
    const result = sanitizeRequestHeaders(headers as any);

    assert.equal(result['accept'], 'application/json, text/plain');
  });

  it('normalizes header keys to lowercase', () => {
    const result = sanitizeRequestHeaders({
      'Content-Type': 'application/json',
      'X-Custom-Header': 'custom-value',
    });

    assert.equal(result['content-type'], 'application/json');
    assert.equal(result['x-custom-header'], 'custom-value');
  });

  it('skips undefined values', () => {
    const result = sanitizeRequestHeaders({
      'x-defined': 'value',
      'x-undefined': undefined,
    });

    assert.equal(result['x-defined'], 'value');
    assert.equal(result['x-undefined'], undefined);
  });
});

describe('buildUpstreamHeaders', () => {
  it('builds complete upstream headers', () => {
    const sanitized = { 'content-type': 'application/json', 'x-custom': 'value' };
    const result = buildUpstreamHeaders(sanitized, 'openrouter.ai', 'sk-test-key', 42, 'req-123');

    assert.equal(result['host'], 'openrouter.ai');
    assert.equal(result['authorization'], 'Bearer sk-test-key');
    assert.equal(result['content-length'], '42');
    assert.equal(result['x-request-id'], 'req-123');
    assert.equal(result['content-type'], 'application/json');
    assert.equal(result['x-custom'], 'value');
  });

  it('overrides any residual managed headers', () => {
    const sanitized = { 'host': 'evil.com', 'authorization': 'Bearer evil' };
    const result = buildUpstreamHeaders(sanitized, 'openrouter.ai', 'sk-good', 0, 'req-1');

    assert.equal(result['host'], 'openrouter.ai');
    assert.equal(result['authorization'], 'Bearer sk-good');
  });
});
