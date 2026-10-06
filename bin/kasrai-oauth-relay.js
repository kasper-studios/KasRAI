#!/usr/bin/env node
/**
 * kasrai-oauth-relay.js — Локальный микро-сервер для обхода ограничений Google OAuth
 * 
 * Если KasRAI запущен на удаленном сервере / планшете / VPS, Google блокирует
 * прямой редирект на частные IP без device_id или требует localhost.
 * 
 * Этот микро-сервер слушает http://localhost:20250/oauth/callback и прозрачно
 * редиректит полученный OAuth code & state на целевой IP вашего основного KasRAI!
 */

import http from 'node:http';

const PORT = parseInt(process.env.RELAY_PORT || '20250', 10);
const TARGET_HOST = process.env.KASRAI_HOST || '192.168.1.102:20250';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/oauth/callback') {
    const targetUrl = `http://${TARGET_HOST}/oauth/callback${url.search}`;
    console.log(`[KasRAI Relay] 🔄 Перехват OAuth callback -> Редирект на: ${targetUrl}`);
    
    // Мгновенный 302 редирект в основной KasRAI
    res.writeHead(302, {
      Location: targetUrl,
      'Content-Type': 'text/html; charset=utf-8'
    });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>KasRAI OAuth Relay</title></head>
        <body style="background:#090a10;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;padding:30px;background:#121420;border:1px solid #8b5cf6;border-radius:16px;">
            <h2 style="color:#c084fc;">⚡ KasRAI OAuth Relay</h2>
            <p>Перенаправление на основной шлюз <b>${TARGET_HOST}</b>...</p>
            <p><a href="${targetUrl}" style="color:#38bdf8;">Нажмите сюда, если редирект не сработал автоматически</a></p>
          </div>
          <script>window.location.href = "${targetUrl}";</script>
        </body>
      </html>
    `);
    return;
  }

  // Здоровье релея
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'kasrai-oauth-relay',
    target: TARGET_HOST,
    hint: 'Слушает http://localhost:20250/oauth/callback и пересылает на основной KasRAI'
  }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`🚀 KasRAI OAuth Relay запущен на http://localhost:${PORT}`);
  console.log(`🎯 Целевой сервер KasRAI: http://${TARGET_HOST}`);
  console.log(`🛡️ Google OAuth теперь без проблем редиректит в ваш шлюз!`);
  console.log(`======================================================\n`);
});
