import { providersDB } from '../db/index.js';
import { getValidAuthToken, OAUTH_PRESETS } from './oauth.js';
import { resolveAntigravityBaseURL } from '../adapters/antigravity.js';

export async function validateAccount(providerId, account) {
  if (!account) return { healthy: false, status: 'invalid', message: 'No account provided' };

  const start = Date.now();
  const prov = providerId.toLowerCase().trim();
  const isOAuth = account.authType === 'oauth';

  // 1. OAuth Validation & Refresh Lifecycle
  if (isOAuth) {
    const oauth = account.oauth || {};
    let token = oauth.accessToken;
    const now = Date.now();
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0;
    let wasRefreshed = false;

    // A. If token expired or close to expiring (< 2 min), refresh via the SHARED OAuth
    // lifecycle (getValidAuthToken). One refresh implementation + in-flight dedup:
    // parallel refreshes used to race each other and kill rotating refresh tokens.
    if (!token || expiresAt <= now + 120000) {
      if (!oauth.refreshToken) {
        account.status = 'invalid';
        account.invalidReason = 'Отсутствует Refresh Token и токен истек';
        await saveAccountState(providerId, account);
        return { healthy: false, status: 'invalid', latencyMs: Date.now() - start, message: account.invalidReason };
      }

      console.log(`[Validator] 🔄 Refreshing OAuth token for '${account.name}' (${providerId})...`);
      try {
        const refreshed = await getValidAuthToken(providerId, account);
        if (refreshed && refreshed !== token) {
          token = refreshed;
          wasRefreshed = true;
          console.log(`[Validator] ✅ Successfully refreshed token for '${account.name}'!`);
        } else if (!refreshed && !token) {
          // Refresh produced nothing and there is no token to probe with
          account.status = 'invalid';
          account.invalidReason = 'OAuth refresh не вернул access_token';
          await saveAccountState(providerId, account);
          return { healthy: false, status: 'invalid', latencyMs: Date.now() - start, message: account.invalidReason };
        } else {
          token = refreshed || token;
        }
      } catch (err) {
        return { healthy: false, status: 'error', latencyMs: Date.now() - start, message: `Ошибка обновления токена: ${err.message}` };
      }
    }

    // B. Probe Antigravity or Google API endpoint to verify token validity
    try {
      if (prov === 'antigravity') {
        const providerCfg = await providersDB.get(providerId);
        const probeBase = resolveAntigravityBaseURL(providerCfg?.baseURL);
        const projectId = account.projectId || oauth.projectId || 'aicode-consumers';
        const probeRes = await fetch(`${probeBase}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
            'x-client-name': 'antigravity',
            'x-client-version': '4.2.0',
          },
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(10000),
        });

        const latencyMs = Date.now() - start;
        const errText = await probeRes.text().catch(() => '');
        const errLower = errText.toLowerCase();
        const isBanned =
          errLower.includes('service has been disabled in this account') ||
          errLower.includes('terms of service') ||
          errLower.includes('account_disabled') ||
          errLower.includes('user_suspended') ||
          errLower.includes('has been disabled');

        if (isBanned) {
          account.status = 'banned';
          account.banReason = 'Google ToS violation / Service disabled';
          account.bannedAt = new Date().toISOString();
          console.error(`\n🚨 [KasRAI Alert] Account ${account.name} BANNED BY GOOGLE ToS during health-check!\n`);
          await saveAccountState(providerId, account);
          return { healthy: false, status: 'banned', latencyMs, message: 'Аккаунт забанен Google ToS (Service Disabled)' };
        }

        if (probeRes.ok) {
          account.status = 'active';
          account.invalidReason = null;
          account.health = { healthy: true, status: 'active', latencyMs, checkedAt: new Date().toISOString() };
          await saveAccountState(providerId, account);
          return { healthy: true, status: 'active', wasRefreshed, latencyMs, message: 'OAuth токен активен и валиден (200 OK)' };
        } else if (probeRes.status === 401 || probeRes.status === 403) {
          account.status = 'invalid';
          account.invalidReason = `Ошибка доступа (${probeRes.status}): токен недействителен или нет прав`;
          await saveAccountState(providerId, account);
          return { healthy: false, status: 'invalid', latencyMs, message: account.invalidReason };
        } else if (probeRes.status === 429) {
          account.status = 'cooldown';
          account.health = { healthy: true, status: 'cooldown', latencyMs, checkedAt: new Date().toISOString() };
          await saveAccountState(providerId, account);
          return { healthy: true, status: 'cooldown', latencyMs, message: 'Квота временно исчерпана (429), аккаунт на кулдауне' };
        } else {
          return { healthy: false, status: 'error', latencyMs, message: `Upstream HTTP ${probeRes.status}` };
        }
      } else {
        if (oauth.provider === 'nous') {
          const probeRes = await fetch(`${(oauth.inferenceBaseURL || OAUTH_PRESETS.nous.inferenceBaseURL).replace(/\/+$/, '')}/models`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });
          const latencyMs = Date.now() - start;
          if (probeRes.ok || probeRes.status === 429) {
            account.status = 'active';
            account.invalidReason = null;
            await saveAccountState(providerId, account);
            return { healthy: true, status: probeRes.status === 429 ? 'cooldown' : 'active', wasRefreshed, latencyMs, message: `Nous Portal inference endpoint replied HTTP ${probeRes.status}` };
          }
          if (probeRes.status === 401 || probeRes.status === 403) {
            account.status = 'invalid';
            account.invalidReason = `Nous Portal inference access rejected (${probeRes.status})`;
            await saveAccountState(providerId, account);
            return { healthy: false, status: 'invalid', wasRefreshed, latencyMs, message: account.invalidReason };
          }
          return { healthy: false, status: 'error', latencyMs, message: `Nous Portal HTTP ${probeRes.status}` };
        }

        // Generic OAuth probe via userinfo
        const probeRes = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        const latencyMs = Date.now() - start;
        if (probeRes.ok) {
          account.status = 'active';
          account.invalidReason = null;
          await saveAccountState(providerId, account);
          return { healthy: true, status: 'active', wasRefreshed, latencyMs, message: 'Аккаунт активен (200 OK)' };
        } else {
          account.status = 'invalid';
          account.invalidReason = `OAuth проверка провалена (${probeRes.status})`;
          await saveAccountState(providerId, account);
          return { healthy: false, status: 'invalid', latencyMs, message: account.invalidReason };
        }
      }
    } catch (err) {
      return { healthy: false, status: 'error', latencyMs: Date.now() - start, message: `Сетевой сбой: ${err.message}` };
    }
  }

  // 2. API Key Validation
  if (!account.apiKey) {
    account.status = 'invalid';
    account.invalidReason = 'API ключ пуст';
    await saveAccountState(providerId, account);
    return { healthy: false, status: 'invalid', latencyMs: 0, message: account.invalidReason };
  }

  const provider = await providersDB.get(providerId);
  const baseURL = provider?.baseURL || 'https://api.openai.com/v1';

  let probeUrl = `${baseURL.replace(/\/+$/, '')}/models`;
  let headers = { Authorization: `Bearer ${account.apiKey}` };

  if (prov === 'openrouter') {
    probeUrl = 'https://openrouter.ai/api/v1/auth/key';
  } else if (prov.includes('gemini')) {
    probeUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${account.apiKey}`;
    headers = {};
  } else if (prov.includes('anthropic')) {
    probeUrl = 'https://api.anthropic.com/v1/models';
    headers = {
      'x-api-key': account.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  try {
    const res = await fetch(probeUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(3500),
    });

    const latencyMs = Date.now() - start;

    if (res.ok) {
      account.status = 'active';
      account.invalidReason = null;
      account.health = { healthy: true, status: 'active', latencyMs, checkedAt: new Date().toISOString() };
      await saveAccountState(providerId, account);
      return { healthy: true, status: 'active', latencyMs, message: 'Ключ валиден и активен (200 OK)' };
    } else if (res.status === 401 || res.status === 403) {
      account.status = 'invalid';
      account.invalidReason = `Неверный или заблокированный ключ (${res.status})`;
      account.health = { healthy: false, status: 'invalid', latencyMs, checkedAt: new Date().toISOString() };
      await saveAccountState(providerId, account);
      return { healthy: false, status: 'invalid', latencyMs, message: account.invalidReason };
    } else if (res.status === 429) {
      account.status = 'cooldown';
      account.health = { healthy: true, status: 'cooldown', latencyMs, checkedAt: new Date().toISOString() };
      await saveAccountState(providerId, account);
      return { healthy: true, status: 'cooldown', latencyMs, message: 'Ключ валиден, но уперся в лимит (429)' };
    } else {
      return { healthy: false, status: 'error', latencyMs, message: `Upstream вернул ${res.status}` };
    }
  } catch (err) {
    return { healthy: false, status: 'error', latencyMs: Date.now() - start, message: `Таймаут/сетевая ошибка: ${err.message}` };
  }
}

async function saveAccountState(providerId, account) {
  const p = await providersDB.get(providerId);
  if (!p || !Array.isArray(p.accounts)) return;
  const idx = p.accounts.findIndex((a) => a.id === account.id);
  if (idx !== -1) {
    p.accounts[idx] = account;
    await providersDB.set(providerId, p);
  }
}

export async function validateAllAccounts() {
  const providers = await providersDB.getAll();
  const summary = {
    totalChecked: 0,
    healthyCount: 0,
    cooldownCount: 0,
    invalidCount: 0,
    refreshedCount: 0,
    results: [],
  };

  const tasks = [];
  for (const [pId, p] of Object.entries(providers)) {
    if (!p.enabled || !Array.isArray(p.accounts)) continue;
    for (const acc of p.accounts) {
      tasks.push({ pId, acc });
    }
  }

  summary.totalChecked = tasks.length;

  // Run with concurrency pool of 6 workers
  const CONCURRENCY = 6;
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIdx = index++;
      const { pId, acc } = tasks[currentIdx];
      const res = await validateAccount(pId, acc);

      if (res.wasRefreshed) summary.refreshedCount++;
      if (res.status === 'active') summary.healthyCount++;
      else if (res.status === 'cooldown') summary.cooldownCount++;
      else if (res.status === 'invalid') summary.invalidCount++;

      summary.results.push({
        providerId: pId,
        accountId: acc.id,
        accountName: acc.name,
        authType: acc.authType,
        ...res,
      });
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker());
  await Promise.all(workers);

  return summary;
}
