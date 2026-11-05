import { calculateIndicators } from './indicators.js';
import { TIMEFRAMES } from './market-data.js';

const REQUIRED_TIMEFRAMES = Object.keys(TIMEFRAMES);
const MIN_CANDLES = 70;
const RISK_REWARD = 1.6;
const STOP_ATR_MULTIPLIER = 1.5;

function isFiniteSnapshot(snapshot) {
  return ['close', 'ema9', 'ema21', 'ema50', 'rsi', 'macdHistogram', 'atr', 'adx']
    .every(key => Number.isFinite(snapshot[key]));
}

function timeframeBias(indicators) {
  if (!indicators || !isFiniteSnapshot(indicators)) return 0;
  const bullish = indicators.close > indicators.ema21
    && indicators.ema21 > indicators.ema50
    && indicators.macdHistogram > 0;
  const bearish = indicators.close < indicators.ema21
    && indicators.ema21 < indicators.ema50
    && indicators.macdHistogram < 0;
  return bullish ? 1 : bearish ? -1 : 0;
}

function priceDigits(symbol) {
  if (symbol.includes('JPY')) return 3;
  return 5;
}

function roundPrice(value, symbol) {
  return Number(value.toFixed(priceDigits(symbol)));
}

function pipSize(symbol) {
  return symbol.includes('JPY') ? 0.01 : 0.0001;
}

function pips(value, symbol) {
  return value / pipSize(symbol);
}

function validateCandleSets(candleSets, timeframe) {
  if (!TIMEFRAMES[timeframe]) throw new Error('Nieobsługiwany interwał analizy.');
  for (const required of REQUIRED_TIMEFRAMES) {
    const candles = candleSets?.[required];
    if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
      throw new Error(`Brak wystarczającej historii świec dla interwału ${required}.`);
    }
  }
}

export function buildSignal({ symbol, timeframe, candleSets, mode = 'demo', now = Date.now() }) {
  if (!['demo', 'live'].includes(mode)) throw new Error('Nieobsługiwany tryb danych.');
  validateCandleSets(candleSets, timeframe);

  const currentCandles = candleSets[timeframe];
  const indicators = calculateIndicators(currentCandles);
  if (!isFiniteSnapshot(indicators)) {
    throw new Error('Nie można obliczyć wszystkich wymaganych wskaźników z dostępnej historii.');
  }

  const lastCandle = currentCandles.at(-1);
  const candleTimestamp = Date.parse(lastCandle.time);
  const intervalMs = TIMEFRAMES[timeframe].minutes * 60_000;
  const candleEnd = candleTimestamp + intervalMs;
  const ageMs = now - candleEnd;
  const timeframeFreshness = Object.fromEntries(REQUIRED_TIMEFRAMES.map(tf => {
    const latest = candleSets[tf].at(-1);
    const openTime = Date.parse(latest.time);
    const duration = TIMEFRAMES[tf].minutes * 60_000;
    const endTime = openTime + duration;
    const age = now - endTime;
    const invalid = !Number.isFinite(openTime) || endTime > now + 5_000;
    return [tf, {
      stale: invalid || (mode === 'live' && age > duration * 3),
      ageSeconds: Number.isFinite(age) ? Math.max(0, Math.round(age / 1000)) : null,
    }];
  }));
  const isStale = Object.values(timeframeFreshness).some(item => item.stale);

  const trendFast = indicators.ema9 > indicators.ema21 ? 1 : indicators.ema9 < indicators.ema21 ? -1 : 0;
  const trendMain = indicators.close > indicators.ema21 ? 1 : indicators.close < indicators.ema21 ? -1 : 0;
  const trendSlow = indicators.close > indicators.ema50 ? 1 : indicators.close < indicators.ema50 ? -1 : 0;
  const macdBias = indicators.macdHistogram > 0 ? 1 : indicators.macdHistogram < 0 ? -1 : 0;
  const rsiBias = indicators.rsi >= 52 && indicators.rsi <= 70
    ? 1
    : indicators.rsi <= 48 && indicators.rsi >= 30 ? -1 : 0;
  const adxOk = indicators.adx >= 18;

  const weights = { fast: 15, main: 20, slow: 20, macd: 20, rsi: 15, adx: 10 };
  let bull = 0;
  let bear = 0;
  for (const [name, bias] of [
    ['fast', trendFast], ['main', trendMain], ['slow', trendSlow],
    ['macd', macdBias], ['rsi', rsiBias],
  ]) {
    if (bias > 0) bull += weights[name];
    if (bias < 0) bear += weights[name];
  }
  if (adxOk) {
    if (bull > bear) bull += weights.adx;
    else if (bear > bull) bear += weights.adx;
  }

  const mtf = Object.fromEntries(REQUIRED_TIMEFRAMES.map(tf => [
    tf,
    timeframeBias(calculateIndicators(candleSets[tf])),
  ]));
  const mtfValues = Object.values(mtf);
  const positiveCount = mtfValues.filter(value => value > 0).length;
  const negativeCount = mtfValues.filter(value => value < 0).length;
  const direction = bull > bear ? 1 : bear > bull ? -1 : 0;
  const supportedCount = direction > 0 ? positiveCount : direction < 0 ? negativeCount : 0;
  const opposingCount = direction > 0 ? negativeCount : direction < 0 ? positiveCount : 0;
  const mtfConflict = opposingCount >= 2;
  const mtfConfirmed = supportedCount >= 2;
  const directionalScore = Math.max(bull, bear);
  // Indeks jakości układu 0–100; celowo nie jest interpretowany jako prawdopodobieństwo zysku.
  const setupScore = Math.min(95, Math.max(0, Math.round(directionalScore * 0.65 + (supportedCount / 3) * 35)));

  const entry = indicators.close;
  const roundedEntry = roundPrice(entry, symbol);
  const atrValue = indicators.atr;
  const riskLevelsValid = Number.isFinite(atrValue) && atrValue > 0 && Number.isFinite(entry) && entry > 0;
  const stopDistance = riskLevelsValid ? atrValue * STOP_ATR_MULTIPLIER : null;
  const targetDistance = stopDistance == null ? null : stopDistance * RISK_REWARD;
  const precisionValid = riskLevelsValid
    && roundPrice(entry - stopDistance, symbol) < roundedEntry
    && roundPrice(entry + targetDistance, symbol) > roundedEntry
    && roundPrice(entry + stopDistance, symbol) > roundedEntry
    && roundPrice(entry - targetDistance, symbol) < roundedEntry;
  const longConditions = direction > 0 && indicators.rsi < 72;
  const shortConditions = direction < 0 && indicators.rsi > 28;
  const commonConditions = !isStale && riskLevelsValid && precisionValid
    && mtfConfirmed && !mtfConflict && setupScore >= 75 && adxOk;

  let candidateAction = 'WAIT';
  if (commonConditions && longConditions) candidateAction = 'BUY';
  if (commonConditions && shortConditions) candidateAction = 'SELL';

  // Dane syntetyczne mogą służyć tylko do demonstracji. Nie generują sygnałów transakcyjnych.
  const tradeEligible = mode === 'live' && candidateAction !== 'WAIT';
  const action = tradeEligible ? candidateAction : 'WAIT';
  const stopLoss = action === 'BUY' ? entry - stopDistance : action === 'SELL' ? entry + stopDistance : null;
  const takeProfit = action === 'BUY' ? entry + targetDistance : action === 'SELL' ? entry - targetDistance : null;

  const reasons = [
    trendFast === 1 ? 'EMA 9 powyżej EMA 21' : trendFast === -1 ? 'EMA 9 poniżej EMA 21' : 'EMA 9/21 bez wyraźnego kierunku',
    trendSlow === 1 ? 'Cena powyżej EMA 50' : trendSlow === -1 ? 'Cena poniżej EMA 50' : 'Cena blisko EMA 50',
    macdBias === 1 ? 'MACD wspiera wzrosty' : macdBias === -1 ? 'MACD wspiera spadki' : 'MACD bez przewagi',
    `RSI ${indicators.rsi.toFixed(1)}`,
    `ADX ${indicators.adx.toFixed(1)}${adxOk ? ' – trend spełnia próg siły' : ' – trend zbyt słaby'}`,
    `Zgodność interwałów: ${positiveCount} wzrostowe / ${negativeCount} spadkowe`,
  ];
  if (mtfConflict) reasons.push('Konflikt kierunku między interwałami – sygnał zablokowany');
  if (!mtfConfirmed) reasons.push('Brak potwierdzenia kierunku na co najmniej 2 z 3 interwałów');
  if (!riskLevelsValid) reasons.push('Nieprawidłowy ATR lub cena – nie można wyznaczyć poziomów ryzyka');
  else if (!precisionValid) reasons.push('Zmienność jest zbyt mała względem precyzji kwotowania – poziomy ryzyka byłyby zaokrąglone do ceny wejścia');
  if (isStale) {
    const staleTimeframes = Object.entries(timeframeFreshness).filter(([, item]) => item.stale).map(([tf]) => tf);
    reasons.push(`Nieaktualne lub czasowo niepoprawne notowania na interwałach: ${staleTimeframes.join(', ')} – sygnał zablokowany`);
  }
  if (candidateAction === 'WAIT' && !reasons.some(reason => reason.includes('zablokowany'))) {
    reasons.push('Warunki wejścia nie spełniają wszystkich filtrów strategii');
  }
  if (mode === 'demo') {
    reasons.push(candidateAction === 'WAIT'
      ? 'DEMO: dane syntetyczne – brak hipotetycznego układu spełniającego filtry'
      : `DEMO: wykryto hipotetyczny układ ${candidateAction}, ale dane syntetyczne nie tworzą sygnału transakcyjnego`);
  }

  const roundedStopDistance = stopDistance == null ? null : Number(pips(stopDistance, symbol).toFixed(1));
  const roundedTargetDistance = targetDistance == null ? null : Number(pips(targetDistance, symbol).toFixed(1));
  const actualRiskReward = stopLoss == null || takeProfit == null
    ? null
    : Number((Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)).toFixed(2));

  return {
    symbol,
    timeframe,
    action,
    candidateAction,
    tradeEligible,
    setupScore,
    scoreMeaning: 'Indeks technicznej jakości układu, nie prawdopodobieństwo powodzenia transakcji.',
    price: roundedEntry,
    entry: action === 'WAIT' ? null : roundedEntry,
    stopLoss: stopLoss == null ? null : roundPrice(stopLoss, symbol),
    takeProfit: takeProfit == null ? null : roundPrice(takeProfit, symbol),
    stopPips: action === 'WAIT' ? null : roundedStopDistance,
    targetPips: action === 'WAIT' ? null : roundedTargetDistance,
    riskReward: actualRiskReward == null ? null : `1:${actualRiskReward}`,
    riskRewardTarget: RISK_REWARD,
    indicators: {
      rsi: Number(indicators.rsi.toFixed(2)),
      adx: Number(indicators.adx.toFixed(2)),
      ema9: roundPrice(indicators.ema9, symbol),
      ema21: roundPrice(indicators.ema21, symbol),
      ema50: roundPrice(indicators.ema50, symbol),
      macdHistogram: Number(indicators.macdHistogram.toPrecision(5)),
      atr: roundPrice(indicators.atr, symbol),
    },
    mtf: Object.fromEntries(Object.entries(mtf).map(([tf, bias]) => [
      tf,
      bias === 1 ? 'BULLISH' : bias === -1 ? 'BEARISH' : 'NEUTRAL',
    ])),
    reasons,
    candleTime: lastCandle.time,
    dataMode: mode,
    dataType: mode === 'demo' ? 'SYNTHETIC' : 'PROVIDER_LIVE',
    stale: isStale,
    dataAgeSeconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : null,
    timeframeFreshness,
    strategy: {
      name: 'EMA-MACD-RSI-ADX MTF',
      stopAtrMultiplier: STOP_ATR_MULTIPLIER,
      rewardRiskTarget: RISK_REWARD,
      requiredMtfAgreement: 2,
      minimumSetupScore: 75,
    },
    disclaimer: 'Sygnał analityczny, nie rekomendacja inwestycyjna. Wyniki nie są zweryfikowane backtestem ani handlem forward. Poziomy nie uwzględniają spreadu, prowizji, poślizgu, swapów ani specyfiki brokera.',
  };
}
