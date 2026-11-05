/**
 * Wskaźniki techniczne liczone z zamkniętych świec OHLC.
 * Rynek spot Forex jest zdecentralizowany, dlatego moduł nie zakłada,
 * że wolumen pojedynczego dostawcy reprezentuje cały rynek.
 */

function validPeriod(period) {
  return Number.isInteger(period) && period > 0;
}

function validSeries(values) {
  return Array.isArray(values) && values.every(Number.isFinite);
}

export function ema(values, period) {
  if (!Array.isArray(values)) return [];
  const out = new Array(values.length).fill(null);
  if (!validPeriod(period) || values.length < period || !validSeries(values)) return out;

  const multiplier = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = previous;

  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * multiplier + previous * (1 - multiplier);
    out[index] = previous;
  }
  return out;
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values)) return [];
  const out = new Array(values.length).fill(null);
  if (!validPeriod(period) || values.length <= period || !validSeries(values)) return out;

  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;

  const calculate = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  };

  out[period] = calculate();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[index] = calculate();
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(values)) return { line: [], signal: [], histogram: [] };
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, index) =>
    fastEma[index] == null || slowEma[index] == null ? null : fastEma[index] - slowEma[index]
  );
  const validLine = line.filter(value => value != null);
  const signalValid = ema(validLine, signalPeriod);
  const signal = new Array(values.length).fill(null);
  let validIndex = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] != null) signal[index] = signalValid[validIndex++];
  }
  return {
    line,
    signal,
    histogram: line.map((value, index) =>
      value == null || signal[index] == null ? null : value - signal[index]
    ),
  };
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  if (!validPeriod(period) || candles.length < period) return out;

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  if (!trueRanges.every(Number.isFinite)) return out;

  let current = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = current;
  for (let index = period; index < trueRanges.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]) / period;
    out[index] = current;
  }
  return out;
}

export function adx(candles, period = 14) {
  if (!Array.isArray(candles)) return [];
  const length = candles.length;
  const out = new Array(length).fill(null);
  if (!validPeriod(period) || length < period * 2) return out;

  const plusDm = new Array(length).fill(0);
  const minusDm = new Array(length).fill(0);
  const trueRanges = new Array(length).fill(0);

  for (let index = 1; index < length; index += 1) {
    const upMove = candles[index].high - candles[index - 1].high;
    const downMove = candles[index - 1].low - candles[index].low;
    plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
    trueRanges[index] = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - candles[index - 1].close),
      Math.abs(candles[index].low - candles[index - 1].close)
    );
  }

  const smoothWilder = values => {
    const result = new Array(length).fill(null);
    let sum = values.slice(1, period + 1).reduce((total, value) => total + value, 0);
    result[period] = sum;
    for (let index = period + 1; index < length; index += 1) {
      sum = sum - sum / period + values[index];
      result[index] = sum;
    }
    return result;
  };

  const smoothedTr = smoothWilder(trueRanges);
  const smoothedPlus = smoothWilder(plusDm);
  const smoothedMinus = smoothWilder(minusDm);
  const dx = new Array(length).fill(null);

  for (let index = period; index < length; index += 1) {
    const trValue = smoothedTr[index];
    if (!Number.isFinite(trValue) || trValue <= 0) continue;
    const plusDi = 100 * smoothedPlus[index] / trValue;
    const minusDi = 100 * smoothedMinus[index] / trValue;
    const denominator = plusDi + minusDi;
    dx[index] = denominator === 0 ? 0 : 100 * Math.abs(plusDi - minusDi) / denominator;
  }

  const firstAdxIndex = period * 2 - 1;
  let firstSum = 0;
  for (let index = period; index <= firstAdxIndex; index += 1) firstSum += dx[index] ?? 0;
  let current = firstSum / period;
  out[firstAdxIndex] = current;

  for (let index = firstAdxIndex + 1; index < length; index += 1) {
    current = (current * (period - 1) + (dx[index] ?? 0)) / period;
    out[index] = current;
  }
  return out;
}

export function calculateIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      close: null, ema9: null, ema21: null, ema50: null, rsi: null,
      macd: null, macdSignal: null, macdHistogram: null, atr: null, adx: null,
    };
  }

  const closes = candles.map(candle => candle.close);
  const last = candles.length - 1;
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);
  const atr14 = atr(candles, 14);
  const adx14 = adx(candles, 14);
  return {
    close: closes[last],
    ema9: ema9[last],
    ema21: ema21[last],
    ema50: ema50[last],
    rsi: rsi14[last],
    macd: macdData.line[last],
    macdSignal: macdData.signal[last],
    macdHistogram: macdData.histogram[last],
    atr: atr14[last],
    adx: adx14[last],
  };
}
