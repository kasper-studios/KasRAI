import crypto from 'node:crypto';
import { providersDB } from '../db/index.js';
import { resolvePublicCred } from './publicCreds.js';

export const OAUTH_PRESETS = {
  nous: {
    flow: 'device_code',
    portalUrl: 'https://portal.nousresearch.com',
    inferenceBaseURL: 'https://inference-api.nousresearch.com/v1',
    clientId: 'hermes-cli',
    scope: 'inference:invoke',
    tokenUrl: 'https://portal.nousresearch.com/api/oauth/token',
  },
  antigravity: {
    get clientId() { return resolvePublicCred('antigravity_id', 'ANTIGRAVITY_OAUTH_CLIENT_ID'); },
    get clientSecret() { return resolvePublicCred('antigravity_secret', 'ANTIGRAVITY_OAUTH_CLIENT_SECRET'); },
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ],
  },
};

// In-memory state tracking for OAuth CSRF protection
const pendingOAuthStates = new Map();
const pendingNousDeviceFlows = new Map();
const nousRefreshPromises = new Map();

const NOUS_TOKEN_REFRESH_SKEW_MS = 120000;
const NOUS_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function getOAuthPreset(providerId) {
  const preset = OAUTH_PRESETS[providerId];
  if (!preset) throw new Error(`OAuth is not configured for provider '${providerId}'`);
  return preset;
}

function trustedNousPortalUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'portal.nousresearch.com' || url.username || url.password) {
    throw new Error('Nous Portal returned an untrusted verification URL');
  }
  return url.toString();
}

function trustedNousInferenceBaseURL(value) {
  if (!value) return OAUTH_PRESETS.nous.inferenceBaseURL;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'inference-api.nousresearch.com' || url.username || url.password) {
    throw new Error('Nous Portal returned an untrusted inference URL');
  }
  if (!['', '/', '/v1', '/v1/'].includes(url.pathname) || url.search || url.hash) {
    throw new Error('Nous Portal returned an unexpected inference URL path');
  }
  return `https://inference-api.nousresearch.com/v1`;
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function tokenExpiry(token, fallbackExpiresIn = 0) {
  const exp = decodeJwtPayload(token).exp;
  if (Number.isFinite(exp)) return new Date(exp * 1000).toISOString();
  return new Date(Date.now() + Math.max(0, Number(fallbackExpiresIn) || 0) * 1000).toISOString();
}

function hasNousInvokeScope(token, responseScope = '') {
  const claims = decodeJwtPayload(token);
  const scopes = [responseScope, claims.scope, claims.scp]
    .flatMap((value) => Array.isArray(value) ? value : String(value || '').split(/[ ,]+/))
    .filter(Boolean);
  return scopes.includes(OAUTH_PRESETS.nous.scope);
}

function isUsableNousInvokeToken(token, responseScope = '') {
  if (!token || !hasNousInvokeScope(token, responseScope)) return false;
  const exp = Number(decodeJwtPayload(token).exp || 0) * 1000;
  return exp > Date.now() + NOUS_TOKEN_REFRESH_SKEW_MS;
}

async function readNousError(response, action) {
  const text = await response.text().catch(() => '');
  let details = text;
  try {
    const data = JSON.parse(text);
    details = data.error_description || data.message || data.error || text;
  } catch {}
  return new Error(`Nous Portal ${action} failed (HTTP ${response.status}): ${String(details).slice(0, 300)}`);
}

/**
 * Build OAuth authorization URL
 */
export function buildOAuthUrl(providerId, redirectUri) {
  const preset = getOAuthPreset(providerId);
  if (preset.flow === 'device_code') {
    throw new Error(`Provider '${providerId}' uses device-code OAuth; start it from the dashboard`);
  }
  const state = crypto.randomBytes(16).toString('hex');
  pendingOAuthStates.set(state, {
    providerId,
    redirectUri,
    timestamp: Date.now(),
  });

  // Clean old states (> 15 min)
  for (const [st, val] of pendingOAuthStates.entries()) {
    if (Date.now() - val.timestamp > 15 * 60 * 1000) {
      pendingOAuthStates.delete(st);
    }
  }

  const params = new URLSearchParams({
    client_id: preset.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: preset.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return {
    authUrl: `${preset.authorizeUrl}?${params.toString()}`,
    state,
  };
}

/**
 * Exchange code for tokens and fetch profile
 */
export async function exchangeOAuthCode(state, code) {
  const stateData = pendingOAuthStates.get(state);
  const providerId = stateData?.providerId || 'antigravity';
  const redirectUri = stateData?.redirectUri;
  pendingOAuthStates.delete(state);

  const preset = getOAuthPreset(providerId);
  if (preset.flow === 'device_code') {
    throw new Error(`Provider '${providerId}' uses device-code OAuth; authorization codes are not supported`);
  }

  const bodyParams = new URLSearchParams({
    code,
    client_id: preset.clientId,
    client_secret: preset.clientSecret,
    grant_type: 'authorization_code',
  });
  if (redirectUri) {
    bodyParams.set('redirect_uri', redirectUri);
  }

  const tokenRes = await fetch(preset.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams.toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`OAuth token exchange failed (${tokenRes.status}): ${errText}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token || null;
  const expiresIn = tokenData.expires_in || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Fetch user info (email / name)
  let email = `oauth-user-${Date.now()}`;
  let displayName = 'OAuth Account';

  try {
    const userRes = await fetch(`${preset.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      email = userData.email || email;
      displayName = userData.name || email;
    }
  } catch (err) {
    console.warn('[OAuth] Could not fetch user profile:', err.message);
  }

  return {
    providerId,
    email,
    displayName,
    accessToken,
    refreshToken,
    expiresAt,
    clientId: preset.clientId,
    clientSecret: preset.clientSecret,
    tokenEndpoint: preset.tokenUrl,
  };
}

async function ensureNousProvider() {
  const preset = OAUTH_PRESETS.nous;
  let provider = await providersDB.get('nous');
  if (!provider) {
    provider = {
      id: 'nous',
      name: 'Nous Portal',
      preset: 'nous',
      type: 'openai',
      authType: 'oauth_device_code',
      baseURL: preset.inferenceBaseURL,
      enabled: true,
      priority: 10,
      rateLimitCooldownSec: 60,
      models: [],
      accounts: [],
    };
    await providersDB.set('nous', provider);
  }
  return provider;
}

/** Start Hermes-compatible Nous Portal OAuth device authorization. */
export async function startNousDeviceAuthorization() {
  const preset = OAUTH_PRESETS.nous;
  await ensureNousProvider();
  const response = await fetch(`${preset.portalUrl}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: preset.clientId, scope: preset.scope }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw await readNousError(response, 'device authorization');
  const data = await response.json();
  const required = ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval'];
  const missing = required.filter((field) => !data[field]);
  if (missing.length) throw new Error(`Nous Portal device-code response is missing: ${missing.join(', ')}`);

  const state = crypto.randomBytes(32).toString('hex');
  const expiresIn = Math.max(1, Number(data.expires_in) || 600);
  const interval = Math.max(1, Math.min(Number(data.interval) || 5, 30));
  const verificationUri = trustedNousPortalUrl(data.verification_uri);
  const verificationUriComplete = trustedNousPortalUrl(data.verification_uri_complete || verificationUri);
  pendingNousDeviceFlows.set(state, {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri,
    verificationUriComplete,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalSec: interval,
    nextPollAt: 0,
    polling: false,
  });
  for (const [key, flow] of pendingNousDeviceFlows) {
    if (flow.expiresAt <= Date.now()) pendingNousDeviceFlows.delete(key);
  }

  return {
    success: true,
    state,
    userCode: data.user_code,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval,
  };
}

async function exchangeNousDeviceCode(flow) {
  const preset = OAUTH_PRESETS.nous;
  const response = await fetch(preset.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: NOUS_DEVICE_GRANT,
      client_id: preset.clientId,
      device_code: flow.deviceCode,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { response, data };
}

async function resolveNousLoginTokens(deviceTokens) {
  const preset = OAUTH_PRESETS.nous;
  let tokens = { ...deviceTokens };
  if (!tokens.access_token) throw new Error('Nous Portal token response did not include access_token');

  if (!isUsableNousInvokeToken(tokens.access_token, tokens.scope)) {
    if (!tokens.refresh_token) {
      throw new Error('Nous Portal returned no usable inference token and no refresh token');
    }
    const response = await fetch(preset.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'x-nous-refresh-token': tokens.refresh_token,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: preset.clientId,
        refresh_token: tokens.refresh_token,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await readNousError(response, 'inference token exchange');
    const refreshed = await response.json();
    tokens = {
      ...tokens,
      ...refreshed,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      scope: refreshed.scope || tokens.scope,
    };
  }

  if (!isUsableNousInvokeToken(tokens.access_token, tokens.scope)) {
    throw new Error('Nous Portal did not return an unexpired JWT with inference:invoke scope');
  }

  return {
    ...tokens,
    expires_at: tokenExpiry(tokens.access_token, tokens.expires_in),
    inference_base_url: trustedNousInferenceBaseURL(tokens.inference_base_url),
  };
}

async function saveNousAccount(tokens) {
  const provider = await ensureNousProvider();
  const claims = decodeJwtPayload(tokens.access_token);
  const subject = String(claims.sub || claims.user_id || 'nous-account');
  const email = claims.email || claims.preferred_username || '';
  const accountName = email || `Nous Portal (${subject.slice(0, 12)})`;
  if (!Array.isArray(provider.accounts)) provider.accounts = [];
  const existing = provider.accounts.find((account) => account.oauth?.provider === 'nous' && account.oauth?.subject === subject);
  const account = {
    ...(existing || {}),
    id: existing?.id || crypto.randomUUID(),
    name: accountName,
    authType: 'oauth',
    apiKey: '',
    oauth: {
      provider: 'nous',
      subject,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      expiresAt: tokens.expires_at,
      tokenEndpoint: OAUTH_PRESETS.nous.tokenUrl,
      clientId: OAUTH_PRESETS.nous.clientId,
      portalBaseURL: OAUTH_PRESETS.nous.portalUrl,
      inferenceBaseURL: tokens.inference_base_url || OAUTH_PRESETS.nous.inferenceBaseURL,
      scope: tokens.scope || OAUTH_PRESETS.nous.scope,
    },
    status: 'active',
    cooldownUntil: 0,
    cooldownReason: null,
    priority: existing?.priority || 0,
    stats: existing?.stats || { totalRequests: 0, successCount: 0, errorCount: 0, lastUsed: null },
  };
  const index = provider.accounts.findIndex((item) => item.id === account.id);
  if (index === -1) provider.accounts.push(account);
  else provider.accounts[index] = account;
  provider.preset = 'nous';
  provider.type = 'openai';
  provider.authType = 'oauth_device_code';
  provider.baseURL = tokens.inference_base_url || OAUTH_PRESETS.nous.inferenceBaseURL;
  provider.enabled = true;
  await providersDB.set('nous', provider);
  return { providerId: 'nous', accountId: account.id, accountName };
}

/** Poll one device-code flow; the short-lived device credential never leaves the server. */
export async function pollNousDeviceAuthorization(state) {
  const flow = pendingNousDeviceFlows.get(state);
  if (!flow) return { status: 'expired', message: 'Nous login expired or was cancelled. Start it again.' };
  if (flow.expiresAt <= Date.now()) {
    pendingNousDeviceFlows.delete(state);
    return { status: 'expired', message: 'Nous login code expired. Start it again.' };
  }
  if (flow.polling || Date.now() < flow.nextPollAt) {
    return { status: 'pending', intervalMs: Math.max(500, flow.nextPollAt - Date.now()) };
  }

  flow.polling = true;
  flow.nextPollAt = Date.now() + flow.intervalSec * 1000;
  try {
    const { response, data } = await exchangeNousDeviceCode(flow);
    if (response.ok) {
      let tokens;
      try {
        tokens = await resolveNousLoginTokens(data);
      } catch (err) {
        pendingNousDeviceFlows.delete(state);
        return { status: 'error', message: err.message };
      }
      const saved = await saveNousAccount(tokens);
      pendingNousDeviceFlows.delete(state);
      return { status: 'complete', ...saved };
    }

    const code = String(data.error || '');
    if (code === 'authorization_pending') {
      return { status: 'pending', intervalMs: flow.intervalSec * 1000 };
    }
    if (code === 'slow_down') {
      flow.intervalSec = Math.min(flow.intervalSec + 1, 30);
      flow.nextPollAt = Date.now() + flow.intervalSec * 1000;
      return { status: 'pending', intervalMs: flow.intervalSec * 1000 };
    }
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      return { status: 'pending', intervalMs: Math.max(flow.intervalSec * 1000, 5000) };
    }
    pendingNousDeviceFlows.delete(state);
    return { status: 'error', message: data.error_description || data.message || code || `Nous Portal returned HTTP ${response.status}` };
  } catch (err) {
    if (Date.now() >= flow.expiresAt) {
      pendingNousDeviceFlows.delete(state);
      return { status: 'expired', message: 'Nous login code expired. Start it again.' };
    }
    return { status: 'pending', intervalMs: 5000, message: err.message };
  } finally {
    flow.polling = false;
  }
}

export function cancelNousDeviceAuthorization(state) {
  return pendingNousDeviceFlows.delete(state);
}

async function refreshNousAccountToken(providerId, account) {
  const key = `${providerId}:${account.id}`;
  if (nousRefreshPromises.has(key)) return nousRefreshPromises.get(key);

  const refreshPromise = (async () => {
    const provider = await providersDB.get(providerId);
    const latestAccount = provider?.accounts?.find((item) => item.id === account.id) || account;
    let oauth = latestAccount.oauth || {};
    if (oauth.accessToken && isUsableNousInvokeToken(oauth.accessToken, oauth.scope)) {
      account.oauth = oauth;
      return oauth.accessToken;
    }
    if (!oauth.refreshToken) throw new Error('Nous Portal refresh token is missing; sign in again from the dashboard');

    const preset = OAUTH_PRESETS.nous;
    const response = await fetch(oauth.tokenEndpoint || preset.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'x-nous-refresh-token': oauth.refreshToken,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauth.clientId || preset.clientId,
        refresh_token: oauth.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await readNousError(response, 'token refresh');
    const tokenData = await response.json();
    if (!tokenData.access_token) throw new Error('Nous Portal refresh response did not include access_token');
    const scope = tokenData.scope || oauth.scope || '';
    const updatedOAuth = {
      ...oauth,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || oauth.refreshToken,
      expiresAt: tokenExpiry(tokenData.access_token, tokenData.expires_in),
      scope,
      inferenceBaseURL: trustedNousInferenceBaseURL(tokenData.inference_base_url || oauth.inferenceBaseURL),
    };
    oauth = updatedOAuth;
    latestAccount.oauth = oauth;
    account.oauth = oauth;
    if (provider && Array.isArray(provider.accounts)) {
      const index = provider.accounts.findIndex((item) => item.id === account.id);
      if (index !== -1) {
        provider.accounts[index] = { ...provider.accounts[index], oauth };
        await providersDB.set(providerId, provider);
      }
    }
    if (!isUsableNousInvokeToken(updatedOAuth.accessToken, scope)) {
      throw new Error('Nous Portal refresh returned a JWT without a valid inference:invoke scope or expiry');
    }
    return updatedOAuth.accessToken;
  })().finally(() => nousRefreshPromises.delete(key));

  nousRefreshPromises.set(key, refreshPromise);
  return refreshPromise;
}

/**
 * Refresh a generic OAuth (Google-style) account token, deduplicating concurrent refreshes
 * for the same account: Google rotates refresh tokens, so two parallel refreshes with the
 * same refresh token turn the second one into invalid_grant and kill the account.
 */
const genericRefreshPromises = new Map();
async function refreshGenericOAuthToken(providerId, account) {
  const key = `${providerId}:${account.id}`;
  if (genericRefreshPromises.has(key)) return genericRefreshPromises.get(key);

  const refreshPromise = (async () => {
    const provider = await providersDB.get(providerId);
    const latestAccount = provider?.accounts?.find((item) => item.id === account.id) || account;
    const oauth = latestAccount.oauth || {};
    console.log(`[OAuth] Refreshing token for account '${account.name || account.id}' (${providerId})...`);

    try {
      const bodyParams = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
      });
      if (oauth.clientId) bodyParams.set('client_id', oauth.clientId);
      if (oauth.clientSecret) bodyParams.set('client_secret', oauth.clientSecret);

      const res = await fetch(oauth.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyParams.toString(),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[OAuth] Refresh failed (${res.status}): ${errText.slice(0, 150)}`);
        return oauth.accessToken || '';
      }

      const tokenData = await res.json();
      oauth.accessToken = tokenData.access_token;
      oauth.expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
      if (tokenData.refresh_token) {
        oauth.refreshToken = tokenData.refresh_token;
      }

      if (provider && Array.isArray(provider.accounts)) {
        const idx = provider.accounts.findIndex((a) => a.id === account.id);
        if (idx !== -1) {
          provider.accounts[idx].oauth = oauth;
          await providersDB.set(providerId, provider);
        }
      }

      account.oauth = oauth;
      console.log(`[OAuth] Successfully refreshed token for '${account.name || account.id}'!`);
      return oauth.accessToken;
    } catch (err) {
      console.error(`[OAuth] Token refresh error for '${account.name || account.id}':`, err.message);
      return oauth.accessToken || '';
    }
  })().finally(() => genericRefreshPromises.delete(key));

  genericRefreshPromises.set(key, refreshPromise);
  return refreshPromise;
}

/**
 * Return valid Bearer token for account, refreshing if needed
 */
export async function getValidAuthToken(providerId, account) {
  if (!account) return '';

  if (account.authType === 'key' || !account.authType) {
    return account.apiKey || '';
  }

  if (account.oauth?.provider === 'nous') {
    return await refreshNousAccountToken(providerId, account);
  }

  if (account.authType === 'oauth' && account.oauth) {
    const oauth = account.oauth;
    const now = Date.now();
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0;

    if (oauth.accessToken && expiresAt > now + 60000) {
      return oauth.accessToken;
    }

    if (oauth.refreshToken && oauth.tokenEndpoint) {
      return await refreshGenericOAuthToken(providerId, account);
    }

    return oauth.accessToken || '';
  }

  return account.apiKey || '';
}
