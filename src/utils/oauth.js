import crypto from 'node:crypto';
import { providersDB } from '../db/index.js';
import { resolvePublicCred } from './publicCreds.js';

export const OAUTH_PRESETS = {
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

/**
 * Build OAuth authorization URL
 */
export function buildOAuthUrl(providerId, redirectUri) {
  const preset = OAUTH_PRESETS[providerId] || OAUTH_PRESETS.antigravity;
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

  const preset = OAUTH_PRESETS[providerId] || OAUTH_PRESETS.antigravity;

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

/**
 * Return valid Bearer token for account, refreshing if needed
 */
export async function getValidAuthToken(providerId, account) {
  if (!account) return '';

  if (account.authType === 'key' || !account.authType) {
    return account.apiKey || '';
  }

  if (account.authType === 'oauth' && account.oauth) {
    const oauth = account.oauth;
    const now = Date.now();
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0;

    if (oauth.accessToken && expiresAt > now + 60000) {
      return oauth.accessToken;
    }

    if (oauth.refreshToken && oauth.tokenEndpoint) {
      console.log(`[OAuth] Refreshing token for account '${account.name || account.id}' (${providerId})...`);
      try {
        let res;
        try {
          const bodyParams = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
          });
          if (oauth.clientId) bodyParams.set('client_id', oauth.clientId);
          if (oauth.clientSecret) bodyParams.set('client_secret', oauth.clientSecret);

          res = await fetch(oauth.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyParams.toString(),
            signal: AbortSignal.timeout(5000),
          });
        } catch (fetchErr) {
          const { execSync } = await import('node:child_process');
          const curlBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(oauth.refreshToken)}&client_id=${encodeURIComponent(oauth.clientId || '')}&client_secret=${encodeURIComponent(oauth.clientSecret || '')}`;
          const rawCurlOut = execSync(`curl -s -X POST "${oauth.tokenEndpoint}" -H "Content-Type: application/x-www-form-urlencoded" -d "${curlBody}"`, {
            encoding: 'utf-8',
            timeout: 10000,
          });
          const parsed = JSON.parse(rawCurlOut);
          res = {
            ok: !parsed.error,
            status: parsed.error ? 400 : 200,
            json: async () => parsed,
            text: async () => rawCurlOut,
          };
        }

        if (res.ok) {
          const tokenData = await res.json();
          oauth.accessToken = tokenData.access_token;
          if (tokenData.expires_in) {
            oauth.expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
          }
          if (tokenData.refresh_token) {
            oauth.refreshToken = tokenData.refresh_token;
          }

          const provider = await providersDB.get(providerId);
          if (provider && Array.isArray(provider.accounts)) {
            const idx = provider.accounts.findIndex((a) => a.id === account.id);
            if (idx !== -1) {
              provider.accounts[idx].oauth = oauth;
              await providersDB.set(providerId, provider);
            }
          }

          console.log(`[OAuth] Successfully refreshed token for '${account.name || account.id}'!`);
          return oauth.accessToken;
        } else {
          console.warn(`[OAuth] Refresh failed (${res.status}): ${await res.text()}`);
        }
      } catch (err) {
        console.error(`[OAuth] Token refresh error for '${account.name}':`, err.message);
      }
    }

    return oauth.accessToken || '';
  }

  return account.apiKey || '';
}
