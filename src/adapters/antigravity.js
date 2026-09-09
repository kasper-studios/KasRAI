import crypto from 'node:crypto';
import { BaseAdapter } from './base.js';
import { getValidAuthToken } from '../utils/oauth.js';

const ANTIGRAVITY_UPSTREAM_ALIASES = {
  // Flash 3.8 (high, medium, low)
  'gemini-3.8-flash': 'gemini-3.8-flash-high',
  'gemini-3.8-flash-high': 'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low': 'gemini-3.8-flash-low',

  // Flash 3.7 (high, medium, low)
  'gemini-3.7-flash': 'gemini-3.7-flash-high',
  'gemini-3.7-flash-high': 'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium': 'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low': 'gemini-3.7-flash-low',

  // Flash 3.6 (high, medium, low)
  'gemini-3.6-flash': 'gemini-3.6-flash-high',
  'gemini-3.6-flash-high': 'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium': 'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low': 'gemini-3.6-flash-low',

  // Flash 3.5 (high, medium, low)
  'gemini-3.5-flash': 'gemini-3-flash-agent',
  'gemini-3.5-flash-high': 'gemini-3-flash-agent',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-extra-low',

  // Pro 3.1 (NO medium — only high and low; upstream high is gemini-pro-agent)
  'gemini-3.1-pro': 'gemini-pro-agent',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
  'gemini-3.1-pro-low': 'gemini-3.1-pro-low',
  'gemini-3-pro-preview': 'gemini-pro-agent',
  'gemini-3-pro-high': 'gemini-pro-agent',

  // Claude in Antigravity (NO sonnet-5)
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-3-7-sonnet': 'claude-sonnet-4-6',
};

export const ANTIGRAVITY_BASE_URLS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
];

export class AntigravityAdapter extends BaseAdapter {
  constructor(providerConfig, activeAccount = null) {
    super(providerConfig);
    this.account = activeAccount;
    if (!this.baseURL || this.baseURL === 'https://cloudcode-pa.googleapis.com') {
      this.baseURL = ANTIGRAVITY_BASE_URLS[0];
    }
  }

  _resolveUpstreamModel(model) {
    if (!model) return 'gemini-3.8-flash-high';
    // Strip antigravity/ prefix
    const clean = model.replace(/^antigravity\//i, '').trim();
    return ANTIGRAVITY_UPSTREAM_ALIASES[clean] || clean;
  }

  async _getAuthToken() {
    if (this.account) {
      return await getValidAuthToken(this.id, this.account);
    }
    return this.apiKey || '';
  }

  _convertOpenAIToAntigravity(requestPayload, targetModel) {
    const rawMessages = requestPayload.messages || [];
    let userSystemText = '';
    const rawContents = [];

    // Map tool_call_id -> function name
    const tcIdToNameMap = {};
    for (const msg of rawMessages) {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id && tc.function?.name) {
            tcIdToNameMap[tc.id] = tc.function.name;
          }
        }
      }
    }

    for (const msg of rawMessages) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (!userSystemText) {
          userSystemText = text;
        } else {
          userSystemText += `\n\n${text}`;
        }
      } else if (msg.role === 'tool' || msg.role === 'function') {
        // Tool execution response from client
        const fnName = msg.name || tcIdToNameMap[msg.tool_call_id] || 'function';
        let respObj = null;
        if (typeof msg.content === 'object' && msg.content !== null) {
          respObj = msg.content;
        } else if (typeof msg.content === 'string') {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              respObj = parsed;
            } else {
              respObj = { content: msg.content };
            }
          } catch {
            respObj = { content: msg.content };
          }
        } else {
          respObj = { content: String(msg.content ?? '') };
        }

        rawContents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: fnName,
                response: respObj,
              },
            },
          ],
        });
      } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // Assistant message with tool calls
        const parts = [];
        if (msg.content) {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          if (text) parts.push({ text });
        }
        for (const tc of msg.tool_calls) {
          let argsObj = {};
          if (typeof tc.function?.arguments === 'string') {
            try {
              argsObj = JSON.parse(tc.function.arguments);
            } catch {
              argsObj = {};
            }
          } else if (typeof tc.function?.arguments === 'object' && tc.function.arguments !== null) {
            argsObj = tc.function.arguments;
          }
          parts.push({
            thoughtSignature: tc.thought_signature || tc.thoughtSignature || 'skip_thought_signature_validator',
            functionCall: {
              name: tc.function?.name || 'function',
              args: argsObj,
              id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
            },
          });
        }
        rawContents.push({
          role: 'model',
          parts,
        });
      } else {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const parts = [];

        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'text' && item.text) {
              parts.push({ text: item.text });
            } else if (item.type === 'image_url' && item.image_url?.url) {
              const url = item.image_url.url;
              if (url.startsWith('data:')) {
                const match = url.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  parts.push({
                    inlineData: {
                      mimeType: match[1],
                      data: match[2],
                    },
                  });
                } else {
                  parts.push({ text: `[Image: ${url}]` });
                }
              } else {
                parts.push({ text: `[Image URL: ${url}]` });
              }
            } else if (item.type === 'input_audio' && item.input_audio?.data) {
              // OpenAI standard input_audio support (wav/mp3)
              const format = item.input_audio.format || 'wav';
              const mimeType = format === 'mp3' ? 'audio/mp3' : 'audio/wav';
              parts.push({
                inlineData: {
                  mimeType,
                  data: item.input_audio.data,
                },
              });
            } else if (item.type === 'video' || item.type === 'video_url') {
              // Video inline / URL support
              const vUrl = item.video_url?.url || item.url || '';
              if (vUrl.startsWith('data:')) {
                const match = vUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  parts.push({
                    inlineData: {
                      mimeType: match[1],
                      data: match[2],
                    },
                  });
                } else {
                  parts.push({ text: `[Video: ${vUrl}]` });
                }
              } else {
                parts.push({ text: `[Video URL: ${vUrl}]` });
              }
            } else if (item.type === 'audio' || item.type === 'audio_url') {
              // Audio inline / URL support
              const aUrl = item.audio_url?.url || item.url || '';
              if (aUrl.startsWith('data:')) {
                const match = aUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  parts.push({
                    inlineData: {
                      mimeType: match[1],
                      data: match[2],
                    },
                  });
                } else {
                  parts.push({ text: `[Audio: ${aUrl}]` });
                }
              } else {
                parts.push({ text: `[Audio URL: ${aUrl}]` });
              }
            } else if (item.inline_data || item.inlineData) {
              const idata = item.inline_data || item.inlineData;
              parts.push({
                inlineData: {
                  mimeType: idata.mime_type || idata.mimeType || 'application/octet-stream',
                  data: idata.data,
                },
              });
            } else if (item.text) {
              parts.push({ text: item.text });
            }
          }
        } else {
          parts.push({ text: JSON.stringify(msg.content) });
        }

        rawContents.push({
          role,
          parts: parts.length > 0 ? parts : [{ text: ' ' }],
        });
      }
    }

    // Merge adjacent contents with same role
    const contents = [];
    for (const c of rawContents) {
      if (!Array.isArray(c.parts) || c.parts.length === 0) continue;
      if (contents.length > 0 && contents[contents.length - 1].role === c.role) {
        contents[contents.length - 1].parts.push(...c.parts);
      } else {
        contents.push(c);
      }
    }

    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    // Two-part systemInstruction:
    // 1st part: Antigravity Deepmind coding agent prompt
    // 2nd part: User's incoming system instruction (or default)
    const antigravityIdentity =
      'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\n' +
      'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.\n' +
      '**Absolute paths only**\n' +
      '**Proactiveness**';

    const systemInstruction = {
      role: 'system',
      parts: [
        { text: antigravityIdentity },
        { text: userSystemText || 'You are a helpful and proactive AI coding assistant.' },
      ],
    };

    const innerRequest = {
      contents,
      systemInstruction,
      generationConfig: {},
    };

    if (typeof requestPayload.temperature === 'number') {
      innerRequest.generationConfig.temperature = requestPayload.temperature;
    }
    if (typeof requestPayload.top_p === 'number') {
      innerRequest.generationConfig.topP = requestPayload.top_p;
    }
    if (typeof requestPayload.top_k === 'number') {
      innerRequest.generationConfig.topK = requestPayload.top_k;
    }
    if (typeof requestPayload.max_tokens === 'number') {
      innerRequest.generationConfig.maxOutputTokens = requestPayload.max_tokens;
    } else if (typeof requestPayload.max_completion_tokens === 'number') {
      innerRequest.generationConfig.maxOutputTokens = requestPayload.max_completion_tokens;
    }
    if (Array.isArray(requestPayload.stop)) {
      innerRequest.generationConfig.stopSequences = requestPayload.stop;
    } else if (typeof requestPayload.stop === 'string') {
      innerRequest.generationConfig.stopSequences = [requestPayload.stop];
    }

    // OpenAI response_format: { type: "json_object" | "json_schema" }
    if (requestPayload.response_format) {
      const rf = requestPayload.response_format;
      if (rf.type === 'json_object') {
        innerRequest.generationConfig.responseMimeType = 'application/json';
      } else if (rf.type === 'json_schema' && rf.json_schema) {
        innerRequest.generationConfig.responseMimeType = 'application/json';
        if (rf.json_schema.schema) {
          innerRequest.generationConfig.responseSchema = rf.json_schema.schema;
        }
      }
    }

    // Convert tools if provided
    if (Array.isArray(requestPayload.tools) && requestPayload.tools.length > 0) {
      const functionDeclarations = [];
      for (const tool of requestPayload.tools) {
        if (tool.type === 'function' && tool.function) {
          const fn = tool.function;
          functionDeclarations.push({
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} },
          });
        } else if (tool.name) {
          functionDeclarations.push({
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
          });
        }
      }
      if (functionDeclarations.length > 0) {
        innerRequest.tools = [{ functionDeclarations }];
      }
    }

    // Convert tool_choice if provided
    if (requestPayload.tool_choice) {
      const tc = requestPayload.tool_choice;
      if (tc === 'none') {
        innerRequest.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (tc === 'auto') {
        innerRequest.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      } else if (tc === 'required' || tc === 'any') {
        innerRequest.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
        innerRequest.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [tc.function.name],
          },
        };
      }
    }

    return innerRequest;
  }

  _buildEnvelope(requestPayload, targetModel) {
    const upstreamModel = this._resolveUpstreamModel(targetModel);
    const inner = this._convertOpenAIToAntigravity(requestPayload, upstreamModel);
    const isGoogleCloudCode = this.baseURL.includes('cloudcode-pa.googleapis.com');

    if (isGoogleCloudCode) {
      const projectId = this.account?.projectId || this.account?.oauth?.projectId || 'aicode-consumers';
      return {
        project: projectId,
        model: upstreamModel,
        request: inner,
        userAgent: 'antigravity',
        requestType: 'agent',
        enabledCreditTypes: ['GOOGLE_ONE_AI'],
      };
    }

    return {
      model: upstreamModel,
      ...inner,
    };
  }

  async complete(requestPayload, targetModel) {
    const token = await this._getAuthToken();
    const isGoogleCloudCode = this.baseURL.includes('cloudcode-pa.googleapis.com');
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
      'x-client-name': 'antigravity',
      'x-client-version': '4.2.0',
      'Accept': 'text/event-stream',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = this._buildEnvelope(requestPayload, targetModel);

    const baseCandidates = isGoogleCloudCode
      ? [this.baseURL, ...ANTIGRAVITY_BASE_URLS.filter((u) => u !== this.baseURL)]
      : [this.baseURL];

    let response = null;
    let lastError = null;

    for (const base of baseCandidates) {
      const url = isGoogleCloudCode
        ? `${base}/v1internal:streamGenerateContent?alt=sse`
        : `${base}/models/${targetModel}:generateContent?key=${token}`;

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          response = res;
          break;
        }

        const errText = await res.text();
        let errorData;
        try {
          errorData = JSON.parse(errText);
        } catch {
          errorData = { error: { message: errText } };
        }
        lastError = new Error(errorData.error?.message || `Antigravity error: ${res.status}`);
        lastError.status = res.status;
        lastError.data = errorData;
        lastError.headers = res.headers;

        // If it was 429 quota exhausted or 5xx, continue to next fallback URL
        if (res.status !== 429 && res.status < 500) {
          throw lastError;
        }
      } catch (err) {
        lastError = err;
        if (err.status && err.status !== 429 && err.status < 500) {
          throw err;
        }
      }
    }

    if (!response) {
      throw lastError || new Error('All Antigravity base URLs failed');
    }

    if (isGoogleCloudCode) {
      // Consume SSE stream and collect chunks into single response
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let textContent = '';
      let finishReason = 'stop';
      let promptTokens = 0;
      let completionTokens = 0;
      const toolCalls = [];

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
          try {
            const eventData = JSON.parse(dataStr);
            const candidate = eventData.response?.candidates?.[0] || eventData.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              for (const p of parts) {
                if (p.text) textContent += p.text;
                if (p.functionCall) {
                  toolCalls.push({
                    id: p.functionCall.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                    type: 'function',
                    function: {
                      name: p.functionCall.name,
                      arguments: JSON.stringify(p.functionCall.args || {}),
                    },
                  });
                }
              }
            }
            if (candidate?.finishReason) {
              finishReason = candidate.finishReason.toLowerCase() === 'stop' ? 'stop' : candidate.finishReason;
            }
            const usage = eventData.response?.usageMetadata || eventData.usageMetadata;
            if (usage) {
              if (usage.promptTokenCount) promptTokens = usage.promptTokenCount;
              if (usage.candidatesTokenCount) completionTokens = usage.candidatesTokenCount;
            }
          } catch {}
        }
      }

      const hasToolCalls = toolCalls.length > 0;
      completionTokens = completionTokens || (textContent ? Math.ceil(textContent.length / 4) : 0);
      const totalTokens = promptTokens + completionTokens;

      // ZERO-TOKEN GUARD: Do not trigger if tool calls were made
      if (!hasToolCalls && (totalTokens === 0 || textContent.trim().length === 0)) {
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

      const messageObj = {
        role: 'assistant',
        content: textContent || (hasToolCalls ? null : ''),
      };
      if (hasToolCalls) {
        messageObj.tool_calls = toolCalls;
      }

      return {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [
          {
            index: 0,
            message: messageObj,
            finish_reason: hasToolCalls ? 'tool_calls' : finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };
    } else {
      const data = await response.json();
      const candidate = data.candidates?.[0];
      let textContent = '';
      const toolCalls = [];

      const parts = candidate?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p.text) textContent += p.text;
          if (p.functionCall) {
            toolCalls.push({
              id: p.functionCall.id || `call_${crypto.randomBytes(8).toString('hex')}`,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {}),
              },
            });
          }
        }
      }

      const hasToolCalls = toolCalls.length > 0;
      const promptTokens = data.usageMetadata?.promptTokenCount || 0;
      const completionTokens = data.usageMetadata?.candidatesTokenCount || (textContent ? Math.ceil(textContent.length / 4) : 0);
      const totalTokens = (data.usageMetadata?.totalTokenCount || 0) || (promptTokens + completionTokens);

      // ZERO-TOKEN GUARD: Do not trigger if tool calls were made
      if (!hasToolCalls && (totalTokens === 0 || textContent.trim().length === 0)) {
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

      const messageObj = {
        role: 'assistant',
        content: textContent || (hasToolCalls ? null : ''),
      };
      if (hasToolCalls) {
        messageObj.tool_calls = toolCalls;
      }

      return {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [
          {
            index: 0,
            message: messageObj,
            finish_reason: hasToolCalls ? 'tool_calls' : (candidate?.finishReason?.toLowerCase() === 'stop' ? 'stop' : (candidate?.finishReason || 'stop')),
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };
    }
  }

  async stream(requestPayload, targetModel, res) {
    const token = await this._getAuthToken();
    const isGoogleCloudCode = this.baseURL.includes('cloudcode-pa.googleapis.com');
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Antigravity/4.2.0 (X11; Linux x86_64) Chrome/142.0.7444.175 Electron/39.2.3',
      'x-client-name': 'antigravity',
      'x-client-version': '4.2.0',
      'Accept': 'text/event-stream',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = this._buildEnvelope(requestPayload, targetModel);

    const baseCandidates = isGoogleCloudCode
      ? [this.baseURL, ...ANTIGRAVITY_BASE_URLS.filter((u) => u !== this.baseURL)]
      : [this.baseURL];

    let response = null;
    let lastError = null;

    for (const base of baseCandidates) {
      const url = isGoogleCloudCode
        ? `${base}/v1internal:streamGenerateContent?alt=sse`
        : `${base}/models/${targetModel}:streamGenerateContent?alt=sse&key=${token}`;

      try {
        const upstreamRes = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        if (upstreamRes.ok) {
          response = upstreamRes;
          break;
        }

        const errorText = await upstreamRes.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: { message: errorText } };
        }
        lastError = new Error(errorData.error?.message || `Antigravity stream error: ${upstreamRes.status}`);
        lastError.status = upstreamRes.status;
        lastError.data = errorData;
        lastError.headers = upstreamRes.headers;

        if (upstreamRes.status !== 429 && upstreamRes.status < 500) {
          throw lastError;
        }
      } catch (err) {
        lastError = err;
        if (err.status && err.status !== 429 && err.status < 500) {
          throw err;
        }
      }
    }

    if (!response) {
      throw lastError || new Error('All Antigravity streaming endpoints failed');
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
    let hasStreamedToolCalls = false;
    let toolCallCounter = 0;

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

          try {
            const eventData = JSON.parse(dataStr);
            const candidate = eventData.response?.candidates?.[0] || eventData.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              for (const p of parts) {
                if (p.text) sendChunk(p.text, null);
                if (p.functionCall) {
                  hasStreamedToolCalls = true;
                  const tcChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: createdTime,
                    model: targetModel,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: toolCallCounter++,
                              id: p.functionCall.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                              type: 'function',
                              function: {
                                name: p.functionCall.name,
                                arguments: JSON.stringify(p.functionCall.args || {}),
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
                }
              }
            }
            if (candidate?.finishReason) {
              if (hasStreamedToolCalls) {
                sendChunk(null, 'tool_calls');
              } else {
                sendChunk('', candidate.finishReason.toLowerCase() === 'stop' ? 'stop' : candidate.finishReason);
              }
            }
          } catch {
            // Ignore partial SSE parsing
          }
        }
      }

      if (!hasStreamedToolCalls && totalGeneratedLength === 0) {
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
