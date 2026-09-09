import { providersDB } from '../db/index.js';
import { parseRetryAfterMs } from '../utils/retryParser.js';

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
   */
  async triggerAccountCooldown(providerId, accountId, err) {
    const provider = await providersDB.get(providerId);
    if (!provider) return;

    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;

    // 1. Check if upstream sent a Retry-After or message with time
    const parsedDelay = parseRetryAfterMs(err.headers, err.data);

    // 2. Fall back to provider configured rateLimitCooldownSec, or default 60s
    const configuredSec = provider.rateLimitCooldownSec || provider.defaultCooldownSec || 60;
    const cooldownMs = parsedDelay !== null ? parsedDelay : configuredSec * 1000;

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
