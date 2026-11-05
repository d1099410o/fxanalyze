import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PAIRS, TIMEFRAMES, getCandles, MarketDataError, setLiveApiKey, hasLiveApiKey, testTwelveDataApiKey, clearMarketCache } from './src/market-data.js';
import { isSetupTokenValid, loadProviderKey, saveProviderKey, removeProviderKey } from './src/provider-config.js';
import { buildSignal } from './src/signal-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, 'public');
const VERSION = '1.4.1';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 90;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

export function loadEnvFile(envPath = path.join(__dirname, '.env')) {
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      const value = match[2].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? '');
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

loadEnvFile();
// Prefer an explicitly supplied environment key; otherwise decrypt the saved credential with the server setup token.
setLiveApiKey(process.env.TWELVE_DATA_API_KEY?.trim() || loadProviderKey());

function readConfig() {
  const requestedPort = Number(process.env.PORT || 3000);
  return {
    port: Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 3000,
    defaultMode: process.env.DATA_MODE === 'live' ? 'live' : 'demo',
    liveConfigured: hasLiveApiKey(),
    appOrigin: process.env.APP_ORIGIN?.trim() || '',
    refreshSeconds: 60,
  };
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 4096) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const error = new Error('Wymagany jest format application/json.');
    error.statusCode = 415;
    throw error;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      const error = new Error('Żądanie jest zbyt duże.');
      error.statusCode = 413;
      throw error;
    }
  }
  try { return JSON.parse(raw || '{}'); }
  catch {
    const error = new Error('Niepoprawny JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function setupAuthorizationError(req) {
  const expected = process.env.FXPULSE_SETUP_TOKEN || '';
  if (expected.length < 32) {
    return { status: 503, error: 'Kreator API wymaga skonfigurowania FXPULSE_SETUP_TOKEN na serwerze (minimum 32 znaki).' };
  }
  const authorization = String(req.headers.authorization || '');
  const candidate = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return isSetupTokenValid(candidate, expected) ? null : { status: 401, error: 'Token administracyjny serwera jest nieprawidłowy.' };
}

function isSecureConnection(req) {
  if (req.socket?.encrypted) return true;
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (remote === '127.0.0.1' || remote === '::1') return true;
  // Enable only when the Node process is reachable exclusively through a trusted TLS reverse proxy.
  return process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function maskApiKey() {
  // The key is deliberately never exposed; the UI only receives a connected/disconnected status.
  return hasLiveApiKey() ? '••••••••' : '';
}

function applyCors(req, res, appOrigin) {
  const origin = req.headers.origin;
  if (!appOrigin) return true;
  if (!origin) return true;
  if (origin !== appOrigin) return false;
  res.setHeader('Access-Control-Allow-Origin', appOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function createRateLimiter({ max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS } = {}) {
  const records = new Map();
  let lastCleanup = 0;
  return ip => {
    const now = Date.now();
    if (now - lastCleanup > windowMs || records.size > 5000) {
      for (const [key, value] of records) {
        if (now >= value.resetAt) records.delete(key);
      }
      lastCleanup = now;
    }
    const key = ip || 'unknown';
    let record = records.get(key);
    if (!record || now >= record.resetAt) record = { count: 0, resetAt: now + windowMs };
    record.count += 1;
    records.set(key, record);
    return { allowed: record.count <= max, remaining: Math.max(0, max - record.count), resetAt: record.resetAt };
  };
}

async function serveStatic(pathname, res) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  if (relativePath.split(/[\\/]+/).some(segment => segment.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const resolvedPath = path.resolve(publicDir, relativePath);
  const relativeCheck = path.relative(publicDir, resolvedPath);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(resolvedPath);
    const actualPath = stat.isDirectory() ? path.join(resolvedPath, 'index.html') : resolvedPath;
    const body = await fs.readFile(actualPath);
    const extension = path.extname(actualPath).toLowerCase();
    const isHtml = extension === '.html';
    const isPwaControl = ['.html', '.webmanifest'].includes(extension) || path.basename(actualPath) === 'sw.js';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Cache-Control': isPwaControl ? 'no-cache, must-revalidate' : 'public, max-age=300',
      ...(path.basename(actualPath) === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    res.end(body);
  } catch (error) {
    if (error?.code === 'ENOENT' && path.extname(decodedPath) === '') {
      try {
        const body = await fs.readFile(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
      return;
    }
    res.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error?.code === 'ENOENT' ? 'Not found' : 'Internal server error');
  }
}

export function createAppServer() {
  const rateLimit = createRateLimiter();
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    const config = readConfig();
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return sendJson(res, 400, { error: 'Nieprawidłowy adres zapytania.' }); }

    if (!applyCors(req, res, config.appOrigin)) {
      return sendJson(res, 403, { error: 'Origin niedozwolony.' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      const allowedMethods = url.pathname === '/api/provider/connect' ? ['GET', 'POST', 'DELETE'] :
        url.pathname === '/api/provider/status' ? ['GET'] : ['GET'];
      if (!allowedMethods.includes(req.method)) return sendJson(res, 405, { error: 'Metoda niedozwolona.' });
      const limit = rateLimit(req.socket.remoteAddress);
      res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
      res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(limit.resetAt / 1000)));
      if (!limit.allowed) return sendJson(res, 429, { error: 'Zbyt wiele zapytań. Spróbuj ponownie za minutę.' });

      if (url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          app: 'FX Pulse',
          version: VERSION,
          dataMode: config.defaultMode,
          liveConfigured: config.liveConfigured,
          serverTime: new Date().toISOString(),
        });
      }

      if (url.pathname === '/api/provider/status') {
        return sendJson(res, 200, {
          provider: 'twelve-data',
          configured: hasLiveApiKey(),
          managedByEnvironment: Boolean(process.env.TWELVE_DATA_API_KEY?.trim()),
          maskedKey: maskApiKey(),
          setupRequired: (process.env.FXPULSE_SETUP_TOKEN || '').length < 32,
          credentialStorage: 'AES-256-GCM encrypted on server',
        });
      }

      if (url.pathname === '/api/provider/connect' && req.method === 'GET') {
        return sendJson(res, 200, {
          provider: 'twelve-data',
          configured: hasLiveApiKey(),
          managedByEnvironment: Boolean(process.env.TWELVE_DATA_API_KEY?.trim()),
          setupRequired: (process.env.FXPULSE_SETUP_TOKEN || '').length < 32,
        });
      }

      if (url.pathname === '/api/provider/connect' && (req.method === 'POST' || req.method === 'DELETE')) {
        if (!isSecureConnection(req)) {
          return sendJson(res, 426, { error: 'Konfiguracja klucza API wymaga HTTPS. Wyjątek: localhost podczas testów.', code: 'HTTPS_REQUIRED' });
        }
        const authError = setupAuthorizationError(req);
        if (authError) return sendJson(res, authError.status, { error: authError.error, code: 'SETUP_AUTH_FAILED' });

        if (req.method === 'DELETE') {
          try {
            if (process.env.TWELVE_DATA_API_KEY?.trim()) {
              // An environment-provided key is intentionally immutable from the app UI.
              setLiveApiKey(process.env.TWELVE_DATA_API_KEY.trim());
              return sendJson(res, 409, { error: 'Klucz jest zarządzany przez TWELVE_DATA_API_KEY na serwerze. Usuń go z konfiguracji wdrożenia.', code: 'ENV_KEY_MANAGED' });
            }
            removeProviderKey();
            setLiveApiKey('');
            clearMarketCache();
            return sendJson(res, 200, { ok: true, configured: false, message: 'Klucz Twelve Data został odłączony.' });
          } catch {
            return sendJson(res, 500, { error: 'Nie udało się usunąć konfiguracji dostawcy.', code: 'PROVIDER_DISCONNECT_FAILED' });
          }
        }

        let body;
        try { body = await readJsonBody(req, 4096); }
        catch (error) { return sendJson(res, error.statusCode || 400, { error: error.message, code: 'INVALID_REQUEST_BODY' }); }
        if (body.provider && body.provider !== 'twelve-data') {
          return sendJson(res, 400, { error: 'Ten kreator obsługuje obecnie wyłącznie Twelve Data.', code: 'UNSUPPORTED_PROVIDER' });
        }
        const apiKey = String(body.apiKey || '').trim();
        if (process.env.TWELVE_DATA_API_KEY?.trim()) {
          return sendJson(res, 409, { error: 'Serwer używa klucza ustawionego w TWELVE_DATA_API_KEY. Usuń tę zmienną, aby zarządzać kluczem przez kreator.', code: 'ENV_KEY_MANAGED' });
        }
        try {
          const verification = await testTwelveDataApiKey(apiKey);
          saveProviderKey(apiKey, process.env.FXPULSE_SETUP_TOKEN);
          setLiveApiKey(apiKey);
          return sendJson(res, 200, {
            ok: true,
            configured: true,
            provider: verification.provider,
            test: { symbol: verification.symbol, timeframe: verification.timeframe, sampleCount: verification.sampleCount },
            message: 'Połączenie z Twelve Data zostało zweryfikowane i zapisane.'
          });
        } catch (error) {
          const status = error instanceof MarketDataError ? error.statusCode : 500;
          return sendJson(res, status, {
            error: error instanceof MarketDataError ? error.message : 'Nie udało się zweryfikować połączenia API.',
            code: error?.code || 'PROVIDER_CONNECT_FAILED',
          });
        }
      }

      if (url.pathname === '/api/config') {
        return sendJson(res, 200, {
          pairs: PAIRS,
          timeframes: Object.keys(TIMEFRAMES),
          dataMode: config.defaultMode,
          liveConfigured: config.liveConfigured,
          provider: 'twelve-data',
          refreshSeconds: config.refreshSeconds,
          tradingEnabled: false,
        });
      }

      if (url.pathname === '/api/signals') {
        const symbol = String(url.searchParams.get('symbol') || 'EUR/USD').trim().toUpperCase();
        const timeframe = String(url.searchParams.get('timeframe') || '5m').trim();
        const requestedMode = url.searchParams.get('mode');
        if (requestedMode && !['demo', 'live'].includes(requestedMode)) {
          return sendJson(res, 400, { error: 'Tryb danych musi mieć wartość demo albo live.' });
        }
        const mode = requestedMode || config.defaultMode;
        if (!PAIRS.includes(symbol)) return sendJson(res, 400, { error: 'Nieobsługiwana para walutowa.' });
        if (!TIMEFRAMES[timeframe]) return sendJson(res, 400, { error: 'Interwał musi mieć wartość 5m, 15m lub 30m.' });

        try {
          const entries = await Promise.all(Object.keys(TIMEFRAMES).map(async tf => [
            tf,
            await getCandles(symbol, tf, mode),
          ]));
          const candleSets = Object.fromEntries(entries);
          const signal = buildSignal({ symbol, timeframe, candleSets, mode });
          return sendJson(res, 200, {
            ...signal,
            chart: candleSets[timeframe].slice(-48).map(candle => ({ time: candle.time, close: candle.close })),
            serverTime: new Date().toISOString(),
            version: VERSION,
          });
        } catch (error) {
          const status = error instanceof MarketDataError ? error.statusCode : 502;
          const message = error instanceof MarketDataError
            ? error.message
            : 'Nie udało się pobrać danych lub obliczyć sygnału.';
          return sendJson(res, status, { error: message, code: error?.code || 'SIGNAL_ERROR' });
        }
      }

      return sendJson(res, 404, { error: 'Nie znaleziono endpointu API.' });
    }

    if (req.method === 'GET') return serveStatic(url.pathname, res);
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  });

  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return server;
}

export function startServer() {
  const config = readConfig();
  const server = createAppServer();
  server.listen(config.port, '0.0.0.0', () => {
    const actualPort = server.address()?.port ?? config.port;
    console.log('');
    console.log(`FX Pulse ${VERSION} działa w trybie ${config.defaultMode.toUpperCase()}.`);
    console.log(`Na tym komputerze: http://localhost:${actualPort}`);
    const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address);
    for (const address of [...new Set(addresses)]) console.log(`W sieci lokalnej: http://${address}:${actualPort}`);
    console.log('');
    console.log('Zatrzymanie serwera: Ctrl+C');
    console.log('Uwaga: adres LAN przez HTTP służy do testów. Instalacja PWA i konfiguracja klucza API na telefonie wymagają HTTPS.');
    console.log('');
  });
  server.on('error', error => {
    console.error(`Nie udało się uruchomić serwera: ${error.message}`);
    process.exitCode = 1;
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
