# ⚡ KasRAI (Kasper Route AI)

<p align="center">
  <img src="https://img.shields.io/badge/Status-Active%20Gateway-emerald?style=for-the-badge&logo=fastapi&logoColor=white" alt="Status" />
  <img src="https://img.shields.io/badge/Port-20250-indigo?style=for-the-badge&logo=express&logoColor=white" alt="Port" />
  <img src="https://img.shields.io/badge/Database-%40kasperenok%2Fkasdb-purple?style=for-the-badge" alt="KasDB" />
  <img src="https://img.shields.io/badge/Architecture-Zero--Native%20Pure%20JS-blue?style=for-the-badge&logo=javascript" alt="Pure JS" />
  <img src="https://img.shields.io/badge/Platform-Termux%20%7C%20Linux%20%7C%20Windows-amber?style=for-the-badge" alt="Platforms" />
</p>

<p align="center">
  <b>Высокопроизводительный, легковесный локальный AI-шлюз и роутер нейросетей стандарта OpenAI API.</b><br>
  Создан для парного программирования, автономных ботов (Discord, Telegram) и мгновенного развёртывания на любых устройствах — от мощных рабочих станций до Android-планшетов в Termux.
</p>

---

## ✨ Ключевые возможности

* 🔄 **100% совместимость с OpenAI API (`/v1/chat/completions`, `/v1/models`)**: подключайте любые сторонние клиенты, IDE, расширения и библиотеки (OpenAI SDK, Claude Code, Cline, OpenCode, Hermes, Python, cURL).
* ⚡ **Встроенный адаптер Antigravity (Google Cloud Code)**:
  * Нативная поддержка Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.5 Flash, 3.1 Pro и Claude Sonnet/Opus в Cloud Code.
  * Пул мульти-аккаунтов с автоматическим обновлением токенов через Google OAuth.
  * Распознавание подписок **Google AI Pro** (`⭐ Google AI Pro`) и Starter Quota.
  * Обход ошибок 400 (`thoughtSignature: skip_thought_signature_validator`).
* 🎂 **Notion AI реверс-адаптер («Десерты Notion»)**:
  * Полная поддержка моделей Notion AI: `orange-mousse` (GPT-5.6 Sol), `olive-jellyroll` (Luna), `angel-cake-high` (Claude Sonnet 5), `agave-flan` (Claude Opus 5), `fireworks-kimi-k3` и др.
  * Удобная загрузка и авто-парсинг файлов куков (`cookies.txt` / JSON / `token_v2`) в 1 клик.
* 🛡️ **Zero-Token Guard (HTTP 999: `APKAKALSA PEDIK`)**:
  * Если upstream-провайдер вернул пустой ответ (0 токенов контента), шлюз моментально пресекает молчаливые падения и возвращает строгий код ошибки `999`.
  * Умное исключение для Tool Calling (когда модель вызывает функцию, пустой контент валиден).
* 🔀 **Умная ротация и очереди приоритетов**:
  * Приоритизация пула аккаунтов (`P:100` -> `P:50` -> `P:10`). Жирные Pro-аккаунты вызываются первыми.
  * Умный кулдаун при 429 (`RESOURCE_EXHAUSTED` / `rate_limit_exceeded`) с авто-восстановлением.
* 🛠️ **Полная поддержка Function Calling (Tools)**:
  * OpenAI Tools (`tools`, `tool_choice`, `role: tool`, `tool_calls`) ➔ авто-конвертация в схемы Gemini/Claude и потоковый стриминг дельт тулов по SSE.
* 📦 **Zero-Native Pure JS рантайм**:
  * База данных на собственном бинарном движке `@kasperenok/kasdb` (`msgpack-lite`).
  * Ноль компиляций C++ (`node-gyp`), чистый JavaScript — устанавливается за 9 секунд на Android Termux!
* 🚀 **Встроенный Git Auto-Updater**:
  * Фоновый опрос репозитория каждые 60 секунд.
  * Бесшовный горячий рефреш на лету (если нет флага перезапуска).
  * Автоматический изящный рестарт при наличии тега `"REQUIRED FULL RESTART"` в коммите.
* 📊 **Интерактивный дашборд UX 2.0**:
  * Toast-уведомления без блокирующих `alert()`.
  * Инспектор квот с цветными прогресс-барами и таймерами сброса.
  * Инспектор логов: просмотр входящего запроса, тела апстрима и сырого вывода провайдера в JSON.
  * Авто-тестер моделей с генератором логических задач (🎲 *«Случайный поносик»*).
* 🏰 **Шина связи агентов (Hermes ⟷ Dirom Inter-Agent Bus)**:
  * Двухсторонний мост между десктопным агентом Hermes и автономным ботом Dirom на планшете.

---

## 🚀 Быстрый старт (Установка в 1 строку)

### 📱 Linux / macOS / Android Termux:
```bash
curl -fsSL https://github.com/kasper-studios/KasRAI/raw/refs/heads/main/install.sh | bash
```

### 🪟 Windows (PowerShell / CMD):
```cmd
curl -fsSL https://github.com/kasper-studios/KasRAI/raw/refs/heads/main/install.bat -o install.bat && install.bat
```

После установки шлюз доступен по адресу:
👉 **`http://localhost:20250/`**

---

## 🛠️ Ручной запуск

### 1. Клонирование и установка зависимостей:
```bash
git clone https://github.com/kasper-studios/KasRAI.git
cd KasRAI
npm install --omit=dev
```

### 2. Запуск:
* **На десктопе (Linux/macOS):**
  ```bash
  bash start.sh
  # или:
  node server.js
  ```
* **На Android (Termux):**
  ```bash
  bash termux.sh
  ```
  *(Скрипт `termux.sh` автоматически активирует `termux-wake-lock`, чтобы Android не усыплял процесс шлюза при выключенном экране).*

---

## 💡 Примеры интеграции

### Python (Официальный `openai` SDK):
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:20250/v1",
    api_key="kasrai"  # любой произвольный ключ
)

# Вызов виртуального маршрута или конкретной модели
response = client.chat.completions.create(
    model="antigravity/gemini-3.8-flash-high",
    messages=[
        {"role": "system", "content": "Ты опытный инженер."},
        {"role": "user", "content": "Объясни устройство Event Loop за 2 предложения."}
    ],
    temperature=0.7
)

print(response.choices[0].message.content)
```

### cURL (Стриминг SSE):
```bash
curl -N http://localhost:20250/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kasrai/smart",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Напиши стих про утренний кофе"}
    ]
  }'
```

---

## 🗺️ Маршрутизация моделей и алиасы

KasRAI поддерживает как прямой вызов моделей провайдеров (`<provider>/<model>`), так и виртуальные маршруты с ротацией:

| Модель / Маршрут | Провайдер | Назначение |
| :--- | :--- | :--- |
| **`kasrai/smart`** | Ротация | Топовые reasoning-модели (Gemini 3.1 Pro, 3.8 Flash, Claude 4.6) |
| **`kasrai/fast`** | Ротация | Быстрые легковесные модели (Gemini 3.7 Flash, 3.6 Flash, 3.5 Flash) |
| **`antigravity/gemini-3.8-flash-high`** | Antigravity | Флагманский быстрый Flash с рассуждениями |
| **`antigravity/gemini-3.1-pro-high`** | Antigravity | Тяжёлая логическая модель Pro-класса |
| **`antigravity/claude-sonnet-4-6`** | Antigravity | Claude Sonnet 4.6 через Google Cloud Code |
| **`antigravity/claude-opus-4-6-thinking`** | Antigravity | Claude Opus с глубоким мышлением |
| **`notion/gpt-5.6-sol`** | Notion AI | Модель `orange-mousse` из Notion AI |
| **`notion/claude-sonnet-5`** | Notion AI | Модель `angel-cake-high` из Notion AI |

---

## 📡 Системные API эндпоинты

* `GET /v1/models` — список всех доступных маршрутов и моделей.
* `POST /v1/chat/completions` — генерация ответов (стандарт OpenAI).
* `GET /v1/health` — проверка доступности шлюза.
* `GET /api/status` — системная статистика, задержка, активность аккаунтов.
* `POST /api/cooldowns/reset` — сброс всех кулдаунов 429 в один клик.
* `POST /api/models/refresh` — опрос живых каталогов `/models` всех подключений.
* `POST /api/agent/hermes/task` — входящая очередь задач для агента Hermes.
* `POST /api/agent/dirom/emit` — отправка событий в Event Bus Дирома (`:8767`).

---

## 🔒 Безопасность и сохранность данных

Все рабочие базы (`providers.db`, `routes.db`, `logs.db`, `config.db`) хранятся локально в директории `data/` в бинарном формате `@kasperenok/kasdb`. 
Папка `data/` внесена в `.gitignore` и **никогда не перезаписывается** при обновлениях через Git.

---

<p align="center">
  Разработано с ❤️ командой <b>Kasper Studios</b> (Hermes & Dirom).<br>
  <i>«Знающие поймут, а незнающие апкакаются.»</i>
</p>
