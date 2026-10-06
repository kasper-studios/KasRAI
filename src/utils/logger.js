import crypto from 'node:crypto';
import { logsDB } from '../db/index.js';
import { CONFIG } from '../config.js';

// Truncate large string fields to avoid runaway memory usage
function truncateField(value, maxLen = 4096) {
  if (typeof value === 'string' && value.length > maxLen) {
    return value.slice(0, maxLen) + `… [truncated ${value.length - maxLen} chars]`;
  }
  if (typeof value === 'object' && value !== null) {
    const str = JSON.stringify(value);
    if (str.length > maxLen) {
      return { _truncated: true, preview: str.slice(0, maxLen) };
    }
  }
  return value;
}

// In-memory active (in-flight) requests tracker for live UI display
const activeRequests = new Map();

export function startActiveRequest(id, data) {
  activeRequests.set(id, {
    id,
    timestamp: new Date().toISOString(),
    startTime: Date.now(),
    requestedModel: data.requestedModel || 'unknown',
    routedProvider: data.routedProvider || 'pending...',
    routedModel: data.routedModel || 'pending...',
    accountName: data.accountName || null,
    status: 'running',
    statusCode: 0,
    latencyMs: 0,
    promptTokens: data.promptTokens || 0,
    completionTokens: 0,
    totalTokens: 0,
    stream: !!data.stream,
    clientRequest: truncateField(data.clientRequest || null),
  });
}

export function updateActiveRequest(id, patch) {
  const item = activeRequests.get(id);
  if (item) {
    Object.assign(item, patch);
  }
}

export function finishActiveRequest(id) {
  activeRequests.delete(id);
}

export async function logCall(entry) {
  if (entry.requestId) {
    finishActiveRequest(entry.requestId);
  }
  try {
    const logItem = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      requestedModel: entry.requestedModel || 'unknown',
      routedProvider: entry.routedProvider || null,
      routedModel: entry.routedModel || null,
      accountName: entry.accountName || null,
      status: entry.status || 'success', // success | error | fallback
      statusCode: entry.statusCode || 200,
      latencyMs: entry.latencyMs || 0,
      promptTokens: entry.promptTokens || 0,
      completionTokens: entry.completionTokens || 0,
      totalTokens: (entry.promptTokens || 0) + (entry.completionTokens || 0),
      stream: !!entry.stream,
      error: entry.error || null,
      // Truncate potentially huge request/response bodies
      clientRequest: truncateField(entry.clientRequest || null),
      upstreamRequest: truncateField(entry.upstreamRequest || null),
      upstreamResponse: truncateField(entry.upstreamResponse || null),
    };

    const current = await logsDB.get('items');
    const items = Array.isArray(current) ? current : [];
    items.unshift(logItem);

    if (items.length > CONFIG.MAX_LOGS) {
      items.length = CONFIG.MAX_LOGS;
    }

    await logsDB.set('items', items);
    return logItem;
  } catch (err) {
    console.error('[Logger] Failed to save log entry:', err.message);
  }
}

export async function getRecentLogs(limit = 100, offset = 0) {
  const current = await logsDB.get('items');
  const items = Array.isArray(current) ? current : [];

  // Prepend currently active (in-flight) requests when viewing the first page (offset === 0)
  if (offset === 0 && activeRequests.size > 0) {
    const now = Date.now();
    const activeList = Array.from(activeRequests.values()).map((a) => ({
      ...a,
      latencyMs: now - a.startTime,
    }));
    return [...activeList, ...items.slice(0, Math.max(0, limit - activeList.length))];
  }

  return items.slice(offset, offset + limit);
}

export async function getLogById(id) {
  const current = await logsDB.get('items');
  const items = Array.isArray(current) ? current : [];
  return items.find((item) => item.id === id) || null;
}

export async function clearLogs() {
  await logsDB.set('items', []);
  return true;
}
