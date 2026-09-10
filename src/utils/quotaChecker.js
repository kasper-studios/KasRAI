import { providersDB } from '../db/index.js';
import { getValidAuthToken } from './oauth.js';

/**
 * Extract Notion cookie fields from an account.
 * Supports both:
 *  - legacy layout: account.tokenV2 / account.userId / account.spaceId
 *  - new layout: account.apiKey = JSON string {token_v2, user_id, space_id}
 */
export function extractNotionCookies(account) {
  let tokenV2 = account.tokenV2 || '';
  let userId = account.userId || account.notion_user_id || '';
  let spaceId = account.spaceId || account.notion_space_id || '';

  // Try JSON apiKey blob
  if (!tokenV2 && account.apiKey) {
    try {
      const parsed = JSON.parse(account.apiKey);
      if (parsed && typeof parsed === 'object') {
        tokenV2 = parsed.token_v2 || parsed.tokenV2 || tokenV2;
        userId = parsed.user_id || parsed.userId || parsed.notion_user_id || userId;
        spaceId = parsed.space_id || parsed.spaceId || parsed.notion_space_id || spaceId;
      }
    } catch {
      // Not JSON — raw apiKey unused for notion cookies
    }
  }

  return { tokenV2, userId, spaceId };
}

/**
 * Live quota and tier checker for providers and accounts
 */
export async function checkAccountQuota(providerId, account) {
  if (!account) return { supported: false, message: 'Account not found' };

  const prov = providerId.toLowerCase().trim();

  // 4. Notion AI (reverse-engineered)
  if (prov === 'notion' || prov.includes('notion')) {
    if (!account.apiKey && !account.tokenV2) {
      return { supported: true, ok: false, error: 'No Notion cookies available' };
    }
    try {
      const { tokenV2, userId, spaceId } = extractNotionCookies(account);
      if (!tokenV2) {
        return { supported: true, ok: false, error: 'Missing token_v2 in cookies' };
      }

      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0',
        'x-notion-active-user-header': userId,
        'x-notion-space-id': spaceId,
        'notion-client-version': '23.13.20260909.0411',
        Cookie: `token_v2=${tokenV2}; notion_user_id=${userId}`,
      };

      // 4a. Credit / rate-limit status
      let creditData = null;
      try {
        const creditRes = await fetch('https://app.notion.com/api/v3/getCreditRateLimitStatus', {
          method: 'POST',
          headers,
          body: JSON.stringify({ spaceId }),
          signal: AbortSignal.timeout(8000),
        });
        if (creditRes.ok) creditData = await creditRes.json();
      } catch (err) {
        console.warn(`[QuotaChecker] Notion credit status error for ${account.name}: ${err.message}`);
      }

      // 4b. AI usage eligibility (trial / quota)
      let eligibilityData = null;
      try {
        const eligRes = await fetch('https://app.notion.com/api/v3/getAIUsageEligibilityV2', {
          method: 'POST',
          headers,
          body: JSON.stringify({ spaceId }),
          signal: AbortSignal.timeout(8000),
        });
        if (eligRes.ok) eligibilityData = await eligRes.json();
      } catch (err) {
        console.warn(`[QuotaChecker] Notion eligibility error for ${account.name}: ${err.message}`);
      }

      // Parse credit status
      const limitState = creditData?.limitState || creditData?.state || null;
      const limitType = creditData?.limitType || null;
      const model = creditData?.model || null;
      const remaining = creditData?.remaining || null;
      const limit = creditData?.limit || null;
      const resetsAt = creditData?.resetsAt || creditData?.resetTime || null;

      // Parse eligibility
      let subscriptionTier = 'Notion AI';
      let isPro = false;
      let usagePercent = null;
      if (eligibilityData) {
        if (eligibilityData.billingSubscriptionType) {
          subscriptionTier = eligibilityData.billingSubscriptionType;
          isPro = !eligibilityData.billingSubscriptionType?.toLowerCase().includes('free');
        }
        if (eligibilityData.tier) subscriptionTier = eligibilityData.tier;
        if (eligibilityData.hasUnlimitedAccess) isPro = true;
        if (eligibilityData.aiCreditMonthlyLimit && eligibilityData.aiCreditUsageTotal) {
          usagePercent = Math.round(
            (eligibilityData.aiCreditUsageTotal / eligibilityData.aiCreditMonthlyLimit) * 100
          );
        }
      } else if (limit && remaining !== null) {
        usagePercent = Math.round((remaining / limit) * 100);
      }

      const quotaResult = {
        supported: true,
        ok: true,
        provider: 'notion',
        accountId: account.id,
        accountName: account.name,
        subscriptionTier,
        isPro,
        usagePercent,
        limitState,
        limitType,
        model,
        remaining,
        limit,
        resetsAt,
        checkedAt: new Date().toISOString(),
      };

      const provider = await providersDB.get(providerId);
      if (provider && Array.isArray(provider.accounts)) {
        const accIdx = provider.accounts.findIndex((a) => a.id === account.id);
        if (accIdx !== -1) {
          provider.accounts[accIdx].quota = quotaResult;
          await providersDB.set(providerId, provider);
        }
      }

      return quotaResult;
    } catch (err) {
      return { supported: true, ok: false, error: err.message };
    }
  }

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
