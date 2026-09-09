import crypto from 'node:crypto';
import { BaseAdapter } from './base.js';
import { getValidAuthToken } from '../utils/oauth.js';

export class AnthropicAdapter extends BaseAdapter {
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
    return {
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    };
  }

  _convertOpenAIToAnthropic(requestPayload, targetModel) {
    const rawMessages = requestPayload.messages || [];
    let systemPrompt = '';
    const anthropicMessages = [];

    for (const msg of rawMessages) {
      if (msg.role === 'system') {
        if (systemPrompt) systemPrompt += '\n\n';
        systemPrompt += typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      } else {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        let content = msg.content;
        if (typeof content !== 'string' && !Array.isArray(content)) {
          content = JSON.stringify(content);
        }

        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === role) {
          if (typeof lastMsg.content === 'string' && typeof content === 'string') {
            lastMsg.content += `\n\n${content}`;
          } else {
            lastMsg.content = `${JSON.stringify(lastMsg.content)}\n\n${JSON.stringify(content)}`;
          }
        } else {
          anthropicMessages.push({ role, content });
        }
      }
    }

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: 'Hello' });
    }

    const payload = {
      model: targetModel,
      messages: anthropicMessages,
      max_tokens: requestPayload.max_tokens || requestPayload.max_completion_tokens || 4096,
    };

    if (systemPrompt) payload.system = systemPrompt;
    if (typeof requestPayload.temperature === 'number') payload.temperature = requestPayload.temperature;
    if (typeof requestPayload.top_p === 'number') payload.top_p = requestPayload.top_p;

    return payload;
  }

  async complete(requestPayload, targetModel) {
    const url = `${this.baseURL}/messages`;
    const payload = this._convertOpenAIToAnthropic(requestPayload, targetModel);
    const headers = await this._getHeaders();

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: { message: errorText } };
      }
      const err = new Error(errorData.error?.message || `Anthropic error: ${response.status}`);
      err.status = response.status;
      err.data = errorData;
      throw err;
    }

    const data = await response.json();
    let textContent = '';
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          textContent += block.text;
        }
      }
    }

    const promptTokens = data.usage?.input_tokens || 0;
    const completionTokens = data.usage?.output_tokens || 0;
    const totalTokens = promptTokens + completionTokens;

    // ZERO-TOKEN GUARD
    if (totalTokens === 0 || textContent.trim().length === 0) {
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

    return {
      id: `chatcmpl-${data.id || crypto.randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: targetModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent,
          },
          finish_reason: data.stop_reason === 'end_turn' ? 'stop' : (data.stop_reason || 'stop'),
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  }

  async stream(requestPayload, targetModel, res) {
    const url = `${this.baseURL}/messages`;
    const payload = {
      ...this._convertOpenAIToAnthropic(requestPayload, targetModel),
      stream: true,
    };
    const headers = await this._getHeaders();

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: { message: errorText } };
      }
      const err = new Error(errorData.error?.message || `Anthropic stream error: ${response.status}`);
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
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const createdTime = Math.floor(Date.now() / 1000);
    let buffer = '';
    let totalGeneratedLength = 0;

    const sendChunk = (deltaContent, finishReason = null) => {
      if (deltaContent) totalGeneratedLength += deltaContent.length;
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: targetModel,
        choices: [
          {
            index: 0,
            delta: deltaContent ? { content: deltaContent } : {},
            finish_reason: finishReason,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const eventData = JSON.parse(dataStr);
            if (eventData.type === 'content_block_delta' && eventData.delta?.type === 'text_delta') {
              sendChunk(eventData.delta.text, null);
            } else if (eventData.type === 'message_stop') {
              sendChunk('', 'stop');
            }
          } catch {}
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

      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
  }
}
