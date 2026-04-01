function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

const authSection = document.getElementById('authSection');
const dashboardSection = document.getElementById('dashboardSection');
const loginTab = document.getElementById('loginTab');
const registerTab = document.getElementById('registerTab');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const logoutBtn = document.getElementById('logoutBtn');
const authMessage = document.getElementById('authMessage');
const settingsMessage = document.getElementById('settingsMessage');

const state = { token: null };

function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(path, { ...options, headers }).then(async res => {
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || res.statusText || 'Request failed');
    return json;
  });
}

function setToken(token) {
  state.token = token;
  if (token) {
    localStorage.setItem('polybot_token', token);
    logoutBtn.classList.remove('hidden');
    authSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    loadDashboard();
  } else {
    localStorage.removeItem('polybot_token');
    logoutBtn.classList.add('hidden');
    authSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');
  }
}

function showMessage(element, message, isError = true) {
  element.textContent = message;
  element.style.color = isError ? 'var(--danger)' : 'var(--success)';
}

function clearMessages() {
  authMessage.textContent = '';
  settingsMessage.textContent = '';
}

function toggleTabs() {
  loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    registerTab.classList.remove('active');
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    clearMessages();
  });

  registerTab.addEventListener('click', () => {
    registerTab.classList.add('active');
    loginTab.classList.remove('active');
    registerForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
    clearMessages();
  });
}

async function login() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  if (!email || !password) return showMessage(authMessage, 'Email and password are required.');
  try {
    const result = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setToken(result.token);
  } catch (err) {
    showMessage(authMessage, err.message || 'Login failed');
  }
}

async function register() {
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value.trim();
  if (!email || !password) return showMessage(authMessage, 'Email and password are required.');
  try {
    const result = await apiFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
    setToken(result.token);
  } catch (err) {
    showMessage(authMessage, err.message || 'Registration failed');
  }
}

async function loadDashboard() {
  clearMessages();
  try {
    const [status, stats, logs, trades, settings] = await Promise.all([
      apiFetch('/api/bot/status'),
      apiFetch('/api/user/stats'),
      apiFetch('/api/bot/logs?limit=10'),
      apiFetch('/api/trades?limit=10'),
      apiFetch('/api/user/settings')
    ]);

    document.getElementById('botStatus').textContent = status.is_running ? 'Running' : 'Stopped';
    document.getElementById('marketCount').textContent = status.activeMarkets || 0;
    document.getElementById('dailyPnl').textContent = `$${status.daily_pnl?.toFixed(2) || 0}`;
    document.getElementById('maxLoss').textContent = `$${status.max_daily_loss?.toFixed(2) || '—'}`;

    document.getElementById('totalTrades').textContent = stats.total_trades ?? 0;
    document.getElementById('winRate').textContent = `${stats.win_rate ?? 0}%`;
    document.getElementById('totalPnl').textContent = `$${stats.total_pnl?.toFixed(2) ?? 0}`;
    document.getElementById('dailyPnlStats').textContent = `$${stats.daily_pnl?.toFixed(2) ?? 0}`;
    document.getElementById('roi').textContent = `${stats.roi ?? 0}%`;

    const logsList = document.getElementById('logsList');
    logsList.innerHTML = logs.length ? logs.map(log => `<div class="log-item"><strong>${escapeHtml(log.level)}</strong><span>${new Date(log.created_at).toLocaleString()}</span><div>${escapeHtml(log.message)}</div></div>`).join('') : '<div class="log-item">No logs found.</div>';

    const tradesBody = document.getElementById('tradesBody');
    tradesBody.innerHTML = trades.trades.length ? trades.trades.map(trade => `
      <tr>
        <td>${new Date(trade.created_at).toLocaleString()}</td>
        <td>${trade.direction || '—'}</td>
        <td>${trade.result || 'PENDING'}</td>
        <td>${trade.pnl != null ? `$${trade.pnl.toFixed(2)}` : '—'}</td>
      </tr>
    `).join('') : '<tr><td colspan="4">No recent trades.</td></tr>';

    document.getElementById('settingsKey').value = '';
    document.getElementById('settingsMaxLoss').value = settings.max_daily_loss ?? '';
    document.getElementById('settingsPaperTrading').value = settings.paper_trading !== false ? 'true' : 'false';
  } catch (err) {
    console.error(err);
    showMessage(authMessage, 'Failed to load dashboard. Please login again.');
    setToken(null);
  }
}

async function startBot() {
  try {
    await apiFetch('/api/bot/start', { method: 'POST' });
    showMessage(settingsMessage, 'Bot started successfully.', false);
    loadDashboard();
  } catch (err) {
    showMessage(settingsMessage, err.message || 'Failed to start bot');
  }
}

async function stopBot() {
  try {
    await apiFetch('/api/bot/stop', { method: 'POST' });
    showMessage(settingsMessage, 'Bot stopped.', false);
    loadDashboard();
  } catch (err) {
    showMessage(settingsMessage, err.message || 'Failed to stop bot');
  }
}

async function saveSettings() {
  const private_key = document.getElementById('settingsKey').value.trim();
  const max_daily_loss = parseFloat(document.getElementById('settingsMaxLoss').value) || null;
  const paper_trading = document.getElementById('settingsPaperTrading').value === 'true';

  try {
    await apiFetch('/api/user/settings', {
      method: 'PUT',
      body: JSON.stringify({ private_key: private_key || undefined, max_daily_loss, paper_trading })
    });
    showMessage(settingsMessage, 'Settings saved.', false);
    loadDashboard();
  } catch (err) {
    showMessage(settingsMessage, err.message || 'Failed to save settings');
  }
}

function logout() {
  setToken(null);
}

function init() {
  toggleTabs();

  document.getElementById('loginBtn').addEventListener('click', login);
  document.getElementById('registerBtn').addEventListener('click', register);
  document.getElementById('startBotBtn').addEventListener('click', startBot);
  document.getElementById('stopBotBtn').addEventListener('click', stopBot);
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  logoutBtn.addEventListener('click', logout);

  const storedToken = localStorage.getItem('polybot_token');
  if (storedToken) {
    setToken(storedToken);
  }
}

window.addEventListener('DOMContentLoaded', init);
