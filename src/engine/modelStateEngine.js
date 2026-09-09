import { configDB } from '../db/index.js';

const DB_KEY = 'model_states';

/**
 * Model State & Priority Optimizer
 * Manages model health status ('active', 'broken_404', 'degraded'),
 * priority weighting, and sorting criteria.
 */
export class ModelStateEngine {
  constructor() {
    this._cache = null;
  }

  async _load() {
    if (!this._cache) {
      const data = await configDB.get(DB_KEY);
      this._cache = data && typeof data === 'object' ? data : {};
    }
    return this._cache;
  }

  async _save() {
    if (this._cache) {
      await configDB.set(DB_KEY, this._cache);
    }
  }

  _getKey(providerId, modelId) {
    return `${providerId.toLowerCase()}::${modelId.trim()}`;
  }

  async getModelState(providerId, modelId) {
    const all = await this._load();
    const key = this._getKey(providerId, modelId);
    return all[key] || {
      status: 'active', // active | broken_404 | degraded
      basePriority: 50,
      effectivePriority: 50,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      lastLatencyMs: null,
      avgLatencyMs: null,
      lastError: null,
      lastTestedAt: null,
    };
  }

  async getProviderModelStates(providerId) {
    const all = await this._load();
    const prefix = `${providerId.toLowerCase()}::`;
    const result = {};
    for (const [key, state] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        const modelId = key.slice(prefix.length);
        result[modelId] = state;
      }
    }
    return result;
  }

  async recordModelTestResult(providerId, modelId, result) {
    const all = await this._load();
    const key = this._getKey(providerId, modelId);
    const existing = all[key] || {
      status: 'active',
      basePriority: 50,
      effectivePriority: 50,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      lastLatencyMs: null,
      avgLatencyMs: null,
      lastError: null,
      lastTestedAt: null,
    };

    existing.lastTestedAt = new Date().toISOString();
    existing.totalCalls++;

    const is404 = result.status === 404 || (result.error && (
      result.error.includes('404') ||
      result.error.toLowerCase().includes('not found') ||
      result.error.toLowerCase().includes('does not exist')
    ));

    if (result.ok || result.status === 200) {
      // If it was broken_404, automatically remove broken flag!
      existing.status = 'active';
      existing.lastError = null;
      existing.successCalls++;
      existing.lastLatencyMs = result.latency || null;
      if (result.latency) {
        existing.avgLatencyMs = existing.avgLatencyMs
          ? Math.round((existing.avgLatencyMs * 0.7) + (result.latency * 0.3))
          : result.latency;
      }
    } else if (is404) {
      // Mark as broken 404 and set priority to 0
      existing.status = 'broken_404';
      existing.lastError = result.error || 'Model returned 404 (Not Found / Does not exist)';
      existing.failedCalls++;
    } else {
      existing.failedCalls++;
      existing.lastError = result.error || `Failed with status ${result.status}`;
      if (existing.status !== 'broken_404') {
        existing.status = 'degraded';
      }
    }

    // Recompute effective priority
    existing.effectivePriority = this._computeEffectivePriority(providerId, modelId, existing);
    all[key] = existing;
    await this._save();
    return existing;
  }

  async clearBrokenFlags(providerId) {
    const all = await this._load();
    const prefix = `${providerId.toLowerCase()}::`;
    let count = 0;
    for (const [key, state] of Object.entries(all)) {
      if (key.startsWith(prefix) && state.status === 'broken_404') {
        state.status = 'active';
        state.lastError = null;
        state.effectivePriority = state.basePriority || 50;
        count++;
      }
    }
    if (count > 0) {
      await this._save();
    }
    return count;
  }

  async setProviderPriorityStrategy(providerId, strategy) {
    // Strategy: 'balanced' | 'deep_reasoning' | 'lowest_latency' | 'highest_throughput'
    const settingsKey = `priority_strategy_${providerId.toLowerCase()}`;
    await configDB.set(settingsKey, strategy);
    await this.recalculateProviderPriorities(providerId);
    return strategy;
  }

  async getProviderPriorityStrategy(providerId) {
    const settingsKey = `priority_strategy_${providerId.toLowerCase()}`;
    return (await configDB.get(settingsKey)) || 'balanced';
  }

  async recalculateProviderPriorities(providerId) {
    const all = await this._load();
    const strategy = await this.getProviderPriorityStrategy(providerId);
    const prefix = `${providerId.toLowerCase()}::`;

    for (const [key, state] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        const modelId = key.slice(prefix.length);
        state.effectivePriority = this._computeEffectivePriority(providerId, modelId, state, strategy);
      }
    }
    await this._save();
  }

  _computeEffectivePriority(providerId, modelId, state, forcedStrategy = null) {
    // 1. Broken 404 models strictly receive 0 priority
    if (state.status === 'broken_404') {
      return 0;
    }

    const base = state.basePriority || 50;
    let bonus = 0;
    const mLower = modelId.toLowerCase();

    const isReasoning = mLower.includes('thinking') ||
      mLower.includes('pro') ||
      mLower.includes('r1') ||
      mLower.includes('opus') ||
      mLower.includes('sol') ||
      mLower.includes('high');

    const isFast = mLower.includes('flash') ||
      mLower.includes('mini') ||
      mLower.includes('instant') ||
      mLower.includes('haiku') ||
      mLower.includes('lite') ||
      mLower.includes('low');

    const strategy = forcedStrategy || 'balanced';

    switch (strategy) {
      case 'deep_reasoning':
        if (isReasoning) bonus += 40;
        if (isFast) bonus -= 10;
        break;
      case 'lowest_latency':
        if (isFast) bonus += 35;
        if (state.avgLatencyMs && state.avgLatencyMs < 400) bonus += 20;
        else if (state.avgLatencyMs && state.avgLatencyMs > 2000) bonus -= 25;
        break;
      case 'highest_throughput':
        if (mLower.includes('flash') || mLower.includes('mini')) bonus += 30;
        break;
      case 'balanced':
      default:
        if (isReasoning) bonus += 15;
        if (state.avgLatencyMs && state.avgLatencyMs < 600) bonus += 10;
        break;
    }

    // High success rate bonus
    if (state.totalCalls >= 3) {
      const successRate = state.successCalls / state.totalCalls;
      if (successRate >= 0.9) bonus += 15;
      else if (successRate < 0.5) bonus -= 20;
    }

    return Math.max(1, Math.min(100, base + bonus));
  }
}

export const modelStateEngine = new ModelStateEngine();
