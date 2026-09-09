/**
 * Utility to extract cooldown / retry delay from upstream headers and error bodies.
 */
export function parseRetryAfterMs(responseHeaders, errorData, defaultCooldownMs = 60000) {
  // 1. Check standard 'retry-after' header (can be seconds or HTTP-date)
  if (responseHeaders) {
    const retryHeader =
      typeof responseHeaders.get === 'function'
        ? responseHeaders.get('retry-after')
        : responseHeaders['retry-after'];

    if (retryHeader) {
      const seconds = parseFloat(retryHeader);
      if (!isNaN(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1000);
      }
      const dateMs = Date.parse(retryHeader);
      if (!isNaN(dateMs) && dateMs > Date.now()) {
        return dateMs - Date.now();
      }
    }
  }

  // 2. Try regex & structured extraction from error bodies
  if (typeof errorData === 'object' && errorData !== null) {
    // Check Google RPC RetryInfo: details -> retryDelay e.g. "97206.216703528s"
    if (Array.isArray(errorData.error?.details)) {
      for (const d of errorData.error.details) {
        if (d.retryDelay && typeof d.retryDelay === 'string') {
          const s = parseFloat(d.retryDelay);
          if (!isNaN(s) && s > 0) return Math.ceil(s * 1000);
        }
        if (d.metadata?.quotaResetDelay && typeof d.metadata.quotaResetDelay === 'string') {
          const s = parseFloat(d.metadata.quotaResetDelay);
          if (!isNaN(s) && s > 0) return Math.ceil(s * 1000);
        }
        if (d.metadata?.quotaResetTimeStamp) {
          const dateMs = Date.parse(d.metadata.quotaResetTimeStamp);
          if (!isNaN(dateMs) && dateMs > Date.now()) {
            return dateMs - Date.now();
          }
        }
      }
    }
  }

  const rawText =
    typeof errorData === 'string'
      ? errorData
      : JSON.stringify(errorData || {});

  // Match e.g. "Resets in 27h0m6s", "resets in 2h"
  const hourMinMatch = rawText.match(/resets in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([0-9.]+)s)?/i);
  if (hourMinMatch && (hourMinMatch[1] || hourMinMatch[2] || hourMinMatch[3])) {
    const hours = parseInt(hourMinMatch[1] || '0', 10);
    const mins = parseInt(hourMinMatch[2] || '0', 10);
    const secs = parseFloat(hourMinMatch[3] || '0');
    const totalMs = (hours * 3600 + mins * 60 + secs) * 1000;
    if (totalMs > 0) return Math.ceil(totalMs);
  }

  // Match e.g. "try again in 14.5s", "retry after 30 seconds", "wait 12s", "reset in 5m"
  const secMatch = rawText.match(/(?:retry after|try again in|wait|resets in)\s*([0-9.]+)\s*(?:s|sec|seconds)/i);
  if (secMatch) {
    const s = parseFloat(secMatch[1]);
    if (!isNaN(s) && s > 0) return Math.ceil(s * 1000);
  }

  const minMatch = rawText.match(/(?:retry after|try again in|wait|resets in)\s*([0-9.]+)\s*(?:m|min|minutes)/i);
  if (minMatch) {
    const m = parseFloat(minMatch[1]);
    if (!isNaN(m) && m > 0) return Math.ceil(m * 60 * 1000);
  }

  // If upstream didn't tell us, return null so caller uses provider default
  return null;
}
