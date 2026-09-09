import { BaseAdapter } from './base.js';
import { getValidAuthToken } from '../utils/oauth.js';

export class OpenAIAdapter extends BaseAdapter {
  constructor(providerConfig, activeAccount = null) {
    super(providerConfig);
    this.account = activeAccount;
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

  async complete(requestPayload, targetModel) {
    const url = `${this.baseURL}/chat/completions`;
    const body = {
      ...requestPayload,
      model: targetModel,
      stream: false,
    };

    const headers = await this._getHeaders();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

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

  async stream(requestPayload, targetModel, res) {
    const url = `${this.baseURL}/chat/completions`;
    const body = {
      ...requestPayload,
      model: targetModel,
      stream: true,
    };

    const headers = await this._getHeaders();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

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
    let totalGeneratedLength = 0;
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
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) totalGeneratedLength += delta.length;
            } catch {}
          }
        }
      }

      if (totalGeneratedLength === 0) {
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
