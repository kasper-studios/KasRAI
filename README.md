# ⚡ KasRAI (Kasper Route AI)

<p align="center">
  <a href="./README.md"><b>English</b></a> •
  <a href="./README.ru.md"><b>Русский</b></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-Active%20Gateway-emerald?style=for-the-badge&logo=fastapi&logoColor=white" alt="Status" />
  <img src="https://img.shields.io/badge/Port-20250-indigo?style=for-the-badge&logo=express&logoColor=white" alt="Port" />
  <img src="https://img.shields.io/badge/Database-%40kasperenok%2Fkasdb-purple?style=for-the-badge" alt="KasDB" />
  <img src="https://img.shields.io/badge/Architecture-Zero--Native%20Pure%20JS-blue?style=for-the-badge&logo=javascript" alt="Pure JS" />
  <img src="https://img.shields.io/badge/Platform-Termux%20%7C%20Linux%20%7C%20Windows-amber?style=for-the-badge" alt="Platforms" />
</p>

<p align="center">
  <b>High-performance, lightweight local AI gateway & neural router conforming to OpenAI API standards.</b><br>
  Engineered for pair programming, autonomous multi-agent swarms (Discord, Telegram), and instant zero-dependency deployment across any machine — from multi-core Linux workstations to Android Termux environments.
</p>

---

## ✨ Core Features

* 🔄 **100% OpenAI API Compatible (`/v1/chat/completions`, `/v1/models`)**: Drop-in replacement for OpenAI endpoints in any tool, IDE, or agent (OpenAI SDK, Claude Code, Cline, OpenCode, Hermes, Python, cURL).
* ⚡ **Built-in Antigravity Adapter (Google Cloud Code)**:
  * Native execution for Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.5 Flash, 3.1 Pro, and Claude Sonnet/Opus in Cloud Code.
  * Account rotation pool with automated background OAuth token refreshes.
  * Real-time subscription tier detection (**Google AI Pro** golden badges vs Starter Quotas).
  * Thought signature bypass sentinel (`thoughtSignature: skip_thought_signature_validator`) preventing upstream 400 errors.
* 🎂 **Notion AI Reverse-Engineered Provider («Notion Desserts»)**:
  * Native access to internal Notion AI models: `orange-mousse` (GPT-5.6 Sol), `olive-jellyroll` (Luna), `angel-cake-high` (Claude Sonnet 5), `agave-flan` (Claude Opus 5), `fireworks-kimi-k3`, etc.
  * 1-Click Cookie file upload and parser (`cookies.txt` / Netscape / JSON / `token_v2`).
* 🛡️ **Zero-Token Guard (HTTP 999: `APKAKALSA PEDIK`)**:
  * If an upstream model generates 0 tokens of content, the gateway immediately halts and returns an explicit `999` error code.
  * Smart detection exempts Tool Calling turns where content is naturally null.
* 🔒 **Configurable API Key Access Protection**:
  * Run open (zero-auth for local subnet) or lock down `/v1/*` behind cryptographically secure bearer keys with one-click key rotation.
* 🔀 **Intelligent Priority Queue & Automatic 404 Model Marking**:
  * Real-time model health optimizer: if a model returns 404, it is marked as `broken_404`, excluded from mass runs, and demoted to `P:0` in routing.
  * Successful manual calls automatically unmark models and restore priorities.
  * Configurable priority strategies per provider: `Deep Reasoning`, `Lowest Latency`, or `Balanced`.
* 🛠️ **Full Tool Calling & Function Calling Support**:
  * OpenAI format (`tools`, `tool_choice`, `role: tool`, `tool_calls`) seamlessly translated to Google Gemini/Claude schemas with streamed tool delta chunks.
* 📦 **Zero-Native Pure JavaScript Runtime**:
  * Powered by `@kasperenok/kasdb` (`msgpack-lite`).
  * Zero C++ native builds (`node-gyp`), pure JS — installs in 9 seconds inside Android Termux!
* 🚀 **Built-in Git Auto-Updater**:
  * Automatic remote repository polling every 60 seconds.
  * Safe in-place hot module reload when commits lack restart tags; automated graceful restarts when `"REQUIRED FULL RESTART"` tag is present.
* 📊 **Dashboard UX 2.0 & Inspectors**:
  * Rich modal quota inspector with visual progress bars and reset countdowns.
  * Full Request/Response Inspector in Call Logs with JSON copying.
  * Batch model auto-tester with logic riddle presets (🎲 *«Random Ponosik»*).
* 🏰 **Hermes ⟷ Dirom Inter-Agent Bus**:
  * Bidirectional communication bridge connecting desktop AI agents with mobile Termux daemons.

---

## 🚀 Quick Start (1-Line Installers)

### 📱 Linux / macOS / Android Termux:
```bash
curl -fsSL https://github.com/kasper-studios/KasRAI/raw/refs/heads/main/install.sh | bash
```

### 🪟 Windows (CMD / PowerShell):
```cmd
curl -fsSL https://github.com/kasper-studios/KasRAI/raw/refs/heads/main/install.bat -o install.bat && install.bat
```

Once started, open the web dashboard:
👉 **`http://localhost:20250/`**

---

## 🛠️ Manual Installation & Launch

### 1. Clone and Install:
```bash
git clone https://github.com/kasper-studios/KasRAI.git
cd KasRAI
npm install --omit=dev
```

### 2. Launch:
* **Desktop (Linux/macOS):**
  ```bash
  bash start.sh
  # or:
  node server.js
  ```
* **Android (Termux):**
  ```bash
  bash termux.sh
  ```
  *(The `termux.sh` script automatically acquires `termux-wake-lock` to keep the gateway running while the screen is off).*

---

## 💡 Usage Examples

### Python (Official `openai` SDK):
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:20250/v1",
    api_key="kasrai"  # or your generated gateway key if auth is enabled
)

response = client.chat.completions.create(
    model="antigravity/gemini-3.8-flash-high",
    messages=[
        {"role": "system", "content": "You are a concise expert engineer."},
        {"role": "user", "content": "Explain asynchronous event loops in 2 sentences."}
    ],
    temperature=0.7
)

print(response.choices[0].message.content)
```

### cURL (Streaming SSE):
```bash
curl -N http://localhost:20250/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kasrai/smart",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello KasRAI!"}
    ]
  }'
```

---

## 🗺️ Virtual Routes & Model Mapping

| Route / Model | Provider | Description |
| :--- | :--- | :--- |
| **`kasrai/smart`** | Virtual Route | Top-tier reasoning chain (Gemini 3.1 Pro, 3.8 Flash, Claude 4.6) |
| **`kasrai/fast`** | Virtual Route | Low-latency response pool (Gemini 3.7 Flash, 3.6 Flash, 3.5 Flash) |
| **`antigravity/gemini-3.8-flash-high`** | Antigravity | Flagship high-speed reasoning model |
| **`antigravity/gemini-3.1-pro-high`** | Antigravity | Heavyweight reasoning model (mapped to Cloud Code agent) |
| **`antigravity/claude-sonnet-4-6`** | Antigravity | Claude Sonnet 4.6 via Google Cloud Code |
| **`antigravity/claude-opus-4-6-thinking`** | Antigravity | Claude Opus with deep reasoning |
| **`notion/gpt-5.6-sol`** | Notion AI | Notion's `orange-mousse` model |
| **`notion/claude-sonnet-5`** | Notion AI | Notion's `angel-cake-high` model |

---

## 📡 API Endpoints Summary

* `GET /v1/models` — List all active models, aliases, and virtual routes.
* `POST /v1/chat/completions` — Standard OpenAI Chat Completions endpoint.
* `GET /v1/health` — Instant health probe.
* `GET /api/status` — Operational metrics, latencies, and account pool state.
* `GET /api/auth/config` & `POST /api/auth/toggle` — Gateway security & API key management.
* `POST /api/models/test-record` — Model test recorder and 404 auto-demoter.
* `POST /api/models/clear-broken/:providerId` — Unmark 404 models for a provider.
* `POST /api/cooldowns/reset` — Global unfreeze of rate-limited accounts.
* `POST /api/agent/hermes/task` — Task ingestion endpoint for Hermes Desktop.
* `POST /api/agent/dirom/emit` — Event dispatcher to Dirom's mobile perception bus (`:8767`).

---

## 🔒 Data Persistence & Security

All configuration and account stores (`providers.db`, `routes.db`, `logs.db`, `config.db`) reside in `data/` using `@kasperenok/kasdb` binary msgpack storage. The `data/` directory is strictly ignored by Git and will never be overwritten by updates.

---

<p align="center">
  Crafted with ❤️ by <b>Kasper Studios</b> (Hermes & Dirom).<br>
  <i>«Those who know will understand, those who don't will be surprised.»</i>
</p>
