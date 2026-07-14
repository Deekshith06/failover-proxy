/**
 * Failover-Proxy v4.0 — Header Sanitization
 *
 * Strips hop-by-hop headers, prevents header injection,
 * and ensures proper header forwarding to upstream providers.
 *
 * Fixes Bug #11: Headers forwarded unsanitized.
 */

import type { IncomingHttpHeaders } from 'http';

/**
 * HTTP/1.1 hop-by-hop headers that MUST NOT be forwarded to upstream.
 * Per RFC 2616 §13.5.1 and RFC 7230 §6.1.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers we manage ourselves — never forward from client.
 */
const MANAGED_HEADERS = new Set([
  'host',
  'authorization',
  'content-length',
]);

/**
 * Sanitize incoming request headers for upstream forwarding.
 *
 * - Removes hop-by-hop headers
 * - Removes managed headers (host, auth, content-length — set by proxy)
 * - Removes headers with empty names or newlines (header injection prevention)
 */
export function sanitizeRequestHeaders(
  incoming: IncomingHttpHeaders,
): Record<string, string> {
  const cleaned: Record<string, string> = {};

  for (const [key, value] of Object.entries(incoming)) {
    const lowerKey = key.toLowerCase();

    // Skip hop-by-hop
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue;

    // Skip managed headers
    if (MANAGED_HEADERS.has(lowerKey)) continue;

    // Skip empty or injection-risky headers
    if (!key || key.includes('\n') || key.includes('\r')) continue;

    // Normalize value
    if (value === undefined) continue;
    const strValue = Array.isArray(value) ? value.join(', ') : value;

    // Prevent header value injection
    if (strValue.includes('\n') || strValue.includes('\r')) continue;

    cleaned[lowerKey] = strValue;
  }

  return cleaned;
}

/**
 * Build the complete set of headers for an upstream request.
 */
export function buildUpstreamHeaders(
  sanitized: Record<string, string>,
  hostname: string,
  apiKey: string,
  bodyLength: number,
  requestId: string,
): Record<string, string> {
  return {
    ...sanitized,
    'host': hostname,
    'authorization': `Bearer ${apiKey}`,
    'content-length': String(bodyLength),
    'x-request-id': requestId,
  };
}
