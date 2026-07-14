/**
 * Failover-Proxy v4.0 — XSS-Safe Dashboard Renderer
 *
 * Renders a rich HTML dashboard with key health, provider status,
 * circuit breaker states, metrics, and model mappings.
 *
 * Fixes Bug #13: All values are HTML-escaped before rendering.
 */

import type {
  DashboardData, DashboardKeyInfo, DashboardProviderInfo,
  DashboardEvent, ModelMapping,
} from '../types';

/**
 * HTML-escape a string to prevent XSS.
 */
function esc(str: string | number | null | undefined): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Format a number of bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format seconds into human-readable uptime.
 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function statusDot(available: boolean): string {
  return `<span class="dot ${available ? 'ok' : 'down'}"></span>`;
}

function circuitBadge(state: string): string {
  const colors: Record<string, string> = {
    'closed': 'ok',
    'open': 'down',
    'half-open': 'warn',
  };
  return `<span class="badge ${colors[state] || 'warn'}">${esc(state.toUpperCase())}</span>`;
}

function healthBar(score: number): string {
  const pct = Math.round(score * 100);
  const cls = pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'down';
  return `<div class="health-bar"><div class="health-fill ${cls}" style="width:${pct}%"></div><span>${pct}%</span></div>`;
}

function renderKeyRows(keys: DashboardKeyInfo[]): string {
  return keys.map(k => `
    <tr>
      <td>${esc(k.keySuffix)}</td>
      <td>${esc(k.provider)}</td>
      <td>${statusDot(k.available)}${k.available ? 'Available' : `Cooling (${esc(k.cooldownRemainingSec)}s)`}</td>
      <td>${healthBar(k.healthScore)}</td>
      <td>${esc(k.requestsHandledSession)}</td>
      <td>${esc(k.requestsToday)}</td>
      <td>${k.avgLatencyMs > 0 ? `${esc(k.avgLatencyMs)}ms` : '—'}</td>
      <td>${esc(k.successRate)}%</td>
      <td>${k.lastUsedAt ? esc(new Date(k.lastUsedAt).toLocaleTimeString()) : '—'}</td>
      <td>${k.lastRateLimit
        ? `${esc(k.lastRateLimit.remaining)}/${esc(k.lastRateLimit.limit)} @ ${esc(new Date(k.lastRateLimit.observedAt).toLocaleTimeString())}`
        : 'Not hit'}</td>
      <td>${(k.creditUsage != null && k.creditUsage.fetchError)
        ? `<span class="err">${esc(k.creditUsage.fetchError)}</span>`
        : (k.creditUsage != null && k.creditUsage.isFreeTier ? 'Free tier' : (k.creditUsage != null && k.creditUsage.usage !== null ? `$${esc(k.creditUsage.usage.toFixed(4))}` : '—'))}</td>
    </tr>`).join('');
}

function renderProviderRows(providers: DashboardProviderInfo[]): string {
  return providers.map(p => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${circuitBadge(p.circuitState)}</td>
      <td>${esc(p.totalRequests)}</td>
      <td>${esc(p.successRate)}%</td>
      <td>${p.avgLatencyMs > 0 ? `${esc(p.avgLatencyMs)}ms` : '—'}</td>
    </tr>`).join('');
}

function renderModelRows(models: ModelMapping[]): string {
  return models.map(m => `
    <tr>
      <td><code>${esc(m.alias)}</code></td>
      <td><code>${esc(m.target)}</code></td>
      <td>${esc(m.provider)}</td>
      <td>${esc(m.description)}</td>
    </tr>`).join('');
}

function renderEventRows(events: DashboardEvent[]): string {
  return events.map(e => `
    <tr>
      <td>${esc(new Date(e.timestamp).toLocaleTimeString())}</td>
      <td><span class="badge ${e.type === 'error' ? 'down' : e.type === 'circuit_trip' ? 'warn' : 'ok'}">${esc(e.type)}</span></td>
      <td>${esc(e.message)}</td>
    </tr>`).join('');
}

/**
 * Render the complete dashboard HTML.
 */
export function renderDashboard(data: DashboardData): string {
  const { health, metrics: m, keys, models, providers, recentEvents } = data;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Failover-Proxy v4.0 — AI Gateway Dashboard</title>
  <meta http-equiv="refresh" content="10">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
      --fg: #c9d1d9; --fg2: #8b949e; --fg3: #484f58;
      --accent: #58a6ff; --ok: #3fb950; --warn: #d29922; --down: #f85149;
      --radius: 8px; --font: 'SF Mono', Menlo, 'Cascadia Code', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--fg); font-family: var(--font); padding: 24px 32px; font-size: 13px; }
    h1 { color: var(--accent); font-size: 20px; margin-bottom: 4px; }
    .sub { color: var(--fg2); font-size: 11px; margin-bottom: 20px; }

    .status-banner {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 14px; border-radius: var(--radius);
      font-weight: 600; font-size: 12px; margin-bottom: 20px;
    }
    .status-banner.healthy { background: rgba(63, 185, 80, 0.15); color: var(--ok); border: 1px solid rgba(63, 185, 80, 0.3); }
    .status-banner.degraded { background: rgba(210, 153, 34, 0.15); color: var(--warn); border: 1px solid rgba(210, 153, 34, 0.3); }
    .status-banner.unhealthy { background: rgba(248, 81, 73, 0.15); color: var(--down); border: 1px solid rgba(248, 81, 73, 0.3); }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: var(--bg2); border: 1px solid var(--bg3); border-radius: var(--radius); padding: 14px; }
    .card .label { color: var(--fg2); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .card .value { font-size: 22px; font-weight: 700; color: var(--accent); }

    section { margin-bottom: 28px; }
    section h2 { color: var(--fg); font-size: 14px; margin-bottom: 10px; border-bottom: 1px solid var(--bg3); padding-bottom: 6px; }

    table { border-collapse: collapse; width: 100%; background: var(--bg2); border-radius: var(--radius); overflow: hidden; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--bg3); font-size: 12px; }
    th { color: var(--fg2); text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; background: var(--bg); }
    tr:last-child td { border-bottom: none; }

    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    .dot.ok { background: var(--ok); } .dot.down { background: var(--down); } .dot.warn { background: var(--warn); }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .badge.ok { background: rgba(63, 185, 80, 0.15); color: var(--ok); }
    .badge.warn { background: rgba(210, 153, 34, 0.15); color: var(--warn); }
    .badge.down { background: rgba(248, 81, 73, 0.15); color: var(--down); }

    .health-bar { position: relative; width: 80px; height: 14px; background: var(--bg3); border-radius: 7px; overflow: hidden; display: inline-block; vertical-align: middle; }
    .health-fill { height: 100%; border-radius: 7px; transition: width 0.3s; }
    .health-fill.ok { background: var(--ok); } .health-fill.warn { background: var(--warn); } .health-fill.down { background: var(--down); }
    .health-bar span { position: absolute; right: 4px; top: 0; font-size: 9px; line-height: 14px; color: var(--fg); }

    .err { color: var(--down); }
    code { background: var(--bg3); padding: 1px 5px; border-radius: 3px; font-size: 11px; }

    @media (max-width: 768px) {
      body { padding: 12px; }
      .grid { grid-template-columns: 1fr 1fr; }
      table { font-size: 11px; }
    }
  </style>
</head>
<body>
  <h1>⚡ Failover-Proxy v${esc(health.version)}</h1>
  <div class="sub">AI Gateway Dashboard · Uptime ${esc(formatUptime(health.uptime))} · Auto-refreshes every 10s</div>

  <div class="status-banner ${esc(health.status)}">
    ${statusDot(health.status === 'healthy')}
    ${esc(health.status.toUpperCase())} — ${esc(health.keys.available)}/${esc(health.keys.total)} keys available
  </div>

  <div class="grid">
    <div class="card"><div class="label">Total Requests</div><div class="value">${esc(m.totalRequests)}</div></div>
    <div class="card"><div class="label">Active Now</div><div class="value">${esc(m.activeRequests)}</div></div>
    <div class="card"><div class="label">Avg Latency</div><div class="value">${m.latency.avg > 0 ? `${esc(m.latency.avg)}ms` : '—'}</div></div>
    <div class="card"><div class="label">P95 Latency</div><div class="value">${m.latency.p95 > 0 ? `${esc(m.latency.p95)}ms` : '—'}</div></div>
    <div class="card"><div class="label">Key Rotations</div><div class="value">${esc(m.keyRotations)}</div></div>
    <div class="card"><div class="label">CB Trips</div><div class="value">${esc(m.circuitBreakerTrips)}</div></div>
    <div class="card"><div class="label">Streams OK</div><div class="value">${esc(m.streamSuccesses)}</div></div>
    <div class="card"><div class="label">Streams Fail</div><div class="value">${esc(m.streamFailures)}</div></div>
    <div class="card"><div class="label">Retries</div><div class="value">${esc(m.retryCount)}</div></div>
    <div class="card"><div class="label">Heap Used</div><div class="value">${esc(formatBytes(m.memoryUsage.heapUsed))}</div></div>
  </div>

  <section>
    <h2>🔑 API Keys</h2>
    <table>
      <tr><th>Key</th><th>Provider</th><th>Status</th><th>Health</th><th>Session</th><th>Today</th><th>Avg Latency</th><th>Success</th><th>Last Used</th><th>Rate Limit</th><th>Credits</th></tr>
      ${renderKeyRows(keys)}
    </table>
  </section>

  <section>
    <h2>🌐 Providers</h2>
    <table>
      <tr><th>Provider</th><th>Circuit Breaker</th><th>Requests</th><th>Success Rate</th><th>Avg Latency</th></tr>
      ${renderProviderRows(providers)}
    </table>
  </section>

  <section>
    <h2>🤖 Model Mappings</h2>
    <table>
      <tr><th>Alias / Input</th><th>Target Model</th><th>Provider</th><th>Description</th></tr>
      ${renderModelRows(models)}
    </table>
  </section>

  ${recentEvents.length > 0 ? `
  <section>
    <h2>📋 Recent Events</h2>
    <table>
      <tr><th>Time</th><th>Type</th><th>Message</th></tr>
      ${renderEventRows(recentEvents)}
    </table>
  </section>` : ''}

</body>
</html>`;
}
