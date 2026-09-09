import { providersDB } from '../db/index.js';
import { getValidAuthToken } from './oauth.js';

export const BUILTIN_FALLBACK_MODELS = {
  antigravity: [
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.6-flash-high',
    'gemini-3.5-flash-high',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
  ],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o1', 'gpt-4-turbo'],
  anthropic: ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  groq: ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound', 'groq/compound-mini', 'allam-2-7b'],
  openrouter: ['google/gemini-2.5-flash', 'deepseek/deepseek-r1', 'anthropic/claude-3.7-sonnet', 'openai/gpt-4o-mini'],
  notion: [
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-opus-5',
    'claude-opus-4-8',
    'kimi-k3',
    'deepseek-v4-pro',
    'grok-4.6',
    'orange-mousse',
    'angel-cake-high',
    'agave-flan',
  ],
};

/**
 * Checks and updates models for a single provider.
 * Uses live upstream /models endpoint if available and working.
 * Falls back to built-in models ONLY if the endpoint fails or returns empty.
 */
export async function checkProviderModels(providerId) {
  const provider = await providersDB.get(providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' not found`);
  }

  const pType = (provider.preset || provider.type || provider.id).toLowerCase();
  let liveModels = [];
  let fetchError = null;

  try {
    // 1. Antigravity (Google Cloud Code)
    if (pType === 'antigravity' || provider.id === 'antigravity') {
      const activeAccount = (provider.accounts || []).find((a) => a.status === 'active' || !a.status) || provider.accounts?.[0];
      if (!activeAccount) {
        throw new Error('No active account available to check Antigravity models');
      }

      const token = await getValidAuthToken('antigravity', activeAccount);
      if (!token) throw new Error('Could not obtain valid token for Antigravity');

      const projectId = activeAccount.projectId || activeAccount.oauth?.projectId || 'aicode-consumers';
      const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
          'x-client-name': 'antigravity',
          'x-client-version': '4.2.0',
        },
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        throw new Error(`Cloud Code HTTP ${res.status}`);
      }

      const data = await res.json();
      const rawMap = data.models || {};
      liveModels = Object.keys(rawMap).filter((m) => !m.startsWith('chat_') && m.length > 2);
    }
    // 2. Anthropic
    else if (pType === 'anthropic') {
      const key = provider.apiKey || provider.accounts?.[0]?.apiKey;
      if (!key) throw new Error('No API key for Anthropic');

      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
      const data = await res.json();
      liveModels = (data.data || []).map((m) => m.id).filter(Boolean);
    }
    // 3. Gemini (Google AI Studio)
    else if (pType === 'gemini') {
      const key = provider.apiKey || provider.accounts?.[0]?.apiKey;
      if (!key) throw new Error('No API key for Gemini');

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      liveModels = (data.models || [])
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
    }
    // 4. Notion AI
    else if (pType === 'notion') {
      const activeAccount = (provider.accounts || []).find((a) => a.status === 'active' || !a.status) || provider.accounts?.[0];
      if (!activeAccount || (!activeAccount.tokenV2 && !provider.apiKey)) {
        throw new Error('No active account or tokenV2 for Notion AI');
      }

      const userId = activeAccount.userId || '';
      const spaceId = activeAccount.spaceId || '';
      const tokenV2 = activeAccount.tokenV2 || provider.apiKey;

      const res = await fetch('https://app.notion.com/api/v3/getAvailableModels', {
        method: 'POST',
        headers: {
          'Host': 'app.notion.com',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0',
          'Content-Type': 'application/json',
          'x-notion-active-user-header': userId,
          'x-notion-space-id': spaceId,
          'notion-client-version': '23.13.20260909.0411',
          'Cookie': `token_v2=${tokenV2}; notion_user_id=${userId};`,
        },
        body: JSON.stringify({ spaceId }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`Notion HTTP ${res.status}`);
      const data = await res.json();
      const list = data.models || data.availableModels || data.data || [];
      liveModels = list.map((m) => (typeof m === 'string' ? m : (m.id || m.name || m.model))).filter(Boolean);
    }
    // 5. OpenAI-compatible / Custom endpoint
    else {
      const baseURL = (provider.baseURL || '').replace(/\/+$/, '');
      if (!baseURL) throw new Error('Missing baseURL');

      const key = provider.apiKey || provider.accounts?.[0]?.apiKey;
      const headers = { 'Content-Type': 'application/json' };
      if (key) {
        headers['Authorization'] = `Bearer ${key}`;
      }

      const res = await fetch(`${baseURL}/models`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data.data || data.models || (Array.isArray(data) ? data : []);
      liveModels = list.map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
    }
  } catch (err) {
    fetchError = err.message;
  }

  // Deduplicate and filter
  liveModels = [...new Set(liveModels)].filter((m) => typeof m === 'string' && m.trim().length > 0);

  // DECISION: If live endpoint succeeded and returned models, use live!
  // Otherwise, fall back to built-in models!
  if (liveModels.length > 0) {
    provider.models = liveModels;
    provider.modelsSource = 'live';
    provider.lastModelsCheckAt = new Date().toISOString();
    provider.lastModelsCheckError = null;
    await providersDB.set(provider.id, provider);
    return {
      ok: true,
      providerId: provider.id,
      source: 'live',
      count: liveModels.length,
      models: liveModels,
    };
  }

  // FALLBACK:
  const fallbackList = BUILTIN_FALLBACK_MODELS[pType] || provider.models || ['default'];
  provider.models = fallbackList;
  provider.modelsSource = 'fallback';
  provider.lastModelsCheckAt = new Date().toISOString();
  provider.lastModelsCheckError = fetchError || 'Endpoint returned 0 models';
  await providersDB.set(provider.id, provider);

  return {
    ok: false,
    providerId: provider.id,
    source: 'fallback',
    count: fallbackList.length,
    models: fallbackList,
    error: provider.lastModelsCheckError,
  };
}

/**
 * Checks/refreshes models across all enabled providers
 */
export async function checkAllProvidersModels() {
  const allMap = await providersDB.getAll();
  const providers = Object.values(allMap || {});
  const results = [];

  for (const p of providers) {
    if (!p.enabled) continue;
    try {
      const res = await checkProviderModels(p.id);
      results.push(res);
    } catch (err) {
      results.push({
        ok: false,
        providerId: p.id,
        source: 'fallback',
        error: err.message,
      });
    }
  }

  return results;
}
