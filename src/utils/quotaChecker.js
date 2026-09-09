import { providersDB } from '../db/index.js';
import { getValidAuthToken } from './oauth.js';

/**
 * Live quota and tier checker for providers and accounts
 */
export async function checkAccountQuota(providerId, account) {
  if (!account) return { supported: false, message: 'Account not found' };

  const prov = providerId.toLowerCase().trim();

  // 1. Antigravity (Google Cloud Code)
  if (prov === 'antigravity') {
    try {
      const token = await getValidAuthToken('antigravity', account);
      if (!token) {
        return { supported: true, ok: false, error: 'No valid token available' };
      }

      const projectId = account.projectId || account.oauth?.projectId || 'aicode-consumers';
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
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          supported: true,
          ok: false,
          status: res.status,
          error: errText.slice(0, 300),
        };
      }

      const data = await res.json();
      const models = data.models || {};
      const modelsQuota = {};

      // 1. Check real-time usage consumption via retrieveUserQuota
      // fetchAvailableModels only shows static catalog quotaInfo where remainingFraction is often omitted/stale.
      // retrieveUserQuota is the single source of truth for actual remaining fraction & reset timestamps!
      const userQuotaMap = new Map();
      try {
        const uqRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
            'x-client-name': 'antigravity',
            'x-client-version': '4.2.0',
          },
          body: JSON.stringify({ project: projectId }),
          signal: AbortSignal.timeout(6000),
        });
        if (uqRes.ok) {
          const uqData = await uqRes.json();
          if (Array.isArray(uqData.buckets)) {
            for (const b of uqData.buckets) {
              if (b.modelId) {
                userQuotaMap.set(b.modelId, {
                  remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
                  resetTime: b.resetTime || null,
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[QuotaChecker] retrieveUserQuota non-fatal warning for ${account.name}: ${err.message}`);
      }

      let totalFraction = 0;
      let count = 0;
      let earliestResetTime = null;

      for (const [mId, mInfo] of Object.entries(models)) {
        if (mInfo.quotaInfo || userQuotaMap.has(mId)) {
          const liveInfo = userQuotaMap.get(mId);
          let frac;
          if (liveInfo && liveInfo.remainingFraction !== null) {
            frac = liveInfo.remainingFraction;
          } else if (typeof mInfo.quotaInfo?.remainingFraction === 'number') {
            frac = mInfo.quotaInfo.remainingFraction;
          } else if (mInfo.quotaInfo?.resetTime || liveInfo?.resetTime) {
            // Upstream reported a resetTime with no fraction => quota is exhausted (0)
            frac = 0;
          } else {
            // Truly unlimited model with no reset time
            frac = 1;
          }

          const resetTime = liveInfo?.resetTime || mInfo.quotaInfo?.resetTime || null;

          modelsQuota[mId] = {
            displayName: mInfo.displayName || mId,
            remainingFraction: frac,
            remainingPercent: Math.round(frac * 100),
            resetTime,
          };
          totalFraction += frac;
          count++;

          if (resetTime) {
            const rDate = new Date(resetTime);
            if (!earliestResetTime || rDate < new Date(earliestResetTime)) {
              earliestResetTime = resetTime;
            }
          }
        }
      }

      // Query loadCodeAssist for subscription tier info
      let subscriptionTier = 'Free';
      let isPro = false;
      try {
        const subRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
            'x-client-name': 'antigravity',
            'x-client-version': '4.2.0',
          },
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', ideVersion: '4.2.0' } }),
          signal: AbortSignal.timeout(6000),
        });
        if (subRes.ok) {
          const subData = await subRes.json();
          const paid = subData.paidTier || subData.subscriptionInfo?.paidTier;
          const current = subData.currentTier || subData.subscriptionInfo?.currentTier;

          if (paid?.id === 'g1-pro-tier' || paid?.name?.includes('Pro') || paid?.id?.includes('pro')) {
            isPro = true;
            subscriptionTier = paid.name || 'Google AI Pro';
          } else if (paid?.name) {
            subscriptionTier = paid.name;
          } else if (current?.name) {
            subscriptionTier = current.name;
          } else {
            subscriptionTier = 'Antigravity Free';
          }
        }
      } catch {}

      const avgPercent = count > 0 ? Math.round((totalFraction / count) * 100) : 100;

      const quotaResult = {
        supported: true,
        ok: true,
        provider: 'antigravity',
        accountId: account.id,
        accountName: account.name,
        subscriptionTier,
        isPro,
        remainingPercent: avgPercent,
        resetTime: earliestResetTime,
        checkedAt: new Date().toISOString(),
        modelsQuota,
      };

      // Update in providersDB
      const provider = await providersDB.get('antigravity');
      if (provider && Array.isArray(provider.accounts)) {
        const accIdx = provider.accounts.findIndex((a) => a.id === account.id);
        if (accIdx !== -1) {
          provider.accounts[accIdx].quota = quotaResult;
          await providersDB.set('antigravity', provider);
        }
      }

      return quotaResult;
    } catch (err) {
      return { supported: true, ok: false, error: err.message };
    }
  }

  // 2. OpenRouter
  if (prov === 'openrouter') {
    if (!account.apiKey) return { supported: true, ok: false, error: 'No API key' };
    try {
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${account.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        return { supported: true, ok: false, status: res.status, error: await res.text() };
      }

      const data = await res.json();
      const d = data.data || {};

      const quotaResult = {
        supported: true,
        ok: true,
        provider: 'openrouter',
        accountId: account.id,
        accountName: account.name,
        usage: d.usage,
        limit: d.limit,
        isFreeTier: d.is_free_tier,
        checkedAt: new Date().toISOString(),
      };

      const provider = await providersDB.get('openrouter');
      if (provider && Array.isArray(provider.accounts)) {
        const accIdx = provider.accounts.findIndex((a) => a.id === account.id);
        if (accIdx !== -1) {
          provider.accounts[accIdx].quota = quotaResult;
          await providersDB.set('openrouter', provider);
        }
      }

      return quotaResult;
    } catch (err) {
      return { supported: true, ok: false, error: err.message };
    }
  }

  // 3. Gemini / Google AI Studio
  if (prov.includes('gemini')) {
    if (!account.apiKey) return { supported: false, message: 'Gemini API key needed' };
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${account.apiKey}`, {
        signal: AbortSignal.timeout(8000),
      });
      return {
        supported: true,
        ok: res.ok,
        status: res.status,
        subscriptionTier: 'Google AI Studio',
        checkedAt: new Date().toISOString(),
        message: res.ok ? 'Ключ активен и валиден' : 'Ошибка проверки ключа',
      };
    } catch (err) {
      return { supported: true, ok: false, error: err.message };
    }
  }

  // 4. OpenAI / Generic
  return {
    supported: false,
    message: 'Провайдер не предоставляет публичный эндпоинт квоты',
  };
}

/**
 * Check all accounts across all providers
 */
export async function checkAllQuotas() {
  const providers = await providersDB.getAll();
  const results = [];

  for (const [pId, p] of Object.entries(providers)) {
    if (!p.enabled || !Array.isArray(p.accounts)) continue;
    for (const acc of p.accounts) {
      const q = await checkAccountQuota(pId, acc);
      if (q.supported) {
        results.push({
          providerId: pId,
          accountId: acc.id,
          accountName: acc.name,
          quota: q,
        });
      }
    }
  }

  return results;
}
