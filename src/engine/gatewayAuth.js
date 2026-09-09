import crypto from 'node:crypto';
import { configDB } from '../db/index.js';

const AUTH_CONFIG_KEY = 'gateway_auth_config';

/**
 * Gateway Auth Manager:
 * Controls whether `/v1/*` requests require an API key or can be called freely (open).
 */
export class GatewayAuthManager {
  constructor() {
    this._cache = null;
  }

  async _load() {
    if (!this._cache) {
      const data = await configDB.get(AUTH_CONFIG_KEY);
      this._cache = data && typeof data === 'object' ? data : {
        requireApiKey: false,
        primaryKey: null,
        allowedKeys: [],
      };
    }
    return this._cache;
  }

  async _save() {
    if (this._cache) {
      await configDB.set(AUTH_CONFIG_KEY, this._cache);
    }
  }

  async getAuthConfig() {
    const conf = await this._load();
    return {
      requireApiKey: !!conf.requireApiKey,
      hasKey: Boolean(conf.primaryKey || (conf.allowedKeys && conf.allowedKeys.length > 0)),
      maskedKey: conf.primaryKey ? `${conf.primaryKey.slice(0, 7)}...${conf.primaryKey.slice(-4)}` : null,
      keysCount: (conf.allowedKeys || []).length + (conf.primaryKey ? 1 : 0),
    };
  }

  async getFullConfig() {
    return await this._load();
  }

  async setRequireApiKey(enabled) {
    const conf = await this._load();
    conf.requireApiKey = !!enabled;
    // Auto-generate primary key if none exists when turning on
    if (conf.requireApiKey && !conf.primaryKey) {
      conf.primaryKey = `kasrai-${crypto.randomBytes(16).toString('hex')}`;
    }
    await this._save();
    return await this.getAuthConfig();
  }

  async generateNewKey(customName = null) {
    const conf = await this._load();
    const newKey = `kasrai-${crypto.randomBytes(16).toString('hex')}`;
    conf.primaryKey = newKey;
    if (!Array.isArray(conf.allowedKeys)) conf.allowedKeys = [];
    conf.allowedKeys.push({
      key: newKey,
      name: customName || `Key #${conf.allowedKeys.length + 1}`,
      createdAt: new Date().toISOString(),
    });
    await this._save();
    return { key: newKey, config: await this.getAuthConfig() };
  }

  async validateRequest(req) {
    const conf = await this._load();
    if (!conf.requireApiKey) {
      return { valid: true, open: true };
    }

    const authHeader = req.headers['authorization'] || '';
    const apiKeyHeader = req.headers['x-api-key'] || '';

    let token = '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (authHeader) {
      token = authHeader.trim();
    } else if (apiKeyHeader) {
      token = apiKeyHeader.trim();
    }

    if (!token) {
      return {
        valid: false,
        status: 401,
        message: 'API Key is required to access KasRAI Gateway. Provide Authorization: Bearer <key>',
      };
    }

    if (conf.primaryKey && token === conf.primaryKey) {
      return { valid: true };
    }

    if (Array.isArray(conf.allowedKeys) && conf.allowedKeys.some((k) => (typeof k === 'string' ? k : k.key) === token)) {
      return { valid: true };
    }

    return {
      valid: false,
      status: 403,
      message: 'Invalid KasRAI API Key. Access denied.',
    };
  }
}

export const gatewayAuth = new GatewayAuthManager();
