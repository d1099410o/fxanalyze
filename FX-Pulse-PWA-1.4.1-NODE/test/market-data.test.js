import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTwelveDataUrl,
  makeDemoCandles,
  normalizeTwelveDataPayload,
  getCandles,
  clearMarketCache,
  setLiveApiKey,
  testTwelveDataApiKey,
  PAIRS,
} from '../src/market-data.js';

test('Twelve Data request explicitly asks for OHLC and UTC timestamps', () => {
  const url = buildTwelveDataUrl('EUR/USD', '5m', 'unit-test-key');
  assert.equal(url.searchParams.get('include_ohlc'), 'true');
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.equal(url.searchParams.get('interval'), '5min');
  assert.equal(url.searchParams.has('apikey'), false); // API keys must never be placed in URLs
});

test('DEMO candles are deterministic and preserve overlap between refreshes', () => {
  const step = 5 * 60_000;
  const now = Date.UTC(2026, 0, 1, 12, 0);
  const first = makeDemoCandles('EUR/USD', '5m', 12, now);
  const repeated = makeDemoCandles('EUR/USD', '5m', 12, now);
  const next = makeDemoCandles('EUR/USD', '5m', 12, now + step);
  assert.deepEqual(first, repeated);
  assert.deepEqual(first.slice(1), next.slice(0, -1));
});

test('provider payload normalizes, sorts and excludes an open candle', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0);
  const values = Array.from({ length: 80 }, (_, index) => {
    const timestamp = now - (80 - index) * 5 * 60_000;
    const close = 1.1 + index * 0.0001;
    return {
      datetime: new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19),
      open: String(close - 0.00005),
      high: String(close + 0.0001),
      low: String(close - 0.0001),
      close: String(close),
    };
  }).reverse();
  values.unshift({ datetime: new Date(now).toISOString().replace('T', ' ').slice(0, 19), open: '1.1', high: '1.2', low: '1.0', close: '1.15' });
  const candles = normalizeTwelveDataPayload({ values }, '5m', now);
  assert.equal(candles.length, 80);
  assert.ok(Date.parse(candles[0].time) < Date.parse(candles.at(-1).time));
  assert.ok(Date.parse(candles.at(-1).time) + 5 * 60_000 <= now);
});

test('provider payload rejects insufficient or malformed OHLC history', () => {
  assert.throws(() => normalizeTwelveDataPayload({ values: [] }, '5m'), /za mało/i);
  const now = Date.UTC(2026, 0, 1, 12, 0);
  const values = Array.from({ length: 80 }, (_, index) => {
    const timestamp = now - (80 - index) * 5 * 60_000;
    return {
      datetime: new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19),
      open: '1.1', high: '1.0', low: '1.2', close: '1.15',
    };
  });
  assert.throws(() => normalizeTwelveDataPayload({ values }, '5m', now), /OHLC/i);
});

test('supported instrument list remains unique and normalized', () => {
  assert.equal(new Set(PAIRS).size, PAIRS.length);
  assert.ok(PAIRS.every(pair => /^[A-Z]{3}\/[A-Z]{3}$/.test(pair)));
});


test('DEMO returns only closed bars and LIVE never silently falls back to synthetic data', async () => {
  const now = Date.UTC(2026, 0, 1, 12, 2);
  const demo = makeDemoCandles('EUR/USD', '5m', 80, now);
  assert.ok(Date.parse(demo.at(-1).time) + 5 * 60_000 <= now);

  const previousKey = process.env.TWELVE_DATA_API_KEY;
  delete process.env.TWELVE_DATA_API_KEY;
  setLiveApiKey('');
  clearMarketCache();
  try {
    await assert.rejects(
      getCandles('EUR/USD', '5m', 'live'),
      error => error.statusCode === 424 && error.code === 'LIVE_NOT_CONFIGURED'
    );
  } finally {
    if (previousKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = previousKey;
    setLiveApiKey(previousKey || '');
    clearMarketCache();
  }
});

test('concurrent LIVE requests share one provider call and keep API key server-side', async () => {
  const previousKey = process.env.TWELVE_DATA_API_KEY;
  const originalFetch = globalThis.fetch;
  const now = Date.now();
  const step = 5 * 60_000;
  const lastClosedOpen = Math.floor(now / step) * step - step;
  const values = Array.from({ length: 80 }, (_, index) => {
    const openTime = lastClosedOpen - (79 - index) * step;
    const close = 1.1 + index * 0.00001;
    return {
      datetime: new Date(openTime).toISOString().replace('T', ' ').slice(0, 19),
      open: String(close - 0.000005),
      high: String(close + 0.00001),
      low: String(close - 0.00001),
      close: String(close),
    };
  }).reverse();
  let callCount = 0;
  let observedUrl;
  process.env.TWELVE_DATA_API_KEY = 'test-secret-key';
  setLiveApiKey('test-secret-key');
  clearMarketCache();
  let observedHeaders;
  globalThis.fetch = async (input, options = {}) => {
    callCount += 1;
    observedUrl = new URL(input);
    observedHeaders = options.headers || {};
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ values }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const [first, second] = await Promise.all([
      getCandles('EUR/USD', '5m', 'live'),
      getCandles('EUR/USD', '5m', 'live'),
    ]);
    assert.equal(callCount, 1);
    assert.equal(first.length, 80);
    assert.deepEqual(first, second);
    assert.equal(observedUrl.searchParams.get('include_ohlc'), 'true');
    assert.equal(observedUrl.searchParams.has('apikey'), false);
    assert.equal(observedHeaders.Authorization, 'apikey test-secret-key');
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = previousKey;
    setLiveApiKey(previousKey || '');
    clearMarketCache();
  }
});


test('Twelve Data API key verification uses the documented Authorization header, never the URL', async () => {
  const originalFetch = globalThis.fetch;
  const observations = [];
  globalThis.fetch = async (input, options = {}) => {
    observations.push({ url: new URL(input), authorization: options.headers?.Authorization });
    return new Response(JSON.stringify({ values: [
      { datetime: '2026-11-04 05:00:00', open: '1.1', high: '1.2', low: '1.0', close: '1.15' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await testTwelveDataApiKey('key-for-unit-test-123');
    assert.deepEqual(result, { provider: 'twelve-data', symbol: 'EUR/USD', timeframe: '5m', sampleCount: 1 });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].authorization, 'apikey key-for-unit-test-123');
    assert.equal(observations[0].url.searchParams.has('apikey'), false);
    assert.equal(observations[0].url.searchParams.get('include_ohlc'), 'true');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Twelve Data API key verification maps invalid-key and plan errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 401, message: 'Invalid API key', status: 'error' }), { status: 401 });
    await assert.rejects(testTwelveDataApiKey('bad-key-123456'), error => error.code === 'INVALID_API_KEY');
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 403, message: 'Forbidden', status: 'error' }), { status: 403 });
    await assert.rejects(testTwelveDataApiKey('limited-key-123456'), error => error.code === 'API_PLAN_RESTRICTED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
