import { CONFIG } from '../config.js';

const MIN_MS = 1000;
const MAX_MS = 600000;

/**
 * Resolve one timeout value with priority: request payload field > provider config field > global default.
 * Invalid / out-of-range values are ignored (fall through to the next level).
 */
function _pick(requestVal, providerVal, defaultVal) {
  for (const v of [requestVal, providerVal]) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= MIN_MS && n <= MAX_MS) return n;
  }
  return defaultVal;
}

/**
 * Resolve effective timeouts for a routing attempt.
 *
 * Priority: request body fields (`first_chunk_timeout_ms`, `timeout_ms`, `idle_timeout_ms`)
 * -> provider config fields (`firstChunkTimeoutMs`, `completionTimeoutMs`, `idleTimeoutMs`)
 * -> CONFIG env defaults.
 *
 * @param {object|null} requestPayload  client request body (may carry *_timeout_ms overrides)
 * @param {object|null} provider        provider config (may carry *TimeoutMs fields)
 * @returns {{firstChunkMs: number, completionMs: number, idleMs: number}}
 */
export function resolveTimeouts(requestPayload, provider) {
  return {
    firstChunkMs: _pick(
      requestPayload?.first_chunk_timeout_ms,
      provider?.firstChunkTimeoutMs,
      CONFIG.FIRST_CHUNK_TIMEOUT_MS,
    ),
    completionMs: _pick(
      requestPayload?.timeout_ms,
      provider?.completionTimeoutMs,
      CONFIG.COMPLETION_TIMEOUT_MS,
    ),
    idleMs: _pick(
      requestPayload?.idle_timeout_ms,
      provider?.idleTimeoutMs,
      CONFIG.STREAM_IDLE_TIMEOUT_MS,
    ),
  };
}

/**
 * Strip client-side timeout override fields so they never leak into upstream payloads.
 */
export function stripTimeoutFields(requestPayload) {
  if (!requestPayload || typeof requestPayload !== 'object') return requestPayload;
  const { first_chunk_timeout_ms, timeout_ms, idle_timeout_ms, ...rest } = requestPayload;
  return rest;
}
