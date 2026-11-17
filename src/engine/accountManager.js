import { providersDB } from '../db/index.js';
import { parseRetryAfterMs } from '../utils/retryParser.js';
import { checkAccountQuota } from '../utils/quotaChecker.js';
import { resolveAntigravityUpstreamModel } from '../adapters/antigravity.js';

const PROVIDER_PREFIX_RE = /^(antigravity|gemini|openai|anthropic|kasrai)\//i;

class AccountManager {
  /**
   * Helper: determine model family/bucket ('gemini-pro', 'gemini-flash', 'claude', or exact model).
   * Pro and Flash are separate quota buckets upstream: a 429 on one must not freeze the other.
   */
  _getModelFamily(modelName) {
    if (!modelName) return 'default';
    const clean = modelName.toLowerCase().replace(PROVIDER_PREFIX_RE, '').trim();
    if (clean.includes('claude') || clean.includes('sonnet') || clean.includes('opus')) {
      return 'claude';
    }
    if (clean.includes('pro')) {
      return 'gemini-pro';
    }
    if (clean.includes('gemini') || clean.includes('flash')) {
      return 'gemini-flash';
    }
    return clean;
  }

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
    const family = this._getModelFamily(targetModel);

    // Check cooldown expirations (global & per-family)
    for (const acc of accounts) {
      if (acc.status === 'cooldown') {
        if (!acc.cooldownUntil) {
          // Cooldown state without an expiry date is stale (e.g. set by the health-checker
          // without cooldownUntil) — heal it instead of leaving the account dead forever.
          console.log(`[AccountManager] Stale cooldown without expiry on '${acc.name || acc.id}'. Restoring to active.`);
          acc.status = 'active';
          acc.cooldownReason = null;
          stateChanged = true;
        } else if (now >= acc.cooldownUntil) {
          console.log(`[AccountManager] Global cooldown expired for '${acc.name || acc.id}'. Restoring to active.`);
          acc.status = 'active';
          acc.cooldownUntil = 0;
          acc.cooldownReason = null;
          stateChanged = true;
        }
      }

      // Check per-family cooldowns
      if (acc.modelCooldowns && typeof acc.modelCooldowns === 'object') {
        for (const [fam, until] of Object.entries(acc.modelCooldowns)) {
          if (until && now >= until) {
            console.log(`[AccountManager] Model family '${fam}' cooldown expired for '${acc.name || acc.id}'.`);
            delete acc.modelCooldowns[fam];
            stateChanged = true;
          }
        }
      }
    }

    if (stateChanged) {
      provider.accounts = accounts;
      await providersDB.set(providerId, provider);
    }

    // Filter active accounts (not in global cooldown, and not in model-family cooldown)
    const cleanModel = targetModel ? targetModel.replace(PROVIDER_PREFIX_RE, '').trim() : null;
    // Quota cache keys are upstream model IDs (e.g. 'gemini-pro-agent'), so check the
    // alias-resolved name too — otherwise remapped models never match the cache.
    const upstreamModel = cleanModel ? resolveAntigravityUpstreamModel(cleanModel) : null;

    const viable = accounts.filter((acc) => {
      if (acc.status === 'disabled' || acc.status === 'invalid' || acc.status === 'banned') {
        return false;
      }
      // If global cooldown is still active, skip
      if (acc.status === 'cooldown' && acc.cooldownUntil && acc.cooldownUntil > now) {
        return false;
      }
      // Check family-specific cooldown (e.g. only 'gemini-pro' is frozen, but 'claude' is free!)
      if (acc.modelCooldowns && acc.modelCooldowns[family] && acc.modelCooldowns[family] > now) {
        return false;
      }
      // Check cached model quota if available: if this specific model is EXPLICITLY 0%
      // and reset is in the future, skip it! ('unknown' entries must never filter.)
      if (cleanModel && acc.quota?.modelsQuota) {
        const mq = acc.quota.modelsQuota[cleanModel] || acc.quota.modelsQuota[upstreamModel];
        if (mq && mq.unknown !== true && mq.remainingFraction === 0 && mq.resetTime) {
          const resetMs = Date.parse(mq.resetTime);
          if (!isNaN(resetMs) && resetMs > now) {
            return false; // Skip account for THIS model because quota is genuinely exhausted!
          }
        }
      }
      return true;
    });

    // Optimistic fallback: if ALL accounts were filtered out purely by cached modelsQuota,
    // but we have valid active accounts (no active cooldowns), allow them to attempt!
    // Google quotas often refresh dynamically or stale cache blocks valid requests.
    if (viable.length === 0 && accounts.length > 0) {
      const activeUnfrozen = accounts.filter(acc => {
        if (acc.status === "disabled" || acc.status === "invalid" || acc.status === "banned") return false;
        if (acc.status === "cooldown" && acc.cooldownUntil && acc.cooldownUntil > now) return false;
        if (acc.modelCooldowns && acc.modelCooldowns[family] && acc.modelCooldowns[family] > now) return false;
        return true;
      });
      if (activeUnfrozen.length > 0) {
        console.log(`[AccountManager] 🔄 Optimistic fallback for ${providerId}/${cleanModel}: cached quota was 0%, but trying ${activeUnfrozen.length} active account(s).`);
        viable.push(...activeUnfrozen);
      }
    }

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
   * Permanently ban an account when upstream returns a Terms of Service / Account Disabled violation.
   * Sets status to 'banned', records reason, and immediately persists to DB so it never enters rotation again.
   */
  async banAccount(providerId, accountId, reason) {
    const provider = await providersDB.get(providerId);
    if (!provider) return;

    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;

    acc.status = 'banned';
    acc.banReason = reason || 'Violation of Terms of Service / Account Disabled';
    acc.bannedAt = new Date().toISOString();
    acc.cooldownUntil = 0;
    acc.cooldownReason = null;

    console.error(`\n🚨 [KasRAI Alert] Account ${acc.name || acc.id} (${providerId}) BANNED BY GOOGLE ToS! Reason: ${acc.banReason}\n`);

    await providersDB.set(providerId, provider);
    return acc;
  }

  /**
   * Put an account on cooldown after a 429 / quota error.
   * Granular: Freezes ONLY the affected model family ('gemini' or 'claude') for Antigravity,
   * keeping the other family completely alive!
   */
  async triggerAccountCooldown(providerId, accountId, err, targetModel = null) {
    const provider = await providersDB.get(providerId);
    if (!provider) return;

    const accounts = Array.isArray(provider.accounts) ? provider.accounts : [];
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;

    // 1. Check if upstream sent a Retry-After or message with time
    const parsedDelay = parseRetryAfterMs(err.headers, err.data);

    // 2. Fall back to explicit err.cooldownMs, provider configured rateLimitCooldownSec, or default 60s
    let cooldownMs = err.cooldownMs || (parsedDelay !== null ? parsedDelay : (provider.rateLimitCooldownSec || provider.defaultCooldownSec || 60) * 1000);

    const family = this._getModelFamily(targetModel);

    // 3. For timeout errors specifically, don't query 429 quota API, just freeze briefly
    if (err.status === 504 || err.isTimeout) {
      if (providerId === 'antigravity') {
        if (!acc.modelCooldowns) acc.modelCooldowns = {};
        const untilTime = Date.now() + cooldownMs;
        acc.modelCooldowns[family] = untilTime;
        console.warn(
          `[AccountManager] ⏳ Timeout (60s) on '${acc.name || acc.id}' [${family}]. Cooldown for ${Math.round(
            cooldownMs / 1000
          )}s.`
        );
        await providersDB.set(providerId, provider);
        return acc;
      }
    }

    // 4. For antigravity 429s: granular per-family cooldown
    if (providerId === 'antigravity') {
      try {
        console.log(`[AccountManager] 🔍 429 hit on '${acc.name}' for family '${family}' (${targetModel}) — checking real quota...`);
        const freshQuota = await checkAccountQuota(providerId, acc);

        if (freshQuota?.ok && freshQuota.modelsQuota) {
          const cleanModel = targetModel ? targetModel.replace(PROVIDER_PREFIX_RE, '').trim() : null;
          const upstreamModel = cleanModel ? resolveAntigravityUpstreamModel(cleanModel) : null;

          let worstResetTime = null;

          for (const [mId, mq] of Object.entries(freshQuota.modelsQuota)) {
            const mFam = this._getModelFamily(mId);
            const modelMatches =
              mFam === family ||
              (cleanModel && (mId === cleanModel || mId === upstreamModel || mId.startsWith(cleanModel)));
            if (modelMatches && mq.unknown !== true && mq.remainingFraction === 0 && mq.resetTime) {
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
                `[AccountManager] 📛 Quota genuinely exhausted for '${acc.name}' [${family}]. ` +
                `Extending cooldown to resetTime: ${worstResetTime} (${Math.round(remainingMs / 3600000)}h from now)`
              );
              cooldownMs = remainingMs;
            }
          } else {
            console.log(`[AccountManager] ⚡ RPM burst limit for '${acc.name}' [${family}]. Short cooldown: ${Math.round(cooldownMs / 1000)}s`);
          }
        }
      } catch (quotaErr) {
        console.warn(`[AccountManager] Quota check after 429 failed (non-fatal): ${quotaErr.message}`);
      }

      // 🧊 GRANULAR COOLDOWN: Freeze ONLY this model family!
      if (!acc.modelCooldowns) acc.modelCooldowns = {};
      const untilTime = Date.now() + cooldownMs;
      acc.modelCooldowns[family] = untilTime;

      console.warn(
        `[AccountManager] 🧊 Lineage '${family}' on account '${acc.name || acc.id}' put on cooldown for ${Math.round(
          cooldownMs / 1000
        )}s (until ${new Date(untilTime).toLocaleTimeString()}). Other model families remain ACTIVE!`
      );

      await providersDB.set(providerId, provider);
      return acc;
    }

    // Default global cooldown for other providers
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
