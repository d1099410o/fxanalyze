const $ = id => document.getElementById(id);

const safeStorage = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage may be disabled */ }
  },
};

const state = {
  pair: safeStorage.get('fx-pair', 'EUR/USD'),
  timeframe: safeStorage.get('fx-timeframe', '5m'),
  mode: safeStorage.get('fx-mode', 'demo'),
  liveConfigured: false,
  providerStatus: null,
  refreshTimer: null,
  lastNotified: '',
  deferredInstall: null,
  currentChart: [],
  requestId: 0,
  controller: null,
  lastSuccessfulFetch: 0,
};

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const digits = Math.abs(Number(value)) >= 100 ? 3 : 5;
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function setModeBanner(mode) {
  const isDemo = mode === 'demo';
  $('demoBanner').classList.toggle('hidden', !isDemo);
  $('dataLabel').textContent = isDemo ? 'DANE SYNTETYCZNE' : 'DANE LIVE';
  $('dataLabel').style.color = isDemo ? '#f1be67' : '#52d6d0';
  $('marketState').textContent = isDemo ? 'Tryb demonstracyjny · bez sygnałów transakcyjnych' : 'Oczekiwanie na aktualne notowania';
}

function showError(message) {
  $('errorBanner').textContent = message;
  $('errorBanner').classList.remove('hidden');
}

function clearError() {
  $('errorBanner').classList.add('hidden');
  $('errorBanner').textContent = '';
}

function setBusy(busy) {
  $('refreshBtn').disabled = busy;
  $('refreshBtn').innerHTML = busy ? '<span>◌</span> Analizuję…' : '<span>↻</span> Analizuj';
  $('refreshBtn').setAttribute('aria-busy', String(busy));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]);
}

function resetSignalView(message = 'Brak aktualnego odczytu. Oczekiwanie na poprawne dane.') {
  $('signalOrb').className = 'signal-orb wait';
  $('signalAction').textContent = 'WAIT';
  $('confidenceValue').textContent = '—/100';
  $('confidenceBar').style.width = '0%';
  $('signalSummary').textContent = message;
  for (const id of ['lastPrice', 'candleTime', 'entryPrice', 'stopPrice', 'targetPrice', 'stopPips', 'targetPips',
    'rsiValue', 'adxValue', 'emaFastValue', 'emaSlowValue', 'macdValue']) $(id).textContent = '—';
  for (const id of ['rsiState', 'adxState', 'emaFastState', 'emaSlowState', 'macdState']) $(id).textContent = '—';
  for (const id of ['mtf5', 'mtf15', 'mtf30']) {
    $(id).textContent = 'NEUTRAL';
    $(id).className = 'neutral';
  }
  $('mtfSummary').textContent = 'Brak danych do porównania interwałów.';
  $('reasonsList').innerHTML = '<li>Nie wykonano aktualnej analizy.</li>';
  $('updatedAt').textContent = 'BRAK AKTUALNEGO ODCZYTU';
  $('riskTag').textContent = 'RR —';
  state.currentChart = [];
  drawChart(state.currentChart);
}

function updateSignal(signal) {
  const orb = $('signalOrb');
  orb.className = `signal-orb ${signal.action.toLowerCase()}`;
  $('signalAction').textContent = signal.action;
  $('confidenceValue').textContent = `${signal.setupScore}/100`;
  $('confidenceBar').style.width = `${Math.max(0, Math.min(100, signal.setupScore))}%`;

  if (signal.dataMode === 'demo') {
    const candidate = signal.candidateAction && signal.candidateAction !== 'WAIT'
      ? ` Hipotetyczny układ ${signal.candidateAction} jest widoczny wyłącznie do testowania.`
      : ' Nie wykryto układu spełniającego kryteria.';
    $('signalSummary').textContent = `DEMO — dane syntetyczne. Aplikacja nie wystawia sygnałów transakcyjnych.${candidate}`;
  } else if (signal.stale) {
    $('signalSummary').textContent = 'Dane są nieaktualne. Sygnał został zablokowany do czasu otrzymania świeżych notowań.';
  } else {
    $('signalSummary').textContent = signal.action === 'WAIT'
      ? 'Brak przewagi spełniającej wszystkie kryteria. Poczekaj na czytelniejszy układ.'
      : signal.action === 'BUY'
        ? 'Warunki strategii wskazują przewagę wzrostową. Zweryfikuj spread i warunki brokera.'
        : 'Warunki strategii wskazują przewagę spadkową. Zweryfikuj spread i warunki brokera.';
  }

  $('selectedPairTitle').textContent = `${signal.symbol} · ${signal.timeframe}`;
  $('lastPrice').textContent = formatPrice(signal.price);
  $('candleTime').textContent = formatTime(signal.candleTime);
  $('entryPrice').textContent = formatPrice(signal.entry);
  $('stopPrice').textContent = formatPrice(signal.stopLoss);
  $('targetPrice').textContent = formatPrice(signal.takeProfit);
  $('stopPips').textContent = signal.stopPips == null ? '—' : `${signal.stopPips} pips`;
  $('targetPips').textContent = signal.targetPips == null ? '—' : `${signal.targetPips} pips`;
  $('riskTag').textContent = signal.riskReward ? `RR ${signal.riskReward}` : 'RR CEL 1:1.6';

  const indicators = signal.indicators || {};
  $('rsiValue').textContent = Number.isFinite(indicators.rsi) ? indicators.rsi.toFixed(1) : '—';
  $('rsiState').textContent = indicators.rsi >= 70 ? 'wykupienie' : indicators.rsi <= 30 ? 'wyprzedanie' : 'strefa neutralna';
  $('adxValue').textContent = Number.isFinite(indicators.adx) ? indicators.adx.toFixed(1) : '—';
  $('adxState').textContent = indicators.adx >= 25 ? 'silniejszy trend' : 'słaby trend';
  $('emaFastValue').textContent = `${formatPrice(indicators.ema9)} / ${formatPrice(indicators.ema21)}`;
  $('emaFastState').textContent = indicators.ema9 > indicators.ema21 ? 'układ wzrostowy' : indicators.ema9 < indicators.ema21 ? 'układ spadkowy' : 'bez przewagi';
  $('emaSlowValue').textContent = formatPrice(indicators.ema50);
  $('emaSlowState').textContent = signal.price > indicators.ema50 ? 'cena powyżej EMA' : 'cena poniżej EMA';
  $('macdValue').textContent = Number.isFinite(indicators.macdHistogram) ? indicators.macdHistogram.toPrecision(4) : '—';
  $('macdState').textContent = indicators.macdHistogram > 0 ? 'momentum dodatnie' : indicators.macdHistogram < 0 ? 'momentum ujemne' : 'bez przewagi';

  for (const [timeframe, id] of [['5m', 'mtf5'], ['15m', 'mtf15'], ['30m', 'mtf30']]) {
    const value = signal.mtf?.[timeframe] || 'NEUTRAL';
    $(id).textContent = value;
    $(id).className = value === 'BULLISH' ? 'bullish' : value === 'BEARISH' ? 'bearish' : 'neutral';
  }
  const biases = Object.values(signal.mtf || {});
  const bullCount = biases.filter(value => value === 'BULLISH').length;
  const bearCount = biases.filter(value => value === 'BEARISH').length;
  $('mtfSummary').textContent = `${bullCount} z 3 interwałów wskazuje wzrosty, ${bearCount} z 3 wskazuje spadki. ${bullCount >= 2 || bearCount >= 2 ? 'Występuje dominujący kierunek.' : 'Brak wspólnego kierunku.'}`;
  $('reasonsList').innerHTML = (signal.reasons || []).map(reason => `<li>${escapeHtml(reason)}</li>`).join('');
  $('updatedAt').textContent = `AKTUALIZACJA ${formatTime(signal.serverTime)}`;

  state.currentChart = Array.isArray(signal.chart) ? signal.chart : [];
  drawChart(state.currentChart);
  $('marketState').textContent = signal.dataMode === 'demo'
    ? 'Dane syntetyczne · brak handlu'
    : signal.stale ? 'Dane LIVE · opóźnione' : `Dane LIVE · wiek świecy ${signal.dataAgeSeconds ?? '—'} s`;

  const alertKey = `${signal.symbol}:${signal.timeframe}:${signal.action}:${signal.candleTime}`;
  if (signal.tradeEligible && typeof Notification !== 'undefined'
      && Notification.permission === 'granted' && state.lastNotified !== alertKey) {
    try {
      new Notification(`FX Pulse · ${signal.action}`, {
        body: `${signal.symbol} (${signal.timeframe}) · ocena układu ${signal.setupScore}/100`,
        icon: '/icons/icon-192.png',
      });
      state.lastNotified = alertKey;
    } catch { /* powiadomienia nie mogą przerwać aktualizacji analizy */ }
  }
}

function drawChart(points) {
  const canvas = $('priceChart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);

  for (let index = 1; index <= 3; index += 1) {
    const y = height / 4 * index;
    context.strokeStyle = 'rgba(137,163,193,.13)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  if (!Array.isArray(points) || points.length < 2) return;
  const values = points.map(point => Number(point.close)).filter(Number.isFinite);
  if (values.length < 2) return;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = Math.max(maximum - minimum, Math.abs(maximum) * 0.00001);
  const padding = 8;
  context.beginPath();
  values.forEach((value, index) => {
    const x = padding + index / (values.length - 1) * (width - padding * 2);
    const y = height - padding - (value - minimum) / spread * (height - padding * 2);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = '#52d6d0';
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.stroke();

  const lastX = width - padding;
  const lastY = height - padding - (values.at(-1) - minimum) / spread * (height - padding * 2);
  context.beginPath();
  context.arc(lastX, lastY, 3.3, 0, Math.PI * 2);
  context.fillStyle = '#52d6d0';
  context.fill();
  context.beginPath();
  context.moveTo(lastX, lastY);
  context.lineTo(width, lastY);
  context.setLineDash([3, 4]);
  context.strokeStyle = '#52d6d066';
  context.stroke();
  context.setLineDash([]);
}

async function loadSignal() {
  const requestId = ++state.requestId;
  state.controller?.abort();
  state.controller = new AbortController();
  const { signal: abortSignal } = state.controller;
  setBusy(true);
  clearError();
  setModeBanner(state.mode);

  try {
    const params = new URLSearchParams({ symbol: state.pair, timeframe: state.timeframe, mode: state.mode });
    const response = await fetch(`/api/signals?${params}`, { cache: 'no-store', signal: abortSignal });
    const data = await response.json();
    if (requestId !== state.requestId) return;
    if (!response.ok) throw new Error(data.error || `Błąd serwera (${response.status}).`);

    updateSignal(data);
    state.lastSuccessfulFetch = Date.now();
    $('connectionText').textContent = state.mode === 'demo' ? 'DEMO ONLINE' : data.stale ? 'LIVE OPÓŹNIONE' : 'LIVE ONLINE';
    $('connectionDot').parentElement.classList.toggle('offline', Boolean(data.stale));
  } catch (error) {
    if (requestId !== state.requestId || error?.name === 'AbortError') return;
    resetSignalView('Nie można potwierdzić aktualnego odczytu. Poprzedni wynik został wyczyszczony dla bezpieczeństwa.');
    showError(error.message || 'Nie udało się pobrać danych.');
    $('connectionText').textContent = 'BRAK DANYCH';
    $('connectionDot').parentElement.classList.add('offline');
    $('marketState').textContent = 'Brak potwierdzonych notowań';
  } finally {
    if (requestId === state.requestId) setBusy(false);
  }
}

async function refreshProviderStatus() {
  try {
    const response = await fetch('/api/provider/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Nie udało się odczytać statusu API.');
    state.providerStatus = data;
    state.liveConfigured = Boolean(data.configured);
    $('disconnectApiBtn').classList.toggle('hidden', !data.configured || data.managedByEnvironment);
    $('connectApiBtn').disabled = Boolean(data.setupRequired || data.managedByEnvironment);
    $('connectApiBtn').textContent = data.managedByEnvironment ? 'Klucz zarządzany na serwerze' : data.setupRequired ? 'Wymagany token serwera' : 'Sprawdź i połącz';
    $('apiWizardStatus').className = `api-wizard-status ${data.configured ? 'success' : 'neutral'}`;
    $('apiWizardStatus').textContent = data.configured
      ? data.managedByEnvironment
        ? 'Twelve Data jest połączone. Klucz pochodzi z konfiguracji środowiska serwera (TWELVE_DATA_API_KEY).'
        : 'Twelve Data jest połączone. Klucz jest zapisany na serwerze w postaci zaszyfrowanej.'
      : data.setupRequired
        ? 'Serwer nie ma jeszcze tokenu FXPULSE_SETUP_TOKEN. Skonfiguruj go po stronie serwera.'
        : 'Brak aktywnego klucza. Wprowadź klucz dostawcy i token serwera.';
    $('modeSelect').disabled = !state.liveConfigured;
    $('modeSelect').title = state.liveConfigured ? '' : 'LIVE wymaga skonfigurowania dostawcy danych.';
    return data;
  } catch (error) {
    $('apiWizardStatus').className = 'api-wizard-status error';
    $('apiWizardStatus').textContent = error.message;
    return null;
  }
}

function openApiWizard() {
  $('providerApiKey').value = '';
  $('setupToken').value = '';
  refreshProviderStatus();
  const dialog = $('apiWizard');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeApiWizard() {
  const dialog = $('apiWizard');
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  $('providerApiKey').value = '';
  $('setupToken').value = '';
}

$('apiWizardBtn').addEventListener('click', openApiWizard);
$('closeApiWizard').addEventListener('click', closeApiWizard);
$('apiWizard').addEventListener('click', event => {
  if (event.target === $('apiWizard')) closeApiWizard();
});
$('apiWizardForm').addEventListener('submit', async event => {
  event.preventDefault();
  const apiKey = $('providerApiKey').value.trim();
  const setupToken = $('setupToken').value;
  if (apiKey.length < 8 || apiKey.length > 200 || /\s/.test(apiKey)) {
    $('apiWizardStatus').className = 'api-wizard-status error';
    $('apiWizardStatus').textContent = 'Sprawdź format klucza API (8–200 znaków, bez spacji).';
    return;
  }
  if (setupToken.length < 32) {
    $('apiWizardStatus').className = 'api-wizard-status error';
    $('apiWizardStatus').textContent = 'Token serwera musi mieć co najmniej 32 znaki.';
    return;
  }

  const button = $('connectApiBtn');
  button.disabled = true;
  button.textContent = 'Weryfikuję dostęp…';
  $('apiWizardStatus').className = 'api-wizard-status neutral';
  $('apiWizardStatus').textContent = 'Sprawdzam klucz na rzeczywistym zapytaniu Twelve Data EUR/USD 5m…';
  try {
    const response = await fetch('/api/provider/connect', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setupToken}` },
      body: JSON.stringify({ provider: $('providerSelect').value, apiKey }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Nie udało się połączyć (HTTP ${response.status}).`);
    $('apiWizardStatus').className = 'api-wizard-status success';
    $('apiWizardStatus').textContent = `${result.message} Test: ${result.test.symbol}, ${result.test.timeframe}, ${result.test.sampleCount} świec.`;
    state.liveConfigured = true;
    state.mode = 'live';
    safeStorage.set('fx-mode', 'live');
    $('modeSelect').disabled = false;
    $('modeSelect').value = 'live';
    await refreshProviderStatus();
    $('providerApiKey').value = '';
    $('setupToken').value = '';
    setTimeout(() => {
      closeApiWizard();
      loadSignal();
    }, 900);
  } catch (error) {
    $('apiWizardStatus').className = 'api-wizard-status error';
    $('apiWizardStatus').textContent = error.message || 'Nie udało się skonfigurować API.';
  } finally {
    button.disabled = false;
    button.textContent = 'Sprawdź i połącz';
  }
});

$('disconnectApiBtn').addEventListener('click', async () => {
  const setupToken = $('setupToken').value;
  if (setupToken.length < 32) {
    $('apiWizardStatus').className = 'api-wizard-status error';
    $('apiWizardStatus').textContent = 'Wpisz token administracyjny serwera, aby odłączyć klucz.';
    $('setupToken').focus();
    return;
  }
  const button = $('disconnectApiBtn');
  button.disabled = true;
  try {
    const response = await fetch('/api/provider/connect', {
      method: 'DELETE', cache: 'no-store',
      headers: { Authorization: `Bearer ${setupToken}` },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Nie udało się odłączyć API.');
    state.liveConfigured = false;
    state.mode = 'demo';
    safeStorage.set('fx-mode', 'demo');
    $('modeSelect').value = 'demo';
    $('modeSelect').disabled = true;
    $('apiWizardStatus').className = 'api-wizard-status success';
    $('apiWizardStatus').textContent = result.message;
    await refreshProviderStatus();
    loadSignal();
  } catch (error) {
    $('apiWizardStatus').className = 'api-wizard-status error';
    $('apiWizardStatus').textContent = error.message;
  } finally {
    $('setupToken').value = '';
    button.disabled = false;
  }
});

async function init() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Błąd konfiguracji (${response.status}).`);
    const config = await response.json();
    state.liveConfigured = Boolean(config.liveConfigured);
    state.mode = safeStorage.get('fx-mode', config.dataMode || 'demo');
    if (!['demo', 'live'].includes(state.mode)) state.mode = config.dataMode === 'live' ? 'live' : 'demo';

    $('pairSelect').innerHTML = config.pairs.map(pair => `<option value="${escapeHtml(pair)}">${escapeHtml(pair)}</option>`).join('');
    if (!config.pairs.includes(state.pair)) state.pair = 'EUR/USD';
    $('pairSelect').value = state.pair;
    if (!config.timeframes.includes(state.timeframe)) state.timeframe = '5m';
    document.querySelectorAll('[data-timeframe]').forEach(button => {
      button.classList.toggle('active', button.dataset.timeframe === state.timeframe);
      button.setAttribute('aria-pressed', String(button.dataset.timeframe === state.timeframe));
    });
    if (state.mode === 'live' && !state.liveConfigured) state.mode = 'demo';
    $('modeSelect').value = state.mode;
    $('modeSelect').disabled = !state.liveConfigured;
    $('modeSelect').title = state.liveConfigured ? '' : 'LIVE wymaga skonfigurowania Twelve Data w kreatorze API.';
    await refreshProviderStatus();

    if (typeof Notification === 'undefined') {
      $('notifyBtn').disabled = true;
      $('notifyBtn').title = 'Ta przeglądarka nie obsługuje powiadomień.';
    } else if (Notification.permission === 'granted') {
      $('notifyBtn').textContent = '✓';
      $('notifyBtn').setAttribute('aria-label', 'Powiadomienia włączone');
    }

    await loadSignal();
    const refreshSeconds = Math.max(30, Math.min(300, Number(config.refreshSeconds) || 60));
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadSignal();
    }, refreshSeconds * 1000);
  } catch (error) {
    resetSignalView('Nie udało się zainicjować aplikacji.');
    showError(`Nie można połączyć się z serwerem: ${error.message}`);
    $('connectionText').textContent = 'BRAK POŁĄCZENIA';
    $('connectionDot').parentElement.classList.add('offline');
  }
}

$('pairSelect').addEventListener('change', () => {
  state.pair = $('pairSelect').value;
  safeStorage.set('fx-pair', state.pair);
  loadSignal();
});

document.querySelectorAll('[data-timeframe]').forEach(button => button.addEventListener('click', () => {
  state.timeframe = button.dataset.timeframe;
  safeStorage.set('fx-timeframe', state.timeframe);
  document.querySelectorAll('[data-timeframe]').forEach(item => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  loadSignal();
}));

$('modeSelect').addEventListener('change', () => {
  const requestedMode = $('modeSelect').value;
  if (requestedMode === 'live' && !state.liveConfigured) {
    $('modeSelect').value = 'demo';
    showError('Aby używać LIVE, otwórz kreator API i połącz konto Twelve Data.');
    return;
  }
  state.mode = requestedMode;
  safeStorage.set('fx-mode', state.mode);
  loadSignal();
});

$('refreshBtn').addEventListener('click', loadSignal);
$('notifyBtn').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return showError('Ta przeglądarka nie obsługuje powiadomień.');
  try {
    const permission = await Notification.requestPermission();
    $('notifyBtn').textContent = permission === 'granted' ? '✓' : '♢';
    $('notifyBtn').setAttribute('aria-label', permission === 'granted' ? 'Powiadomienia włączone' : 'Powiadomienia wyłączone');
    if (permission === 'granted') new Notification('FX Pulse', { body: 'Powiadomienia o sygnałach LIVE są włączone.' });
  } catch {
    showError('Nie udało się uzyskać uprawnień do powiadomień.');
  }
});

window.addEventListener('resize', () => drawChart(state.currentChart));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastSuccessfulFetch > 30_000) loadSignal();
});
window.addEventListener('online', () => loadSignal());
function isAppInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function installPlatformSteps() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return {
    title: 'iPhone / iPad',
    steps: [
      'Otwórz tę stronę w Safari.',
      'Dotknij przycisku Udostępnij (kwadrat ze strzałką w górę).',
      'Wybierz „Dodaj do ekranu początkowego”.',
      'Włącz „Otwórz jako aplikację internetową”, jeśli opcja jest widoczna, a następnie wybierz „Dodaj”.',
    ],
  };
  if (/Android/i.test(ua)) return {
    title: 'Android',
    steps: [
      'Otwórz FX Pulse w Chrome lub Samsung Internet.',
      'W Chrome dotknij menu ⋮ w prawym górnym rogu.',
      'Wybierz „Zainstaluj aplikację” lub „Dodaj do ekranu głównego”.',
      'Potwierdź instalację. Ikona FX Pulse pojawi się na ekranie aplikacji.',
    ],
  };
  return {
    title: 'Komputer',
    steps: [
      'Otwórz FX Pulse w Chrome lub Edge.',
      'Wybierz ikonę instalacji w pasku adresu albo menu przeglądarki.',
      'Kliknij „Zainstaluj” i potwierdź.',
    ],
  };
}

function openInstallGuide() {
  const guide = $('installGuide');
  const platform = installPlatformSteps();
  $('installGuideSteps').innerHTML = `<h3>${platform.title}</h3><ol>${platform.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`;
  const secure = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
  const swSupported = 'serviceWorker' in navigator;
  const installed = isAppInstalled();
  const checks = [
    `<span class="${secure ? 'ok' : 'bad'}">${secure ? '✓' : '!'}</span><span><strong>${secure ? 'Bezpieczne połączenie' : 'Wymagane HTTPS'}</strong><small>${secure ? 'Adres jest dostępny w bezpiecznym kontekście.' : 'Aplikację można instalować z HTTPS lub lokalnego localhost.'}</small></span>`,
    `<span class="${swSupported ? 'ok' : 'bad'}">${swSupported ? '✓' : '!'}</span><span><strong>${swSupported ? 'Obsługa trybu offline' : 'Brak obsługi Service Worker'}</strong><small>${swSupported ? 'Przeglądarka obsługuje zapis powłoki aplikacji.' : 'Użyj aktualnego Chrome, Edge lub Safari.'}</small></span>`,
    `<span class="${installed ? 'ok' : 'neutral'}">${installed ? '✓' : '•'}</span><span><strong>${installed ? 'Aplikacja jest zainstalowana' : 'Gotowe do dodania'}</strong><small>${installed ? 'FX Pulse działa w trybie aplikacji.' : 'Postępuj według instrukcji dla urządzenia.'}</small></span>`,
  ];
  $('installPrerequisites').innerHTML = checks.map(item => `<div class="install-check">${item}</div>`).join('');
  $('installGuideAction').textContent = installed ? 'Zamknij' : 'Gotowe';
  if (!guide.open) guide.showModal();
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.deferredInstall = event;
  $('installBtn').classList.add('install-ready');
  $('installBtn').setAttribute('aria-label', 'Zainstaluj FX Pulse teraz');
});

window.addEventListener('appinstalled', () => {
  state.deferredInstall = null;
  $('installBtn').classList.add('hidden');
  showInstallToast('FX Pulse został zainstalowany. Znajdziesz go na ekranie głównym.');
});

function showInstallToast(message) {
  const banner = $('installToast');
  if (!banner) return;
  banner.textContent = message;
  banner.classList.remove('hidden');
}

async function handleInstallClick() {
  if (isAppInstalled()) {
    openInstallGuide();
    return;
  }
  if (state.deferredInstall) {
    const promptEvent = state.deferredInstall;
    state.deferredInstall = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        $('installBtn').classList.add('hidden');
        showInstallToast('Instalacja FX Pulse została zaakceptowana.');
        return;
      }
    } catch { /* przeglądarka może wycofać prompt; pokażemy instrukcję ręczną */ }
  }
  openInstallGuide();
}

$('installBtn').addEventListener('click', handleInstallClick);
$('footerInstallLink').addEventListener('click', event => { event.preventDefault(); openInstallGuide(); });
$('closeInstallGuide').addEventListener('click', () => $('installGuide').close());
$('installGuideAction').addEventListener('click', () => $('installGuide').close());
$('installGuide').addEventListener('click', event => {
  if (event.target === $('installGuide')) $('installGuide').close();
});
if (isAppInstalled()) $('installBtn').classList.add('hidden');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      registration.update().catch(() => {});
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showInstallToast('Dostępna jest aktualizacja FX Pulse. Odśwież stronę, aby ją zastosować.');
          }
        });
      });
    } catch (error) {
      console.warn('Nie udało się zarejestrować Service Workera:', error);
    }
  });
}

init();
