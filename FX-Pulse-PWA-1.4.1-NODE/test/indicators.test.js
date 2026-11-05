import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, rsi, macd, atr, adx, calculateIndicators } from '../src/indicators.js';

const sample = Array.from({ length: 180 }, (_, index) => {
  const close = 1.1 + index * 0.00002 + Math.sin(index / 3) * 0.0001;
  const previous = index === 0 ? close - 0.00002 : 1.1 + (index - 1) * 0.00002 + Math.sin((index - 1) / 3) * 0.0001;
  return {
    time: new Date(Date.UTC(2025, 0, 1, 0, index * 5)).toISOString(),
    open: previous,
    high: Math.max(previous, close) + 0.00008,
    low: Math.min(previous, close) - 0.00008,
    close,
  };
});

test('EMA returns an aligned series and rejects malformed input', () => {
  const result = ema([1, 2, 3, 4, 5], 3);
  assert.equal(result.length, 5);
  assert.equal(result[0], null);
  assert.ok(Number.isFinite(result.at(-1)));
  assert.deepEqual(ema([1, 2, 3], 0), [null, null, null]);
  assert.deepEqual(ema([1, Number.NaN, 3], 2), [null, null, null]);
});

test('RSI stays within 0..100 and handles flat, rising and falling markets', () => {
  const values = sample.map(candle => candle.close);
  const calculated = rsi(values, 14).filter(Number.isFinite);
  assert.ok(calculated.length > 0);
  assert.ok(calculated.every(value => value >= 0 && value <= 100));
  assert.equal(rsi(Array(20).fill(1), 14).at(-1), 50);
  assert.equal(rsi(Array.from({ length: 20 }, (_, index) => index + 1), 14).at(-1), 100);
  assert.equal(rsi(Array.from({ length: 20 }, (_, index) => 20 - index), 14).at(-1), 0);
});

test('MACD, ATR and ADX calculate finite values with sufficient valid history', () => {
  const values = sample.map(candle => candle.close);
  const calculatedMacd = macd(values);
  assert.ok(Number.isFinite(calculatedMacd.line.at(-1)));
  assert.ok(Number.isFinite(calculatedMacd.signal.at(-1)));
  assert.ok(Number.isFinite(atr(sample, 14).at(-1)));
  assert.ok(Number.isFinite(adx(sample, 14).at(-1)));
  assert.equal(atr(sample.slice(0, 5), 14).at(-1), null);
  assert.equal(adx(sample.slice(0, 10), 14).at(-1), null);
});

test('combined indicator snapshot returns the complete technical contract', () => {
  const result = calculateIndicators(sample);
  for (const key of ['close', 'ema9', 'ema21', 'ema50', 'rsi', 'macdHistogram', 'atr', 'adx']) {
    assert.ok(Number.isFinite(result[key]), `expected finite ${key}`);
  }
  const empty = calculateIndicators([]);
  assert.equal(empty.close, null);
  assert.equal(empty.adx, null);
});
