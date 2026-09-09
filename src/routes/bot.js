import express from 'express';
import crypto from 'node:crypto';
import { providersDB, routesDB } from '../db/index.js';
import { getRecentLogs } from '../utils/logger.js';
import { buildOAuthUrl } from '../utils/oauth.js';
import { importFromOmniroute } from '../utils/omnirouteImport.js';
import { checkAllQuotas } from '../utils/quotaChecker.js';
import { validateAllAccounts } from '../utils/accountValidator.js';
import { CONFIG } from '../config.js';

export const botRouter = express.Router();

/**
 * GET /api/bot/status - Discord Embed & Telegram ready status summary
 */
botRouter.get('/status', async (req, res) => {
  try {
    const providers = await providersDB.getAll();
    const logs = await getRecentLogs(500);
    const now = Date.now();

    const providerList = Object.values(providers);
    const activeProviders = providerList.filter((p) => p.enabled);

    let totalAccounts = 0;
    const providerBreakdown = [];
    let cooldownAccounts = 0;
    let minCooldownSec = null;

    for (const p of providerList) {
      const accs = Array.isArray(p.accounts) ? p.accounts : [];
      if (accs.length > 0) {
        totalAccounts += accs.length;
        providerBreakdown.push(`${p.name || p.id}: ${accs.length}`);
      }
      for (const a of accs) {
        if (a.status === 'cooldown' && a.cooldownUntil > now) {
          cooldownAccounts++;
          const remainingSec = Math.ceil((a.cooldownUntil - now) / 1000);
          if (minCooldownSec === null || remainingSec < minCooldownSec) {
            minCooldownSec = remainingSec;
          }
        }
      }
    }

    const totalRequests = logs.length;
    const successfulRequests = logs.filter((l) => l.status === 'success' || l.status === 'fallback').length;
    const avgLatency =
      successfulRequests > 0
        ? Math.round(
            logs
              .filter((l) => l.status !== 'error')
              .reduce((acc, l) => acc + (l.latencyMs || 0), 0) / successfulRequests
          )
        : 0;

    const poolStr =
      providerBreakdown.length > 0
        ? `${totalAccounts} (${providerBreakdown.join(', ')})`
        : `${totalAccounts} аккаунтов`;

    const cooldownStr =
      cooldownAccounts > 0
        ? `${cooldownAccounts} аккаунт(ов) (осталось ~${minCooldownSec}с)`
        : '0 (все чисты)';

    // Pre-formatted Discord Embed object
    const discordEmbed = {
      title: `🟢 KasRAI Gateway: ONLINE (порт ${CONFIG.PORT})`,
      color: cooldownAccounts > 0 ? 0xf59e0b : 0x22c55e, // amber if cooldown, emerald if all clean
      description: [
        `• **Активных провайдеров:** ${activeProviders.length}/${providerList.length}`,
        `• **Аккаунтов в пуле:** ${poolStr}`,
        `• **На кулдауне (429):** ${cooldownStr}`,
        `• **Всего запросов:** ${totalRequests.toLocaleString()} | **Средний пинг:** ${avgLatency}мс`,
      ].join('\n'),
      footer: {
        text: 'KasRAI Engine • kasdb binary storage',
      },
      timestamp: new Date().toISOString(),
    };

    // Pre-formatted plain text
    const plainText = [
      `🟢 KasRAI Gateway: ONLINE (порт ${CONFIG.PORT})`,
      `• Активных провайдеров: ${activeProviders.length}/${providerList.length}`,
      `• Аккаунтов в пуле: ${poolStr}`,
      `• На кулдауне (429): ${cooldownStr}`,
      `• Всего запросов: ${totalRequests.toLocaleString()} | Средний пинг: ${avgLatency}мс`,
    ].join('\n');

    res.json({
      online: true,
      port: CONFIG.PORT,
      version: CONFIG.VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      stats: {
        activeProviders: activeProviders.length,
        totalProviders: providerList.length,
        totalAccounts,
        cooldownAccounts,
        minCooldownSec,
        totalRequests,
        avgLatencyMs: avgLatency,
      },
      discordEmbed,
      plainText,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bot/key - Add API key on the fly from Discord Modal / Bot command
 */
botRouter.post('/key', async (req, res) => {
  try {
    const { provider, apiKey, name } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'provider and apiKey are required' });
    }

    const providerId = provider.toLowerCase().trim();
    let p = await providersDB.get(providerId);

    // If provider doesn't exist yet, auto-create standard entry
    if (!p) {
      p = {
        id: providerId,
        name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
        preset: providerId,
        type: providerId === 'anthropic' ? 'anthropic' : providerId === 'gemini' ? 'gemini' : 'openai',
        baseURL:
          providerId === 'gemini'
            ? 'https://generativelanguage.googleapis.com/v1beta'
            : providerId === 'anthropic'
            ? 'https://api.anthropic.com/v1'
            : providerId === 'groq'
            ? 'https://api.groq.com/openai/v1'
            : 'https://api.openai.com/v1',
        enabled: true,
        priority: 10,
        rateLimitCooldownSec: 60,
        models: [],
        accounts: [],
      };
    }

    if (!Array.isArray(p.accounts)) {
      p.accounts = [];
    }

    p.enabled = true;

    const newAccount = {
      id: crypto.randomUUID(),
      name: name || `Discord Key #${p.accounts.length + 1}`,
      authType: 'key',
      apiKey: apiKey.trim(),
      oauth: null,
      status: 'active',
      cooldownUntil: 0,
      cooldownReason: null,
      stats: { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: new Date().toISOString() },
    };

    p.accounts.push(newAccount);
    await providersDB.set(providerId, p);

    res.json({
      success: true,
      message: `Ключ успешно залетел в providers.db для ${p.name}!`,
      provider: p.id,
      accountId: newAccount.id,
      accountName: newAccount.name,
      totalAccountsInPool: p.accounts.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bot/oauth - Generate instant OAuth link for Discord Link Button
 */
botRouter.post('/oauth', (req, res) => {
  try {
    const { provider } = req.body;
    const providerId = (provider || 'antigravity').toLowerCase().trim();
    const host = req.get('host') || `localhost:${CONFIG.PORT}`;
    const redirectUri = `http://${host}/oauth/callback`;

    const oauthData = buildOAuthUrl(providerId, redirectUri);

    res.json({
      success: true,
      provider: providerId,
      authUrl: oauthData.authUrl,
      state: oauthData.state,
      discordButton: {
        label: '🔗 Авторизовать Google аккаунт',
        url: oauthData.authUrl,
        style: 5, // Link button style
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bot/quota - Discord Embed & plain text quota report
 */
botRouter.get('/quota', async (req, res) => {
  try {
    const quotas = await checkAllQuotas();
    if (quotas.length === 0) {
      return res.json({
        message: 'Нет подключенных аккаунтов с поддержкой проверки квоты',
        discordEmbed: {
          title: '📊 Квоты аккаунтов',
          description: 'Нет активных аккаунтов с квотами.',
          color: 0x6366f1,
        },
      });
    }

    const lines = quotas.map((q) => {
      const remaining =
        q.quota.remainingPercent !== undefined
          ? `${q.quota.remainingPercent}%`
          : q.quota.usage !== undefined
          ? `$${q.quota.usage.toFixed(4)}`
          : 'OK';
      const reset = q.quota.resetTime ? ` (сброс в ${new Date(q.quota.resetTime).toLocaleTimeString()})` : '';
      return `• **${q.providerId}** (\`${q.accountName}\`): **${remaining}**${reset}`;
    });

    const discordEmbed = {
      title: '📊 Статус квот аккаунтов в пуле',
      color: 0x6366f1,
      description: lines.join('\n'),
      footer: { text: 'KasRAI Quota Engine' },
      timestamp: new Date().toISOString(),
    };

    res.json({
      success: true,
      quotas,
      discordEmbed,
      plainText: lines.join('\n'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bot/health-check - Trigger full health check across accounts
 */
botRouter.post('/health-check', async (req, res) => {
  try {
    const summary = await validateAllAccounts();

    const discordEmbed = {
      title: '🩺 Результаты проверки здоровья аккаунтов (Health Check)',
      color: summary.invalidCount > 0 ? 0xef4444 : 0x22c55e,
      description: [
        `• **Всего проверено:** ${summary.totalChecked}`,
        `• 🟢 **Активны и валидны:** ${summary.healthyCount}`,
        `• 🔄 **Обновлено токенов (refresh):** ${summary.refreshedCount}`,
        `• 🟠 **На кулдауне (429):** ${summary.cooldownCount}`,
        `• 🔴 **Невалидны / отозваны:** ${summary.invalidCount}`,
      ].join('\n'),
      footer: { text: 'KasRAI Health Validator' },
      timestamp: new Date().toISOString(),
    };

    res.json({
      success: true,
      summary,
      discordEmbed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bot/cooldowns/reset - Force unfreeze all accounts
 */
botRouter.post('/cooldowns/reset', async (req, res) => {
  try {
    const providers = await providersDB.getAll();
    let resetCount = 0;

    for (const [pId, p] of Object.entries(providers)) {
      if (Array.isArray(p.accounts)) {
        let changed = false;
        for (const a of p.accounts) {
          if (a.status === 'cooldown') {
            a.status = 'active';
            a.cooldownUntil = 0;
            a.cooldownReason = null;
            resetCount++;
            changed = true;
          }
        }
        if (changed) {
          await providersDB.set(pId, p);
        }
      }
    }

    res.json({
      success: true,
      resetCount,
      message: `❄️ Разморожено аккаунтов: ${resetCount}. Все кулдауны сброшены!`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bot/import/omniroute - Trigger import from ~/.omniroute
 */
botRouter.post('/import/omniroute', async (req, res) => {
  try {
    const result = await importFromOmniroute();
    res.json({
      success: true,
      message: `📥 Успешно импортировано ${result.importedAccountsCount} аккаунтов в ${result.importedProvidersCount} провайдеров из OmniRoute!`,
      details: result.details,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/bot/logs - Formatted recent calls for Discord message codeblock
 */
botRouter.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '5', 10);
    const logs = await getRecentLogs(limit);

    if (logs.length === 0) {
      return res.json({
        count: 0,
        formattedDiscord: '```txt\n[Логи пусты]\n```',
        logs: [],
      });
    }

    const lines = logs.map((l) => {
      const time = new Date(l.timestamp).toLocaleTimeString();
      const statusStr = l.statusCode === 999 ? '999 APKAKALSA' : `${l.statusCode} ${l.status.toUpperCase()}`;
      return `[${time}] ${l.requestedModel} -> ${l.routedProvider || 'none'}/${l.routedModel || 'none'} | ${statusStr} | ${l.latencyMs}ms | ${l.totalTokens} tok`;
    });

    const formattedDiscord = `\`\`\`prolog\n${lines.join('\n')}\n\`\`\``;

    res.json({
      count: logs.length,
      formattedDiscord,
      logs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
