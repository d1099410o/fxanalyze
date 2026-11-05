
export const PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD',
  'USD/CAD', 'NZD/USD', 'EUR/JPY', 'GBP/JPY', 'EUR/GBP',
  'EUR/CHF', 'AUD/JPY', 'GBP/CHF',
];

export const TIMEFRAMES = {
  '5m': { provider: '5min', minutes: 5 },
  '15m': { provider: '15min', minutes: 15 },
  '30m': { provider: '30min', minutes: 30 },
};

export class MarketDataError extends Error {
  constructor(message, statusCode = 502, code = 'MARKET_DATA_ERROR') {
    super(message);
    this.name = 'MarketDataError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const cache = new Map();
const inFlight = new Map();
let activeApiKey = process.env.TWELVE_DATA_API_KEY?.trim() || '';

export function setLiveApiKey(apiKey = '') {
  activeApiKey = String(apiKey || '').trim();
  clearMarketCache();
}

export function hasLiveApiKey() {
  return Boolean(activeApiKey);
}


function cacheTtlMs() {
  const configured = Number(process.env.CACHE_TTL_SECONDS || 45);
  const seconds = Number.isFinite(configured) ? Math.min(300, Math.max(10, configured)) : 45;
  return seconds * 1000;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unitNoise(seed, index, salt = 0) {
  let value = (seed ^ Math.imul(index + salt, 0x45d9f3b)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function demoPriceAt(index, base, pip, phase, seed) {
  const trend = Math.sin(index / 31 + phase) * 3.2 + Math.sin(index / 83 + phase * 1.7) * 5.1;
  const cycle = Math.sin(index / 7.5 + phase * 2.3) * 1.1;
  const noise = (unitNoise(seed, index) - 0.5) * 1.6;
  return base + pip * (trend + cycle + noise);
}

/** Deterministyczne świece testowe: wspólne historyczne świece nie zmieniają się między odczytami. */
export function makeDemoCandles(symbol, timeframe, count = 180, now = Date.now()) {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) throw new MarketDataError('Nieobsługiwany interwał DEMO.', 400, 'INVALID_TIMEFRAME');
  if (!Number.isInteger(count) || count < 2 || count > 2000) {
    throw new MarketDataError('Nieprawidłowa liczba świec DEMO.', 400, 'INVALID_CANDLE_COUNT');
  }

  const symbolSeed = stableHash(symbol);
  const seed = stableHash(`${symbol}:${timeframe}`);
  const isJpy = symbol.includes('JPY');
  const base = isJpy ? 149.5 + (symbolSeed % 500) / 100 : 1.02 + (symbolSeed % 50) / 100;
  const pip = isJpy ? 0.01 : 0.0001;
  const digits = isJpy ? 3 : 5;
  const phase = (symbolSeed % 1000) / 1000 * Math.PI * 2;
  const stepMs = tf.minutes * 60_000;
  const bucket = Math.floor(now / stepMs) - 1; // tylko zakończone świece
  const candles = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const index = bucket - offset;
    const open = demoPriceAt(index - 1, base, pip, phase, seed);
    const close = demoPriceAt(index, base, pip, phase, seed);
    const highWick = unitNoise(seed, index, 11) * pip * 1.8;
    const lowWick = unitNoise(seed, index, 29) * pip * 1.8;
    candles.push({
      time: new Date(index * stepMs).toISOString(),
      open: Number(open.toFixed(digits)),
      high: Number((Math.max(open, close) + highWick).toFixed(digits)),
      low: Number((Math.min(open, close) - lowWick).toFixed(digits)),
      close: Number(close.toFixed(digits)),
    });
  }
  return candles;
}

function parseProviderTime(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const raw = value.trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? raw
    : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function validateCandles(candles, { minCount = 70 } = {}) {
  if (!Array.isArray(candles) || candles.length < minCount) {
    throw new MarketDataError(
      `Dostawca zwrócił za mało poprawnych świec (wymagane minimum: ${minCount}).`,
      502,
      'INSUFFICIENT_CANDLES'
    );
  }

  let previousTime = -Infinity;
  for (const [index, candle] of candles.entries()) {
    const timestamp = Date.parse(candle.time);
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (!Number.isFinite(timestamp) || !prices.every(Number.isFinite)) {
      throw new MarketDataError(`Niepoprawna świeca OHLC na pozycji ${index}.`, 502, 'INVALID_CANDLE');
    }
    if (timestamp <= previousTime) {
      throw new MarketDataError('Świece mają duplikaty lub nieprawidłową kolejność czasu.', 502, 'INVALID_CANDLE_ORDER');
    }
    if (candle.low <= 0 || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) {
      throw new MarketDataError(`Niespójne wartości OHLC na pozycji ${index}.`, 502, 'INVALID_OHLC');
    }
    previousTime = timestamp;
  }
  return candles;
}

/** Parser jest eksportowany, aby format i walidację API można było testować bez prawdziwego klucza. */
export function normalizeTwelveDataPayload(payload, timeframe, now = Date.now()) {
  const tf = TIMEFRAMES[timeframe];
  if (!tf) throw new MarketDataError('Nieobsługiwany interwał.', 400, 'INVALID_TIMEFRAME');
  if (!payload || !Array.isArray(payload.values)) {
    const message = payload?.message || payload?.msg || 'Dostawca nie zwrócił tablicy świec.';
    if (payload?.code === 429 || payload?.status === 'error' && /limit|credits|quota/i.test(message)) {
      throw new MarketDataError('Limit API Twelve Data został przekroczony. Sprawdź limit planu i odczekaj.', 429, 'PROVIDER_RATE_LIMIT');
    }
    throw new MarketDataError(message, 502, 'INVALID_PROVIDER_RESPONSE');
  }

  const durationMs = tf.minutes * 60_000;
  const parsed = payload.values.map(value => {
    const timestamp = parseProviderTime(value.datetime);
    return {
      time: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '',
      open: Number(value.open),
      high: Number(value.high),
      low: Number(value.low),
      close: Number(value.close),
    };
  }).filter(candle => candle.time && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));

  parsed.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const closed = parsed.filter(candle => Date.parse(candle.time) + durationMs <= now);
  return validateCandles(closed, { minCount: 70 });
}

export function buildTwelveDataUrl(symbol, timeframe, apiKey) {
  const interval = TIMEFRAMES[timeframe]?.provider;
  if (!interval) throw new MarketDataError('Nieobsługiwany interwał.', 400, 'INVALID_TIMEFRAME');
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('outputsize', '180');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('include_ohlc', 'true');
  return url;
}

async function fetchTwelveData(symbol, timeframe, apiKey) {
  const url = buildTwelveDataUrl(symbol, timeframe, apiKey);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json', Authorization: `apikey ${apiKey}` } });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new MarketDataError(
      timedOut ? 'Przekroczono czas oczekiwania na Twelve Data.' : 'Nie można połączyć się z Twelve Data.',
      502,
      timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR'
    );
  }
  if (response.status === 429) {
    throw new MarketDataError('Limit API Twelve Data został przekroczony. Sprawdź limit planu i odczekaj.', 429, 'PROVIDER_RATE_LIMIT');
  }
  if (!response.ok) throw new MarketDataError(`Dostawca danych zwrócił HTTP ${response.status}.`, 502, 'PROVIDER_HTTP_ERROR');

  let payload;
  try { payload = await response.json(); }
  catch { throw new MarketDataError('Twelve Data zwróciło niepoprawny JSON.', 502, 'INVALID_PROVIDER_JSON'); }

  if (payload?.status === 'error' || payload?.code) {
    const message = payload.message || payload.msg || 'Dostawca zgłosił nieznany błąd.';
    if (payload.code === 429 || /rate limit|credits|quota/i.test(message)) {
      throw new MarketDataError('Limit API Twelve Data został przekroczony. Sprawdź limit planu i odczekaj.', 429, 'PROVIDER_RATE_LIMIT');
    }
    throw new MarketDataError(`Twelve Data: ${message}`, 502, 'PROVIDER_ERROR');
  }
  return normalizeTwelveDataPayload(payload, timeframe);
}

/** Verifies an API key against a small real OHLC time-series request. The key is sent only in an HTTP header. */
export async function testTwelveDataApiKey(apiKey) {
  const normalized = String(apiKey || '').trim();
  if (normalized.length < 8 || normalized.length > 200 || /\s/.test(normalized)) {
    throw new MarketDataError('Klucz API ma nieprawidłowy format.', 400, 'INVALID_API_KEY_FORMAT');
  }
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', 'EUR/USD');
  url.searchParams.set('interval', '5min');
  url.searchParams.set('outputsize', '2');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('include_ohlc', 'true');

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: 'application/json', Authorization: `apikey ${normalized}` },
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new MarketDataError(
      timedOut ? 'Przekroczono czas testowania klucza Twelve Data.' : 'Nie można połączyć się z Twelve Data.',
      502,
      timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR'
    );
  }

  let payload;
  try { payload = await response.json(); }
  catch { throw new MarketDataError('Twelve Data zwróciło niepoprawny JSON.', 502, 'INVALID_PROVIDER_JSON'); }

  if (response.status === 401 || payload?.code === 401) {
    throw new MarketDataError('Klucz API jest nieprawidłowy. Sprawdź go w panelu Twelve Data.', 401, 'INVALID_API_KEY');
  }
  if (response.status === 403 || payload?.code === 403) {
    throw new MarketDataError('Klucz jest poprawny, ale plan Twelve Data nie ma dostępu do tego zakresu danych.', 403, 'API_PLAN_RESTRICTED');
  }
  if (response.status === 429 || payload?.code === 429 || /rate limit|credits|quota/i.test(payload?.message || '')) {
    throw new MarketDataError('Limit API Twelve Data został przekroczony. Spróbuj ponownie później.', 429, 'PROVIDER_RATE_LIMIT');
  }
  if (!response.ok || payload?.status === 'error' || !Array.isArray(payload?.values) || payload.values.length === 0) {
    throw new MarketDataError('Twelve Data nie zwróciło danych OHLC dla EUR/USD 5m. Sprawdź uprawnienia konta.', 502, 'PROVIDER_TEST_FAILED');
  }
  const first = payload.values[0];
  if (!first || !['open', 'high', 'low', 'close'].every(field => Number.isFinite(Number(first[field])))) {
    throw new MarketDataError('Odpowiedź API nie zawiera poprawnych danych OHLC.', 502, 'PROVIDER_TEST_INVALID_OHLC');
  }
  return { provider: 'twelve-data', symbol: 'EUR/USD', timeframe: '5m', sampleCount: payload.values.length };
}

export async function getCandles(symbol, timeframe, mode = process.env.DATA_MODE || 'demo') {
  symbol = String(symbol || '').trim().toUpperCase();
  if (!PAIRS.includes(symbol)) throw new MarketDataError('Ta para nie znajduje się na liście obsługiwanych instrumentów.', 400, 'INVALID_SYMBOL');
  if (!TIMEFRAMES[timeframe]) throw new MarketDataError('Nieobsługiwany interwał.', 400, 'INVALID_TIMEFRAME');
  if (!['demo', 'live'].includes(mode)) throw new MarketDataError('Nieobsługiwany tryb danych.', 400, 'INVALID_MODE');

  const key = `${mode}:${symbol}:${timeframe}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cacheTtlMs()) return cached.candles;
  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    let candles;
    if (mode === 'live') {
      if (!activeApiKey) {
        throw new MarketDataError('Brak skonfigurowanego klucza Twelve Data. Otwórz kreator połączenia API.', 424, 'LIVE_NOT_CONFIGURED');
      }
      candles = await fetchTwelveData(symbol, timeframe, activeApiKey);
    } else {
      candles = makeDemoCandles(symbol, timeframe);
      validateCandles(candles, { minCount: 70 });
    }
    cache.set(key, { at: Date.now(), candles });
    return candles;
  })();

  inFlight.set(key, task);
  try { return await task; }
  finally { inFlight.delete(key); }
}

export function clearMarketCache() {
  cache.clear();
  inFlight.clear();
}
