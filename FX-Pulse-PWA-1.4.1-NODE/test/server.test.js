import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.js';
import { removeProviderKey } from '../src/provider-config.js';
import { setLiveApiKey } from '../src/market-data.js';

async function withServer(callback) {
  const server = createAppServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('health endpoint exposes status without exposing provider credentials', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.ok(payload.version);
    assert.equal(Object.hasOwn(payload, 'apiKey'), false);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  });
});

test('config endpoint explicitly reports that trading is disabled', async () => {
  await withServer(async base => {
    const response = await fetch(`${base}/api/config`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.tradingEnabled, false);
    assert.ok(payload.pairs.includes('EUR/USD'));
    assert.deepEqual(payload.timeframes, ['5m', '15m', '30m']);
  });
});

test('signals endpoint validates query parameters and returns safe DEMO status', async () => {
  await withServer(async base => {
    const invalid = await fetch(`${base}/api/signals?symbol=NOT/A/PAIR`);
    assert.equal(invalid.status, 400);
    const invalidMode = await fetch(`${base}/api/signals?symbol=EUR%2FUSD&mode=invalid`);
    assert.equal(invalidMode.status, 400);

    const response = await fetch(`${base}/api/signals?symbol=EUR%2FUSD&timeframe=5m&mode=demo`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.dataMode, 'demo');
    assert.equal(payload.dataType, 'SYNTHETIC');
    assert.equal(payload.action, 'WAIT');
    assert.equal(payload.tradeEligible, false);
    assert.equal(payload.chart.length, 48);
  });
});


test('web app is served locally and provider secrets are not exposed as static files', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /FX Pulse — Forex Signals/);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');

    const secretAttempt = await fetch(`${base}/.env`);
    assert.equal(secretAttempt.status, 404);
  });
});


test('API wizard requires server admin token and never returns provider credentials', async () => {
  const previousToken = process.env.FXPULSE_SETUP_TOKEN;
  const previousApiKey = process.env.TWELVE_DATA_API_KEY;
  delete process.env.FXPULSE_SETUP_TOKEN;
  delete process.env.TWELVE_DATA_API_KEY;
  setLiveApiKey('');
  try {
    await withServer(async base => {
      const status = await fetch(`${base}/api/provider/status`);
      const statusBody = await status.json();
      assert.equal(status.status, 200);
      assert.equal(statusBody.provider, 'twelve-data');
      assert.equal(statusBody.configured, false);
      assert.equal(statusBody.setupRequired, true);
      assert.equal(Object.hasOwn(statusBody, 'apiKey'), false);

      const response = await fetch(`${base}/api/provider/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'twelve-data', apiKey: 'should-not-be-stored' }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'SETUP_AUTH_FAILED');
    });
  } finally {
    if (previousToken === undefined) delete process.env.FXPULSE_SETUP_TOKEN;
    else process.env.FXPULSE_SETUP_TOKEN = previousToken;
    if (previousApiKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = previousApiKey;
    setLiveApiKey(previousApiKey || '');
    removeProviderKey();
  }
});

test('API wizard verifies the provider with an Authorization header and persists only encrypted credentials', async () => {
  const previousToken = process.env.FXPULSE_SETUP_TOKEN;
  const previousApiKey = process.env.TWELVE_DATA_API_KEY;
  const originalFetch = globalThis.fetch;
  const token = 'test-admin-token-fxpulse-32-chars-minimum-123456789';
  const providerKey = 'test-provider-key-which-is-not-real';
  const observed = { authorization: '', url: '' };
  process.env.FXPULSE_SETUP_TOKEN = token;
  delete process.env.TWELVE_DATA_API_KEY;
  setLiveApiKey('');
  globalThis.fetch = async (input, options = {}) => {
    observed.url = String(input);
    observed.authorization = options.headers?.Authorization || '';
    return new Response(JSON.stringify({ values: [
      { datetime: '2026-11-04 05:00:00', open: '1.1', high: '1.2', low: '1.0', close: '1.15' },
      { datetime: '2026-11-04 05:05:00', open: '1.15', high: '1.25', low: '1.1', close: '1.2' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await withServer(async base => {
      const denied = await originalFetch(`${base}/api/provider/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
        body: JSON.stringify({ provider: 'twelve-data', apiKey: providerKey }),
      });
      assert.equal(denied.status, 401);

      const response = await originalFetch(`${base}/api/provider/connect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: 'twelve-data', apiKey: providerKey }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);
      assert.equal(payload.configured, true);
      assert.equal(payload.test.symbol, 'EUR/USD');
      assert.equal(observed.authorization, `apikey ${providerKey}`);
      assert.equal(new URL(observed.url).searchParams.has('apikey'), false);

      const status = await originalFetch(`${base}/api/provider/status`);
      const statusPayload = await status.json();
      assert.equal(statusPayload.configured, true);
      assert.equal(JSON.stringify(statusPayload).includes(providerKey), false);
      const { readFileSync, statSync } = await import('node:fs');
      const encrypted = readFileSync(new URL('../data/provider-key.enc.json', import.meta.url), 'utf8');
      assert.equal(encrypted.includes(providerKey), false);
      assert.ok((statSync(new URL('../data/provider-key.enc.json', import.meta.url)).mode & 0o077) === 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.FXPULSE_SETUP_TOKEN;
    else process.env.FXPULSE_SETUP_TOKEN = previousToken;
    if (previousApiKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = previousApiKey;
    removeProviderKey();
    setLiveApiKey(previousApiKey || '');
  }
});
