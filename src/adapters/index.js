import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';
import { AntigravityAdapter } from './antigravity.js';
import { NotionAdapter } from './notion.js';

export function createAdapter(providerConfig, activeAccount = null) {
  if (!providerConfig) {
    throw new Error('Provider config is required');
  }

  const type = (providerConfig.type || providerConfig.preset || 'openai').toLowerCase();

  switch (type) {
    case 'notion':
      return new NotionAdapter(providerConfig, activeAccount);
    case 'antigravity':
      return new AntigravityAdapter(providerConfig, activeAccount);
    case 'anthropic':
    case 'claude':
      return new AnthropicAdapter(providerConfig, activeAccount);
    case 'gemini':
    case 'google':
      return new GeminiAdapter(providerConfig, activeAccount);
    case 'openai':
    default:
      return new OpenAIAdapter(providerConfig, activeAccount);
  }
}
