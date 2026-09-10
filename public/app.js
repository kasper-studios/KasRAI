// KasRAI Web Dashboard Engine
let currentTab = 'overview';
let cachedProviders = [];
let cachedRoutes = [];
let providerSearchQuery = '';
let providerActiveFilter = 'all';
let cooldownTickerInterval = null;

// ==========================================
// 🔔 Toast Notification System
// ==========================================
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-item pointer-events-auto flex items-center space-x-3 px-4 py-3 rounded-xl border shadow-xl backdrop-blur text-xs font-medium max-w-md transition-all';

  let icon = '<i class="fa-solid fa-circle-info text-brand-400 text-sm"></i>';
  let colors = 'bg-dark-card/95 border-dark-cardBorder text-gray-200';

  if (type === 'success') {
    icon = '<i class="fa-solid fa-circle-check text-emerald-400 text-sm"></i>';
    colors = 'bg-dark-card/95 border-emerald-500/30 text-emerald-300';
  } else if (type === 'error') {
    icon = '<i class="fa-solid fa-triangle-exclamation text-rose-400 text-sm"></i>';
    colors = 'bg-dark-card/95 border-rose-500/30 text-rose-300';
  } else if (type === 'warning') {
    icon = '<i class="fa-solid fa-hourglass-half text-amber-400 text-sm"></i>';
    colors = 'bg-dark-card/95 border-amber-500/30 text-amber-300';
  }

  toast.className += ` ${colors}`;
  toast.innerHTML = `
    <div class="flex-shrink-0">${icon}</div>
    <div class="flex-1 whitespace-pre-wrap">${message}</div>
    <button class="text-gray-500 hover:text-gray-300 flex-shrink-0 ml-2" onclick="this.parentElement.remove()"><i class="fa-solid fa-xmark"></i></button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) scale(0.95)';
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// Quick Copy Helper
function copyToClipboard(text, btn = null) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Скопировано в буфер: ${text.length > 30 ? text.slice(0, 30) + '...' : text}`, 'success', 2000);
    if (btn) {
      const originalHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i>';
      setTimeout(() => { btn.innerHTML = originalHtml; }, 1500);
    }
  }).catch(() => {
    showToast('Не удалось скопировать', 'error');
  });
}

// ==========================================
// 📑 Tab Navigation
// ==========================================
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`tab-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');

  const views = ['overview', 'providers', 'routes', 'logs', 'playground'];
  views.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (el) {
      if (v === tab) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  if (tab === 'overview') loadStatus();
  if (tab === 'providers') loadProviders();
  if (tab === 'routes') loadRoutes();
  if (tab === 'logs') loadLogs();
  if (tab === 'playground') loadPlaygroundModels();
}

// ==========================================
// 📊 1. Overview Tab
// ==========================================
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    document.getElementById('header-port').innerText = `PORT ${data.port || 20250}`;
    document.getElementById('stat-active-providers').innerText = `${data.counts.activeProviders} / ${data.counts.totalProviders}`;
    document.getElementById('stat-accounts-detail').innerText = `(${data.counts.totalAccounts} аккаунтов)`;
    document.getElementById('stat-total-routes').innerText = data.counts.totalRoutes;
    document.getElementById('stat-total-requests').innerText = data.counts.totalRequests;
    document.getElementById('stat-avg-latency').innerText = `${data.counts.avgLatencyMs} ms`;
    document.getElementById('stat-failover-count').innerHTML = `<i class="fa-solid fa-shield-halved mr-1"></i>${data.counts.fallbackRequests} фоллбеков`;

    const cooldownEl = document.getElementById('stat-cooldown-note');
    if (data.counts.cooldownAccounts > 0) {
      cooldownEl.className = 'text-xs text-amber-400 mt-2 flex items-center justify-between';
      cooldownEl.innerHTML = `
        <span><i class="fa-solid fa-triangle-exclamation mr-1"></i>${data.counts.cooldownAccounts} на паузе (cooldown)</span>
        <button onclick="resetAllCooldowns()" class="underline hover:text-amber-300 font-semibold ml-2">Сбросить</button>
      `;
    } else {
      cooldownEl.className = 'text-xs text-emerald-400 mt-2';
      cooldownEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i>Все аккаунты активны`;
    }

    const total = data.counts.totalRequests;
    const ok = data.counts.successfulRequests + data.counts.fallbackRequests;
    const rate = total > 0 ? Math.round((ok / total) * 100) : 100;
    document.getElementById('stat-success-rate').innerText = `${rate}% OK`;
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

// ==========================================
// 🔌 2. Providers & Accounts Management
// ==========================================
async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    const providers = await res.json();
    cachedProviders = providers;
    renderProviders();
  } catch (err) {
    showToast('Не удалось загрузить список провайдеров: ' + err.message, 'error');
  }
}

function onProviderSearch(val) {
  providerSearchQuery = (val || '').trim().toLowerCase();
  renderProviders();
}

function setProviderFilter(filter) {
  providerActiveFilter = filter;
  document.querySelectorAll('#provider-filter-chips .filter-chip').forEach(btn => {
    if (btn.dataset.filter === filter) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  renderProviders();
}

function renderProviders() {
  const container = document.getElementById('providers-container');
  if (!container) return;
  container.innerHTML = '';

  let filtered = cachedProviders.filter(p => {
    // 1. Text search query
    if (providerSearchQuery) {
      const matchName = (p.name || '').toLowerCase().includes(providerSearchQuery);
      const matchId = (p.id || '').toLowerCase().includes(providerSearchQuery);
      const matchUrl = (p.baseURL || '').toLowerCase().includes(providerSearchQuery);
      const matchModels = Array.isArray(p.models) && p.models.some(m => m.toLowerCase().includes(providerSearchQuery));
      const matchAccounts = Array.isArray(p.accounts) && p.accounts.some(a => 
        (a.name || '').toLowerCase().includes(providerSearchQuery) ||
        (a.subscriptionTier || '').toLowerCase().includes(providerSearchQuery)
      );
      if (!matchName && !matchId && !matchUrl && !matchModels && !matchAccounts) {
        return false;
      }
    }

    // 2. Chip filters
    if (providerActiveFilter === 'pro') {
      return Array.isArray(p.accounts) && p.accounts.some(a => a.isPro || (a.subscriptionTier && a.subscriptionTier.includes('Pro')));
    }
    if (providerActiveFilter === 'antigravity') {
      return p.id === 'antigravity' || p.preset === 'antigravity';
    }
    if (providerActiveFilter === 'hasAccounts') {
      return Array.isArray(p.accounts) && p.accounts.length > 0;
    }
    if (providerActiveFilter === 'cooldown') {
      return Array.isArray(p.accounts) && p.accounts.some(a => a.status === 'cooldown' || a.cooldownRemainingSec > 0);
    }
    if (providerActiveFilter === 'invalid') {
      return Array.isArray(p.accounts) && p.accounts.some(a => a.status === 'invalid');
    }

    return true;
  });

  const countBadge = document.getElementById('provider-matches-count');
  if (countBadge) {
    countBadge.innerText = `Найдено ${filtered.length} из ${cachedProviders.length}`;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-12 text-center bg-dark-card border border-dark-cardBorder rounded-2xl">
        <i class="fa-solid fa-filter-circle-xmark text-4xl text-gray-600 mb-3"></i>
        <p class="text-sm text-gray-400 font-medium">Ничего не найдено по заданным фильтрам</p>
        <button onclick="setProviderFilter('all'); document.getElementById('provider-search-input').value=''; onProviderSearch('');" class="mt-3 px-3 py-1.5 bg-brand-600/20 hover:bg-brand-600/30 text-brand-400 border border-brand-500/30 rounded-lg text-xs font-semibold transition">
          Сбросить фильтры
        </button>
      </div>
    `;
    return;
  }

  filtered.forEach((p) => {
    const card = document.createElement('div');
    card.className = `bg-dark-card border ${p.enabled ? 'border-dark-cardBorder' : 'border-rose-900/30 opacity-70'} rounded-2xl p-5 flex flex-col justify-between space-y-4 shadow-sm hover:border-brand-500/30 transition-all`;

    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    const accountsHTML = accounts.length > 0
      ? accounts.map((acc) => {
          const isCooldown = acc.status === 'cooldown' || (acc.cooldownRemainingSec && acc.cooldownRemainingSec > 0);
          let statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono">ЖИВ</span>`;
          if (acc.status === 'invalid') {
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-rose-500/10 border border-rose-500/20 text-rose-400 font-mono" title="${acc.invalidReason || 'Невалиден'}">МЁРТВ</span>`;
          } else if (isCooldown) {
            statusBadge = `
              <span class="cooldown-timer px-2 py-0.5 rounded text-[10px] bg-amber-500/10 border border-amber-500/20 text-amber-400 font-mono flex items-center space-x-1" data-sec="${acc.cooldownRemainingSec || 60}" id="cd-${p.id}-${acc.id}">
                <i class="fa-solid fa-hourglass-half animate-spin text-[9px]"></i>
                <span class="cd-val">КД ${acc.cooldownRemainingSec || 60}с</span>
              </span>
            `;
          }

          const authTypeIcon = acc.authType === 'oauth'
            ? `<i class="fa-solid fa-key text-purple-400" title="OAuth token"></i>`
            : `<i class="fa-solid fa-lock text-brand-400" title="API Key"></i>`;

          const tierBadge = acc.subscriptionTier
            ? `<span class="px-2 py-0.5 rounded-lg text-[10px] font-bold ${acc.isPro ? 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20 text-yellow-300 border border-yellow-500/40 shadow-sm shadow-yellow-500/10' : 'bg-dark-input text-gray-400 border border-dark-cardBorder'} font-mono">${acc.isPro ? '⭐ ' : ''}${acc.subscriptionTier}</span>`
            : '';

          const prioBadge = `<span class="px-1.5 py-0.2 rounded text-[10px] bg-dark-input text-brand-400 border border-dark-cardBorder font-mono" title="Приоритет в очереди">P:${acc.priority || 0}</span>`;

          return `
            <div class="flex items-center justify-between bg-dark-input px-3 py-2 rounded-xl border border-dark-cardBorder text-xs hover:border-brand-500/20 transition-all">
              <div class="flex items-center space-x-2 truncate mr-2">
                ${authTypeIcon}
                <span class="font-medium text-gray-200 truncate" title="${acc.name}">${acc.name}</span>
                ${tierBadge}
                ${prioBadge}
                <button onclick="copyToClipboard('${acc.name}', this)" title="Скопировать имя/email" class="text-gray-500 hover:text-gray-300 text-[10px]"><i class="fa-regular fa-copy"></i></button>
              </div>
              <div class="flex items-center space-x-1.5 flex-shrink-0">
                ${statusBadge}
                <button onclick="verifySingleAccount('${p.id}', '${acc.id}', this)" title="Быстрая проверка пульса" class="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-emerald-400 hover:bg-dark-cardBorder transition"><i class="fa-solid fa-heart-pulse text-[11px]"></i></button>
                <button onclick="checkSingleAccountQuota('${p.id}', '${acc.id}', this)" title="Проверить квоту" class="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-brand-400 hover:bg-dark-cardBorder transition"><i class="fa-solid fa-chart-pie text-[11px]"></i></button>
                <button onclick="openEditAccountModal('${p.id}', '${acc.id}')" title="Изменить приоритет / ключ" class="w-6 h-6 rounded flex items-center justify-center text-gray-400 hover:text-indigo-400 hover:bg-dark-cardBorder transition"><i class="fa-solid fa-pen-to-square text-[11px]"></i></button>
                ${isCooldown ? `<button onclick="resetAccountCooldown('${p.id}', '${acc.id}')" title="Снять кулдаун сейчас" class="w-6 h-6 rounded flex items-center justify-center text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 transition"><i class="fa-solid fa-snowflake text-[11px]"></i></button>` : ''}
                <button onclick="deleteAccount('${p.id}', '${acc.id}')" title="Удалить" class="w-6 h-6 rounded flex items-center justify-center text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 transition"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
              </div>
            </div>
          `;
        }).join('')
      : `<div class="text-xs text-gray-500 italic py-2 text-center bg-dark-input/50 rounded-xl border border-dashed border-dark-cardBorder">Нет добавленных аккаунтов. Запросы пойдут по базовому ключу.</div>`;

    card.innerHTML = `
      <div>
        <!-- Header -->
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2.5">
            <div class="w-9 h-9 rounded-xl bg-dark-input border border-dark-cardBorder flex items-center justify-center font-bold text-base text-brand-400">
              ${p.preset === 'antigravity' ? '⚡' : p.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div class="flex items-center space-x-1.5">
                <h4 class="font-bold text-sm text-white">${p.name}</h4>
                <span class="text-[10px] uppercase font-mono px-1.5 py-0.2 bg-dark-input text-gray-400 rounded border border-dark-cardBorder">${p.preset || p.type}</span>
              </div>
              <div class="text-[11px] text-gray-400 font-mono truncate max-w-[220px]" title="${p.baseURL}">${p.baseURL}</div>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <span class="w-2 h-2 rounded-full ${p.enabled ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}"></span>
            <button onclick="toggleProvider('${p.id}', ${p.enabled})" class="text-xs ${p.enabled ? 'text-emerald-400 hover:text-emerald-300' : 'text-gray-500 hover:text-gray-300'} font-medium">
              ${p.enabled ? 'Включен' : 'Выключен'}
            </button>
          </div>
        </div>

        <!-- Cooldown & Settings Bar -->
        <div class="mt-3 flex items-center justify-between text-[11px] text-gray-400 bg-dark-input/40 px-3 py-1.5 rounded-lg border border-dark-cardBorder">
          <span>Дефолтный КД при 429: <b class="text-brand-400 font-mono">${p.rateLimitCooldownSec || 60}с</b></span>
          <button onclick="openProviderModal('${p.id}')" class="text-brand-400 hover:underline flex items-center space-x-1">
            <i class="fa-solid fa-sliders text-[10px]"></i>
            <span>Настроить</span>
          </button>
        </div>

        <!-- Accounts Pool Header -->
        <div class="mt-4">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Пул аккаунтов (${accounts.length})</span>
            <div class="flex items-center space-x-1.5">
              ${p.authType === 'oauth' || p.preset === 'antigravity' ? `
                <a href="/api/providers/${p.id}/oauth/authorize" target="_blank" class="px-2 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded-lg text-[11px] font-medium transition flex items-center space-x-1">
                  <i class="fa-solid fa-link"></i>
                  <span>+ OAuth вход</span>
                </a>
              ` : ''}
              <button onclick="openAddAccountModal('${p.id}')" class="px-2 py-1 bg-dark-input hover:bg-dark-cardBorder text-gray-200 border border-dark-cardBorder rounded-lg text-[11px] font-medium transition flex items-center space-x-1">
                <i class="fa-solid fa-plus text-[10px]"></i>
                <span>Ключ</span>
              </button>
            </div>
          </div>
          <div class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            ${accountsHTML}
          </div>
        </div>
      </div>

      <!-- Models Tags Footer -->
      <div class="pt-3 border-t border-dark-cardBorder/60 flex flex-wrap gap-1.5 items-center justify-between">
        <div class="flex flex-wrap gap-1 items-center">
          <span class="text-[10px] text-gray-500 uppercase font-mono mr-1">Модели:</span>
          <span class="px-1.5 py-0.5 rounded ${p.modelsSource === 'live' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'} text-[10px] font-mono border" title="${p.modelsSource === 'live' ? 'Загружено из живого API провайдера' : (p.lastModelsCheckError || 'Используются встроенные модели')}">
            ${p.modelsSource === 'live' ? '🟢 Live' : '🟠 Fallback'} (${(p.models || []).length})
          </span>
          ${(p.models || []).slice(0, 3).map(m => `<span class="px-1.5 py-0.5 rounded bg-dark-input text-[10px] text-gray-400 font-mono border border-dark-cardBorder">${m}</span>`).join('')}
          ${(p.models || []).length > 3 ? `<span class="text-[10px] text-brand-400 font-mono">+${p.models.length - 3}</span>` : ''}
        </div>
        <button onclick="checkSingleProviderModels('${p.id}', this)" title="Опросить эндпоинт моделей провайдера" class="text-[11px] text-gray-400 hover:text-brand-400 font-mono flex items-center space-x-1 py-0.5 px-1.5 rounded hover:bg-dark-input transition">
          <i class="fa-solid fa-arrows-rotate text-[10px]"></i>
          <span>Чек моделей</span>
        </button>
      </div>
    `;

    container.appendChild(card);
  });
}

// Live Cooldown Ticker
function startLiveCooldownTicker() {
  if (cooldownTickerInterval) clearInterval(cooldownTickerInterval);
  cooldownTickerInterval = setInterval(() => {
    const timers = document.querySelectorAll('.cooldown-timer');
    timers.forEach(el => {
      let sec = parseInt(el.dataset.sec || '0', 10);
      if (sec > 0) {
        sec--;
        el.dataset.sec = sec;
        const valSpan = el.querySelector('.cd-val');
        if (valSpan) valSpan.innerText = `КД ${sec}с`;
      } else {
        el.className = 'px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono';
        el.innerHTML = 'ЖИВ';
      }
    });
  }, 1000);
}

// Global Cooldown Reset
async function resetAllCooldowns() {
  try {
    const res = await fetch('/api/cooldowns/reset', { method: 'POST' });
    const data = await res.json();
    showToast(`❄️ ${data.message || 'Кулдауны сброшены!'}`, 'success');
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка сброса кулдаунов: ' + err.message, 'error');
  }
}

// Single Account Cooldown Reset
async function resetAccountCooldown(providerId, accId) {
  try {
    const res = await fetch(`/api/providers/${providerId}/accounts/${accId}/reset-cooldown`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Кулдаун аккаунта успешно сброшен!', 'success');
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка сброса: ' + err.message, 'error');
  }
}

// Single Account Verify
async function verifySingleAccount(providerId, accId, btn = null) {
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-brand-400"></i>';

  try {
    const res = await fetch(`/api/providers/${providerId}/accounts/${accId}/verify`, { method: 'POST' });
    const data = await res.json();
    if (data.healthy) {
      showToast(`🟢 Аккаунт проверен: ЖИВ (${data.latencyMs || 0}ms)\n${data.message || ''}`, 'success');
    } else {
      showToast(`🔴 Ошибка аккаунта: ${data.message || 'Не отвечает'}`, 'error');
    }
    loadProviders();
  } catch (err) {
    showToast('Ошибка проверки: ' + err.message, 'error');
  } finally {
    if (btn && originalHtml) btn.innerHTML = originalHtml;
  }
}

// Single Account Quota Check (Modal Inspector)
async function checkSingleAccountQuota(providerId, accId, btn = null) {
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-brand-400"></i>';

  try {
    const res = await fetch(`/api/providers/${providerId}/accounts/${accId}/quota`);
    const data = await res.json();
    openQuotaModal(providerId, accId, data);
    loadProviders();
  } catch (err) {
    showToast('Ошибка получения квоты: ' + err.message, 'error');
  } finally {
    if (btn && originalHtml) btn.innerHTML = originalHtml;
  }
}

function openQuotaModal(providerId, accId, data) {
  const modal = document.getElementById('quota-modal');
  if (!modal) return;

  const p = cachedProviders.find((x) => x.id === providerId);
  const acc = (p?.accounts || []).find((a) => a.id === accId);

  const titleEl = document.getElementById('modal-quota-title');
  const subtitleEl = document.getElementById('modal-quota-subtitle');
  const tierCard = document.getElementById('modal-quota-tier-card');
  const modelsList = document.getElementById('modal-quota-models-list');
  const resetTimeEl = document.getElementById('modal-quota-reset-time');
  const rawEl = document.getElementById('modal-quota-raw');

  titleEl.innerText = `${acc?.name || accId} • Квота [${p?.name || providerId}]`;
  subtitleEl.innerText = `Провайдер: ${providerId} | Приоритет: P:${acc?.priority || 0} | Тип: ${acc?.authType || 'key'}`;

  // Raw JSON
  rawEl.innerText = JSON.stringify(data, null, 2);

  if (!data.supported) {
    tierCard.className = 'p-4 rounded-xl border border-dark-cardBorder bg-dark-input flex items-center justify-between';
    tierCard.innerHTML = `
      <div class="flex items-center space-x-3">
        <i class="fa-solid fa-circle-info text-gray-500 text-xl"></i>
        <div>
          <h4 class="font-bold text-gray-300">Статус квоты недоступен</h4>
          <p class="text-[11px] text-gray-500">${data.message || 'Данный провайдер не предоставляет API проверки квот'}</p>
        </div>
      </div>
    `;
    modelsList.innerHTML = '<div class="text-gray-500 italic py-4 text-center">Нет детальных данных по квотам моделей</div>';
    resetTimeEl.innerText = '';
    modal.classList.remove('hidden');
    return;
  }

  // Tier Card
  const isPro = data.isPro || (data.subscriptionTier && data.subscriptionTier.includes('Pro'));
  tierCard.className = `p-4 rounded-xl border ${isPro ? 'border-amber-500/40 bg-gradient-to-r from-amber-500/10 via-yellow-500/10 to-transparent' : 'border-dark-cardBorder bg-dark-input'} flex items-center justify-between`;
  tierCard.innerHTML = `
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl ${isPro ? 'bg-amber-500/20 text-yellow-300 border border-amber-500/30' : 'bg-dark-bg text-gray-400 border border-dark-cardBorder'} flex items-center justify-center font-bold text-lg">
        ${isPro ? '⭐' : '📦'}
      </div>
      <div>
        <div class="flex items-center space-x-2">
          <h4 class="font-bold text-sm ${isPro ? 'text-yellow-300' : 'text-gray-200'}">${data.subscriptionTier || 'Standard'}</h4>
          <span class="px-2 py-0.5 rounded text-[10px] font-mono ${isPro ? 'bg-amber-500/20 text-yellow-400 border border-amber-500/30' : 'bg-dark-bg text-gray-400 border border-dark-cardBorder'}">${isPro ? 'PREMIUM TIER' : 'FREE TIER'}</span>
        </div>
        <p class="text-[11px] text-gray-400 mt-0.5">Аккаунт подключен и активен в пуле ротации KasRAI</p>
      </div>
    </div>
    <div class="text-right font-mono">
      <span class="text-xs text-gray-400">Статус:</span>
      <div class="text-xs font-bold text-emerald-400">АКТИВЕН</div>
    </div>
  `;

  // Reset time
  if (data.earliestResetTime) {
    const rDate = new Date(data.earliestResetTime);
    resetTimeEl.innerHTML = `<i class="fa-solid fa-clock-rotate-left mr-1 text-brand-400"></i>Сброс: ${rDate.toLocaleTimeString()} (${rDate.toLocaleDateString()})`;
  } else {
    resetTimeEl.innerText = '';
  }

  // Models Progress Bars
  modelsList.innerHTML = '';
  const modelsQuota = data.modelsQuota || {};
  const entries = Object.entries(modelsQuota);

  if (entries.length === 0) {
    modelsList.innerHTML = '<div class="text-gray-500 italic py-4 text-center">Модели без ограничений квот или данные отсутствуют</div>';
  } else {
    entries.forEach(([mId, info]) => {
      const pct = Math.max(0, Math.min(100, info.remainingPercent !== undefined ? info.remainingPercent : Math.round((info.remainingFraction || 1) * 100)));
      
      let barColor = 'bg-emerald-500';
      let textColor = 'text-emerald-400';
      if (pct <= 20) {
        barColor = 'bg-rose-500';
        textColor = 'text-rose-400';
      } else if (pct <= 50) {
        barColor = 'bg-amber-500';
        textColor = 'text-amber-400';
      }

      const itemEl = document.createElement('div');
      itemEl.className = 'bg-dark-input p-3 rounded-xl border border-dark-cardBorder space-y-1.5';
      itemEl.innerHTML = `
        <div class="flex items-center justify-between text-xs">
          <div class="flex items-center space-x-2 truncate">
            <span class="font-mono font-bold text-gray-200 truncate">${info.displayName || mId}</span>
          </div>
          <div class="flex items-center space-x-2 font-mono">
            ${info.resetTime ? `<span class="text-[10px] text-gray-500">${new Date(info.resetTime).toLocaleTimeString()}</span>` : ''}
            <span class="font-bold ${textColor}">${pct}%</span>
          </div>
        </div>
        <div class="w-full bg-dark-bg rounded-full h-2 overflow-hidden border border-dark-cardBorder/40">
          <div class="${barColor} h-2 rounded-full transition-all duration-500" style="width: ${pct}%"></div>
        </div>
      `;
      modelsList.appendChild(itemEl);
    });
  }

  modal.classList.remove('hidden');
}

function closeQuotaModal() {
  const modal = document.getElementById('quota-modal');
  if (modal) modal.classList.add('hidden');
}

// Toggle Provider State
async function toggleProvider(id, currentEnabled) {
  try {
    const res = await fetch(`/api/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !currentEnabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`Провайдер ${id} ${!currentEnabled ? 'включен' : 'выключен'}`, 'info');
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка переключения: ' + err.message, 'error');
  }
}

// Delete Account
async function deleteAccount(providerId, accId) {
  if (!confirm('Удалить этот аккаунт из пула ротации?')) return;
  try {
    const res = await fetch(`/api/providers/${providerId}/accounts/${accId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Аккаунт удален из пула', 'info');
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка удаления: ' + err.message, 'error');
  }
}

// Toggle Auth fields based on select
function toggleAuthFields() {
  const authType = document.getElementById('modal-acc-authtype')?.value || 'key';
  const keyField = document.getElementById('field-api-key');
  const cookieField = document.getElementById('field-cookie');
  const oauthField = document.getElementById('field-oauth');

  if (keyField) keyField.classList.toggle('hidden', authType !== 'key');
  if (cookieField) cookieField.classList.toggle('hidden', authType !== 'cookie');
  if (oauthField) oauthField.classList.toggle('hidden', authType !== 'oauth');
}

// Parse Cookie / Netscape / JSON
function parseRawCookieInput(val) {
  if (!val) return;
  try {
    if (val.trim().startsWith('{')) {
      const parsed = JSON.parse(val);
      if (parsed.token_v2) document.getElementById('modal-acc-tokenv2').value = parsed.token_v2;
      if (parsed.user_id || parsed.userId) document.getElementById('modal-acc-userid').value = parsed.user_id || parsed.userId;
      if (parsed.space_id || parsed.spaceId) document.getElementById('modal-acc-spaceid').value = parsed.space_id || parsed.spaceId;
      return;
    }
  } catch {}

  const tokenMatch = val.match(/token_v2=([^;\s]+)/);
  if (tokenMatch) document.getElementById('modal-acc-tokenv2').value = tokenMatch[1];

  const userMatch = val.match(/notion_user_id=([^;\s]+)/);
  if (userMatch) document.getElementById('modal-acc-userid').value = userMatch[1];
}

function handleCookieFileUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target.result;
    document.getElementById('modal-acc-cookie-raw').value = text;
    parseRawCookieInput(text);
  };
  reader.readAsText(file);
}

// Add Account Modal
function openAddAccountModal(providerId) {
  const p = cachedProviders.find((x) => x.id === providerId);
  const provName = p ? p.name : providerId;

  document.getElementById('modal-acc-provider-id').value = providerId;
  const titleEl = document.getElementById('modal-account-title');
  if (titleEl) titleEl.innerText = `Добавить в ${provName}`;
  document.getElementById('modal-acc-name').value = '';
  document.getElementById('modal-acc-key').value = '';
  if (document.getElementById('modal-acc-prio')) document.getElementById('modal-acc-prio').value = '0';
  if (document.getElementById('modal-acc-oauth-access')) document.getElementById('modal-acc-oauth-access').value = '';
  if (document.getElementById('modal-acc-oauth-refresh')) document.getElementById('modal-acc-oauth-refresh').value = '';
  if (document.getElementById('modal-acc-tokenv2')) document.getElementById('modal-acc-tokenv2').value = '';
  if (document.getElementById('modal-acc-userid')) document.getElementById('modal-acc-userid').value = '';
  if (document.getElementById('modal-acc-spaceid')) document.getElementById('modal-acc-spaceid').value = '';
  if (document.getElementById('modal-acc-cookie-raw')) document.getElementById('modal-acc-cookie-raw').value = '';

  const authSelect = document.getElementById('modal-acc-authtype');
  if (authSelect) {
    if (p && p.preset === 'notion') {
      authSelect.value = 'cookie';
    } else {
      authSelect.value = 'key';
    }
    toggleAuthFields();
  }

  document.getElementById('account-modal').classList.remove('hidden');
}

function closeAccountModal() {
  document.getElementById('account-modal').classList.add('hidden');
}
const closeAddAccountModal = closeAccountModal;

async function saveAccountModal() {
  const providerId = document.getElementById('modal-acc-provider-id').value;
  const name = document.getElementById('modal-acc-name').value.trim();
  const authType = document.getElementById('modal-acc-authtype')?.value || 'key';
  const priority = parseInt(document.getElementById('modal-acc-prio')?.value || '0', 10);

  let apiKey = '';
  let oauth = null;

  if (authType === 'key') {
    apiKey = document.getElementById('modal-acc-key')?.value.trim() || '';
    if (!apiKey) {
      showToast('Укажите API-ключ', 'warning');
      return;
    }
  } else if (authType === 'oauth') {
    const accessToken = document.getElementById('modal-acc-oauth-access')?.value.trim() || '';
    const refreshToken = document.getElementById('modal-acc-oauth-refresh')?.value.trim() || '';
    if (!accessToken) {
      showToast('Укажите Access Token', 'warning');
      return;
    }
    oauth = { accessToken, refreshToken, expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() };
  } else if (authType === 'cookie') {
    const tokenV2 = document.getElementById('modal-acc-tokenv2')?.value.trim() || '';
    const userId = document.getElementById('modal-acc-userid')?.value.trim() || '';
    const spaceId = document.getElementById('modal-acc-spaceid')?.value.trim() || '';
    if (!tokenV2) {
      showToast('Укажите token_v2', 'warning');
      return;
    }
    apiKey = JSON.stringify({ token_v2: tokenV2, user_id: userId, space_id: spaceId });
  }

  const accName = name || (authType === 'key' ? `Key ${Date.now().toString().slice(-4)}` : `${authType.toUpperCase()} Account`);

  try {
    const res = await fetch(`/api/providers/${providerId}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: accName, authType, apiKey, oauth, priority }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    showToast('Ключ / Аккаунт успешно добавлен в ротацию!', 'success');
    closeAccountModal();
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка добавления: ' + err.message, 'error');
  }
}
const saveNewAccount = saveAccountModal;

// Edit Account Modal
function openEditAccountModal(providerId, accId) {
  const p = cachedProviders.find((x) => x.id === providerId);
  if (!p) return;
  const acc = (p.accounts || []).find((a) => a.id === accId);
  if (!acc) return;

  document.getElementById('modal-edit-acc-provider-id').value = providerId;
  document.getElementById('modal-edit-acc-id').value = accId;
  document.getElementById('modal-edit-acc-name').value = acc.name || '';
  document.getElementById('modal-edit-acc-prio').value = acc.priority || 0;
  document.getElementById('modal-edit-acc-key').value = '';

  const keyField = document.getElementById('field-edit-acc-key');
  if (acc.authType === 'oauth') {
    keyField.style.display = 'none';
  } else {
    keyField.style.display = 'block';
  }

  document.getElementById('edit-account-modal').classList.remove('hidden');
}

function closeEditAccountModal() {
  document.getElementById('edit-account-modal').classList.add('hidden');
}

async function saveEditAccountModal() {
  const providerId = document.getElementById('modal-edit-acc-provider-id').value;
  const accId = document.getElementById('modal-edit-acc-id').value;
  const name = document.getElementById('modal-edit-acc-name').value.trim();
  const priority = parseInt(document.getElementById('modal-edit-acc-prio').value || '0', 10);
  const apiKey = document.getElementById('modal-edit-acc-key').value.trim();

  const body = { name, priority };
  if (apiKey) body.apiKey = apiKey;

  try {
    const res = await fetch(`/api/providers/${providerId}/accounts/${accId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Настройки аккаунта сохранены!', 'success');
    closeEditAccountModal();
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка сохранения: ' + err.message, 'error');
  }
}

// Provider Settings Modal
function openProviderModal(providerId) {
  const p = cachedProviders.find((x) => x.id === providerId);
  if (!p) return;

  document.getElementById('modal-provider-id').value = p.id;
  document.getElementById('modal-provider-title').innerText = `Настройки: ${p.name}`;
  document.getElementById('modal-provider-url').value = p.baseURL || '';
  document.getElementById('modal-provider-cooldown').value = p.rateLimitCooldownSec || 60;
  document.getElementById('modal-provider-models').value = Array.isArray(p.models) ? p.models.join(', ') : '';
  const enabledCheckbox = document.getElementById('modal-provider-enabled');
  if (enabledCheckbox) enabledCheckbox.checked = p.enabled !== false;
  document.getElementById('provider-modal').classList.remove('hidden');
}

function closeProviderModal() {
  document.getElementById('provider-modal').classList.add('hidden');
}

async function saveProviderModal() {
  const id = document.getElementById('modal-provider-id').value;
  const baseURL = document.getElementById('modal-provider-url').value.trim();
  const cooldown = parseInt(document.getElementById('modal-provider-cooldown').value || '60', 10);
  const modelsStr = document.getElementById('modal-provider-models').value.trim();
  const enabled = document.getElementById('modal-provider-enabled') ? document.getElementById('modal-provider-enabled').checked : true;
  const models = modelsStr ? modelsStr.split(',').map((s) => s.trim()).filter(Boolean) : [];

  try {
    const res = await fetch(`/api/providers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, rateLimitCooldownSec: cooldown, models, enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Настройки провайдера сохранены!', 'success');
    closeProviderModal();
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка сохранения: ' + err.message, 'error');
  }
}
const saveProviderSettings = saveProviderModal;

// Add Custom Provider
function openAddProviderModal() {
  document.getElementById('new-prov-id').value = '';
  document.getElementById('new-prov-name').value = '';
  document.getElementById('new-prov-key').value = '';
  document.getElementById('new-prov-preset').value = 'openai';
  document.getElementById('new-prov-authtype').value = 'key';
  onPresetChange();
  onNewProvAuthChange();
  document.getElementById('add-provider-modal').classList.remove('hidden');
}

function closeAddProviderModal() {
  document.getElementById('add-provider-modal').classList.add('hidden');
}

function onPresetChange() {
  const preset = document.getElementById('new-prov-preset').value;
  const urlInput = document.getElementById('new-prov-url');
  const defaults = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    openrouter: 'https://openrouter.ai/api/v1',
    groq: 'https://api.groq.com/openai/v1',
    antigravity: 'https://daily-cloudcode-pa.googleapis.com',
  };
  if (defaults[preset]) {
    urlInput.value = defaults[preset];
  }
}

function onNewProvAuthChange() {
  const authType = document.getElementById('new-prov-authtype').value;
  const keyGroup = document.getElementById('group-new-prov-key');
  const oauthGroup = document.getElementById('group-new-prov-oauth');
  if (authType === 'key') {
    keyGroup.classList.remove('hidden');
    oauthGroup.classList.add('hidden');
  } else {
    keyGroup.classList.add('hidden');
    oauthGroup.classList.remove('hidden');
  }
}

async function saveNewProvider() {
  const id = document.getElementById('new-prov-id').value.trim().toLowerCase();
  const name = document.getElementById('new-prov-name').value.trim();
  const type = document.getElementById('new-prov-preset').value;
  const baseURL = document.getElementById('new-prov-url').value.trim();
  const authType = document.getElementById('new-prov-authtype').value;
  const apiKey = document.getElementById('new-prov-key').value.trim();

  if (!id || !name) {
    showToast('Укажите ID и Название провайдера', 'warning');
    return;
  }

  const payload = { id, name, type, baseURL, authType, enabled: true };
  if (authType === 'key' && apiKey) {
    payload.apiKey = apiKey;
  }

  try {
    const res = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Провайдер успешно создан!', 'success');
    closeAddProviderModal();
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка создания: ' + err.message, 'error');
  }
}

// Health Check
async function runHealthCheck() {
  const btn = event?.currentTarget;
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-emerald-400 mr-2"></i>Проверка...';

  try {
    showToast('Запущен чекер здоровья всех аккаунтов...', 'info');
    const res = await fetch('/api/health-check', { method: 'POST' });
    const data = await res.json();
    showToast(`🩺 Чекер завершен!\n• Всего: ${data.totalChecked} | 🟢 Живы: ${data.healthyCount}\n• 🔄 Обновлено: ${data.refreshedCount} | ⏳ КД: ${data.cooldownCount}`, 'success', 5000);
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка чекера здоровья: ' + err.message, 'error');
  } finally {
    if (btn && originalHtml) btn.innerHTML = originalHtml;
  }
}

// OmniRoute Import
async function runOmnirouteImport() {
  if (!confirm('Импортировать все настроенные подключения из ~/.omniroute?')) return;
  try {
    const res = await fetch('/api/import/omniroute', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    showToast(`📥 Импорт успешен!\n• Аккаунтов: ${data.importedAccountsCount}\n• Провайдеров: ${data.importedProvidersCount}`, 'success');
    loadProviders();
    loadStatus();
  } catch (err) {
    showToast('Ошибка импорта: ' + err.message, 'error');
  }
}

// Single Provider Models Check
async function checkSingleProviderModels(providerId, btn = null) {
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-brand-400"></i>';
  try {
    const res = await fetch(`/api/providers/${providerId}/models/check`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast(`🟢 ${providerId}: обнаружено ${data.count} моделей (Live API)!`, 'success');
    } else {
      showToast(`🟠 ${providerId}: эндпоинт недоступен, включен Fallback (${data.count} моделей)\n${data.error || ''}`, 'warning', 4500);
    }
    loadProviders();
  } catch (err) {
    showToast(`Ошибка проверки моделей ${providerId}: ` + err.message, 'error');
  } finally {
    if (btn && originalHtml) btn.innerHTML = originalHtml;
  }
}

// All Providers Models Refresh
async function runModelsRefresh() {
  const btn = event?.currentTarget;
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-brand-400 mr-2"></i>Опрос...';

  try {
    showToast('Запущен чекер моделей для всех провайдеров...', 'info');
    const res = await fetch('/api/models/refresh', { method: 'POST' });
    const data = await res.json();
    const liveCount = (data.results || []).filter(r => r.ok).length;
    const fallbackCount = (data.results || []).filter(r => !r.ok).length;
    showToast(`🏁 Чекер завершен!\n• 🟢 Live API: ${liveCount} провайдеров\n• 🟠 Fallback: ${fallbackCount} провайдеров`, 'success', 5000);
    loadProviders();
  } catch (err) {
    showToast('Ошибка общего чекера моделей: ' + err.message, 'error');
  } finally {
    if (btn && originalHtml) btn.innerHTML = originalHtml;
  }
}

// ==========================================
// 🔀 3. Virtual Routes Tab
// ==========================================
async function loadRoutes() {
  try {
    const res = await fetch('/api/routes');
    const routes = await res.json();
    cachedRoutes = routes;

    const container = document.getElementById('routes-container');
    container.innerHTML = '';

    if (!routes || routes.length === 0) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-16 text-center">
          <i class="fa-solid fa-route text-4xl text-gray-600 mb-4"></i>
          <p class="text-gray-400 font-medium">Маршрутов пока нет</p>
          <p class="text-gray-600 text-sm mt-1">Нажмите «+ Создать маршрут» чтобы добавить цепочку фоллбеков</p>
        </div>`;
      return;
    }

    routes.forEach((r) => {
      // API returns: alias, rotationMode, targets, description (no .name/.mode/.id)
      const routeName = r.alias || r.name || '(без имени)';
      const routeMode = r.rotationMode || r.mode || 'priority';
      const routeId = r.alias || r.id || routeName;
      const routeEnabled = r.enabled !== false;

      const card = document.createElement('div');
      card.className = 'bg-dark-card border border-dark-cardBorder rounded-2xl p-5 shadow-sm space-y-3';

      const targetsHTML = (r.targets || []).map((t, idx) => `
        <span class="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-dark-input border border-dark-cardBorder text-xs font-mono">
          <span class="text-gray-500 font-bold">${idx + 1}.</span>
          <span class="text-gray-400 text-[10px]">[${t.provider || '-'}]</span>
          <span class="text-gray-200">${t.model}</span>
          ${t.priority !== undefined ? `<span class="text-brand-400 text-[10px] ml-1">P:${t.priority}</span>` : ''}
        </span>
      `).join('');

      card.innerHTML = `
        <div class="flex items-center justify-between">
          <div>
            <div class="flex items-center space-x-2">
              <span class="text-base font-bold text-white font-mono">${routeName}</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-brand-500/10 text-brand-400 border border-brand-500/20">${routeMode}</span>
              <button onclick="copyToClipboard('${routeName}', this)" title="Скопировать имя маршрута" class="text-gray-500 hover:text-gray-300 text-xs"><i class="fa-regular fa-copy"></i></button>
            </div>
            <p class="text-xs text-gray-400 mt-0.5">${r.description || 'Пользовательский маршрут'}</p>
          </div>
          <div class="flex items-center space-x-2">
            <button onclick="toggleRoute('${routeId}', ${routeEnabled})" class="text-xs ${routeEnabled ? 'text-emerald-400' : 'text-gray-500'} font-medium hover:opacity-80 transition">
              ${routeEnabled ? '● Включен' : '○ Выключен'}
            </button>
            <button onclick="deleteRoute('${routeId}')" class="text-gray-500 hover:text-rose-400 text-sm p-1 transition"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
        <div class="pt-2 border-t border-dark-cardBorder/60 flex flex-wrap gap-2 items-center">
          <span class="text-xs text-gray-500">Цепочка:</span>
          ${targetsHTML}
        </div>
      `;

      container.appendChild(card);
    });
  } catch (err) {
    showToast('Не удалось загрузить маршруты: ' + err.message, 'error');
  }
}

function openAddRouteModal() {
  document.getElementById('new-route-name').value = 'kasrai/';
  document.getElementById('new-route-desc').value = '';
  document.getElementById('new-route-targets').value = '';
  document.getElementById('add-route-modal').classList.remove('hidden');
}

function closeAddRouteModal() {
  document.getElementById('add-route-modal').classList.add('hidden');
}

async function saveNewRoute() {
  const name = document.getElementById('new-route-name').value.trim();
  const description = document.getElementById('new-route-desc').value.trim();
  const mode = document.getElementById('new-route-mode').value;
  const targetsRaw = document.getElementById('new-route-targets').value.trim();

  if (!name || !targetsRaw) {
    showToast('Укажите имя маршрута и список моделей', 'warning');
    return;
  }

  const targets = targetsRaw.split(',').map((t, idx) => ({
    model: t.trim(),
    priority: 100 - idx * 10,
  })).filter((t) => t.model.length > 0);

  try {
    const res = await fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, mode, targets, enabled: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Маршрут успешно создан!', 'success');
    closeAddRouteModal();
    loadRoutes();
    loadStatus();
  } catch (err) {
    showToast('Ошибка создания маршрута: ' + err.message, 'error');
  }
}

async function toggleRoute(id, currentEnabled) {
  try {
    const res = await fetch(`/api/routes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !currentEnabled }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    showToast(`Маршрут ${!currentEnabled ? 'активирован' : 'выключен'}`, 'info');
    await loadRoutes();
    loadStatus();
  } catch (err) {
    showToast('Ошибка переключения маршрута: ' + err.message, 'error');
  }
}

async function deleteRoute(id) {
  if (!confirm('Удалить этот маршрут?')) return;
  try {
    const res = await fetch(`/api/routes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    showToast('Маршрут удален', 'info');
    await loadRoutes();
    loadStatus();
  } catch (err) {
    showToast('Ошибка удаления: ' + err.message, 'error');
  }
}

// ==========================================
// 📜 4. Call Logs Tab & Inspector
// ==========================================
let activeInspectorLog = null;
let logsOffset = 0;
const LOGS_PAGE_SIZE = 50;

function renderLogRow(l, tbody) {
  const tr = document.createElement('tr');
  tr.className = 'border-b border-dark-cardBorder hover:bg-dark-input/60 transition cursor-pointer group';
  tr.onclick = () => openLogModal(l);

  const statusBadge = l.status === 200 || l.statusCode === 200
    ? '<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">200 OK</span>'
    : (l.status === 999 || l.statusCode === 999)
    ? '<span class="px-2 py-0.5 rounded text-[10px] bg-purple-500/20 text-purple-300 border border-purple-500/40 font-mono font-bold" title="Zero-Token Guard">💩 999</span>'
    : `<span class="px-2 py-0.5 rounded text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono">${l.statusCode || l.status}</span>`;

  const typeBadge = l.stream
    ? '<span class="text-[10px] font-mono text-purple-400">stream</span>'
    : '<span class="text-[10px] font-mono text-gray-500">sync</span>';

  const time = new Date(l.timestamp).toLocaleTimeString();

  tr.innerHTML = `
    <td class="px-4 py-3 font-mono text-gray-400">${time}</td>
    <td class="px-4 py-3 font-mono font-bold text-white truncate max-w-[150px]" title="${l.requestedModel}">${l.requestedModel || '-'}</td>
    <td class="px-4 py-3 font-mono text-gray-300 truncate max-w-[200px]" title="${l.routedModel || '-'}">
      <span class="text-brand-400">[${l.routedProvider || '-'}]</span> ${l.routedModel || '-'}
    </td>
    <td class="px-4 py-3">${statusBadge}</td>
    <td class="px-4 py-3 font-mono text-amber-400">${l.latencyMs}ms</td>
    <td class="px-4 py-3 font-mono text-gray-400">${l.totalTokens || l.tokens || 0}</td>
    <td class="px-4 py-3">${typeBadge}</td>
    <td class="px-4 py-3 text-right">
      <span class="px-2 py-1 bg-dark-card border border-dark-cardBorder rounded text-brand-400 group-hover:bg-brand-600 group-hover:text-white transition text-[10px]">
        <i class="fa-solid fa-eye mr-1"></i>Инспектор
      </span>
    </td>
  `;
  tbody.appendChild(tr);
}

async function loadLogs() {
  logsOffset = 0;
  try {
    const res = await fetch(`/api/logs?limit=${LOGS_PAGE_SIZE}&offset=0`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const raw = await res.json();
    const logs = Array.isArray(raw) ? raw : (raw?.logs || []);

    const tbody = document.getElementById('logs-table-body');
    tbody.innerHTML = '';

    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-gray-500 italic">Логов пока нет. Сделайте первый запрос!</td></tr>';
      document.getElementById('logs-load-more-wrap').classList.add('hidden');
      return;
    }

    logs.forEach((l) => renderLogRow(l, tbody));
    logsOffset = logs.length;

    // Show "load more" only if a full page was returned (there may be more)
    const wrap = document.getElementById('logs-load-more-wrap');
    if (logs.length >= LOGS_PAGE_SIZE) {
      wrap.classList.remove('hidden');
      document.getElementById('logs-load-more-label').textContent = `Загрузить ещё ${LOGS_PAGE_SIZE}`;
    } else {
      wrap.classList.add('hidden');
    }
  } catch (err) {
    showToast('Ошибка загрузки логов: ' + err.message, 'error');
  }
}

async function loadMoreLogs() {
  try {
    const btn = document.querySelector('#logs-load-more-wrap button');
    if (btn) btn.disabled = true;

    const res = await fetch(`/api/logs?limit=${LOGS_PAGE_SIZE}&offset=${logsOffset}`);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const raw = await res.json();
    const logs = Array.isArray(raw) ? raw : (raw?.logs || []);

    if (!logs || logs.length === 0) {
      document.getElementById('logs-load-more-wrap').classList.add('hidden');
      return;
    }

    const tbody = document.getElementById('logs-table-body');
    logs.forEach((l) => renderLogRow(l, tbody));
    logsOffset += logs.length;

    const wrap = document.getElementById('logs-load-more-wrap');
    if (logs.length >= LOGS_PAGE_SIZE) {
      wrap.classList.remove('hidden');
      document.getElementById('logs-load-more-label').textContent = `Загрузить ещё ${LOGS_PAGE_SIZE}`;
    } else {
      wrap.classList.add('hidden');
    }

    if (btn) btn.disabled = false;
  } catch (err) {
    showToast('Ошибка загрузки логов: ' + err.message, 'error');
  }
}

function openLogModal(log) {
  activeInspectorLog = log;
  const modal = document.getElementById('log-detail-modal');
  if (!modal) return;

  const statusEl = document.getElementById('modal-log-status');
  const titleEl = document.getElementById('modal-log-title');
  const subtitleEl = document.getElementById('modal-log-subtitle');

  const isOk = log.status === 'success' || log.status === 200 || log.statusCode === 200;
  const is999 = log.status === 999 || log.statusCode === 999;

  statusEl.className = isOk
    ? 'px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
    : is999
    ? 'px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40'
    : 'px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20';

  statusEl.innerText = isOk ? '200 OK' : is999 ? '💩 999 APKAKALSA' : `${log.statusCode || log.status || 'ERROR'}`;

  titleEl.innerText = `${log.requestedModel} → ${log.routedProvider || '-'}/${log.routedModel || '-'}`;
  subtitleEl.innerText = `ID: ${log.id} • ${new Date(log.timestamp).toLocaleString()} • ${log.latencyMs}ms • Аккаунт: ${log.accountName || '-'}`;

  const clientEl = document.getElementById('modal-log-client');
  const upstreamEl = document.getElementById('modal-log-upstream');
  const responseEl = document.getElementById('modal-log-response');

  clientEl.innerText = JSON.stringify(log.clientRequest || { model: log.requestedModel, note: 'Входящее тело не зафиксировано' }, null, 2);
  upstreamEl.innerText = JSON.stringify(log.upstreamRequest || { provider: log.routedProvider, targetModel: log.routedModel, account: log.accountName }, null, 2);
  responseEl.innerText = JSON.stringify(log.upstreamResponse || (log.error ? { error: log.error } : { note: 'Ответ пуст' }), null, 2);

  modal.classList.remove('hidden');
}

function closeLogModal() {
  const modal = document.getElementById('log-detail-modal');
  if (modal) modal.classList.add('hidden');
  activeInspectorLog = null;
}

function copyLogSection(sec) {
  if (!activeInspectorLog) return;
  let data = null;
  if (sec === 'client') data = activeInspectorLog.clientRequest;
  if (sec === 'upstream') data = activeInspectorLog.upstreamRequest;
  if (sec === 'response') data = activeInspectorLog.upstreamResponse || { error: activeInspectorLog.error };
  copyToClipboard(JSON.stringify(data || {}, null, 2));
}

async function clearAllLogs() {
  if (!confirm('Очистить историю всех логов?')) return;
  try {
    await fetch('/api/logs', { method: 'DELETE' });
    showToast('История логов очищена', 'info');
    loadLogs();
    loadStatus();
  } catch (err) {
    showToast('Ошибка очистки: ' + err.message, 'error');
  }
}

// ==========================================
// 🧪 5. Interactive Playground & Auto-Tester
// ==========================================
let playgroundMode = 'single';
let isAutoTestingRunning = false;
let stopAutoTestFlag = false;

function setPlaygroundMode(mode) {
  playgroundMode = mode;
  const singleBtn = document.getElementById('play-mode-single');
  const batchBtn = document.getElementById('play-mode-batch');
  const singleContainer = document.getElementById('playground-single-container');
  const batchContainer = document.getElementById('playground-batch-container');

  if (mode === 'single') {
    singleBtn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white shadow-sm transition';
    batchBtn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-gray-400 hover:text-white transition';
    singleContainer.classList.remove('hidden');
    batchContainer.classList.add('hidden');
  } else {
    singleBtn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-gray-400 hover:text-white transition';
    batchBtn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white shadow-sm transition';
    singleContainer.classList.add('hidden');
    batchContainer.classList.remove('hidden');
    initAutoTester();
  }
}

async function loadPlaygroundModels() {
  try {
    const res = await fetch('/v1/models');
    const data = await res.json();
    const select = document.getElementById('play-model');
    select.innerHTML = '';

    (data.data || []).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.innerText = m.id + (m.owned_by === 'kasrai' ? ' [Маршрут]' : ` [${m.owned_by}]`);
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

const PONOS_RANDOM_RIDDLES = [
  'Какун варит 3 поносика по 10 минут каждый в одной кастрюле. Сколько всего минут займет варка? Ответ кратко в 1 предложение.',
  'У пердуна было 5 килограммов поносика и 5 килограммов железа. Что из этого тяжелее и почему? Ответь в 1 предложение.',
  'Шёл пердун в деревню Поносики, а навстречу 3 какуна, у каждого по 2 мешка. Сколько существ шло в Поносики? Ответ кратко.',
  'В комнате горело 10 свечей, 3 свечи задул какун, а остальные догорели. Сколько свечей останется до утра?',
  'Электропоезд едет с севера на юг со скоростью 80 км/ч, ветер дует с запада. В какую сторону сдувает дым поезда?',
  'Кирпич весит 1 килограмм плюс полкирпича. Сколько весит целый кирпич? Реши по шагам кратко.',
];

function generateRandomPonosPrompt() {
  const promptInput = document.getElementById('autotest-prompt');
  if (!promptInput) return;
  const rand = PONOS_RANDOM_RIDDLES[Math.floor(Math.random() * PONOS_RANDOM_RIDDLES.length)];
  promptInput.value = rand;
  showToast('Случайный логический поносик заряжен в авто-тестер! 🎲💩', 'info', 2000);
}

function initAutoTester() {
  const provSelect = document.getElementById('autotest-provider-select');
  if (!provSelect) return;
  provSelect.innerHTML = '';

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.innerText = '🌐 Все подключенные провайдеры';
  provSelect.appendChild(optAll);

  cachedProviders.forEach(p => {
    if (p.enabled && Array.isArray(p.models) && p.models.length > 0) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.innerText = `${p.name} (${p.models.length} моделей)`;
      provSelect.appendChild(opt);
    }
  });

  // Default to antigravity if available
  if (cachedProviders.some(p => p.id === 'antigravity')) {
    provSelect.value = 'antigravity';
  }

  onAutotestProviderChange(provSelect.value);
}

function onAutotestProviderChange(providerId) {
  const grid = document.getElementById('autotest-grid');
  if (!grid) return;
  grid.innerHTML = '';

  let modelsList = [];
  if (providerId === 'all') {
    cachedProviders.forEach(p => {
      if (p.enabled && Array.isArray(p.models)) {
        p.models.forEach(m => modelsList.push({ providerId: p.id, modelId: m }));
      }
    });
  } else {
    const p = cachedProviders.find(x => x.id === providerId);
    if (p && Array.isArray(p.models)) {
      p.models.forEach(m => modelsList.push({ providerId: p.id, modelId: m }));
    }
  }

  const countEl = document.getElementById('autotest-summary-count');
  if (countEl) countEl.innerText = `Моделей: ${modelsList.length}`;

  document.getElementById('autotest-summary-ok').classList.add('hidden');
  document.getElementById('autotest-summary-err').classList.add('hidden');
  document.getElementById('autotest-summary-ping').classList.add('hidden');
  document.getElementById('autotest-summary-skipped').classList.add('hidden');
  document.getElementById('autotest-progress-bar-wrap').classList.add('hidden');

  // Load Strategy
  if (providerId !== 'all') {
    fetch(`/api/models/states/${providerId}`)
      .then(r => r.json())
      .then(data => {
        if (data.strategy) {
          const stratSelect = document.getElementById('autotest-strategy-select');
          if (stratSelect) stratSelect.value = data.strategy;
        }
        renderAutotestModelCards(modelsList, data.states || {});
      })
      .catch(() => renderAutotestModelCards(modelsList, {}));
  } else {
    renderAutotestModelCards(modelsList, {});
  }
}

function renderAutotestModelCards(modelsList, statesMap) {
  const grid = document.getElementById('autotest-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (modelsList.length === 0) {
    grid.innerHTML = '<div class="text-xs text-gray-500 italic py-6 text-center bg-dark-card border border-dark-cardBorder rounded-2xl">У выбранного провайдера нет моделей для теста. Нажмите "Чек моделей" во вкладке провайдеров!</div>';
    return;
  }

  modelsList.forEach(item => {
    const cleanSafeId = `autotest-card-${item.providerId}-${item.modelId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const card = document.createElement('div');
    const state = statesMap[item.modelId] || {};
    const isBroken = state.status === 'broken_404';

    card.id = cleanSafeId;
    card.className = `bg-dark-card border ${isBroken ? 'border-rose-900/40 opacity-75' : 'border-dark-cardBorder hover:border-dark-cardBorder/80'} rounded-xl p-3.5 text-xs transition-all space-y-2`;
    if (isBroken) card.dataset.broken = 'true';

    let initialBadge = '<span class="model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-dark-input text-gray-400 border border-dark-cardBorder">Ожидание...</span>';
    if (isBroken) {
      initialBadge = '<span class="model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/20 text-rose-300 border border-rose-500/30 font-bold">🚫 Нерабочее (404)</span>';
    } else if (state.status === 'active' && state.successCalls > 0) {
      initialBadge = `<span class="model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">🟢 OK (${state.lastLatencyMs || 0}ms)</span>`;
    }

    const priorityBadge = `<span class="model-prio-badge px-1.5 py-0.5 rounded text-[10px] font-mono bg-dark-input ${isBroken ? 'text-gray-500' : 'text-brand-400'} border border-dark-cardBorder">P:${isBroken ? 0 : (state.effectivePriority || 50)}</span>`;

    card.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2 truncate mr-3">
          <span class="px-2 py-0.5 rounded bg-dark-input font-mono text-[10px] text-brand-400 border border-dark-cardBorder">[${item.providerId}]</span>
          <span class="font-mono font-bold text-gray-200 truncate" title="${item.modelId}">${item.modelId}</span>
          ${priorityBadge}
        </div>
        <div class="flex items-center space-x-2 flex-shrink-0">
          ${initialBadge}
          <button onclick="testSingleModel('${item.providerId}', '${item.modelId}', this)" title="Протестировать эту модель" class="px-2.5 py-1 rounded-lg bg-dark-input hover:bg-dark-cardBorder border border-dark-cardBorder text-gray-200 font-medium transition flex items-center space-x-1">
            <i class="fa-solid fa-play text-[10px] text-brand-400"></i>
            <span>Тест</span>
          </button>
        </div>
      </div>
      <div class="model-preview-box ${state.lastError ? '' : 'hidden'} text-[11px] font-mono bg-dark-input p-2.5 rounded-lg border border-dark-cardBorder max-h-32 overflow-y-auto whitespace-pre-wrap selection:bg-brand-500 text-rose-300">
        ${state.lastError ? escapeHtml(state.lastError) : ''}
      </div>
    `;

    grid.appendChild(card);
  });
}

async function testSingleModel(providerId, modelId, btn = null) {
  const cleanSafeId = `autotest-card-${providerId}-${modelId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const cardEl = document.getElementById(cleanSafeId);
  const statusBadge = cardEl ? cardEl.querySelector('.model-status-badge') : null;
  const prioBadge = cardEl ? cardEl.querySelector('.model-prio-badge') : null;
  const previewBox = cardEl ? cardEl.querySelector('.model-preview-box') : null;
  const prompt = document.getElementById('autotest-prompt').value.trim() || 'Скажи тест';

  if (statusBadge) {
    statusBadge.className = 'model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-indigo-500/10 text-indigo-400 border border-indigo-500/20';
    statusBadge.innerHTML = '<i class="fa-solid fa-spinner animate-spin mr-1"></i>Тест...';
  }
  if (btn) btn.disabled = true;

  const targetModel = `${providerId}/${modelId}`;
  const start = Date.now();

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
    });

    const latency = Date.now() - start;

    if (res.status === 999) {
      if (statusBadge) {
        statusBadge.className = 'model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold';
        statusBadge.innerText = '💩 999 APKAKALSA';
      }
      if (previewBox) {
        previewBox.classList.remove('hidden');
        previewBox.innerHTML = '<span class="text-purple-300 font-bold">Zero-Token Guard: модель вернула 0 токенов (APKAKALSA PEDIK)</span>';
      }
      await recordTestResult(providerId, modelId, { ok: false, status: 999, latency });
      return { ok: false, status: 999, latency };
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errText = errData.error?.message || `HTTP ${res.status}`;
      const is404 = res.status === 404 || errText.includes('404') || errText.toLowerCase().includes('not found') || errText.toLowerCase().includes('does not exist');

      if (statusBadge) {
        statusBadge.className = is404
          ? 'model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/20 text-rose-300 border border-rose-500/30 font-bold'
          : 'model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/20';
        statusBadge.innerText = is404 ? '🚫 Нерабочее (404)' : `🔴 Ошибка (${res.status})`;
      }
      if (cardEl && is404) {
        cardEl.dataset.broken = 'true';
        cardEl.className = 'bg-dark-card border border-rose-900/40 opacity-75 rounded-xl p-3.5 text-xs transition-all space-y-2';
        if (prioBadge) {
          prioBadge.innerText = 'P:0';
          prioBadge.className = 'model-prio-badge px-1.5 py-0.5 rounded text-[10px] font-mono bg-dark-input text-gray-500 border border-dark-cardBorder';
        }
      }
      if (previewBox) {
        previewBox.classList.remove('hidden');
        previewBox.innerHTML = `<span class="text-rose-400">${escapeHtml(errText)}</span>`;
      }
      const updatedState = await recordTestResult(providerId, modelId, { ok: false, status: res.status, error: errText, latency });
      if (prioBadge && updatedState) {
        prioBadge.innerText = `P:${updatedState.effectivePriority || 0}`;
      }
      return { ok: false, status: res.status, is404, error: errText, latency };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || (data.choices?.[0]?.message?.tool_calls ? '🛠️ Вызов инструмента' : '[Пустой ответ]');

    // If it was marked as broken before, auto-unmark!
    if (cardEl) {
      delete cardEl.dataset.broken;
      cardEl.className = 'bg-dark-card border border-dark-cardBorder hover:border-dark-cardBorder/80 rounded-xl p-3.5 text-xs transition-all space-y-2';
    }

    if (statusBadge) {
      statusBadge.className = 'model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold';
      statusBadge.innerText = `🟢 200 OK (${latency}ms)`;
    }
    if (previewBox) {
      previewBox.classList.remove('hidden');
      previewBox.innerHTML = `<span class="text-gray-300">${escapeHtml(content)}</span>`;
    }

    const updatedState = await recordTestResult(providerId, modelId, { ok: true, status: 200, latency, tokens: data.usage?.total_tokens || 0 });
    if (prioBadge && updatedState) {
      prioBadge.innerText = `P:${updatedState.effectivePriority || 50}`;
      prioBadge.className = 'model-prio-badge px-1.5 py-0.5 rounded text-[10px] font-mono bg-dark-input text-brand-400 border border-dark-cardBorder';
    }

    return { ok: true, status: 200, latency, tokens: data.usage?.total_tokens || 0 };
  } catch (err) {
    const latency = Date.now() - start;
    if (statusBadge) {
      statusBadge.className = 'model-status-badge px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/20';
      statusBadge.innerText = '🔴 Network Error';
    }
    if (previewBox) {
      previewBox.classList.remove('hidden');
      previewBox.innerHTML = `<span class="text-rose-400">${escapeHtml(err.message)}</span>`;
    }
    await recordTestResult(providerId, modelId, { ok: false, error: err.message, latency });
    return { ok: false, error: err.message, latency };
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function recordTestResult(providerId, modelId, result) {
  try {
    const res = await fetch('/api/models/test-record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, modelId, result }),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function clearBrokenModelsNow() {
  const provSelect = document.getElementById('autotest-provider-select');
  const providerId = provSelect ? provSelect.value : 'antigravity';
  if (providerId === 'all') {
    showToast('Выберите конкретного провайдера для снятия флага', 'warning');
    return;
  }

  try {
    const res = await fetch(`/api/models/clear-broken/${providerId}`, { method: 'POST' });
    const data = await res.json();
    showToast(`✨ ${data.message || 'Флаги нерабочих моделей сняты'}`, 'success');
    onAutotestProviderChange(providerId);
  } catch (err) {
    showToast('Ошибка снятия флагов: ' + err.message, 'error');
  }
}

async function onStrategyChange(strategy) {
  const provSelect = document.getElementById('autotest-provider-select');
  const providerId = provSelect ? provSelect.value : 'antigravity';
  if (providerId === 'all') return;

  try {
    await fetch(`/api/models/strategy/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy }),
    });
    showToast(`🎯 Стратегия "${strategy}" применена к провайдеру ${providerId}!`, 'info');
    onAutotestProviderChange(providerId);
  } catch (err) {
    showToast('Ошибка смены стратегии: ' + err.message, 'error');
  }
}

async function runBatchAutoTest() {
  if (isAutoTestingRunning) return;
  isAutoTestingRunning = true;
  stopAutoTestFlag = false;

  const runBtn = document.getElementById('autotest-run-btn');
  const stopBtn = document.getElementById('autotest-stop-btn');
  const progressWrap = document.getElementById('autotest-progress-bar-wrap');
  const progressBar = document.getElementById('autotest-progress-bar');
  const okBadge = document.getElementById('autotest-summary-ok');
  const errBadge = document.getElementById('autotest-summary-err');
  const pingBadge = document.getElementById('autotest-summary-ping');

  runBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';

  okBadge.classList.remove('hidden');
  errBadge.classList.remove('hidden');
  pingBadge.classList.remove('hidden');

  let okCount = 0;
  let errCount = 0;
  let totalLatency = 0;

  const grid = document.getElementById('autotest-grid');
  const cards = Array.from(grid.querySelectorAll('div[id^="autotest-card-"]'));
  const total = cards.length;

  for (let i = 0; i < total; i++) {
    if (stopAutoTestFlag) {
      showToast('Авто-тестирование остановлено пользователем', 'warning');
      break;
    }

    const card = cards[i];
    // Skip models already marked as broken_404 during mass run
    if (card.dataset.broken === 'true') {
      continue;
    }

    const testBtn = card.querySelector('button');
    const parts = card.id.replace('autotest-card-', '').split('-');
    const providerId = parts[0];
    const modelId = parts.slice(1).join('-');

    const modelName = card.querySelector('.font-bold').innerText;

    const result = await testSingleModel(providerId, modelName, testBtn);
    if (result.ok) {
      okCount++;
    } else {
      errCount++;
    }
    totalLatency += result.latency || 0;

    const percent = Math.round(((i + 1) / total) * 100);
    progressBar.style.width = `${percent}%`;

    okBadge.innerText = `🟢 ${okCount} OK`;
    errBadge.innerText = `🔴 ${errCount} Ошибок`;
    const avgPing = Math.round(totalLatency / (okCount + errCount || 1));
    pingBadge.innerText = `⏱️ ${avgPing}ms`;
  }

  isAutoTestingRunning = false;
  runBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  showToast(`🏁 Авто-тест завершен!\n• Успешно: ${okCount}\n• Ошибок: ${errCount}`, okCount > 0 ? 'success' : 'warning');
}

function stopBatchAutoTest() {
  stopAutoTestFlag = true;
}

function onSelectPreset(val) {
  applyPlaygroundPreset(val);
}

function applyPlaygroundPreset(preset) {
  const promptEl = document.getElementById('play-prompt');
  const sysEl = document.getElementById('play-system');
  const toolCheck = document.getElementById('play-tools');
  const modelSelect = document.getElementById('play-model');

  if (preset === 'hello') {
    promptEl.value = 'Привет! Расскажи о себе кратко: кто ты и что умеешь?';
    sysEl.value = 'Ты дружелюбный и компактный ИИ-ассистент.';
    if (toolCheck) toolCheck.checked = false;
  } else if (preset === 'math') {
    promptEl.value = 'Сколько секунд в одном високосном году? Реши по шагам с объяснением.';
    sysEl.value = 'Отвечай структурированно и точно.';
    if (toolCheck) toolCheck.checked = false;
  } else if (preset === 'tool') {
    promptEl.value = 'Какая сейчас погода в Москве?';
    sysEl.value = 'Используй доступные функции для ответа на запросы.';
    if (toolCheck) toolCheck.checked = true;
    if (modelSelect) {
      for (let i = 0; i < modelSelect.options.length; i++) {
        if (modelSelect.options[i].value.includes('gemini-3.8-flash')) {
          modelSelect.selectedIndex = i;
          break;
        }
      }
    }
  } else if (preset === 'code') {
    promptEl.value = 'Напиши компактный Python-скрипт для пинга списка серверов с замером задержки.';
    sysEl.value = 'Ты опытный senior Python разработчик.';
    if (toolCheck) toolCheck.checked = false;
  }
}

async function runPlaygroundTest() {
  const model = document.getElementById('play-model').value;
  const system = document.getElementById('play-system').value.trim();
  const prompt = document.getElementById('play-prompt').value.trim();
  const stream = document.getElementById('play-stream').checked;
  const useTools = document.getElementById('play-tools')?.checked || false;

  if (!prompt) {
    showToast('Введите текст сообщения в поле ввода', 'warning');
    return;
  }

  const outputEl = document.getElementById('play-output');
  const statusEl = document.getElementById('play-status');
  const statsEl = document.getElementById('play-stats');
  const btn = document.getElementById('play-submit-btn');

  outputEl.innerHTML = '';
  statusEl.innerText = 'Отправка...';
  statsEl.classList.add('hidden');
  btn.disabled = true;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const payload = { model, messages, stream };

  // Attach mock tool if enabled
  if (useTools) {
    payload.tools = [
      {
        type: 'function',
        function: {
          name: 'get_current_weather',
          description: 'Получить текущую погоду для указанного города',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'Город (например Москва, Париж)' },
            },
            required: ['location'],
          },
        },
      },
    ];
  }

  const startTime = Date.now();

  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 999) {
      const errJson = await res.json().catch(() => ({}));
      outputEl.innerHTML = `<div class="p-3 bg-purple-950/40 border border-purple-500/40 rounded-xl text-purple-300 font-bold">💩 999 ERROR: ${errJson.error?.message || 'APKAKALSA PEDIK'}<br><span class="text-xs font-normal">Модель вернула 0 токенов (Zero-Token Guard)!</span></div>`;
      statusEl.innerText = 'APKAKALSA PEDIK (999)';
      return;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `HTTP ${res.status}`);
    }

    if (!stream) {
      const data = await res.json();
      const choice = data.choices?.[0];
      const message = choice?.message;
      const latency = Date.now() - startTime;

      let html = '';
      if (message?.tool_calls && message.tool_calls.length > 0) {
        message.tool_calls.forEach(tc => {
          html += `
            <div class="mb-3 p-3 bg-indigo-950/40 border border-brand-500/40 rounded-xl text-xs">
              <div class="flex items-center space-x-2 text-brand-300 font-bold mb-1">
                <i class="fa-solid fa-wrench"></i>
                <span>Вызов инструмента: ${tc.function.name}</span>
                <span class="text-[10px] text-gray-500 font-mono">(${tc.id})</span>
              </div>
              <pre class="bg-dark-input/80 p-2 rounded-lg text-emerald-400 overflow-x-auto">${tc.function.arguments}</pre>
            </div>
          `;
        });
      }

      if (message?.content) {
        html += `<div>${escapeHtml(message.content)}</div>`;
      } else if (!message?.tool_calls) {
        html += '<span class="text-gray-500 italic">[Пустой ответ]</span>';
      }

      outputEl.innerHTML = html;
      statusEl.innerText = '200 OK';

      statsEl.innerText = `⏱️ ${latency}ms | 🪙 ${data.usage?.total_tokens || '-'} токенов`;
      statsEl.classList.remove('hidden');
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let streamedToolCalls = [];
      let textBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.includes('APKAKALSA PEDIK')) {
            outputEl.innerHTML = `<div class="p-3 bg-purple-950/40 border border-purple-500/40 rounded-xl text-purple-300 font-bold">💩 999 ERROR: APKAKALSA PEDIK (0 tokens streamed)</div>`;
            statusEl.innerText = 'APKAKALSA PEDIK (999)';
            return;
          }
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const chunkStr = trimmed.slice(6);
          if (chunkStr === '[DONE]') continue;

          try {
            const parsed = JSON.parse(chunkStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              textBuffer += delta.content;
              updatePlaygroundStreamingView(outputEl, streamedToolCalls, textBuffer);
            }
            if (delta?.tool_calls) {
              delta.tool_calls.forEach(tc => {
                streamedToolCalls.push(tc);
              });
              updatePlaygroundStreamingView(outputEl, streamedToolCalls, textBuffer);
            }
          } catch {}
        }
      }

      const latency = Date.now() - startTime;
      statusEl.innerText = 'Стрим завершен';
      statsEl.innerText = `⏱️ ${latency}ms (SSE)`;
      statsEl.classList.remove('hidden');
    }
  } catch (err) {
    outputEl.innerHTML = `<div class="text-rose-400"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Ошибка: ${escapeHtml(err.message)}</div>`;
    statusEl.innerText = 'Ошибка выполнения';
  } finally {
    btn.disabled = false;
  }
}

function updatePlaygroundStreamingView(container, toolCalls, text) {
  let html = '';
  if (toolCalls && toolCalls.length > 0) {
    toolCalls.forEach(tc => {
      html += `
        <div class="mb-3 p-3 bg-indigo-950/40 border border-brand-500/40 rounded-xl text-xs">
          <div class="flex items-center space-x-2 text-brand-300 font-bold mb-1">
            <i class="fa-solid fa-wrench"></i>
            <span>Вызов инструмента: ${tc.function?.name || 'function'}</span>
          </div>
          <pre class="bg-dark-input/80 p-2 rounded-lg text-emerald-400 overflow-x-auto">${escapeHtml(tc.function?.arguments || '{}')}</pre>
        </div>
      `;
    });
  }
  if (text) {
    html += `<div>${escapeHtml(text)}</div>`;
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// 🛡️ Gateway Auth Modal & Settings
// ==========================================
async function openAuthKeyModal() {
  try {
    const res = await fetch('/api/auth/config');
    const data = await res.json();
    const toggle = document.getElementById('auth-toggle-require');
    const keyInput = document.getElementById('auth-current-key');
    const details = document.getElementById('auth-key-details');

    if (toggle) toggle.checked = data.requireApiKey;
    if (keyInput) keyInput.value = data.hasKey ? (data.maskedKey || 'kasrai-••••••••••••') : 'Ключ не создан';
    if (details) details.style.opacity = data.requireApiKey ? '1' : '0.6';

    document.getElementById('auth-key-modal').classList.remove('hidden');
  } catch (err) {
    showToast('Ошибка загрузки настроек авторизации: ' + err.message, 'error');
  }
}

function closeAuthKeyModal() {
  const modal = document.getElementById('auth-key-modal');
  if (modal) modal.classList.add('hidden');
}

async function onToggleRequireAuth(checked) {
  try {
    const res = await fetch('/api/auth/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireApiKey: checked }),
    });
    const data = await res.json();
    updateAuthHeaderBadge(data);
    showToast(checked ? '🔒 Шлюз закрыт на API-ключ!' : '🔓 Шлюз открыт для всех локальных клиентов!', checked ? 'warning' : 'info');
    openAuthKeyModal();
  } catch (err) {
    showToast('Ошибка переключения защиты: ' + err.message, 'error');
  }
}

async function generateNewGatewayKey() {
  try {
    const res = await fetch('/api/auth/generate-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    const keyInput = document.getElementById('auth-current-key');
    if (keyInput) keyInput.value = data.key;
    updateAuthHeaderBadge(data.config);
    showToast(`🔑 Сгенерирован новый API-ключ!\nСкопируйте его: ${data.key}`, 'success', 6000);
  } catch (err) {
    showToast('Ошибка генерации ключа: ' + err.message, 'error');
  }
}

async function loadAuthHeaderState() {
  try {
    const res = await fetch('/api/auth/config');
    const data = await res.json();
    updateAuthHeaderBadge(data);
  } catch {}
}

function updateAuthHeaderBadge(conf) {
  const btn = document.getElementById('header-auth-btn');
  const icon = document.getElementById('header-auth-icon');
  const label = document.getElementById('header-auth-label');
  if (!btn || !icon || !label) return;

  if (conf.requireApiKey) {
    icon.className = 'fa-solid fa-lock text-amber-400';
    label.innerText = 'API: Защищен';
    btn.className = 'px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 transition flex items-center space-x-1.5 font-mono';
  } else {
    icon.className = 'fa-solid fa-lock-open text-emerald-400';
    label.innerText = 'API: Открытый';
    btn.className = 'px-2.5 py-1 rounded-lg bg-dark-input hover:bg-dark-cardBorder border border-dark-cardBorder text-gray-300 transition flex items-center space-x-1.5 font-mono';
  }
}

// Git Updater Check
async function loadGitStatus() {
  try {
    const res = await fetch('/api/git/status');
    const data = await res.json();
    const btnText = document.getElementById('header-git-commit');
    if (btnText && data.currentCommit) {
      btnText.innerText = `git:${data.currentCommit}`;
      if (data.hasUpdate) {
        btnText.innerHTML = `git:${data.currentCommit} <span class="text-amber-400 font-bold">▲ New</span>`;
      }
    }
  } catch {}
}

async function checkGitUpdateNow(btn = null) {
  const originalHtml = btn ? btn.innerHTML : null;
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-brand-400"></i>';
  try {
    showToast('Проверка обновлений в Git репозитории...', 'info');
    const res = await fetch('/api/git/check', { method: 'POST' });
    const data = await res.json();
    if (data.hasUpdate) {
      if (data.requiresFullRestart) {
        showToast(`🚀 Загружен коммит ${data.newCommit}!\nВ коммите найден тег "REQUIRED FULL RESTART" — перезапуск сервера...`, 'warning', 6000);
      } else {
        showToast(`⚡ Успешно обновлено до ${data.newCommit}!\nБезопасный рефреш применен на лету без перезапуска!`, 'success', 5000);
      }
      loadStatus();
      loadProviders();
    } else if (data.ok) {
      showToast(`Версия актуальна (${data.currentCommit})`, 'info', 2000);
    } else {
      showToast(data.error || 'Ошибка проверки git', 'warning');
    }
    loadGitStatus();
  } catch (err) {
    showToast('Ошибка апдейтера: ' + err.message, 'error');
  } finally {
    if (btn && originalHtml) btn.innerHTML = originalHtml;
  }
}

// ==========================================
// 🚀 Initialization
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadGitStatus();
  loadAuthHeaderState();
  startLiveCooldownTicker();
});
