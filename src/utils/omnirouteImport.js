import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { scryptSync, createDecipheriv } from 'node:crypto';
import { providersDB } from '../db/index.js';
import { OAUTH_PRESETS } from './oauth.js';

const OMNIROUTE_DIR = process.env.OMNIROUTE_DIR || path.join(os.homedir(), '.omniroute');
const SQLITE_PATH = path.join(OMNIROUTE_DIR, 'storage.sqlite');
const ENV_PATH = path.join(OMNIROUTE_DIR, '.env');

// Accurate mapping of provider IDs to their real Base URLs
const KNOWN_PROVIDER_BASE_URLS = {
  antigravity: 'https://cloudcode-pa.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  'gemini-cli': 'https://generativelanguage.googleapis.com/v1beta',
  'gemini-web': 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  siliconflow: 'https://api.siliconflow.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.com/v2',
  friendliai: 'https://inference.friendli.ai/v1',
  huggingface: 'https://api-inference.huggingface.co/v1',
  huggingchat: 'https://huggingface.co/chat/api',
  'api-airforce': 'https://api.airforce/v1',
  'kilo-gateway': 'https://gateway.kilo.ai/v1',
  zenmux: 'https://zenmux.ai/api/v1',
  'freemodel-dev': 'https://api.freemodel.dev/v1',
  bazaarlink: 'https://api.bazaarlink.com/v1',
  'command-code': 'https://api.command-code.com/v1',
  qoder: 'https://api.qoder.com/v1',
  agentrouter: 'https://api.agentrouter.com/v1',
  trae: 'https://api-us-east.trae.ai',
  'kimi-coding': 'https://api.moonshot.cn/v1',
  'github-models': 'https://models.inference.ai.azure.com',
  'arcee-ai': 'https://api.arcee.ai/v1',
  'freeaiapikey': 'https://freeaiapikey.com/v1',
  'ollama-cloud': 'https://ollama.com/v1',
  'lm-studio': 'http://localhost:1234/v1',
  'ollama-local': 'http://nodefrankfurt.kasperstudios.xyz:8765/v1',
  sq: 'https://api.onlysq.me/ai/openai/',
  fta: 'https://api.freetheai.xyz/v1',
};

// Non-chat services to ignore during chat gateway import
const NON_CHAT_SERVICES = new Set([
  'elevenlabs',
  'deepgram',
  'assemblyai',
  'tavily-search',
  'exa-search',
  'linkup-search',
  'inworld',
  'piapi',
  'suno',
]);

export async function importFromOmniroute() {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`OmniRoute database not found at ${SQLITE_PATH}`);
  }

  // 1. Resolve encryption key from .env if present
  let staticKey = null;
  if (fs.existsSync(ENV_PATH)) {
    const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    const match = envContent.match(/STORAGE_ENCRYPTION_KEY=([^\r\n]+)/);
    if (match) {
      const secret = match[1].trim();
      staticKey = scryptSync(secret, 'omniroute-field-encryption-v1', 32);
    }
  }

  function decrypt(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return '';
    if (!ciphertext.startsWith('enc:v1:')) return ciphertext;
    if (!staticKey) return null;

    const parts = ciphertext.slice(7).split(':');
    if (parts.length !== 3) return null;
    const [ivHex, encHex, tagHex] = parts;

    try {
      const decipher = createDecipheriv('aes-256-gcm', staticKey, Buffer.from(ivHex, 'hex'), {
        authTagLength: 16,
      });
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return decipher.update(encHex, 'hex', 'utf8') + decipher.final('utf8');
    } catch {
      return null;
    }
  }

  // 2. Query ALL connections in JSON format
  const sql = `SELECT id, provider, auth_type, name, email, access_token, refresh_token, expires_at, api_key, project_id, provider_specific_data, is_active FROM provider_connections;`;
  let rawJson = '';
  try {
    rawJson = execSync(`sqlite3 -json "${SQLITE_PATH}" "${sql}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    if (err.message && err.message.includes('not found')) {
      throw new Error("Утилита 'sqlite3' не найдена. В Termux выполните: pkg install sqlite");
    }
    throw new Error(`Failed to query OmniRoute SQLite: ${err.message}`);
  }

  let rows = [];
  try {
    rows = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Failed to parse OmniRoute JSON output: ${err.message}`);
  }

  // Start with built-in Antigravity preserved
  const existingProviders = await providersDB.getAll();
  const cleanProviders = {
    antigravity: existingProviders.antigravity || {
      id: 'antigravity',
      name: 'Antigravity',
      preset: 'antigravity',
      type: 'antigravity',
      baseURL: 'https://cloudcode-pa.googleapis.com',
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

  let importedAccountsCount = 0;
  let importedProvidersCount = 0;
  const importedDetails = [];

  for (const row of rows) {
    const rawProvider = (row.provider || '').toLowerCase().trim();
    if (!rawProvider || NON_CHAT_SERVICES.has(rawProvider)) continue;

    let specData = {};
    if (row.provider_specific_data) {
      try {
        specData = JSON.parse(row.provider_specific_data);
      } catch {}
    }

    // Determine normalized provider ID and Name
    let providerId = rawProvider;
    let providerName = rawProvider.charAt(0).toUpperCase() + rawProvider.slice(1);

    if (specData.nodeName) {
      providerName = specData.nodeName;
      if (specData.prefix) {
        providerId = specData.prefix.toLowerCase();
      }
    }

    // Determine actual Base URL (never default to openai.com for non-openai!)
    let parsedBaseUrl =
      specData.baseUrl ||
      specData.host ||
      KNOWN_PROVIDER_BASE_URLS[providerId] ||
      KNOWN_PROVIDER_BASE_URLS[rawProvider] ||
      (rawProvider === 'openai' ? 'https://api.openai.com/v1' : `https://api.${rawProvider}.com/v1`);

    // Clean trailing slashes
    parsedBaseUrl = parsedBaseUrl.replace(/\/+$/, '');

    // Determine adapter type
    let type = 'openai';
    let defaultModels = [];

    if (rawProvider === 'antigravity') {
      type = 'antigravity';
      parsedBaseUrl = 'https://cloudcode-pa.googleapis.com';
    } else if (rawProvider.includes('gemini')) {
      type = 'gemini';
      defaultModels = ['gemini-2.5-pro', 'gemini-2.0-flash'];
    } else if (rawProvider.includes('anthropic') || rawProvider.includes('claude')) {
      type = 'anthropic';
      defaultModels = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'];
    } else if (rawProvider === 'groq') {
      defaultModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'deepseek-r1-distill-llama-70b'];
    } else if (rawProvider === 'openrouter') {
      defaultModels = ['anthropic/claude-3.5-sonnet', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct'];
    }

    const apiKey = decrypt(row.api_key);
    const accessToken = decrypt(row.access_token);
    const refreshToken = decrypt(row.refresh_token);
    const isOAuth = row.auth_type === 'oauth' || !!accessToken || !!refreshToken;

    // Skip empty dummy test entries without credentials
    if (!isOAuth && (!apiKey || apiKey.length < 5)) continue;

    // Register provider if new
    if (!cleanProviders[providerId]) {
      cleanProviders[providerId] = {
        id: providerId,
        name: providerName,
        preset: rawProvider,
        type,
        baseURL: parsedBaseUrl,
        enabled: true,
        priority: rawProvider === 'antigravity' ? 5 : 15,
        rateLimitCooldownSec: 60,
        models: defaultModels,
        accounts: [],
      };
      importedProvidersCount++;
    }

    const providerObj = cleanProviders[providerId];
    if (!Array.isArray(providerObj.accounts)) {
      providerObj.accounts = [];
    }

    const email = row.email || row.name || `account-${(row.id || '').slice(0, 6)}`;
    const resolvedProjectId = row.project_id || specData.projectId || 'aicode-consumers';

    const accountItem = {
      id: row.id || crypto.randomUUID(),
      name: email,
      authType: isOAuth ? 'oauth' : 'key',
      apiKey: !isOAuth && apiKey ? apiKey : '',
      projectId: resolvedProjectId,
      oauth: isOAuth
        ? {
            accessToken: accessToken || '',
            refreshToken: refreshToken || '',
            expiresAt: row.expires_at || new Date(Date.now() + 3600 * 1000).toISOString(),
            clientId: OAUTH_PRESETS.antigravity.clientId,
            clientSecret: OAUTH_PRESETS.antigravity.clientSecret,
            tokenEndpoint: OAUTH_PRESETS.antigravity.tokenUrl,
            projectId: resolvedProjectId,
          }
        : null,
      status: 'active',
      cooldownUntil: 0,
      cooldownReason: null,
      stats: { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: null },
    };

    const existingIdx = providerObj.accounts.findIndex((a) => a.id === accountItem.id || a.name === accountItem.name);
    if (existingIdx !== -1) {
      providerObj.accounts[existingIdx] = accountItem;
    } else {
      providerObj.accounts.push(accountItem);
    }

    importedAccountsCount++;
    importedDetails.push(`${providerName} (${parsedBaseUrl}): ${email}`);
  }

  // Save cleaned providers to kasdb
  await providersDB.setAll(cleanProviders);

  return {
    success: true,
    importedProvidersCount: Object.keys(cleanProviders).length,
    importedAccountsCount,
    details: importedDetails,
  };
}
