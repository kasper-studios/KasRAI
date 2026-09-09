import { providersDB, routesDB } from '../db/index.js';
import { createAdapter } from '../adapters/index.js';
import { accountManager } from './accountManager.js';
import { modelStateEngine } from './modelStateEngine.js';
import { logCall } from '../utils/logger.js';

export class RouterEngine {
  /**
   * Resolves requested model into candidate execution targets with account rotation.
   */
  async resolveTargets(requestedModel) {
    const providersMap = await providersDB.getAll();
    const routesMap = await routesDB.getAll();

    // 1. Alias in routesDB
    const aliasRoute = routesMap[requestedModel];
    if (aliasRoute && Array.isArray(aliasRoute.targets) && aliasRoute.targets.length > 0) {
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
    const startTime = Date.now();

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const attemptStart = Date.now();
      const adapter = createAdapter(candidate.provider, candidate.account);

      try {
        console.log(
          `[Router] Target #${i + 1}: [${candidate.provider.id}/${candidate.targetModel}] using account '${
            candidate.account?.name || candidate.account?.id || 'default'
          }'`
        );

        if (isStream) {
          await adapter.stream(requestPayload, candidate.targetModel, res);

          const latencyMs = Date.now() - attemptStart;
          await accountManager.recordAccountSuccess(candidate.provider.id, candidate.account.id, latencyMs);
          await logCall({
            requestedModel,
            routedProvider: candidate.provider.id,
            routedModel: candidate.targetModel,
            accountName: candidate.account?.name || candidate.account?.id || 'default',
            status: i > 0 ? 'fallback' : 'success',
            statusCode: 200,
            latencyMs,
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
          const responseData = await adapter.complete(requestPayload, candidate.targetModel);
          const latencyMs = Date.now() - attemptStart;
          await accountManager.recordAccountSuccess(candidate.provider.id, candidate.account.id, latencyMs);
          await logCall({
            requestedModel,
            routedProvider: candidate.provider.id,
            routedModel: candidate.targetModel,
            accountName: candidate.account?.name || candidate.account?.id || 'default',
            status: i > 0 ? 'fallback' : 'success',
            statusCode: 200,
            latencyMs,
            promptTokens: responseData.usage?.prompt_tokens || 0,
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

        // Check if error is ZERO-TOKEN GUARD
        if (err.message === 'APKAKALSA PEDIK' || err.status === 999) {
          console.error('[Router] 💩 APKAKALSA PEDIK: Upstream returned 0 tokens!');
          await logCall({
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

        // Check for 429 / Rate Limit / Quota Exceeded
        const isQuotaErr =
          err.status === 429 ||
          err.message?.includes('RESOURCE_EXHAUSTED') ||
          err.message?.includes('rate_limit_exceeded') ||
          err.message?.includes('insufficient_quota') ||
          err.message?.includes('quota');

        if (isQuotaErr && candidate.account) {
          // Pass full error object with data and headers so RetryInfo/quotaResetDelay is accurately parsed!
          // Also pass targetModel so quota check knows which bucket to inspect after 429!
          await accountManager.triggerAccountCooldown(candidate.provider.id, candidate.account.id, {
            status: err.status,
            message: err.message,
            data: err.data || err.errorData,
            headers: err.headers,
          }, candidate.targetModel);
        }

        // If response headers already sent, cannot fallback
        if (res.headersSent) {
          console.error('[Router] Headers already sent to client; stream aborted.');
          return;
        }
      }
    }

    // All accounts & providers failed
    const totalLatency = Date.now() - startTime;
    const finalErrMsg = `All ${candidates.length} routing candidate(s) failed for '${requestedModel}': ${errors.join('; ')}`;

    await logCall({
      requestedModel,
      status: 'error',
      statusCode: 502,
      latencyMs: totalLatency,
      error: finalErrMsg,
      stream: isStream,
      clientRequest: requestPayload,
      upstreamRequest: {
        attemptedCandidates: candidates.map((c) => ({
          provider: c.provider.id,
          targetModel: c.targetModel,
          account: c.account?.name || c.account?.id || 'default',
        })),
      },
      upstreamResponse: { error: finalErrMsg, details: errors },
    });

    if (!res.headersSent) {
      return res.status(502).json({
        error: {
          message: finalErrMsg,
          type: 'kasrai_all_candidates_failed',
          code: 502,
          details: errors,
        },
      });
    }
  }
}

export const routerEngine = new RouterEngine();
