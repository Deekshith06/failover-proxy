/**
 * Failover-Proxy v4.0 — Thin Wrapper
 *
 * This file exists for backward compatibility with `npm start` and
 * the shell scripts. It simply loads the compiled TypeScript output.
 *
 * For development, use: npm run dev (runs with tsx directly)
 * For production, use: npm run build && npm start
 */
require('./dist/index.js');
