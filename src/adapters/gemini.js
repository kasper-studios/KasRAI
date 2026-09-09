import crypto from 'node:crypto';
import { BaseAdapter } from './base.js';
import { getValidAuthToken } from '../utils/oauth.js';

export class GeminiAdapter extends BaseAdapter {
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

  _convertOpenAIToGemini(requestPayload) {
    const rawMessages = requestPayload.messages || [];
    let systemInstruction = null;
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
        if (!systemInstruction) {
          systemInstruction = { parts: [{ text }] };
        } else {
          systemInstruction.parts[0].text += `\n\n${text}`;
        }
      } else if (msg.role === 'tool' || msg.role === 'function') {
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

    const payload = {
      contents,
      generationConfig: {},
    };

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }

    if (typeof requestPayload.temperature === 'number') {
      payload.generationConfig.temperature = requestPayload.temperature;
    }
    if (typeof requestPayload.max_tokens === 'number') {
      payload.generationConfig.maxOutputTokens = requestPayload.max_tokens;
    } else if (typeof requestPayload.max_completion_tokens === 'number') {
      payload.generationConfig.maxOutputTokens = requestPayload.max_completion_tokens;
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
        payload.tools = [{ functionDeclarations }];
      }
    }

    // Convert tool_choice if provided
    if (requestPayload.tool_choice) {
      const tc = requestPayload.tool_choice;
      if (tc === 'none') {
        payload.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      } else if (tc === 'auto') {
        payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      } else if (tc === 'required' || tc === 'any') {
        payload.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      } else if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
        payload.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [tc.function.name],
          },
        };
      }
    }

    return payload;
  }

  async complete(requestPayload, targetModel) {
    const token = await this._getAuthToken();
    const isOAuth = token.startsWith('ya29.');
    const url = isOAuth
      ? `${this.baseURL}/models/${targetModel}:generateContent`
      : `${this.baseURL}/models/${targetModel}:generateContent?key=${token}`;

    const headers = { 'Content-Type': 'application/json' };
    if (isOAuth) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = this._convertOpenAIToGemini(requestPayload);

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
      const err = new Error(errorData.error?.message || `Gemini error: ${response.status}`);
      err.status = response.status;
      err.data = errorData;
      err.headers = response.headers;
      throw err;
    }

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

  async stream(requestPayload, targetModel, res) {
    const token = await this._getAuthToken();
    const isOAuth = token.startsWith('ya29.');
    const url = isOAuth
      ? `${this.baseURL}/models/${targetModel}:streamGenerateContent?alt=sse`
      : `${this.baseURL}/models/${targetModel}:streamGenerateContent?alt=sse&key=${token}`;

    const headers = { 'Content-Type': 'application/json' };
    if (isOAuth) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const payload = this._convertOpenAIToGemini(requestPayload);

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
      const err = new Error(errorData.error?.message || `Gemini stream error: ${response.status}`);
      err.status = response.status;
      err.data = errorData;
      err.headers = response.headers;
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
            const candidate = eventData.candidates?.[0];
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
          } catch {}
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
