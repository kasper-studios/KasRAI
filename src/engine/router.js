import { providersDB, routesDB } from '../db/index.js';
import { createAdapter } from '../adapters/index.js';
import { accountManager } from './accountManager.js';
import { modelStateEngine } from './modelStateEngine.js';
import { logCall, startActiveRequest, updateActiveRequest, finishActiveRequest } from '../utils/logger.js';
import { resolveTimeouts, stripTimeoutFields } from '../utils/timeoutResolver.js';
import crypto from 'node:crypto';

// In-flight attempt tracking per account: parallel requests used to grab the same
// highest-priority account simultaneously and Google burst-limits the rest into 429s.
const accountInflight = new Map();
const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 1;

function inflightKey(candidate) {
  return `${candidate.provider.id}:${candidate.account?.id || 'default'}`;
}

function inflightCount(candidate) {
  return accountInflight.get(inflightKey(candidate)) || 0;
}

function maxPerAccount(provider) {
  const n = parseInt(provider?.maxConcurrentPerAccount, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_CONCURRENT_PER_ACCOUNT;
}

export class RouterEngine {
  /**
   * Resolves requested model into candidate execution targets with account rotation.
   */
  async resolveTargets(requestedModel) {
    const providersMap = await providersDB.getAll();
    const routesMap = await routesDB.getAll();

    // 1. Alias in routesDB
    const aliasRoute = routesMap[requestedModel];
    if (aliasRoute && aliasRoute.enabled !== false && Array.isArray(aliasRoute.targets) && aliasRoute.targets.length > 0) {
      let targets = [...aliasRoute.targets];
      const mode = aliasRoute.rotationMode || 'priority';

      // Apply model rotation strategy
      if (mode === 'round-robin') {
        const idx = aliasRoute.rrIndex || 0;
        targets = [...targets.slice(idx), ...targets.slice(0, idx)];
        aliasRoute.rrIndex = (idx + 1) % targets.length;
        await routesDB.set(requestedModel, aliasRoute);
      } else if (mode === 'random') {
        targets.sort(() => Math.random() - 0.5);
      }

      const candidates = [];
      for (const t of targets) {
        const provider = providersMap[t.provider];
        if (!provider || !provider.enabled) continue;

        // Skip broken 404 models during routing
        const mState = await modelStateEngine.getModelState(provider.id, t.model);
        if (mState.status === 'broken_404') {
          console.warn(`[Router] Skipping broken (404) target: ${provider.id}/${t.model}`);
          continue;
        }

        // Fetch viable accounts (excluding those on cooldown or exhausted on this model)
        const viableAccounts = await accountManager.getViableAccounts(provider.id, t.model);
        if (viableAccounts.length > 0) {
          for (const acc of viableAccounts) {
            candidates.push({
              provider,
              targetModel: t.model,
              account: acc,
              modelPriority: mState.effectivePriority || 50,
            });
          }
        }
      }
      if (candidates.length > 0) {
        // Sort candidates by effective model priority DESC, then by account priority DESC
        candidates.sort((a, b) => {
          const modelDiff = (b.modelPriority || 50) - (a.modelPriority || 50);
          if (modelDiff !== 0) return modelDiff;
          return (b.account?.priority || 0) - (a.account?.priority || 0);
        });
        return candidates;
      }
    }

    // 2. Direct provider/model
    if (requestedModel.includes('/')) {
      const [providerId, ...rest] = requestedModel.split('/');
      const targetModel = rest.join('/');
      const provider = providersMap[providerId];
      if (provider && provider.enabled) {
        const mState = await modelStateEngine.getModelState(provider.id, targetModel);
        const viableAccounts = await accountManager.getViableAccounts(provider.id, targetModel);
        console.log(`[Router] Viable accounts for direct ${provider.id}:`, viableAccounts.map(a => `${a.name} (P:${a.priority})`));
        return viableAccounts.map((acc) => ({
          provider,
          targetModel,
          account: acc,
          modelPriority: mState.effectivePriority || 50,
        }));
      }
    }

    // 3. Match provider by advertised model
    for (const provider of Object.values(providersMap)) {
      if (!provider.enabled) continue;
      if (Array.isArray(provider.models) && provider.models.includes(requestedModel)) {
        const mState = await modelStateEngine.getModelState(provider.id, requestedModel);
        if (mState.status === 'broken_404') continue; // Don't auto-match 404 broken models
        const viableAccounts = await accountManager.getViableAccounts(provider.id, requestedModel);
        return viableAccounts.map((acc) => ({
          provider,
          targetModel: requestedModel,
          account: acc,
          modelPriority: mState.effectivePriority || 50,
        }));
      }
    }

    // 4. Fallback to any enabled provider
    const enabledProviders = Object.values(providersMap).filter((p) => p.enabled);
    if (enabledProviders.length > 0) {
      enabledProviders.sort((a, b) => (a.priority || 50) - (b.priority || 50));
      const fallbackProvider = enabledProviders[0];
      const viableAccounts = await accountManager.getViableAccounts(fallbackProvider.id);
      return viableAccounts.map((acc) => ({
        provider: fallbackProvider,
        targetModel: requestedModel,
        account: acc,
      }));
    }

    return [];
  }

  /**
   * Execute chat completion with multi-account rotation, failover, and zero-token guard.
   */
  async executeChat(requestPayload, res, isStream = false) {
    const requestedModel = requestPayload.model || 'default';
    // Client-side timeout overrides must never leak into upstream provider payloads
    const upstreamPayload = stripTimeoutFields(requestPayload);
    const candidates = await this.resolveTargets(requestedModel);

    if (candidates.length === 0) {
      const errMsg = `No active providers or non-cooldown accounts available for '${requestedModel}'. Check KasRAI dashboard.`;
      await logCall({
        requestedModel,
        status: 'error',
        statusCode: 503,
        error: errMsg,
      });
      return res.status(503).json({
        error: {
          message: errMsg,
          type: 'kasrai_no_viable_accounts',
          code: 503,
        },
      });
    }

    const errors = [];
    const candidateErrors = [];
    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    // Client disconnect tracking: abort the current upstream attempt when the client goes away
    // (otherwise the upstream request keeps generating and burns quota for nobody).
    let clientDisconnected = false;
    let attemptAbortController = null;
    const onResClose = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        attemptAbortController?.abort();
        console.warn(`[Router] Client disconnected for request ${requestId}; aborting current attempt.`);
      }
    };
    res.on('close', onResClose);

    // Estimate input prompt tokens from text length (~4 chars per token)
    let estimatedPromptTokens = 0;
    if (Array.isArray(requestPayload.messages)) {
      for (const m of requestPayload.messages) {
        if (typeof m.content === 'string') estimatedPromptTokens += Math.ceil(m.content.length / 4);
      }
    }

    startActiveRequest(requestId, {
      requestedModel,
      stream: isStream,
      clientRequest: requestPayload,
      promptTokens: estimatedPromptTokens,
    });

    // Flapping shared pools (cloudcode-pa free tier) often return 429 for EVERY account
    // for tens of seconds, then release. One retry round with a short backoff saves the
    // request from a 502; skipped entirely when the failure wasn't quota-family.
    const RETRY_ROUNDS = 2;
    const RETRY_DELAY_MS = 10000;
    try {
      for (let round = 0; round < RETRY_ROUNDS && !clientDisconnected; round++) {
      if (round > 0) {
        const allQuota = candidateErrors.length > 0 && candidateErrors.every((e) => e.status === 429);
        if (!allQuota) break;
        console.warn(`[Router] All candidates hit 429/quota — retry round #${round + 1} in ${RETRY_DELAY_MS / 1000}s (flapping upstream pool)...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        if (clientDisconnected) break;
      }
      for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const attemptStart = Date.now();
      const adapter = createAdapter(candidate.provider, candidate.account);
      const timeouts = resolveTimeouts(requestPayload, candidate.provider);
      attemptAbortController = new AbortController();

      // Anti-herd: skip accounts that already carry a concurrent attempt, unless
      // nothing freer is left (then the least busy one is still tried — never 503 on this).
      const maxConc = maxPerAccount(candidate.provider);
      if (inflightCount(candidate) >= maxConc && candidates.slice(i + 1).some((c) => inflightCount(c) < maxPerAccount(c.provider))) {
        errors.push(`[${candidate.provider.id}:${candidate.account?.name || candidate.account?.id || 'default'}]: skipped (account busy, ${inflightCount(candidate)} in-flight)`);
        continue;
      }
      const iKey = inflightKey(candidate);
      accountInflight.set(iKey, inflightCount(candidate) + 1);

      updateActiveRequest(requestId, {
        routedProvider: candidate.provider.id,
        routedModel: candidate.targetModel,
        accountName: candidate.account?.name || candidate.account?.id || 'default',
      });

      try {
        console.log(
          `[Router] Target #${i + 1}: [${candidate.provider.id}/${candidate.targetModel}] using account '${
            candidate.account?.name || candidate.account?.id || 'default'
          }'`
        );

        if (isStream) {
          // Wrap stream with deferred response handling: don't commit headers to client
          // until the first byte/chunk actually arrives from upstream!
          // If first chunk takes >= firstChunkMs, abort and rotate to next candidate account!
          // Timeout is resolved per attempt: request field > provider config > env default.
          let clientHeadersCommitted = false;
          let firstChunkTimer = null;
          const streamAbortController = attemptAbortController;
          // This attempt is considered abandoned once it timed out or the client left:
          // the (still running in background) adapter must not write into the client res anymore.
          let attemptAbandoned = false;

          // Intercept proxy response object passed to adapter.stream
          const streamProxyRes = new Proxy(res, {
            get(target, prop) {
              if (prop === 'write') {
                return function (chunk, encoding, cb) {
                  if (attemptAbandoned || clientDisconnected || target.destroyed) {
                    // Drop chunks from an abandoned attempt instead of interleaving
                    // them into the next candidate's stream or a destroyed socket.
                    return true;
                  }
                  if (!clientHeadersCommitted) {
                    if (firstChunkTimer) clearTimeout(firstChunkTimer);
                    clientHeadersCommitted = true;
                    if (!target.headersSent) {
                      target.setHeader('Content-Type', 'text/event-stream');
                      target.setHeader('Cache-Control', 'no-cache');
                      target.setHeader('Connection', 'keep-alive');
                      target.flushHeaders?.();
                    }
                  }
                  return target.write(chunk, encoding, cb);
                };
              }
              if (prop === 'end') {
                return function (...args) {
                  // A background-abandoned attempt must not terminate the client connection
                  // that a subsequent attempt may already be streaming into.
                  if (attemptAbandoned || clientDisconnected) return;
                  return target.end(...args);
                };
              }
              if (prop === 'setHeader' || prop === 'flushHeaders') {
                // Defer actual headers dispatch until first write
                return function (...args) {
                  if (clientHeadersCommitted) return target[prop](...args);
                };
              }
              if (prop === 'headersSent') {
                return clientHeadersCommitted || target.headersSent;
              }
              const val = target[prop];
              return typeof val === 'function' ? val.bind(target) : val;
            },
          });

          const timeoutPromise = new Promise((_, reject) => {
            firstChunkTimer = setTimeout(() => {
              if (!clientHeadersCommitted) {
                attemptAbandoned = true;
                streamAbortController.abort();
                const err = new Error(`First chunk response timeout (${timeouts.firstChunkMs}ms exceeded)`);
                err.status = 504;
                err.isTimeout = true;
                reject(err);
              }
            }, timeouts.firstChunkMs);
          });

          let streamResult;
          try {
            streamResult = await Promise.race([
              adapter.stream(upstreamPayload, candidate.targetModel, streamProxyRes, {
                signal: streamAbortController.signal,
                firstChunkMs: timeouts.firstChunkMs,
                idleMs: timeouts.idleMs,
              }),
              timeoutPromise,
            ]);
          } finally {
            if (firstChunkTimer) clearTimeout(firstChunkTimer);
          }

          const latencyMs = Date.now() - attemptStart;
          await accountManager.recordAccountSuccess(candidate.provider.id, candidate.account.id, latencyMs);
          await logCall({
            requestId,
            requestedModel,
            routedProvider: candidate.provider.id,
            routedModel: candidate.targetModel,
            accountName: candidate.account?.name || candidate.account?.id || 'default',
            status: i > 0 ? 'fallback' : 'success',
            statusCode: 200,
            latencyMs,
            promptTokens: streamResult?.promptTokens || estimatedPromptTokens,
            completionTokens: streamResult?.completionTokens || 0,
            stream: true,
            clientRequest: requestPayload,
            upstreamRequest: {
              provider: candidate.provider.id,
              targetModel: candidate.targetModel,
              account: candidate.account?.name || candidate.account?.id || 'default',
              baseURL: candidate.provider.baseURL,
            },
            upstreamResponse: { type: 'sse_stream', note: 'Response streamed to client via SSE' },
          });
          return;
        } else {
          const completeAbortController = attemptAbortController;
          let completionTimer = null;
          const timeoutPromise = new Promise((_, reject) => {
            completionTimer = setTimeout(() => {
              completeAbortController.abort(); // kill the upstream request so it stops burning quota
              const err = new Error(`Model completion response timeout (${timeouts.completionMs}ms exceeded)`);
              err.status = 504;
              err.isTimeout = true;
              reject(err);
            }, timeouts.completionMs);
          });

          let responseData;
          try {
            responseData = await Promise.race([
              adapter.complete(upstreamPayload, candidate.targetModel, { signal: completeAbortController.signal }),
              timeoutPromise,
            ]);
          } finally {
            if (completionTimer) clearTimeout(completionTimer);
          }
          const latencyMs = Date.now() - attemptStart;
          await accountManager.recordAccountSuccess(candidate.provider.id, candidate.account.id, latencyMs);
          await logCall({
            requestId,
            requestedModel,
            routedProvider: candidate.provider.id,
            routedModel: candidate.targetModel,
            accountName: candidate.account?.name || candidate.account?.id || 'default',
            status: i > 0 ? 'fallback' : 'success',
            statusCode: 200,
            latencyMs,
            promptTokens: responseData.usage?.prompt_tokens || estimatedPromptTokens,
            completionTokens: responseData.usage?.completion_tokens || 0,
            stream: false,
            clientRequest: requestPayload,
            upstreamRequest: {
              provider: candidate.provider.id,
              targetModel: candidate.targetModel,
              account: candidate.account?.name || candidate.account?.id || 'default',
              baseURL: candidate.provider.baseURL,
              attemptNumber: i + 1,
              skippedErrors: errors,
            },
            upstreamResponse: responseData,
          });

          return res.json(responseData);
        }
      } catch (err) {
        const attemptLatency = Date.now() - attemptStart;
        const errDetail = `[${candidate.provider.id}:${candidate.account?.name || candidate.account?.id}]: ${err.message}`;
        console.warn(`[Router] Target failed (${attemptLatency}ms): ${errDetail}`);
        errors.push(errDetail);
        candidateErrors.push({
          provider: candidate.provider.id,
          account: candidate.account?.name || candidate.account?.id || 'default',
          targetModel: candidate.targetModel,
          status: err.status || null,
          message: err.message,
          // Full upstream body (quota violation ids / RetryInfo live here — the
          // generic "Resource has been exhausted" message alone is not diagnostic)
          data: err.data || null,
        });

        // Check if error is ZERO-TOKEN GUARD
        if (err.status === 999 || err.message?.startsWith('APKAKALSA PEDIK')) {
          console.error('[Router] 💩 APKAKALSA PEDIK: Upstream returned 0 tokens!');
          await logCall({
            requestId,
            requestedModel,
            routedProvider: candidate.provider.id,
            routedModel: candidate.targetModel,
            accountName: candidate.account?.name || candidate.account?.id || 'default',
            status: 'error',
            statusCode: 999,
            latencyMs: attemptLatency,
            error: 'APKAKALSA PEDIK',
            clientRequest: requestPayload,
            upstreamRequest: {
              provider: candidate.provider.id,
              targetModel: candidate.targetModel,
              account: candidate.account?.name || candidate.account?.id || 'default',
              baseURL: candidate.provider.baseURL,
            },
            upstreamResponse: err.data || { error: 'APKAKALSA PEDIK (0 tokens)' },
          });
          if (!res.headersSent) {
            return res.status(999).json({
              error: {
                message: 'APKAKALSA PEDIK',
                type: 'apkakalsa_pedik',
                code: 999,
              },
            });
          }
          return;
        }

        // Check for ToS Ban / Account Disabled / User Suspended
        const errStr = `${err.message || ''} ${JSON.stringify(err.data || err.errorData || '')}`.toLowerCase();
        const isToSBan =
          errStr.includes('service has been disabled in this account') ||
          errStr.includes('terms of service') ||
          errStr.includes('account_disabled') ||
          errStr.includes('user_suspended') ||
          errStr.includes('has been disabled');

        if (isToSBan && candidate.account) {
          await accountManager.banAccount(
            candidate.provider.id,
            candidate.account.id,
            err.message || 'Terms of Service violation / Account Disabled'
          );
        }

        // Check for 429 / Rate Limit / Quota Exceeded
        const isQuotaErr =
          !isToSBan && (
            err.status === 429 ||
            err.message?.includes('RESOURCE_EXHAUSTED') ||
            err.message?.includes('rate_limit_exceeded') ||
            err.message?.includes('insufficient_quota') ||
            err.message?.includes('quota')
          );

        if (isQuotaErr && candidate.account) {
          // Pass full error object with data and headers so RetryInfo/quotaResetDelay is accurately parsed!
          // Also pass targetModel so quota check knows which bucket to inspect after 429!
          await accountManager.triggerAccountCooldown(candidate.provider.id, candidate.account.id, {
            status: err.status,
            message: err.message,
            data: err.data || err.errorData,
            headers: err.headers,
          }, candidate.targetModel);
        } else if (err.isTimeout && candidate.account) {
          // Account hung / unresponsive: trigger short temporary cooldown (e.g. 90s)
          // so router immediately falls back to next non-hung account without re-trying this one right away!
          await accountManager.triggerAccountCooldown(candidate.provider.id, candidate.account.id, {
            status: 504,
            message: `Model response hung (${err.message})`,
            cooldownMs: 90000,
          }, candidate.targetModel);
        }

        // If response headers already sent, cannot fallback
        if (res.headersSent) {
          console.error('[Router] Headers already sent to client; stream aborted.');
          return;
        }

        // Nobody is listening anymore: stop rotating through candidates (and burning quota).
        if (clientDisconnected) {
          console.warn('[Router] Client disconnected; stopping failover rotation.');
          return;
        }
      } finally {
        // Release the in-flight slot (runs on success return, error and rotation alike)
        accountInflight.set(iKey, Math.max(0, (accountInflight.get(iKey) || 1) - 1));
      }
      }
      }

    // All accounts & providers failed
    const totalLatency = Date.now() - startTime;
    const finalErrMsg = `All ${candidates.length} routing candidate(s) failed for '${requestedModel}': ${errors.join('; ')}`;

    // When EVERY candidate got 429, this is upstream rate-limiting (often a flapping
    // shared pool invisible in quota APIs), not a gateway failure. Respond 429 + Retry-After
    // so agent clients back off and retry themselves instead of treating it as fatal.
    const allQuotaExhausted =
      candidateErrors.length > 0 && candidateErrors.every((e) => e.status === 429);
    const finalStatus = allQuotaExhausted ? 429 : 502;

    await logCall({
      requestId,
      requestedModel,
      status: 'error',
      statusCode: finalStatus,
      latencyMs: totalLatency,
      error: finalErrMsg,
      stream: isStream,
      raw: true, // capture the FULL client request (system prompt) for diagnostics
      clientRequest: requestPayload,
      upstreamRequest: {
        attemptedCandidates: candidates.map((c) => ({
          provider: c.provider.id,
          targetModel: c.targetModel,
          account: c.account?.name || c.account?.id || 'default',
        })),
      },
      upstreamResponse: { error: finalErrMsg, details: errors, candidateErrors },
    });

    if (!res.headersSent) {
      if (allQuotaExhausted) {
        res.setHeader('Retry-After', '30');
      }
      return res.status(finalStatus).json({
        error: {
          message: finalErrMsg,
          type: allQuotaExhausted ? 'kasrai_rate_limited' : 'kasrai_all_candidates_failed',
          code: finalStatus,
          details: errors,
        },
      });
    }
  } finally {
    res.off('close', onResClose);
    finishActiveRequest(requestId);
  }
}
}

export const routerEngine = new RouterEngine();
