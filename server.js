import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { CONFIG } from './src/config.js';
import { v1Router } from './src/routes/v1.js';
import { apiRouter } from './src/routes/api.js';
import { botRouter } from './src/routes/bot.js';
import { exchangeOAuthCode } from './src/utils/oauth.js';
import { providersDB } from './src/db/index.js';
import { gitUpdater } from './src/utils/gitUpdater.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static frontend for micro-panel
app.use(express.static(CONFIG.PUBLIC_DIR));

// OAuth Callback Endpoint
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <body style="background:#0a0a0f;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#12141f;border:1px solid #1e2235;padding:32px;border-radius:16px;text-align:center;max-width:400px;">
          <h2 style="margin-top:0;">Ошибка авторизации OAuth</h2>
          <p style="color:#9ca3af;font-size:14px;">${error}</p>
          <a href="/" style="display:inline-block;margin-top:16px;color:#818cf8;text-decoration:none;">← Вернуться в дашборд</a>
        </div>
      </body>
    `);
  }

  if (!code || !state) {
    return res.status(400).send('Отсутствует code или state');
  }

  try {
    const accountData = await exchangeOAuthCode(state, code);
    const provider = (await providersDB.get(accountData.providerId)) || {
      id: accountData.providerId,
      name: accountData.providerId,
      enabled: true,
      accounts: [],
    };

    if (!Array.isArray(provider.accounts)) {
      provider.accounts = [];
    }

    // Check if account with this email/name already exists, update or append
    const existingIdx = provider.accounts.findIndex((a) => a.name === accountData.email);
    const newAcc = {
      id: existingIdx !== -1 ? provider.accounts[existingIdx].id : crypto.randomUUID(),
      name: accountData.email,
      authType: 'oauth',
      apiKey: '',
      oauth: {
        accessToken: accountData.accessToken,
        refreshToken: accountData.refreshToken,
        expiresAt: accountData.expiresAt,
        tokenEndpoint: accountData.tokenEndpoint,
        clientId: accountData.clientId,
        clientSecret: accountData.clientSecret,
      },
      status: 'active',
      cooldownUntil: 0,
      cooldownReason: null,
      stats: { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: new Date().toISOString() },
    };

    if (existingIdx !== -1) {
      provider.accounts[existingIdx] = newAcc;
    } else {
      provider.accounts.push(newAcc);
    }

    await providersDB.set(provider.id, provider);

    res.send(`
      <body style="background:#0a0a0f;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#12141f;border:1px solid #1e2235;padding:36px;border-radius:20px;text-align:center;max-width:440px;box-shadow:0 20px 40px rgba(0,0,0,0.5);">
          <div style="font-size:48px;margin-bottom:12px;">⚡</div>
          <h2 style="margin:0 0 8px 0;color:#fff;font-size:20px;">Авторизация успешна!</h2>
          <p style="color:#94a3b8;font-size:14px;margin-bottom:20px;">
            Аккаунт <b>${accountData.email}</b> успешно привязан к провайдеру <b>${provider.name || provider.id}</b>.
            Токены сохранены в kasdb. Можешь закрыть эту вкладку.
          </p>
          <a href="/" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:bold;">Перейти в KasRAI Dashboard →</a>
        </div>
      </body>
    `);
  } catch (err) {
    console.error('[OAuth Callback Error]', err);
    res.status(500).send(`
      <body style="background:#0a0a0f;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#12141f;border:1px solid #1e2235;padding:32px;border-radius:16px;text-align:center;max-width:400px;">
          <h2 style="margin-top:0;">Ошибка обмена токенов</h2>
          <p style="color:#9ca3af;font-size:14px;">${err.message}</p>
          <a href="/" style="display:inline-block;margin-top:16px;color:#818cf8;text-decoration:none;">← Вернуться</a>
        </div>
      </body>
    `);
  }
});

// API Routers
app.use('/v1', v1Router);
app.use('/api/bot', botRouter);
app.use('/api', apiRouter);

// Fallback for SPA routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/v1') || req.path.startsWith('/api') || req.path.startsWith('/oauth')) {
    return next();
  }
  res.sendFile(path.join(CONFIG.PUBLIC_DIR, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: {
        message: err.message || 'Internal Server Error',
        type: 'kasrai_server_error',
        code: 500,
      },
    });
  }
});

const server = app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                      ⚡ KasRAI Gateway ⚡                 ║
║               Kasper Route AI v${CONFIG.VERSION}                      ║
╠═══════════════════════════════════════════════════════════╣
║  • Dashboard UI:  http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${CONFIG.PORT}/
║  • OpenAI API:    http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${CONFIG.PORT}/v1
║  • Health Probe:  http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${CONFIG.PORT}/v1/health
║  • OAuth Return:  http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${CONFIG.PORT}/oauth/callback
║  • Data Storage:  ${CONFIG.DATA_DIR} (kasdb)
╚═══════════════════════════════════════════════════════════╝
  `);

  // Start auto-updater polling (checks every 60s)
  gitUpdater.startAutoPolling(60000);
});

// Handle port already in use — log clearly instead of crashing with unhandled throw
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[KasRAI] ❌ Port ${CONFIG.PORT} is already in use. Is another instance running?`);
    // lsof is not available on Termux/Android — use fuser or pkill instead
    console.error(`[KasRAI] Fix: pkill -f "node server.js"  OR  fuser -k ${CONFIG.PORT}/tcp`);
  } else {
    console.error('[KasRAI] Server error:', err.message);
  }
  process.exit(1);
});

const shutdown = () => {
  console.log('\n[KasRAI] Shutting down server...');
  server.close(() => {
    console.log('[KasRAI] Goodbye!');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
