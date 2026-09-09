import { providersDB } from '../db/index.js';
import { getValidAuthToken, OAUTH_PRESETS } from './oauth.js';

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

    // A. If token expired or close to expiring (< 2 min), force refresh via refreshToken
    if (!token || expiresAt <= now + 120000) {
      if (!oauth.refreshToken) {
        account.status = 'invalid';
        account.invalidReason = 'Отсутствует Refresh Token и токен истек';
        await saveAccountState(providerId, account);
        return { healthy: false, status: 'invalid', latencyMs: Date.now() - start, message: account.invalidReason };
      }

      console.log(`[Validator] 🔄 Refreshing OAuth token for '${account.name}' (${providerId})...`);
      const tokenEndpoint = oauth.tokenEndpoint || OAUTH_PRESETS.antigravity.tokenUrl;
      const clientId = oauth.clientId || OAUTH_PRESETS.antigravity.clientId;
      const clientSecret = oauth.clientSecret || OAUTH_PRESETS.antigravity.clientSecret;

      try {
        let refreshRes;
        try {
          const bodyParams = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
          });
          if (clientId) bodyParams.set('client_id', clientId);
          if (clientSecret) bodyParams.set('client_secret', clientSecret);

          refreshRes = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyParams.toString(),
            signal: AbortSignal.timeout(5000),
          });
        } catch (fetchErr) {
          // Fallback to curl if Node.js undici network stack hits dual-stack IPv6/TLS timeout
          const { execSync } = await import('node:child_process');
          const curlBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(oauth.refreshToken)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
          const rawCurlOut = execSync(`curl -s -X POST "${tokenEndpoint}" -H "Content-Type: application/x-www-form-urlencoded" -d "${curlBody}"`, {
            encoding: 'utf-8',
            timeout: 10000,
          });
          const parsedCurl = JSON.parse(rawCurlOut);
          refreshRes = {
            ok: !parsedCurl.error,
            status: parsedCurl.error ? 400 : 200,
            json: async () => parsedCurl,
            text: async () => rawCurlOut,
          };
        }

        if (!refreshRes.ok) {
          const errText = await refreshRes.text();
          if (errText.includes('invalid_grant') || refreshRes.status === 400 || refreshRes.status === 401) {
            account.status = 'invalid';
            account.invalidReason = 'OAuth Refresh Token отозван или недействителен (invalid_grant)';
            await saveAccountState(providerId, account);
            return { healthy: false, status: 'invalid', latencyMs: Date.now() - start, message: account.invalidReason };
          }
          throw new Error(`Token refresh failed HTTP ${refreshRes.status}: ${errText.slice(0, 150)}`);
        }

        const tokenData = await refreshRes.json();
        token = tokenData.access_token;
        oauth.accessToken = token;
        oauth.expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
        if (tokenData.refresh_token) {
          oauth.refreshToken = tokenData.refresh_token;
        }
        account.oauth = oauth;
        wasRefreshed = true;
        console.log(`[Validator] ✅ Successfully refreshed token for '${account.name}'!`);
      } catch (err) {
        return { healthy: false, status: 'error', latencyMs: Date.now() - start, message: `Ошибка обновления токена: ${err.message}` };
      }
    }

    // B. Probe Antigravity or Google API endpoint to verify token validity
    try {
      if (prov === 'antigravity') {
        const projectId = account.projectId || oauth.projectId || 'aicode-consumers';
        const probeRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
            'x-client-name': 'antigravity',
            'x-client-version': '4.2.0',
          },
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(3500),
        });

        const latencyMs = Date.now() - start;

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
