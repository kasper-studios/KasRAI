import fs from 'node:fs';
import path from 'node:path';
import kasdbPkg from '@kasperenok/kasdb';
import { CONFIG } from '../config.js';

const { AsyncDB } = kasdbPkg;

class KasDBStore {
  constructor(dbName, initialData = {}) {
    this.name = dbName;
    this.initialData = initialData;
    this.dbPath = path.join(CONFIG.DATA_DIR, dbName);
    this.filePath = `${this.dbPath}.db`;
    this._queue = Promise.resolve();
    this._init();
  }

  _init() {
    if (!fs.existsSync(CONFIG.DATA_DIR)) {
      fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this.db = new AsyncDB({ filename: this.dbPath, data: this.initialData });
    } else {
      this.db = new AsyncDB({ filename: this.dbPath });
    }
  }

  _lock(fn) {
    const next = this._queue.then(() => fn()).catch((err) => {
      console.error(`[kasdb:${this.name}] Error:`, err);
      throw err;
    });
    this._queue = next.catch(() => {});
    return next;
  }

  _isCorrupted(err) {
    return err.message && (
      err.message.includes('BUFFER_SHORTAGE') ||
      err.message.includes('INVALID_TYPE') ||
      err.message.includes('Unexpected end of buffer') ||
      err.code === 'ERR_INVALID_ARG_TYPE'
    );
  }

  async _resetDb() {
    console.warn(`[kasdb:${this.name}] ⚠️ Corrupted DB detected — resetting to initial data.`);
    try { fs.unlinkSync(this.filePath); } catch {}
    this.db = new AsyncDB({ filename: this.dbPath, data: this.initialData });
  }

  async getAll() {
    return this._lock(async () => {
      try {
        const data = await this.db.getData();
        return data || {};
      } catch (err) {
        if (err.code === 'ENOENT') return this.initialData;
        if (this._isCorrupted(err)) {
          await this._resetDb();
          return this.initialData;
        }
        throw err;
      }
    });
  }

  async get(key) {
    return this._lock(async () => {
      try {
        const val = await this.db.getData(key);
        return val !== undefined ? val : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        if (this._isCorrupted(err)) {
          await this._resetDb();
          return null;
        }
        throw err;
      }
    });
  }

  async set(key, value) {
    return this._lock(async () => {
      await this.db.saveData(key, value);
      return value;
    });
  }

  async delete(key) {
    return this._lock(async () => {
      const all = await this.db.getData();
      if (all && key in all) {
        delete all[key];
        const msgpack = await import('msgpack-lite');
        const binary = msgpack.default.encode(all);
        await fs.promises.writeFile(this.filePath, binary);
      }
      return true;
    });
  }

  async setAll(fullData) {
    return this._lock(async () => {
      const msgpack = await import('msgpack-lite');
      const binary = msgpack.default.encode(fullData);
      await fs.promises.writeFile(this.filePath, binary);
      return fullData;
    });
  }
}

// Built-in Provider is EXCLUSIVELY Antigravity
// (OpenAI, Anthropic, Gemini are API adapter types for custom providers)
const defaultProviders = {
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    preset: 'antigravity',
    type: 'antigravity',
    baseURL: 'https://daily-cloudcode-pa.googleapis.com',
    enabled: true,
    priority: 5,
    rateLimitCooldownSec: 60,
    models: [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium',
      'gemini-3.7-flash-low',
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.5-flash-high',
      'gemini-3.5-flash-medium',
      'gemini-3.5-flash-low',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
    ],
    accounts: [],
  },
};

// Default Virtual Routes targeting real Antigravity 3.x models
const defaultRoutes = {
  'kasrai/smart': {
    alias: 'kasrai/smart',
    description: 'High-capability reasoning model (Gemini 3.1 Pro High / 3.8 / Claude 4.6)',
    rotationMode: 'priority',
    rrIndex: 0,
    targets: [
      { provider: 'antigravity', model: 'gemini-3.1-pro-high' },
      { provider: 'antigravity', model: 'gemini-3.8-flash-high' },
      { provider: 'antigravity', model: 'claude-sonnet-4-6' },
    ],
  },
  'kasrai/fast': {
    alias: 'kasrai/fast',
    description: 'Ultra-low latency model (Gemini 3.7 / 3.6 / 3.5 Flash High)',
    rotationMode: 'round-robin',
    rrIndex: 0,
    targets: [
      { provider: 'antigravity', model: 'gemini-3.7-flash-high' },
      { provider: 'antigravity', model: 'gemini-3.6-flash-high' },
      { provider: 'antigravity', model: 'gemini-3.5-flash-high' },
    ],
  },
};

const defaultConfig = {
  systemKey: '',
  defaultCooldownMs: 15 * 60 * 1000,
  maxRetries: 5,
};

export const providersDB = new KasDBStore('providers', defaultProviders);
export const routesDB = new KasDBStore('routes', defaultRoutes);
export const configDB = new KasDBStore('config', defaultConfig);
export const logsDB = new KasDBStore('logs', { items: [] });
