import { BaseAdapter } from './base.js';
import { getValidAuthToken } from '../utils/oauth.js';
import { hasGeneratedStreamOutput } from './streamOutput.js';

// OpenAI-compatible providers disagree on parameter surfaces (e.g. NVIDIA NIM rejects the
// `reasoning` object while accepting `reasoning_effort`). When upstream replies 400 with
// "Unsupported parameter(s): `x`", strip the named parameters and retry.
const UNSUPPORTED_PARAM_RE = /Unsupported parameter\(s\):\s*((?:`[^`]+`[,\s]*)+)/gi;

function extractUnsupportedParams(text) {
  const params = new Set();
  let match;
  while ((match = UNSUPPORTED_PARAM_RE.exec(text)) !== null) {
    for (const p of match[1].matchAll(/`([^`]+)`/g)) params.add(p[1]);
  }
  return [...params];
}

async function fetchCompletionsSanitized(url, headers, body, signal) {
  let currentBody = { ...body };
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(currentBody),
      signal,
    });
    if (response.ok || response.status !== 400) return { response, body: currentBody };

    const errorText = await response.text();
    const badParams = extractUnsupportedParams(errorText);
    if (badParams.length === 0) {
      // Not a param-surface problem — rebuild an error response for the caller
      return {
        response: new Response(errorText, { status: 400, headers: { 'Content-Type': 'application/json' } }),
        body: currentBody,
      };
    }
    console.warn(`[OpenAIAdapter] Upstream rejected parameter(s) ${badParams.join(', ')} — stripping and retrying (attempt ${attempt + 1})`);
    currentBody = { ...currentBody };
    for (const p of badParams) delete currentBody[p];
  }
  // Final try with the sanitized body
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(currentBody),
    signal,
  });
  return { response, body: currentBody };
}

export class OpenAIAdapter extends BaseAdapter {
  constructor(providerConfig, activeAccount = null) {
    super(providerConfig);
    this.account = activeAccount;
  }

  get baseURL() {
    if (this.account?.oauth?.provider === 'nous') {
      return this.account.oauth.inferenceBaseURL || this.config.baseURL || '';
    }
    return super.baseURL;
  }

  async _getAuthToken() {
    if (this.account) {
      return await getValidAuthToken(this.id, this.account);
    }
    return this.apiKey || '';
  }

  async _getHeaders() {
    const token = await this._getAuthToken();
    const headers = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (this.id === 'openrouter') {
      headers['HTTP-Referer'] = 'https://kasperstudios.xyz';
      headers['X-Title'] = 'KasRAI Gateway';
    }
    return headers;
  }

  async complete(requestPayload, targetModel, options = {}) {
    const url = `${this.baseURL}/chat/completions`;
    const body = {
      ...requestPayload,
      model: targetModel,
      stream: false,
    };

    const headers = await this._getHeaders();
    const { response } = await fetchCompletionsSanitized(url, headers, body, options.signal);

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: { message: errorText } };
      }
      const err = new Error(errorData.error?.message || `Upstream error: ${response.status}`);
      err.status = response.status;
      err.data = errorData;
      throw err;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const tokens = (data.usage?.completion_tokens || 0) + (data.usage?.prompt_tokens || 0);

    // ZERO-TOKEN GUARD
    if (tokens === 0 || (!content && !data.choices?.[0]?.message?.tool_calls?.length)) {
      const err = new Error('APKAKALSA PEDIK');
      err.status = 999;
      err.data = {
        error: {
          message: 'APKAKALSA PEDIK',
          type: 'apkakalsa_pedik',
          code: 999,
        },
      };
      throw err;
    }

    return data;
  }

  async stream(requestPayload, targetModel, res, options = {}) {
    const url = `${this.baseURL}/chat/completions`;
    const body = {
      ...requestPayload,
      model: targetModel,
      stream: true,
    };

    const headers = await this._getHeaders();
    const { response } = await fetchCompletionsSanitized(url, headers, body, options.signal);

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: { message: errorText } };
      }
      const err = new Error(errorData.error?.message || `Upstream stream error: ${response.status}`);
      err.status = response.status;
      err.data = errorData;
      throw err;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let hasGeneratedOutput = false;
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        res.write(chunk);

        // Approximate token/content count check
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (hasGeneratedStreamOutput(parsed)) hasGeneratedOutput = true;
            } catch {}
          }
        }
      }

      if (!hasGeneratedOutput) {
        const apkakal = {
          error: {
            message: 'APKAKALSA PEDIK',
            type: 'apkakalsa_pedik',
            code: 999,
          },
        };
        res.write(`event: error\ndata: ${JSON.stringify(apkakal)}\n\n`);
        throw new Error('APKAKALSA PEDIK (0 tokens streamed)');
      }
    } finally {
      res.end();
    }
  }
}
