import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSignal } from '../src/signal-engine.js';

function makeCandles({ now = Date.now(), timeframeMinutes = 5, count = 220, priceOffset = 0, drift = 0.000005, volatility = 0.00004, randomSeed = 6 } = {}) {
  const stepMs = timeframeMinutes * 60_000;
  const lastOpen = Math.floor(now / stepMs) * stepMs - stepMs;
  let randomState = randomSeed | 0;
  const random = () => {
    randomState = (Math.imul(1664525, randomState) + 1013904223) | 0;
    return (randomState >>> 0) / 4294967296;
  };
  let price = 1.1 + priceOffset;
  return Array.from({ length: count }, (_, index) => {
    const open = price;
    price += drift + (random() - 0.5) * volatility;
    return {
      time: new Date(lastOpen - (count - 1 - index) * stepMs).toISOString(),
      open,
      high: Math.max(open, price) + volatility * 0.15,
      low: Math.min(open, price) - volatility * 0.15,
      close: price,
    };
  });
}

function makeCandleSets(now = Date.now(), trend = 1) {
  return {
    '5m': makeCandles({ now, timeframeMinutes: 5, priceOffset: 0.0001, drift: trend * 0.000005, randomSeed: trend > 0 ? 6 : 35 }),
    '15m': makeCandles({ now, timeframeMinutes: 15, priceOffset: 0.0002, drift: trend * 0.000005, randomSeed: trend > 0 ? 6 : 35 }),
    '30m': makeCandles({ now, timeframeMinutes: 30, priceOffset: 0.0003, drift: trend * 0.000005, randomSeed: trend > 0 ? 6 : 35 }),
  };
}

test('DEMO never emits an actionable BUY or SELL from synthetic data', () => {
  const result = buildSignal({ symbol: 'EUR/USD', timeframe: '5m', candleSets: makeCandleSets(), mode: 'demo' });
  assert.equal(result.action, 'WAIT');
  assert.equal(result.tradeEligible, false);
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(result.candidateAction));
  assert.equal(result.dataType, 'SYNTHETIC');
  assert.ok(result.reasons.some(reason => reason.startsWith('DEMO:')));
});

test('LIVE signal contract includes validated action, score and technical levels', () => {
  const result = buildSignal({ symbol: 'EUR/USD', timeframe: '5m', candleSets: makeCandleSets(), mode: 'live' });
  assert.ok(['BUY', 'SELL', 'WAIT'].includes(result.action));
  assert.ok(result.setupScore >= 0 && result.setupScore <= 95);
  assert.equal(result.mtf['5m'] !== undefined, true);
  assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  assert.equal(result.tradeEligible, result.action !== 'WAIT');
  if (result.action === 'WAIT') {
    assert.equal(result.entry, null);
    assert.equal(result.stopLoss, null);
    assert.equal(result.takeProfit, null);
  } else {
    assert.ok(Number.isFinite(result.entry));
    assert.ok(Number.isFinite(result.stopLoss));
    assert.ok(Number.isFinite(result.takeProfit));
    assert.ok(result.riskReward);
    if (result.action === 'BUY') {
      assert.ok(result.stopLoss < result.entry);
      assert.ok(result.takeProfit > result.entry);
    } else {
      assert.ok(result.stopLoss > result.entry);
      assert.ok(result.takeProfit < result.entry);
    }
  }
});

test('qualified multi-timeframe bullish setup can produce a LIVE BUY', () => {
  const result = buildSignal({ symbol: 'EUR/USD', timeframe: '5m', candleSets: makeCandleSets(), mode: 'live' });
  assert.equal(result.mtf['5m'], 'BULLISH');
  assert.equal(result.mtf['15m'], 'BULLISH');
  assert.equal(result.mtf['30m'], 'BULLISH');
  assert.equal(result.action, 'BUY');
  assert.equal(result.tradeEligible, true);
  assert.ok(result.stopLoss < result.entry && result.takeProfit > result.entry);
});

test('qualified multi-timeframe bearish setup can produce a LIVE SELL', () => {
  const result = buildSignal({ symbol: 'EUR/USD', timeframe: '5m', candleSets: makeCandleSets(Date.now(), -1), mode: 'live' });
  assert.equal(result.mtf['5m'], 'BEARISH');
  assert.equal(result.mtf['15m'], 'BEARISH');
  assert.equal(result.mtf['30m'], 'BEARISH');
  assert.equal(result.action, 'SELL');
  assert.equal(result.tradeEligible, true);
  assert.ok(result.stopLoss > result.entry && result.takeProfit < result.entry);
});

test('stale LIVE candles block entries', () => {
  const now = Date.now();
  const staleSets = {
    '5m': makeCandles({ now: now - 60 * 60_000, timeframeMinutes: 5 }),
    '15m': makeCandles({ now: now - 60 * 60_000, timeframeMinutes: 15 }),
    '30m': makeCandles({ now: now - 60 * 60_000, timeframeMinutes: 30 }),
  };
  const result = buildSignal({ symbol: 'EUR/USD', timeframe: '5m', candleSets: staleSets, mode: 'live', now });
  assert.equal(result.stale, true);
  assert.equal(result.action, 'WAIT');
  assert.equal(result.tradeEligible, false);
});

test('stale higher timeframe blocks an otherwise valid LIVE setup', () => {
  const now = Date.now();
  const fresh = makeCandleSets(now);
  const oldThirty = makeCandles({
    now: now - 3 * 60 * 60_000,
    timeframeMinutes: 30,
    priceOffset: 0.0003,
    drift: 0.000005,
    randomSeed: 6,
  });
  const result = buildSignal({
    symbol: 'EUR/USD', timeframe: '5m',
    candleSets: { ...fresh, '30m': oldThirty }, mode: 'live', now,
  });
  assert.equal(result.stale, true);
  assert.equal(result.action, 'WAIT');
  assert.equal(result.timeframeFreshness['30m'].stale, true);
});

test('missing timeframe history is rejected explicitly', () => {
  assert.throws(() => buildSignal({
    symbol: 'EUR/USD', timeframe: '5m', candleSets: { '5m': makeCandles() }, mode: 'live',
  }), /15m/);
});
