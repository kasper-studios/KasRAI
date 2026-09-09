# KasRAI DevNotes

> IMPORTANT: This file contains critical project rules, implementation context, and constraints for the author and AI assistants.
> Treat this file as the operational contract of the project.
> If something is unclear, prefer existing code/project patterns over invention.

---

## 0. DevNotes Writing Rules

**DevNotes is an internal operational document, not a marketing page.
Do not add hype, “wow-effect”, promotional language, or exaggerated claims.
Write only what is useful for implementation, review, maintenance, and AI execution.**

This file is operational, not promotional.
No marketing language, hype, or “wow-effect” wording.
Do not beautify the project or exaggerate maturity/stability.
Prefer precise facts over impressive wording.
If something is unknown, mark it as unknown/TODO instead of inventing.
Keep sections short, structured, and directly useful for implementation.
Do not add filler sections just to make the file look complete.
Do not rewrite simple facts into grandiose descriptions.
If a sentence does not change how the project is implemented, reviewed, or maintained — it does not belong in this file.

---

## 1. Project Overview

### What this project is
KasRAI (Kasper Route AI) is a local, lightweight unified AI Gateway and routing proxy with an integrated micro-dashboard for LLM providers management. It serves as a local alternative to OmniRoute / LiteLLM.

### Core goal
Provide a centralized, resilient OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`) for local agents (Hermes, Dirom, OpenCode), bots, and scripts, featuring automatic provider failover, request retry, model aliasing, and persistent usage logging.

### Success criteria
- 100% OpenAI API compatible for `/v1/chat/completions` (standard JSON and SSE streaming).
- Built-in provider is exclusively Antigravity (Google Code Assist / Cloud Code).
- API adapter types for custom providers: OpenAI format, Anthropic format, Gemini format.
- Multi-auth support: API Key and OAuth (access token, refresh token, expiry).
- Multi-account rotation pool per provider: accounts rotate with quota monitoring and automatic cooldown on 429/quota exhaustion.
- Virtual model aliases with configurable rotation strategies (`priority`, `round-robin`, `least-used`, `random`).
- Transparent failover pipeline across accounts and fallback providers.
- Strict token output guard: if final completion returns 0 tokens / empty response, fail with error `APKAKALSA PEDIK` (code 999).
- Persistent state management exclusively using `@kasperenok/kasdb`.
- Integrated fast micro-dashboard (HTML/JS/CSS) served directly by Express.
- Absolute paths used in all system configurations.

### Project type
- [x] API / backend
- [x] Web app (micro-panel)

---

## 2. Current Status

### Status summary
Stable core prototype implemented and active. Gateway server runs on port 20250 with full OpenAI compatibility, multi-account rotation, OAuth support, Discord bot integrations, and kasdb storage.

### Implemented
- [x] Project workspace initialized at `/home/kasperenok/Desktop/projects/KasRAI`
- [x] Registered as Hermes Desktop project `KasRAI`
- [x] Operational contract defined (`DevNotes.md`)
- [x] Storage engine implemented via `@kasperenok/kasdb` (providers, routes, config, logs)
- [x] Built-in Antigravity provider with strict real model lineup:
  - Flash tiers (high / medium / low): `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`, `gemini-3.6-flash-{high,medium,low}`, `gemini-3.5-flash-{high,medium,low}`
  - Pro tiers (high / low only, no medium): `gemini-3.1-pro-high`, `gemini-3.1-pro-low`
  - Claude in Antigravity (no sonnet 5): `claude-sonnet-4-6`, `claude-opus-4-6-thinking`
- [x] Perfect Termux compatibility: pure JS runtime (no node-gyp), dynamic `os.homedir()` paths, `termux.sh` launcher with `termux-wake-lock`
- [x] Antigravity DeepMind agent `systemInstruction` protocol (Part 1: Google Deepmind Antigravity identity; Part 2: user instruction)
- [x] Antigravity request envelope: automatic `antigravity/` prefix stripping, mapping to `gemini-3-flash-agent`, and `enabledCreditTypes: ["GOOGLE_ONE_AI"]`
- [x] Full import from `~/.omniroute/storage.sqlite` + `.env` (AES-256-GCM decrypt, parsing base URLs, hosts, and account tokens)
- [x] Multimodal & image link parsing in chat messages (`inlineData` & image URLs)
- [x] Account management & prioritization:
  - Account priority queue order (`priority: number`, higher calls first) in router engine
  - Live modal for changing account API keys, display names, and priorities (`PATCH /api/providers/:id/accounts/:accId`)
  - Subscription tier detection via `loadCodeAssist` (`Google AI Pro`, `Antigravity Free`, etc.) with badges in UI
- [x] Quota & tier checker for Antigravity, OpenRouter, and Gemini (`GET /api/quota`, `GET /api/bot/quota`, per-account quota)
- [x] Live health validator & OAuth refresh token lifecycle (`src/utils/accountValidator.js`, `POST /api/health-check`, `POST /api/bot/health-check`)
- [x] Native OAuth direct login & token paste (`POST /api/oauth/paste`, `GET /api/oauth/login/:id`)
- [x] Multi-account rotation pool per provider (API Key and OAuth tokens)
- [x] Automatic quota & 429 rate limit cooldown tracking with auto-recovery
- [x] Configurable provider rate limit cooldown (`rateLimitCooldownSec`) when delay cannot be parsed from upstream headers
- [x] Google / Antigravity OAuth flow: `/api/bot/oauth`, `/oauth/callback` with token exchange, profile discovery, and auto-refresh
- [x] Virtual model routing engine with rotation modes (`priority`, `round-robin`, `least-used`, `random`)
- [x] Zero-token output guard: throws `APKAKALSA PEDIK` with HTTP 999 if upstream produces 0 tokens
- [x] Discord / Bot integration API (`/api/bot/status`, `/api/bot/key`, `/api/bot/oauth`, `/api/bot/cooldowns/reset`, `/api/bot/logs`)
- [x] Modern micro-dashboard web UI (HTML5, Tailwind, Vanilla JS) mounted at `/`

### In progress
- [x] Antigravity Google Cloud Code live upstream integration: moved from legacy `cloudcode-pa.googleapis.com` (which permanently returns 429 quota exhausted) to `https://daily-cloudcode-pa.googleapis.com` with multi-base fallback array
- [x] Gemini 3.1 Pro upstream ID mapping: `gemini-3.1-pro-high` maps to Google Cloud Code internal `gemini-pro-agent`
- [x] Tested & verified live endpoints: streaming + non-streaming for `gemini-3.8-flash-high`, `gemini-3.7-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `kasrai/smart`, `kasrai/fast`
- [x] Full Tool Calling (Function Calling) support: OpenAI format (`tools`, `tool_choice`, `tool_calls`, `role: tool`) seamlessly converted to Google Cloud Code format with `skip_thought_signature_validator` injection and streaming tool_calls
- [x] Dashboard UX 2.0: Toast notifications system (no more blocking browser alerts), instant search & filter chips for providers (All, Pro, Antigravity, Cooldown, Errors), live real-time countdown ticker on cooldown badges, 1-click global & per-account cooldown reset, quick-copy buttons, and interactive playground with mock tool calling & streaming latency stats
- [x] Dynamic Model Checker & Discovery (`src/utils/modelChecker.js`): live polling of `/models` endpoints per provider with automatic fallback to built-in models if endpoint fails/empty; `🟢 Live` / `🟠 Fallback` badges, individual & global refresh buttons
- [x] Full Request / Response Inspector in Logs: every call records client request payload, upstream target & credentials used, and raw upstream response/error; clicking any log opens a 3-tab inspector modal with JSON copy
- [x] Batch Auto-Tester in Tester tab: provider-scoped model testing with progress bar, funny logic riddle generator (`🎲 Случайный поносик`), per-model test buttons, and expandable response previews
- [x] Groq model catalog verified live: updated with working `qwen/qwen3.8-27b`, `openai/gpt-oss-120b`, `groq/compound`
- [x] Notion AI Provider Adapter (`src/adapters/notion.js`): reverse-engineered official Notion AI API (`app.notion.com/api/v3/runInferenceTranscript`, `getAvailableModels`) with full "Desserts" model aliases (`orange-mousse`, `angel-cake-high`, `agave-flan`), ndjson streaming, and 1-click Cookie file upload/parsing
- [x] Dedicated Quota Inspector Modal: rich visualization of account subscription tier (Google AI Pro golden badges), color-coded progress bars for model quotas/buckets, next reset timestamps, and expandable raw JSON inspector
- [x] Automatic 404 Model Demotion & Optimizer (`src/engine/modelStateEngine.js`): 404 models are marked `broken_404`, skipped during mass runs, demoted to `P:0` in router; successful manual tests automatically unmark; priority optimization filters (`deep_reasoning`, `lowest_latency`, `balanced`)
- [x] Full Multimodal Input Support (Images, Audio, Video): OpenAI schema (`image_url`, `input_audio`, `video_url`, `audio_url`, `inline_data`), plus `response_format` (JSON object/schema), `stop`, `top_p`, `top_k`
- [x] Optional Gateway API Key Protection (`src/engine/gatewayAuth.js`): run fully open for local LAN or lock down `/v1/*` behind cryptographically generated bearer tokens with live UI toggle & status badge
- [x] Bilingual Documentation: English `README.md` as primary and `README.ru.md` as Russian edition with mutual cross-references
- [x] Inter-Agent Communication Bus (`/api/agent/hermes/task`, `/api/agent/dirom/emit`): two-way bridge between Dirom (Termux Android Node) and Hermes (Desktop Assistant) with persistent Task Inbox in `config.db`
- [x] Git Auto-Updater Engine (`src/utils/gitUpdater.js`): git repo initialized with strict `.gitignore` (protecting `data/*.db` and credentials); auto-pulls new commits every 60s; performs safe in-place hot module reload when commit lacks "REQUIRED FULL RESTART" tag, or graceful process restart when tag is present; UI badge `git:commit` with manual check button
- [ ] Connect live accounts (Antigravity OAuth / OpenAI / Gemini keys)
- [ ] Wire Discord bot command handlers to `/api/bot/*` endpoints

### Planned / TODO
- [ ] Optional Telegram Bot interactive commands
- [ ] Enhanced token cost calculator per provider model

### Not in scope right now
- Multi-tenant enterprise billing
- Vector database / RAG inside gateway

---

## 3. Tech Stack

### Core stack
- Runtime: Node.js (v22+)
- Language: JavaScript (Modern ESM, `"type": "module"`)
- Framework: Express 5 / 4.x
- Database: `@kasperenok/kasdb` (binary msgpack database by kasperenok)
- Networking: native Node.js `fetch` with streaming support
- Frontend: Vanilla JS SPA + modern dark CSS (Tailwind CDN / custom utility classes)

### Versions
- Node.js: 22.x
- @kasperenok/kasdb: ^1.0.2
- express: ^5.0.0 or ^4.21.0

### Environment notes
- OS: Linux (Arch Linux x86_64) & Android Termux (aarch64 / armv7)
- Default Port: `20250` (configurable via `PORT` env var)
- Zero native binaries requirement: Pure JavaScript runtime with `@kasperenok/kasdb` and `msgpack-lite` (zero node-gyp / C++ build steps, instant `npm install` on Termux)
- Termux launcher: `termux.sh` with automatic `termux-wake-lock` acquisition to prevent Android deep sleep
- Dynamic directory resolution via `import.meta.url` and `os.homedir()`

---

## 4. Architecture Notes

### High-level architecture
Clients (agents, bots, scripts) send requests to `http://localhost:20250/v1/chat/completions`.
The KasRAI router resolves the model ID (or alias), selects the primary target provider, converts the payload into the provider's native format, and executes the request.
If the provider fails with a retryable error (rate limit, server error, timeout), the router switches to the next fallback provider.
Streamed responses are normalized on the fly into OpenAI SSE chunks (`data: {...}\n\n`).
All requests and metrics are recorded into `@kasperenok/kasdb`.

### Main modules / layers
1. **Server & Middleware** (`server.js`): Express app, CORS, error handling, static UI serving.
2. **Database Layer** (`src/db/`): Wrapper around `@kasperenok/kasdb` instances for `config.db`, `providers.db`, `aliases.db`, `logs.db`.
3. **Routing & Failover Engine** (`src/engine/`): Resolves aliases, manages provider priority lists, implements retry/fallback loop.
4. **Provider Adapters** (`src/adapters/`):
   - `openai.js`: Handles OpenAI, Groq, OpenRouter, DeepSeek, Ollama.
   - `anthropic.js`: Handles Claude Messages API (converts to/from Anthropic JSON and SSE).
   - `gemini.js`: Handles Gemini `generateContent` and `streamGenerateContent`.
5. **API Endpoints**:
   - `/v1/*`: Public OpenAI-compatible API.
   - `/api/*`: Internal management API for the micro-dashboard.
6. **Micro-Dashboard** (`public/`): SPA for monitoring status, configuring providers, editing routes, testing prompts.

### Dependency direction
```txt
[Client / Agent] -> [/v1 Router] -> [Failover Engine] -> [Adapters] -> [Upstream LLM APIs]
                                            │
                                            ▼
                                   [kasdb (Storage)]
                                            ▲
[Micro Dashboard] -> [/api Management] ────┘
```

### Important boundaries
- Database operations must exclusively use `@kasperenok/kasdb`.
- Adapters must encapsulate upstream quirks; the `/v1` consumer must only see standard OpenAI responses.
- API keys and upstream tokens stored in `providers.db` must never be leaked to client responses.

---

## 5. Project Structure

```txt
/home/kasperenok/Desktop/projects/KasRAI/
├── DevNotes.md          # Operational contract
├── package.json         # Node.js dependencies and scripts
├── server.js            # Main Express entrypoint
├── data/                # Binary databases (.db via kasdb)
│   ├── config.db
│   ├── providers.db
│   ├── aliases.db
│   └── logs.db
├── src/
│   ├── config.js        # Global settings & paths
│   ├── db/
│   │   └── index.js     # kasdb instance handlers
│   ├── engine/
│   │   ├── router.js    # Routing & failover loop
│   │   └── aliases.js   # Model alias resolution
│   ├── adapters/
│   │   ├── base.js      # Base adapter class
│   │   ├── openai.js    # OpenAI format adapter
│   │   ├── anthropic.js # Anthropic Messages adapter
│   │   └── gemini.js    # Google Gemini adapter
│   ├── routes/
│   │   ├── v1.js        # OpenAI compatible endpoints (/v1/chat/completions, /v1/models)
│   │   └── api.js       # Admin panel endpoints (/api/providers, /api/logs, etc.)
│   └── utils/
│       ├── sse.js       # SSE stream transformations
│       └── logger.js    # Call metrics logger
└── public/              # Micro-dashboard SPA
    ├── index.html       # Single page interface
    ├── app.js           # Frontend logic
    └── style.css        # Theme styles
```

### Structure rules
- All server-side business logic goes into `src/`.
- All database files must reside in `data/` and end with `.db`.
- Dashboard UI assets stay in `public/`.

---

## 6. Language & Text Rules

### User-facing language
- Public API errors: English (OpenAI standard format: `{"error": {"message": "...", "type": "...", "code": ...}}`).
- Dashboard UI: Russian / English bilingual or clean Russian (per user preference).
- Code comments and DevNotes: Russian / English technical.

---

## 7. Code Rules

### General style
- Clean modern ECMAScript (ESM `import`/`export`).
- Avoid bloated dependencies; prefer Node.js 22 built-ins (`fetch`, `crypto`, `stream`).
- No unnecessary abstractions; keep adapter interfaces simple.

### Storage rules
- Always use `AsyncDB` from `@kasperenok/kasdb`.
- Avoid direct filesystem writes bypassing `kasdb` for application data.

### Logging
- Requests logged to `logs.db` via `kasdb` with timestamp, model, provider, tokens, latency, status code.
- Console logs: concise colored stdout.

---

## 8. Critical Rules

1. **Database engine is strictly `@kasperenok/kasdb`**. No SQLite, no raw JSON re-implementations.
2. **Absolute paths only** for system files and configs.
3. **OpenAI compatibility is inviolable**: `/v1/chat/completions` must accurately parse tools, stream chunks, and return standard format.
4. **Zero-Token Guard**: If upstream completion outputs 0 tokens / empty text, gateway aborts with `APKAKALSA PEDIK` and status code 999.
5. **Quota Protection**: Exhausted / 429 accounts must be put on cooldown immediately; no requests sent to them until cooldown expires.
6. **No silent failures**: If all fallback providers/accounts fail, return a structured 502/504 error detailing why each candidate failed.
7. **No breaking changes to DevNotes**: update status when milestones are achieved.

---

## 9. AI Assistant Rules

1. Always inspect existing files before creating or modifying code.
2. Maintain `DevNotes.md` up-to-date with actual progress.
3. Test every endpoint with actual requests (e.g. `curl`) before marking tasks complete.
4. Do not delete or overwrite user configurations.

---

## 10. API / Integration Notes

### Public interfaces
- `POST /v1/chat/completions`: Main inference endpoint. Supports `stream: true` and `stream: false`.
- `GET /v1/models`: Returns list of available models and aliases.
- `GET /v1/health`: Gateway status probe.

### Management interfaces
- `GET /api/status`: System stats, active providers, recent latency.
- `GET/POST /api/providers`: Configure upstream providers, presets, and API keys.
- `POST /api/providers/:id/oauth/start`: Returns `{ authUrl, state }` for Google/Antigravity OAuth login.
- `GET/POST /api/routes`: Configure model routing, rotation modes (`priority`, `round-robin`, `least-used`, `random`), and fallback chains.
- `GET /api/logs`: View recent request logs.

### Discord & Bot Integration API (`/api/bot/*`)
- `GET /api/bot/status`: Returns preformatted `discordEmbed` with online status, active providers, accounts breakdown by provider, remaining cooldown time on 429, total requests and latency.
- `POST /api/bot/key`: Body `{ provider, apiKey, name }`. Directly injects key into `providers.db` without complex UI nesting.
- `POST /api/bot/oauth`: Body `{ provider }`. Returns instant OAuth link button payload `{ authUrl, discordButton }`.
- `POST /api/bot/cooldowns/reset`: Force unfreezes all frozen/429 accounts across all providers.
- `GET /api/bot/logs?limit=5`: Returns formatted Discord code block (`prolog`) of recent calls with status, latency, and tokens.

---

## 11. Testing & Validation

1. Server startup test: verifies Express binds to port and `kasdb` files initialize.
2. Model listing test: `curl http://localhost:20250/v1/models`.
3. Non-streaming completion test: verified via local adapter or upstream mock.
4. Streaming completion test: verified via `curl -N`.
5. Dashboard validation: verify UI loads and communicates with `/api/*`.

---

**Last Updated:** 2026-09-08  
**Project Status:** bootstrap / active development  
**DevNotes Version:** v0.1
