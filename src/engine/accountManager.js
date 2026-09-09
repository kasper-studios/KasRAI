import { providersDB } from '../db/index.js';
import { parseRetryAfterMs } from '../utils/retryParser.js';
import { checkAccountQuota } from '../utils/quotaChecker.js';

class AccountManager {
  /**
   * Retrieves an ordered list of viable accounts for a provider.
   * Auto-heals expired cooldowns.
   * If targetModel is passed, checks account model-specific quota/buckets!
   */
  async getViableAccounts(providerId, targetModel = null) {
    const provider = await providersDB.get(providerId);
    if (!provider) return [];

    let accounts = Array.isArray(provider.accounts) ? [...provider.accounts] : [];
    let stateChanged = false;
    const now = Date.now();

    // Check cooldown expirations
    for (const acc of accounts) {
      if (acc.status === 'cooldown') {
        if (acc.cooldownUntil && now >= acc.cooldownUntil) {
          console.log(`[AccountManager] Cooldown expired for '${acc.name || acc.id}'. Restoring to active.`);
          acc.status = 'active';
          acc.cooldownUntil = 0;
          acc.cooldownReason = null;
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      provider.accounts = accounts;
      await providersDB.set(providerId, provider);
    }

    // Filter active accounts (not in cooldown, not disabled, not model-exhausted)
    const cleanModel = targetModel ? targetModel.replace(/^(antigravity|gemini|openai|anthropic)\//i, '').trim() : null;

    const viable = accounts.filter((acc) => {
      if (acc.status === 'cooldown' || acc.status === 'disabled' || acc.status === 'invalid') {
        return false;
      }
      // Check cached model quota if available: if this specific model is 0% and reset is in the future, skip it!
      if (cleanModel && acc.quota?.modelsQuota && acc.quota.modelsQuota[cleanModel]) {
        const mq = acc.quota.modelsQuota[cleanModel];
        if (mq.remainingFraction === 0 && mq.resetTime) {
          const resetMs = Date.parse(mq.resetTime);
          if (!isNaN(resetMs) && resetMs > now) {
            return false; // Skip account for THIS model because quota is genuinely exhausted!
          }
        }
      }
      return true;
    });

    // Sort by priority (higher priority number = first; default 0)
    viable.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // If no accounts array defined or all empty, but provider has apiKey/baseURL, synthesize a default account
    if (accounts.length === 0 && (provider.apiKey || provider.type === 'antigravity')) {
      return [
        {
          id: 'default',
          name: 'Primary Key',
          authType: 'key',
          apiKey: provider.apiKey || '',
          status: 'active',
          cooldownUntil: 0,
        },
      ];
    }

    return viable;
  }

  /**
   * Put an account on cooldown after a 429 / quota error.
   * For antigravity: immediately re-checks real quota via retrieveUserQuota.
   * If a model bucket is fully exhausted (0%), extends cooldown to resetTime
   * so the router never wastes a request on a known-dead bucket until the
   * daily reset (typically ~24h later).
   */
  async triggerAccountCooldown(providerId, accountId, err, targetModel = null) {
    const provider = await providersDB.get(providerId);
    if (!provider) return;

    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;

    // 1. Check if upstream sent a Retry-After or message with time
    const parsedDelay = parseRetryAfterMs(err.headers, err.data);

    // 2. Fall back to provider configured rateLimitCooldownSec, or default 60s
    const configuredSec = provider.rateLimitCooldownSec || provider.defaultCooldownSec || 60;
    let cooldownMs = parsedDelay !== null ? parsedDelay : configuredSec * 1000;

    // 3. For antigravity 429s: immediately fetch real quota to see if the model
    //    bucket is genuinely exhausted. If so, extend cooldown to the reset time
    //    so we stop spamming Google every 60s when quota is 0%.
    if (providerId === 'antigravity') {
      try {
        console.log(`[AccountManager] 🔍 429 hit on '${acc.name}' — checking real quota...`);
        const freshQuota = await checkAccountQuota(providerId, acc);

        if (freshQuota?.ok && freshQuota.modelsQuota) {
          const cleanModel = targetModel
            ? targetModel.replace(/^(antigravity|gemini|openai|anthropic)\//i, '').trim()
            : null;

          // Find the most specific exhausted bucket for this model
          let worstResetTime = null;

          for (const [mId, mq] of Object.entries(freshQuota.modelsQuota)) {
            const modelMatches = !cleanModel || mId === cleanModel || mId.startsWith(cleanModel);
            if (modelMatches && mq.remainingFraction === 0 && mq.resetTime) {
              const resetMs = Date.parse(mq.resetTime);
              if (!isNaN(resetMs) && resetMs > Date.now()) {
                if (!worstResetTime || resetMs > Date.parse(worstResetTime)) {
                  worstResetTime = mq.resetTime;
                }
              }
            }
          }

          if (worstResetTime) {
            const resetMs = Date.parse(worstResetTime);
            const remainingMs = resetMs - Date.now();
            if (remainingMs > cooldownMs) {
              console.warn(
                `[AccountManager] 📛 Quota genuinely exhausted for '${acc.name}' (${cleanModel || 'all models'}). ` +
                `Extending cooldown to resetTime: ${worstResetTime} (${Math.round(remainingMs / 3600000)}h from now)`
              );
              cooldownMs = remainingMs;
            }
          } else {
            // Quota is NOT 0 — this was a temporary RPM/burst rate limit, keep short cooldown
            console.log(`[AccountManager] ⚡ RPM burst limit for '${acc.name}'. Quota still available. Short cooldown: ${Math.round(cooldownMs / 1000)}s`);
          }
        }
      } catch (quotaErr) {
        console.warn(`[AccountManager] Quota check after 429 failed (non-fatal): ${quotaErr.message}`);
      }
    }

    acc.status = 'cooldown';
    acc.cooldownUntil = Date.now() + cooldownMs;
    acc.cooldownReason = err.message || 'Quota exhausted / 429 Rate limit';

    console.warn(
      `[AccountManager] 🛑 Account '${acc.name || acc.id}' (${providerId}) put on cooldown for ${Math.round(
        cooldownMs / 1000
      )}s (until ${new Date(acc.cooldownUntil).toLocaleTimeString()}). Reason: ${acc.cooldownReason}`
    );

    await providersDB.set(providerId, provider);
    return acc;
  }

  /**
   * Record successful call on account
   */
  async recordAccountSuccess(providerId, accountId, latencyMs) {
    const provider = await providersDB.get(providerId);
    if (!provider || !Array.isArray(provider.accounts)) return;

    const acc = provider.accounts.find((a) => a.id === accountId);
    if (acc) {
      if (!acc.stats) acc.stats = { totalRequests: 0, successCount: 0, errorCount: 0 };
      acc.stats.totalRequests = (acc.stats.totalRequests || 0) + 1;
      acc.stats.successCount = (acc.stats.successCount || 0) + 1;
      acc.stats.lastUsed = new Date().toISOString();
      await providersDB.set(providerId, provider);
    }
  }
}

export const accountManager = new AccountManager();
