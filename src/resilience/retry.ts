/**
 * Failover-Proxy v4.0 — Retry Policy
 *
 * Determines whether a failed request should be retried based on
 * the error type, status code, and attempt count.
 */

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly reason: string;
  readonly applyKeyCooldown: boolean;
}

/**
 * Determine whether to retry a request based on the upstream response status.
 *
 * Retryable:
 *   429 — Rate limited (cooldown the key)
 *   500 — Internal server error
 *   502 — Bad gateway
 *   503 — Service unavailable
 *   504 — Gateway timeout
 *
 * Not retryable:
 *   400 — Bad request (client error, retrying won't help)
 *   401 — Unauthorized (bad key, cooldown it)
 *   403 — Forbidden
 *   404 — Not found
 *   Other 4xx — Client errors
 */
export function shouldRetryStatus(statusCode: number, attempt: number, maxRetries: number): RetryDecision {
  if (attempt >= maxRetries) {
    return { shouldRetry: false, reason: `Max retries (${maxRetries}) exceeded`, applyKeyCooldown: false };
  }

  switch (statusCode) {
    case 429:
      return { shouldRetry: true, reason: 'Rate limited (429)', applyKeyCooldown: true };
    case 500:
      return { shouldRetry: true, reason: 'Internal server error (500)', applyKeyCooldown: false };
    case 502:
      return { shouldRetry: true, reason: 'Bad gateway (502)', applyKeyCooldown: false };
    case 503:
      return { shouldRetry: true, reason: 'Service unavailable (503)', applyKeyCooldown: false };
    case 504:
      return { shouldRetry: true, reason: 'Gateway timeout (504)', applyKeyCooldown: false };
    case 401:
      return { shouldRetry: true, reason: 'Unauthorized — rotating key (401)', applyKeyCooldown: true };
    default:
      if (statusCode >= 400 && statusCode < 500) {
        return { shouldRetry: false, reason: `Client error (${statusCode})`, applyKeyCooldown: false };
      }
      if (statusCode >= 500) {
        return { shouldRetry: true, reason: `Server error (${statusCode})`, applyKeyCooldown: false };
      }
      return { shouldRetry: false, reason: `Unexpected status (${statusCode})`, applyKeyCooldown: false };
  }
}

/**
 * Determine whether to retry on a network/connection error.
 * These are always retryable (with key rotation) since the error
 * is not a definitive response from the upstream.
 */
export function shouldRetryError(errorMessage: string, attempt: number, maxRetries: number): RetryDecision {
  if (attempt >= maxRetries) {
    return { shouldRetry: false, reason: `Max retries (${maxRetries}) exceeded`, applyKeyCooldown: false };
  }

  // Timeout errors
  if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
    return { shouldRetry: true, reason: `Timeout: ${errorMessage}`, applyKeyCooldown: false };
  }

  // Connection errors
  if (
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('ECONNRESET') ||
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('EHOSTUNREACH') ||
    errorMessage.includes('socket hang up')
  ) {
    return { shouldRetry: true, reason: `Connection error: ${errorMessage}`, applyKeyCooldown: false };
  }

  // Default: retry network errors
  return { shouldRetry: true, reason: `Network error: ${errorMessage}`, applyKeyCooldown: false };
}
