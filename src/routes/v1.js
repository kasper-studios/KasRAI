import express from 'express';
import { routerEngine } from '../engine/router.js';
import { providersDB, routesDB } from '../db/index.js';
import { CONFIG } from '../config.js';

export const v1Router = express.Router();

// Health probe
v1Router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gateway: 'KasRAI',
    version: CONFIG.VERSION,
    timestamp: new Date().toISOString(),
  });
});

// GET /v1/models - list all virtual routes, aliases, and enabled provider models
v1Router.get('/models', async (req, res) => {
  try {
    const routesMap = await routesDB.getAll();
    const providersMap = await providersDB.getAll();
    const modelsList = [];
    const seen = new Set();

    // 1. Add all virtual aliases
    for (const [alias, route] of Object.entries(routesMap)) {
      if (!seen.has(alias)) {
        seen.add(alias);
        modelsList.push({
          id: alias,
          object: 'model',
          created: 1700000000,
          owned_by: 'kasrai',
          permission: [],
          root: alias,
          parent: null,
          description: route.description || 'KasRAI Virtual Route',
        });
      }
    }

    // 2. Add provider models
    for (const [pId, p] of Object.entries(providersMap)) {
      if (!p.enabled) continue;
      if (Array.isArray(p.models)) {
        for (const m of p.models) {
          const directId = `${pId}/${m}`;
          if (!seen.has(directId)) {
            seen.add(directId);
            modelsList.push({
              id: directId,
              object: 'model',
              created: 1700000000,
              owned_by: pId,
              permission: [],
              root: m,
              parent: null,
            });
          }
          if (!seen.has(m)) {
            seen.add(m);
            modelsList.push({
              id: m,
              object: 'model',
              created: 1700000000,
              owned_by: pId,
              permission: [],
              root: m,
              parent: null,
            });
          }
        }
      }
    }

    res.json({
      object: 'list',
      data: modelsList,
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err.message,
        type: 'kasrai_internal_error',
        code: 500,
      },
    });
  }
});

// POST /v1/chat/completions - main inference entrypoint
v1Router.post('/chat/completions', async (req, res) => {
  const isStream = !!req.body.stream;
  try {
    await routerEngine.executeChat(req.body, res, isStream);
  } catch (err) {
    console.error('[v1/chat/completions] Unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: err.message || 'Internal gateway error',
          type: 'kasrai_server_error',
          code: 500,
        },
      });
    }
  }
});
