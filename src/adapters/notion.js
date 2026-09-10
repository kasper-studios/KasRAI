import crypto from 'node:crypto';
import { BaseAdapter } from './base.js';
import { extractNotionCookies } from '../utils/quotaChecker.js';

export const NOTION_MODEL_ALIASES = {
  // OpenAI Sol & Luna & Terra (GPT-5.6 family)
  'gpt-5.6-sol': 'orange-mousse',
  'sol': 'orange-mousse',
  'orange-mousse': 'orange-mousse',

  'gpt-5.6-luna': 'olive-jellyroll',
  'luna': 'olive-jellyroll',
  'olive-jellyroll': 'olive-jellyroll',

  'gpt-5.6-terra': 'orchid-muffin',
  'terra': 'orchid-muffin',
  'orchid-muffin': 'orchid-muffin',

  // Anthropic Claude in Notion
  'claude-sonnet-5': 'angel-cake-high',
  'angel-cake-high': 'angel-cake-high',

  'claude-sonnet-4-6': 'almond-croissant-low',
  'almond-croissant-low': 'almond-croissant-low',

  'claude-opus-5': 'agave-flan',
  'agave-flan': 'agave-flan',

  'claude-opus-4-8': 'ambrosia-tart-high',
  'ambrosia-tart-high': 'ambrosia-tart-high',

  // Others
  'kimi-k3': 'fireworks-kimi-k3',
  'fireworks-kimi-k3': 'fireworks-kimi-k3',

  'deepseek-v4-pro': 'baseten-deepseek-v4-pro',
  'baseten-deepseek-v4-pro': 'baseten-deepseek-v4-pro',

  'grok-4.6': 'soursop-shortcake',
  'soursop-shortcake': 'soursop-shortcake',
};

export class NotionAdapter extends BaseAdapter {
  constructor(providerConfig, activeAccount = null) {
    super(providerConfig);
    this.account = activeAccount;
  }

  _resolveUpstreamModel(model) {
    if (!model) return 'orange-mousse';
    const clean = model.replace(/^notion\//i, '').trim().toLowerCase();
    return NOTION_MODEL_ALIASES[clean] || clean;
  }

  _buildHeaders() {
    const acc = this.account || {};
    const { tokenV2, userId, spaceId, cookieHeader } = extractNotionCookies(acc);

    // Prefer the full raw cookie header exported from the browser (includes
    // notion_browser_id, device_id, __cf_bm etc. required to pass Cloudflare).
    // Fall back to minimal token_v2+user_id pair.
    let cookie = cookieHeader;
    if (!cookie) {
      cookie = `token_v2=${tokenV2}; notion_user_id=${userId};`;
    }

    return {
      'Host': 'app.notion.com',
      'Origin': 'https://app.notion.com',
      'Referer': 'https://app.notion.com/ai',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0',
      'Content-Type': 'application/json',
      'x-notion-active-user-header': userId,
      'x-notion-space-id': spaceId,
      'notion-client-version': '23.13.20260909.0411',
      'notion-audit-log-platform': 'web',
      'Cookie': cookie,
      'Accept': 'application/x-ndjson',
    };
  }

  _convertOpenAIToNotionPayload(requestPayload, upstreamModel) {
    const rawMessages = requestPayload.messages || [];
    const acc = this.account || {};
    const { spaceId, userId } = extractNotionCookies(acc);

    const traceId    = crypto.randomUUID();
    const threadId   = crypto.randomUUID();
    const now        = new Date().toISOString();

    // Transcript always starts with a config block (workflow settings + model)
    const transcript = [
      {
        id: crypto.randomUUID(),
        type: 'config',
        value: {
          type: 'workflow',
          model: upstreamModel,
          reasoningEffort: requestPayload.reasoning_effort || 'medium',
          modelFromUser: true,
          enableAgentAutomations: false,
          enableAgentIntegrations: false,
          enableCustomAgents: false,
          enableExperimentalIntegrations: false,
          enableScriptAgent: false,
          enableScriptAgentAdvanced: false,
          enableScriptAgentMcpServers: false,
          enableAgentDiffs: false,
          enableCsvAttachmentSupport: false,
          showDatabaseAgentsDiscoverability: false,
          enableAgentThreadTools: false,
          enableCrdtOperations: false,
          enableAgentCardCustomization: false,
          enableSystemPromptAsPage: false,
          enableUserSessionContext: false,
          enableAgentGenerateImage: false,
          enableMarkdownVNext: true,
          enableSuggestedEditsTools: false,
          enableAgentSkillsV2: false,
          useWebSearch: false,
          internetAccess: false,
          isHipaa: false,
          manageWorkers: false,
          useReadOnlyMode: false,
          writerMode: false,
          isCustomAgent: false,
          isCustomAgentBuilder: false,
          isCustomAgentCreate: false,
          isAgentResearchRequest: false,
          useCustomAgentDraft: false,
          isOnboardingAgent: false,
          isMobile: false,
          availableConnectors: [],
          searchScopes: [{ type: 'everything' }],
          agentMemorySettings: { useMemories: false, excludeChatFromMemories: true },
        },
      },
      // Context block: user identity & surface
      {
        id: crypto.randomUUID(),
        type: 'context',
        value: {
          timezone: 'UTC',
          userId: userId || '',
          spaceId,
          surface: 'ai_module',
          currentDatetime: now,
        },
      },
    ];

    // Convert OpenAI messages — system goes as extra context, user/assistant as user/agent
    for (const msg of rawMessages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
          : JSON.stringify(msg.content);

      if (msg.role === 'system') {
        // Inject system prompt as an extra context value
        transcript[1].value.systemPrompt = text;
        continue;
      }

      const type = msg.role === 'assistant' ? 'agent' : 'user';
      transcript.push({
        id: crypto.randomUUID(),
        type,
        userId: userId || undefined,
        // Notion expects value as array-of-rich-text: [["text"]]
        value: [[text]],
        createdAt: now,
      });
    }

    return {
      traceId,
      spaceId,
      transcript,
      threadId,
      threadParentPointer: {
        table: 'space',
        id: spaceId,
        spaceId,
      },
      createThread: true,
      generateTitle: false,
      saveAllThreadOperations: true,
      setUnreadState: false,
      createdSource: 'ai_module',
      threadType: 'workflow',
      isPartialTranscript: false,
      asPatchResponse: true,
      patchResponseVersion: 2,
      isUserInAnySalesAssistedSpace: false,
      isSpaceSalesAssisted: false,
      supportsCustomAgentNudgeTranscriptStep: false,
      debugOverrides: { emitInferences: false, cachedInferences: {}, annotationInferences: {} },
    };
  }

  async complete(requestPayload, targetModel) {
    const upstreamModel = this._resolveUpstreamModel(targetModel);
    const url = `${this.baseURL || 'https://app.notion.com'}/api/v3/runInferenceTranscript`;
    const headers = this._buildHeaders();
    const payload = this._convertOpenAIToNotionPayload(requestPayload, upstreamModel);

    console.log(`[NotionAdapter] complete → model=${upstreamModel} spaceId=${payload.spaceId?.slice(0,8)} transcript=${payload.transcript?.length} msgs`);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[NotionAdapter] HTTP ${response.status}:`, errText.slice(0, 800));
      console.error(`[NotionAdapter] Payload:`, JSON.stringify(payload).slice(0, 600));
      let errorData;
      try {
        errorData = JSON.parse(errText);
      } catch {
        errorData = { error: { message: errText } };
      }
      const err = new Error(errorData.error?.message || errorData.message || `Notion AI HTTP ${response.status}`);
      err.status = response.status;
      err.data = errorData;
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let textContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          if (chunk.type === 'text' && chunk.text) {
            textContent += chunk.text;
          } else if (chunk.text) {
            textContent += chunk.text;
          } else if (chunk.delta) {
            textContent += chunk.delta;
          }
        } catch {
          // Ignore partial non-json lines
        }
      }
    }

    const promptTokens = Math.ceil(JSON.stringify(requestPayload.messages).length / 4);
    const completionTokens = Math.ceil(textContent.length / 4);
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
      id: `chatcmpl-${crypto.randomUUID()}`,
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
          finish_reason: 'stop',
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
    const upstreamModel = this._resolveUpstreamModel(targetModel);
    const url = `${this.baseURL || 'https://app.notion.com'}/api/v3/runInferenceTranscript`;
    const headers = this._buildHeaders();
    const payload = this._convertOpenAIToNotionPayload(requestPayload, upstreamModel);

    console.log(`[NotionAdapter] stream → model=${upstreamModel} spaceId=${payload.spaceId?.slice(0,8)} transcript=${payload.transcript?.length} msgs`);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[NotionAdapter] stream HTTP ${response.status}:`, errText.slice(0, 800));
      console.error(`[NotionAdapter] Payload:`, JSON.stringify(payload).slice(0, 600));
      let errorData;
      try {
        errorData = JSON.parse(errText);
      } catch {
        errorData = { error: { message: errText } };
      }
      const err = new Error(errorData.error?.message || errorData.message || `Notion AI HTTP ${response.status}`);
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

    const sendChunk = (deltaText, finishReason = null) => {
      if (deltaText) totalGeneratedLength += deltaText.length;
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: createdTime,
        model: targetModel,
        choices: [
          {
            index: 0,
            delta: deltaText ? { content: deltaText } : {},
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
          if (!trimmed) continue;
          try {
            const chunk = JSON.parse(trimmed);
            const delta = chunk.type === 'text' ? chunk.text : (chunk.text || chunk.delta || '');
            if (delta) {
              sendChunk(delta, null);
            }
          } catch {}
        }
      }

      // ZERO-TOKEN GUARD
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

      sendChunk('', 'stop');
      res.write('data: [DONE]\n\n');
    } finally {
      res.end();
    }
  }
}
