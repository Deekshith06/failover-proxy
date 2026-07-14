/**
 * Failover-Proxy v4.0 — In-Memory Metrics Collector
 *
 * Tracks request counts, latencies, errors, and system metrics.
 * Exposed via /metrics endpoint in JSON and Prometheus-compatible text format.
 * No external dependencies — pure in-memory with periodic GC of old data.
 */

import type { MetricsSnapshot, LatencyStats } from '../types';

const MAX_LATENCY_SAMPLES = 10000;

class MetricsCollector {
  private _startTime = Date.now();
  private _totalRequests = 0;
  private _activeRequests = 0;
  private _requestsByStatus: Record<number, number> = {};
  private _requestsByProvider: Record<string, number> = {};
  private _requestsByModel: Record<string, number> = {};
  private _latencySamples: number[] = [];
  private _keyRotations = 0;
  private _circuitBreakerTrips = 0;
  private _streamSuccesses = 0;
  private _streamFailures = 0;
  private _retryCount = 0;
  private _lastCpuUsage = process.cpuUsage();

  // ── Increment Methods ──────────────────────────────────────────────

  recordRequest(statusCode: number, provider: string, model: string, latencyMs: number): void {
    this._totalRequests++;
    this._requestsByStatus[statusCode] = (this._requestsByStatus[statusCode] || 0) + 1;
    this._requestsByProvider[provider] = (this._requestsByProvider[provider] || 0) + 1;
    if (model) {
      this._requestsByModel[model] = (this._requestsByModel[model] || 0) + 1;
    }
    this.addLatencySample(latencyMs);
  }

  incrementActive(): void { this._activeRequests++; }
  decrementActive(): void { this._activeRequests = Math.max(0, this._activeRequests - 1); }
  recordKeyRotation(): void { this._keyRotations++; }
  recordCircuitBreakerTrip(): void { this._circuitBreakerTrips++; }
  recordStreamSuccess(): void { this._streamSuccesses++; }
  recordStreamFailure(): void { this._streamFailures++; }
  recordRetry(): void { this._retryCount++; }

  private addLatencySample(ms: number): void {
    this._latencySamples.push(ms);
    // Evict oldest samples when buffer is full
    if (this._latencySamples.length > MAX_LATENCY_SAMPLES) {
      this._latencySamples = this._latencySamples.slice(-MAX_LATENCY_SAMPLES);
    }
  }

  // ── Snapshot ───────────────────────────────────────────────────────

  private computeLatencyStats(): LatencyStats {
    const samples = this._latencySamples;
    if (samples.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round(sum / sorted.length),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  snapshot(): MetricsSnapshot {
    return {
      uptime: Math.round((Date.now() - this._startTime) / 1000),
      totalRequests: this._totalRequests,
      activeRequests: this._activeRequests,
      requestsByStatus: { ...this._requestsByStatus },
      requestsByProvider: { ...this._requestsByProvider },
      requestsByModel: { ...this._requestsByModel },
      latency: this.computeLatencyStats(),
      keyRotations: this._keyRotations,
      circuitBreakerTrips: this._circuitBreakerTrips,
      streamSuccesses: this._streamSuccesses,
      streamFailures: this._streamFailures,
      retryCount: this._retryCount,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(this._lastCpuUsage),
    };
  }

  /**
   * Serialize metrics in Prometheus text exposition format.
   */
  toPrometheus(): string {
    const s = this.snapshot();
    const lines: string[] = [];

    lines.push('# HELP failover_proxy_uptime_seconds Proxy uptime in seconds');
    lines.push('# TYPE failover_proxy_uptime_seconds gauge');
    lines.push(`failover_proxy_uptime_seconds ${s.uptime}`);

    lines.push('# HELP failover_proxy_requests_total Total requests processed');
    lines.push('# TYPE failover_proxy_requests_total counter');
    lines.push(`failover_proxy_requests_total ${s.totalRequests}`);

    lines.push('# HELP failover_proxy_active_requests Current in-flight requests');
    lines.push('# TYPE failover_proxy_active_requests gauge');
    lines.push(`failover_proxy_active_requests ${s.activeRequests}`);

    lines.push('# HELP failover_proxy_requests_by_status_total Requests by HTTP status');
    lines.push('# TYPE failover_proxy_requests_by_status_total counter');
    for (const [code, count] of Object.entries(s.requestsByStatus)) {
      lines.push(`failover_proxy_requests_by_status_total{status="${code}"} ${count}`);
    }

    lines.push('# HELP failover_proxy_requests_by_provider_total Requests by provider');
    lines.push('# TYPE failover_proxy_requests_by_provider_total counter');
    for (const [prov, count] of Object.entries(s.requestsByProvider)) {
      lines.push(`failover_proxy_requests_by_provider_total{provider="${prov}"} ${count}`);
    }

    lines.push('# HELP failover_proxy_latency_ms Request latency');
    lines.push('# TYPE failover_proxy_latency_ms summary');
    lines.push(`failover_proxy_latency_ms{quantile="0.5"} ${s.latency.p50}`);
    lines.push(`failover_proxy_latency_ms{quantile="0.95"} ${s.latency.p95}`);
    lines.push(`failover_proxy_latency_ms{quantile="0.99"} ${s.latency.p99}`);
    lines.push(`failover_proxy_latency_ms_count ${s.latency.count}`);

    lines.push('# HELP failover_proxy_key_rotations_total Key rotation events');
    lines.push('# TYPE failover_proxy_key_rotations_total counter');
    lines.push(`failover_proxy_key_rotations_total ${s.keyRotations}`);

    lines.push('# HELP failover_proxy_circuit_breaker_trips_total Circuit breaker trips');
    lines.push('# TYPE failover_proxy_circuit_breaker_trips_total counter');
    lines.push(`failover_proxy_circuit_breaker_trips_total ${s.circuitBreakerTrips}`);

    lines.push('# HELP failover_proxy_stream_successes_total Successful stream completions');
    lines.push('# TYPE failover_proxy_stream_successes_total counter');
    lines.push(`failover_proxy_stream_successes_total ${s.streamSuccesses}`);

    lines.push('# HELP failover_proxy_stream_failures_total Failed stream completions');
    lines.push('# TYPE failover_proxy_stream_failures_total counter');
    lines.push(`failover_proxy_stream_failures_total ${s.streamFailures}`);

    lines.push('# HELP failover_proxy_retries_total Total retry attempts');
    lines.push('# TYPE failover_proxy_retries_total counter');
    lines.push(`failover_proxy_retries_total ${s.retryCount}`);

    lines.push('# HELP failover_proxy_memory_rss_bytes Resident set size');
    lines.push('# TYPE failover_proxy_memory_rss_bytes gauge');
    lines.push(`failover_proxy_memory_rss_bytes ${s.memoryUsage.rss}`);

    lines.push('# HELP failover_proxy_memory_heap_used_bytes V8 heap used');
    lines.push('# TYPE failover_proxy_memory_heap_used_bytes gauge');
    lines.push(`failover_proxy_memory_heap_used_bytes ${s.memoryUsage.heapUsed}`);

    return lines.join('\n') + '\n';
  }
}

/** Global singleton metrics collector. */
export const metrics = new MetricsCollector();
