import crypto from 'node:crypto';
import { logsDB } from '../db/index.js';
import { CONFIG } from '../config.js';

export async function logCall(entry) {
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
      clientRequest: entry.clientRequest || null,
      upstreamRequest: entry.upstreamRequest || null,
      upstreamResponse: entry.upstreamResponse || null,
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
