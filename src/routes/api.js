import express from 'express';
import crypto from 'node:crypto';
import { providersDB, routesDB, configDB } from '../db/index.js';
import { getRecentLogs, getLogById, clearLogs } from '../utils/logger.js';
import { buildOAuthUrl, exchangeOAuthCode } from '../utils/oauth.js';
import { importFromOmniroute } from '../utils/omnirouteImport.js';
import { checkAccountQuota, checkAllQuotas } from '../utils/quotaChecker.js';
import { validateAccount, validateAllAccounts } from '../utils/accountValidator.js';
import { checkProviderModels, checkAllProvidersModels } from '../utils/modelChecker.js';
import { gitUpdater } from '../utils/gitUpdater.js';
import { modelStateEngine } from '../engine/modelStateEngine.js';
import { gatewayAuth } from '../engine/gatewayAuth.js';
import { CONFIG } from '../config.js';

export const apiRouter = express.Router();

// GET /api/status - Gateway status & quick stats
apiRouter.get('/status', async (req, res) => {
  try {
    const providers = await providersDB.getAll();
    const routes = await routesDB.getAll();
    const logs = await getRecentLogs(500);

    const activeProviders = Object.values(providers).filter((p) => p.enabled);
    const totalRequests = logs.length;
    const successfulRequests = logs.filter((l) => l.status === 'success').length;
    const fallbackRequests = logs.filter((l) => l.status === 'fallback').length;
    const errorRequests = logs.filter((l) => l.status === 'error').length;

    let totalAccounts = 0;
    let cooldownAccounts = 0;
    const now = Date.now();

    for (const p of Object.values(providers)) {
      if (Array.isArray(p.accounts)) {
        totalAccounts += p.accounts.length;
        for (const a of p.accounts) {
          if (a.status === 'cooldown' && a.cooldownUntil > now) {
            cooldownAccounts++;
          }
        }
      }
    }

    const avgLatency =
      successfulRequests + fallbackRequests > 0
        ? Math.round(
            logs
              .filter((l) => l.status !== 'error')
              .reduce((acc, l) => acc + (l.latencyMs || 0), 0) /
              (successfulRequests + fallbackRequests)
          )
        : 0;

    res.json({
      status: 'online',
      version: CONFIG.VERSION,
      port: CONFIG.PORT,
      uptimeSeconds: Math.floor(process.uptime()),
      counts: {
        totalProviders: Object.keys(providers).length,
        activeProviders: activeProviders.length,
        totalRoutes: Object.keys(routes).length,
        totalAccounts,
        cooldownAccounts,
        totalRequests,
        successfulRequests,
        fallbackRequests,
        errorRequests,
        avgLatencyMs: avgLatency,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers
apiRouter.get('/providers', async (req, res) => {
  try {
    const providers = await providersDB.getAll();
    const now = Date.now();

    const safeProviders = Object.values(providers).map((p) => {
      const accounts = (p.accounts || []).map((a) => {
        const isCooldown = a.status === 'cooldown' && a.cooldownUntil > now;
        const cooldownRemainingSec = isCooldown ? Math.ceil((a.cooldownUntil - now) / 1000) : 0;
        return {
          id: a.id,
          name: a.name,
          authType: a.authType || 'key',
          status: isCooldown ? 'cooldown' : 'active',
          cooldownUntil: a.cooldownUntil || 0,
          cooldownRemainingSec,
          cooldownReason: a.cooldownReason || null,
          hasKey: !!a.apiKey,
          hasOAuth: !!(a.oauth?.accessToken || a.oauth?.refreshToken),
          maskedKey: a.apiKey ? `${a.apiKey.slice(0, 4)}...${a.apiKey.slice(-4)}` : '',
          priority: a.priority || 0,
          quota: a.quota || null,
          subscriptionTier: a.quota?.subscriptionTier || null,
          isPro: !!a.quota?.isPro,
          stats: a.stats || {},
        };
      });

      return {
        id: p.id,
        name: p.name,
        preset: p.preset || p.id,
        type: p.type || 'openai',
        baseURL: p.baseURL,
        enabled: p.enabled,
        priority: p.priority || 10,
        rateLimitCooldownSec: p.rateLimitCooldownSec || 60,
        models: p.models || [],
        accounts,
      };
    });

    res.json(safeProviders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers - Create / register new provider (API key or OAuth)
apiRouter.post('/providers', async (req, res) => {
  try {
    const { id, name, preset, type, baseURL, apiKey, authType, models, rateLimitCooldownSec } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: 'id and name are required' });
    }

    const host = req.get('host') || `localhost:${CONFIG.PORT}`;
    const redirectUri = `http://${host}/oauth/callback`;

    const newProvider = {
      id: id.toLowerCase().trim(),
      name: name.trim(),
      preset: preset || id.toLowerCase().trim(),
      type: type || (preset === 'antigravity' ? 'antigravity' : preset === 'anthropic' ? 'anthropic' : preset === 'gemini' ? 'gemini' : 'openai'),
      baseURL: baseURL || (preset === 'antigravity' ? 'https://cloudcode-pa.googleapis.com' : 'https://api.openai.com/v1'),
      enabled: true,
      priority: 15,
      rateLimitCooldownSec: parseInt(rateLimitCooldownSec || '60', 10),
      models: Array.isArray(models) ? models : ['default-model'],
      accounts: [],
    };

    if (authType === 'key' && apiKey) {
      newProvider.accounts.push({
        id: crypto.randomUUID(),
        name: 'Primary Key',
        authType: 'key',
        apiKey,
        oauth: null,
        status: 'active',
        cooldownUntil: 0,
        stats: { totalRequests: 0, successCount: 0, errorCount: 0 },
      });
      await providersDB.set(newProvider.id, newProvider);
      return res.json({ success: true, provider: newProvider });
    }

    if (authType === 'oauth') {
      await providersDB.set(newProvider.id, newProvider);
      const oauthData = buildOAuthUrl(newProvider.id, redirectUri);
      return res.json({
        success: true,
        provider: newProvider,
        authUrl: oauthData.authUrl,
        state: oauthData.state,
      });
    }

    // Default save without immediate account
    await providersDB.set(newProvider.id, newProvider);
    res.json({ success: true, provider: newProvider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/:id/oauth/authorize - Browser redirect to OAuth provider (used as href link)
apiRouter.get('/providers/:id/oauth/authorize', (req, res) => {
  try {
    const { id } = req.params;
    const host = req.get('host') || `localhost:${CONFIG.PORT}`;
    const redirectUri = `http://${host}/oauth/callback`;
    const oauthData = buildOAuthUrl(id, redirectUri);
    res.redirect(oauthData.authUrl);
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// POST /api/providers/:id/oauth/start - Start OAuth flow for provider (returns JSON)
apiRouter.post('/providers/:id/oauth/start', (req, res) => {
  try {
    const { id } = req.params;
    const host = req.get('host') || `localhost:${CONFIG.PORT}`;
    const redirectUri = `http://${host}/oauth/callback`;
    const oauthData = buildOAuthUrl(id, redirectUri);
    res.json({ success: true, authUrl: oauthData.authUrl, state: oauthData.state });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST/PUT/PATCH /api/providers/:id - Update provider settings
const handleUpdateProvider = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const existing = (await providersDB.get(id)) || { id };

    const updated = {
      ...existing,
      ...updates,
      id,
    };

    await providersDB.set(id, updated);
    res.json({ success: true, provider: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

apiRouter.post('/providers/:id', handleUpdateProvider);
apiRouter.put('/providers/:id', handleUpdateProvider);
apiRouter.patch('/providers/:id', handleUpdateProvider);

// DELETE /api/providers/:id
apiRouter.delete('/providers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await providersDB.delete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/:id/accounts - Add account manually
apiRouter.post('/providers/:id/accounts', async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await providersDB.get(id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    if (!Array.isArray(provider.accounts)) {
      provider.accounts = [];
    }

    const { name, authType, apiKey, oauth, priority } = req.body;
    const newAccount = {
      id: crypto.randomUUID(),
      name: name || `Account ${provider.accounts.length + 1}`,
      authType: authType || 'key',
      apiKey: apiKey || '',
      oauth: oauth || null,
      priority: typeof priority === 'number' ? priority : 0,
      status: 'active',
      cooldownUntil: 0,
      cooldownReason: null,
      stats: { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: null },
    };

    provider.accounts.push(newAccount);
    await providersDB.set(id, provider);
    res.json({ success: true, account: newAccount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/providers/:id/accounts/:accId - Edit account priority, key, name
apiRouter.patch('/providers/:id/accounts/:accId', async (req, res) => {
  try {
    const { id, accId } = req.params;
    const provider = await providersDB.get(id);
    if (!provider || !Array.isArray(provider.accounts)) {
      return res.status(404).json({ error: 'Provider or accounts not found' });
    }

    const acc = provider.accounts.find((a) => a.id === accId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const { name, apiKey, priority, status } = req.body;
    if (name !== undefined) acc.name = name.trim();
    if (apiKey !== undefined && apiKey.trim()) acc.apiKey = apiKey.trim();
    if (priority !== undefined) acc.priority = parseInt(priority, 10) || 0;
    if (status !== undefined) acc.status = status;

    await providersDB.set(id, provider);
    res.json({ success: true, account: acc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/providers/:id/accounts/:accId - Delete account
apiRouter.delete('/providers/:id/accounts/:accId', async (req, res) => {
  try {
    const { id, accId } = req.params;
    const provider = await providersDB.get(id);
    if (!provider || !Array.isArray(provider.accounts)) {
      return res.status(404).json({ error: 'Provider or accounts not found' });
    }

    provider.accounts = provider.accounts.filter((a) => a.id !== accId);
    await providersDB.set(id, provider);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/:id/accounts/:accId/reset-cooldown
apiRouter.post('/providers/:id/accounts/:accId/reset-cooldown', async (req, res) => {
  try {
    const { id, accId } = req.params;
    const provider = await providersDB.get(id);
    if (!provider || !Array.isArray(provider.accounts)) {
      return res.status(404).json({ error: 'Provider or accounts not found' });
    }

    const acc = provider.accounts.find((a) => a.id === accId);
    if (acc) {
      acc.status = 'active';
      acc.cooldownUntil = 0;
      acc.cooldownReason = null;
      await providersDB.set(id, provider);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cooldowns/reset - Reset all account cooldowns across all providers
apiRouter.post('/cooldowns/reset', async (req, res) => {
  try {
    const allProvidersMap = await providersDB.getAll();
    const providers = Object.values(allProvidersMap || {});
    let resetCount = 0;
    for (const p of providers) {
      if (Array.isArray(p.accounts)) {
        let changed = false;
        for (const a of p.accounts) {
          if (a.status === 'cooldown' || (a.cooldownUntil && a.cooldownUntil > 0)) {
            a.status = 'active';
            a.cooldownUntil = 0;
            a.cooldownReason = null;
            resetCount++;
            changed = true;
          }
        }
        if (changed) {
          await providersDB.set(p.id, p);
        }
      }
    }
    res.json({ ok: true, resetCount, message: `Сброшены кулдауны для ${resetCount} аккаунтов` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/health-check - Check health of all accounts and refresh OAuth tokens
apiRouter.post('/health-check', async (req, res) => {
  try {
    const summary = await validateAllAccounts();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/:id/accounts/:accId/verify - Verify single account
apiRouter.post('/providers/:id/accounts/:accId/verify', async (req, res) => {
  try {
    const { id, accId } = req.params;
    const provider = await providersDB.get(id);
    if (!provider || !Array.isArray(provider.accounts)) {
      return res.status(404).json({ error: 'Provider or accounts not found' });
    }

    const acc = provider.accounts.find((a) => a.id === accId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const result = await validateAccount(id, acc);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/quota - Check all accounts that support quota discovery
apiRouter.get('/quota', async (req, res) => {
  try {
    const quotas = await checkAllQuotas();
    res.json(quotas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/providers/:id/accounts/:accId/quota - Check single account quota
apiRouter.get('/providers/:id/accounts/:accId/quota', async (req, res) => {
  try {
    const { id, accId } = req.params;
    const provider = await providersDB.get(id);
    if (!provider || !Array.isArray(provider.accounts)) {
      return res.status(404).json({ error: 'Provider or accounts not found' });
    }

    const acc = provider.accounts.find((a) => a.id === accId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const quota = await checkAccountQuota(id, acc);
    res.json(quota);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/:id/models/check - Check and discover live models for a provider (falls back to built-in if failing/empty)
apiRouter.post('/providers/:id/models/check', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await checkProviderModels(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/models/refresh - Check and discover models for all providers
apiRouter.post('/models/refresh', async (req, res) => {
  try {
    const results = await checkAllProvidersModels();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/oauth/login/:id - Direct browser redirect to OAuth flow
apiRouter.get('/oauth/login/:id', (req, res) => {
  try {
    const { id } = req.params;
    const host = req.get('host') || `localhost:${CONFIG.PORT}`;
    const redirectUri = `http://${host}/oauth/callback`;
    const oauthData = buildOAuthUrl(id, redirectUri);
    res.redirect(oauthData.authUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/oauth/paste - Native token / refresh_token paste for VPS or CLI
apiRouter.post('/oauth/paste', async (req, res) => {
  try {
    const { provider, accessToken, refreshToken, name, projectId } = req.body;
    const providerId = (provider || 'antigravity').toLowerCase().trim();

    if (!accessToken && !refreshToken) {
      return res.status(400).json({ error: 'accessToken or refreshToken is required' });
    }

    let p = await providersDB.get(providerId);
    if (!p) {
      p = {
        id: providerId,
        name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
        preset: providerId,
        type: providerId === 'antigravity' ? 'antigravity' : 'openai',
        baseURL: providerId === 'antigravity' ? 'https://cloudcode-pa.googleapis.com' : 'https://api.openai.com/v1',
        enabled: true,
        priority: 10,
        rateLimitCooldownSec: 60,
        models: [],
        accounts: [],
      };
    }

    if (!Array.isArray(p.accounts)) p.accounts = [];

    const newAccount = {
      id: crypto.randomUUID(),
      name: name || `OAuth Account #${p.accounts.length + 1}`,
      authType: 'oauth',
      apiKey: '',
      projectId: projectId || 'aicode-consumers',
      oauth: {
        accessToken: accessToken || '',
        refreshToken: refreshToken || '',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        clientId: OAUTH_PRESETS.antigravity.clientId,
        clientSecret: OAUTH_PRESETS.antigravity.clientSecret,
      },
      status: 'active',
      cooldownUntil: 0,
      cooldownReason: null,
      stats: { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: new Date().toISOString() },
    };

    p.accounts.push(newAccount);
    await providersDB.set(providerId, p);

    res.json({
      success: true,
      message: `OAuth токен успешно сохранён для ${p.name}!`,
      account: newAccount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import/omniroute - Import providers and accounts from ~/.omniroute
apiRouter.post('/import/omniroute', async (req, res) => {
  try {
    const result = await importFromOmniroute();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/routes
apiRouter.get('/routes', async (req, res) => {
  try {
    const routes = await routesDB.getAll();
    res.json(Object.values(routes));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper for saving / updating routes
const handleSaveRoute = async (req, res) => {
  try {
    const rawAlias = req.params[0] || req.params.alias || req.body.alias || req.body.name;
    if (!rawAlias) {
      return res.status(400).json({ error: 'Route alias is required' });
    }
    const alias = decodeURIComponent(rawAlias);
    const existing = (await routesDB.get(alias)) || {};

    const { description, rotationMode, mode, targets, enabled } = req.body;
    const routeData = {
      ...existing,
      alias,
      description: description !== undefined ? description : (existing.description || ''),
      rotationMode: rotationMode || mode || existing.rotationMode || 'priority',
      rrIndex: existing.rrIndex || 0,
      targets: Array.isArray(targets) ? targets : (existing.targets || []),
      enabled: enabled !== undefined ? enabled : (existing.enabled !== false),
      updatedAt: new Date().toISOString(),
    };

    await routesDB.set(alias, routeData);
    res.json({ success: true, route: routeData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

apiRouter.post('/routes', handleSaveRoute);
apiRouter.put('/routes/*', handleSaveRoute);
apiRouter.patch('/routes/*', handleSaveRoute);

// DELETE /api/routes/*
apiRouter.delete('/routes/*', async (req, res) => {
  try {
    const rawAlias = req.params[0] || req.params.alias;
    const alias = decodeURIComponent(rawAlias);
    await routesDB.delete(alias);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs
apiRouter.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const logs = await getRecentLogs(limit, offset);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/:id - Get single detailed log item
apiRouter.get('/logs/:id', async (req, res) => {
  try {
    const log = await getLogById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🛡️ Gateway API Key & Access Protection API
// ==========================================
apiRouter.get('/auth/config', async (req, res) => {
  try {
    const conf = await gatewayAuth.getAuthConfig();
    res.json(conf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/auth/toggle', async (req, res) => {
  try {
    const { requireApiKey } = req.body;
    const conf = await gatewayAuth.setRequireApiKey(requireApiKey);
    res.json(conf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/auth/generate-key', async (req, res) => {
  try {
    const { name } = req.body;
    const result = await gatewayAuth.generateNewKey(name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 🎯 Model States & Priority Optimizer API
// ==========================================
apiRouter.get('/models/states/:providerId', async (req, res) => {
  try {
    const states = await modelStateEngine.getProviderModelStates(req.params.providerId);
    const strategy = await modelStateEngine.getProviderPriorityStrategy(req.params.providerId);
    res.json({ states, strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/models/test-record', async (req, res) => {
  try {
    const { providerId, modelId, result } = req.body;
    if (!providerId || !modelId || !result) {
      return res.status(400).json({ error: 'Missing parameters' });
    }
    const state = await modelStateEngine.recordModelTestResult(providerId, modelId, result);
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/models/clear-broken/:providerId', async (req, res) => {
  try {
    const count = await modelStateEngine.clearBrokenFlags(req.params.providerId);
    res.json({ ok: true, clearedCount: count, message: `Снят флаг нерабочих моделей (${count} шт.)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/models/strategy/:providerId', async (req, res) => {
  try {
    const { strategy } = req.body;
    const setStrategy = await modelStateEngine.setProviderPriorityStrategy(req.params.providerId, strategy);
    res.json({ ok: true, strategy: setStrategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/git/status - Get git repository and update status
apiRouter.get('/git/status', async (req, res) => {
  try {
    const status = await gitUpdater.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/git/check - Manually trigger check and pull from git remote
apiRouter.post('/git/check', async (req, res) => {
  try {
    const result = await gitUpdater.checkForUpdates();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/hermes/task - Direct task intake from Dirom (Termux Android)
apiRouter.post('/agent/hermes/task', async (req, res) => {
  try {
    const { from, task, context } = req.body;
    if (!task) {
      return res.status(400).json({ error: 'Task description is required' });
    }

    const taskItem = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      from: from || 'dirom',
      task,
      context: context || {},
      status: 'pending',
    };

    console.log(`[Inter-Agent Bus] 📥 Incoming task from '${taskItem.from}': ${taskItem.task}`);
    
    // Save to task inbox
    const tasksDbKey = 'hermes_tasks';
    const currentTasks = (await configDB.get(tasksDbKey)) || [];
    currentTasks.unshift(taskItem);
    if (currentTasks.length > 200) currentTasks.length = 200;
    await configDB.set(tasksDbKey, currentTasks);

    res.json({
      ok: true,
      taskId: taskItem.id,
      message: 'Задача принята в Hermes Task Inbox на KasRAI!',
      task: taskItem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent/hermes/tasks - Read Hermes Task Inbox
apiRouter.get('/agent/hermes/tasks', async (req, res) => {
  try {
    const tasks = (await configDB.get('hermes_tasks')) || [];
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/dirom/emit - Hermes sends event directly to Dirom Event Bus on tablet (:8767)
apiRouter.post('/agent/dirom/emit', async (req, res) => {
  try {
    const { type, source, payload } = req.body;
    const diromHost = req.query.host || '192.168.1.102:8767';
    const url = `http://${diromHost}/api/events/emit`;

    console.log(`[Inter-Agent Bus] 📤 Emitting event to Dirom at ${url}:`, type);

    const emitRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: type || 'hermes_event',
        source: source || 'hermes_desktop',
        payload: payload || {},
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await emitRes.json().catch(() => ({}));
    res.json({ ok: emitRes.ok, status: emitRes.status, diromResponse: data });
  } catch (err) {
    res.status(500).json({ error: `Failed to emit to Dirom: ${err.message}` });
  }
});
