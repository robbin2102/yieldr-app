import { config } from '../config';
import { logger } from '../utils/logger';

export interface TaapiCoinData {
  indicators: Record<string, unknown>;
  candlestick_patterns: Array<{ pattern: string; value: number; timeframe: string }>;
  errors: string[];
}

const BULK_URL = `${config.taapi.baseUrl}/bulk`;

const PATTERN_BATCH_1 = [
  'engulfing', 'hammer', 'doji', 'morningstar', 'eveningstar', 'shootingstar',
  '3whitesoldiers', '3blackcrows', 'harami', 'piercing', 'darkcloudcover',
  'dragonflydoji', 'gravestonedoji', 'spinningtop', 'marubozu', 'hangingman',
  'invertedhammer', 'abandonedbaby', 'belthold', 'breakaway',
];
const PATTERN_BATCH_2 = [
  'closingmarubozu', 'concealbabyswall', 'counterattack', 'dojistar',
  'gapsidesidewhite', 'highwave', 'hikkake', 'homingpigeon', 'identical3crows',
  'inneck', 'kicking', 'ladderbottom', 'longleggeddoji', 'matchinglow', 'mathold',
  'morningdojistar', 'onneck', 'rickshawman', 'separatinglines', 'sticksandwich',
];
const PATTERN_BATCH_3 = [
  'takuri', 'tasukigap', 'thrusting', 'tristar', 'unique3river',
  'upsidegap2crows', 'xsidegap3methods',
];
const ALL_PATTERN_BATCHES = [PATTERN_BATCH_1, PATTERN_BATCH_2, PATTERN_BATCH_3];

const PATTERNS_PER_SYMBOL_PER_REQUEST = 6;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function postBulk(body: object, retries = 3): Promise<any> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(BULK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        const waitMs = 15000 * (attempt + 1);
        logger.warn('TAAPI', `Rate limited (429), waiting ${waitMs}ms before retry ${attempt + 1}/${retries}`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`TAAPI ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err: any) {
      if (attempt === retries - 1) throw err;
      logger.warn('TAAPI', `Attempt ${attempt + 1} failed: ${err.message}, retrying...`);
      await sleep(2000 * (attempt + 1));
    }
  }
}

export async function fetchCoreIndicators(symbol: string): Promise<Record<string, unknown>> {
  const taapiSymbol = `${symbol}/USDT`;
  const body = {
    secret: config.taapi.apiKey,
    construct: {
      exchange: config.taapi.exchange,
      symbol: taapiSymbol,
      interval: config.taapi.interval,
      indicators: [
        { id: 'ema_8',       indicator: 'ema', period: 8 },
        { id: 'ema_21',      indicator: 'ema', period: 21 },
        { id: 'ema_50',      indicator: 'ema', period: 50 },
        { id: 'ema_200',     indicator: 'ema', period: 200 },
        { id: 'sma_50',      indicator: 'sma', period: 50 },
        { id: 'sma_200',     indicator: 'sma', period: 200 },
        { id: 'rsi_14',      indicator: 'rsi' },
        { id: 'macd',        indicator: 'macd' },
        { id: 'stochrsi',    indicator: 'stochrsi' },
        { id: 'adx',         indicator: 'adx' },
        { id: 'plus_di',     indicator: 'plusdi' },
        { id: 'minus_di',    indicator: 'minusdi' },
        { id: 'momentum',    indicator: 'mom' },
        { id: 'bbands',      indicator: 'bbands' },
        { id: 'atr_14',      indicator: 'atr' },
        { id: 'vwap',        indicator: 'vwap' },
        { id: 'obv',         indicator: 'obv' },
        { id: 'cmf',         indicator: 'cmf' },
        { id: 'ichimoku',    indicator: 'ichimoku' },
        { id: 'supertrend',  indicator: 'supertrend' },
        { id: 'psar',        indicator: 'psar' },
        { id: 'pivot_points', indicator: 'pivotpoints' },
      ],
    },
  };
  const data = await postBulk(body);
  return parseSingleConstructResponse(data, symbol);
}

export async function fetchStructureIndicators(symbols: string[]): Promise<Map<string, Record<string, unknown>>> {
  const constructs = symbols.map(sym => ({
    exchange: config.taapi.exchange,
    symbol: `${sym}/USDT`,
    interval: config.taapi.interval,
    indicators: [
      { id: 'fibonacci', indicator: 'fibonacciretracement' },
    ],
  }));
  const body = { secret: config.taapi.apiKey, construct: constructs };
  const data = await postBulk(body);
  return parseMultiConstructResponse(data, symbols);
}

export async function fetchPatternBatch(
  symbols: string[],
  patterns: string[],
): Promise<Map<string, Record<string, number>>> {
  const patternsChunk = patterns.slice(0, PATTERNS_PER_SYMBOL_PER_REQUEST);
  const constructs = symbols.map(sym => ({
    exchange: config.taapi.exchange,
    symbol: `${sym}/USDT`,
    interval: config.taapi.interval,
    indicators: patternsChunk.map(p => ({ id: p, indicator: p })),
  }));
  const body = { secret: config.taapi.apiKey, construct: constructs };
  const data = await postBulk(body);
  return parsePatternResponse(data, symbols);
}

export async function fetchAllForCoin(symbol: string): Promise<TaapiCoinData> {
  const errors: string[] = [];
  let indicators: Record<string, unknown> = {};
  try {
    indicators = await fetchCoreIndicators(symbol);
    await sleep(config.taapi.rateDelayMs);
  } catch (err: any) {
    errors.push(`BULK1: ${err.message}`);
    logger.warn('TAAPI', `${symbol} BULK1 failed: ${err.message}`);
  }
  return { indicators, candlestick_patterns: [], errors };
}

export async function fetchAllCoins(coins: string[]): Promise<Map<string, TaapiCoinData>> {
  const result = new Map<string, TaapiCoinData>();
  const errors = new Map<string, string[]>();

  for (const coin of coins) {
    result.set(coin, { indicators: {}, candlestick_patterns: [], errors: [] });
    errors.set(coin, []);
  }

  logger.info('TAAPI', `Starting fetch for ${coins.length} coins`);

  // BULK 1: Core indicators
  logger.info('TAAPI', `BULK 1: Fetching core indicators (${coins.length} requests)`);
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    try {
      const indicators = await fetchCoreIndicators(coin);
      result.get(coin)!.indicators = indicators;
      logger.debug('TAAPI', `BULK1 ${i + 1}/${coins.length} ${coin} ✓`);
    } catch (err: any) {
      errors.get(coin)!.push(`BULK1: ${err.message}`);
      logger.warn('TAAPI', `BULK1 ${coin} failed: ${err.message}`);
    }
    if (i < coins.length - 1) await sleep(config.taapi.rateDelayMs);
  }

  // BULK 2: Structure indicators (3 coins per request)
  logger.info('TAAPI', `BULK 2: Fetching structure indicators (${Math.ceil(coins.length / 3)} requests)`);
  for (let i = 0; i < coins.length; i += 3) {
    const group = coins.slice(i, i + 3);
    try {
      const structureData = await fetchStructureIndicators(group);
      for (const [sym, data] of structureData) {
        const existing = result.get(sym);
        if (existing) existing.indicators = { ...existing.indicators, ...data };
      }
      logger.debug('TAAPI', `BULK2 group ${Math.floor(i / 3) + 1}/${Math.ceil(coins.length / 3)} ✓`);
    } catch (err: any) {
      for (const sym of group) errors.get(sym)!.push(`BULK2: ${err.message}`);
      logger.warn('TAAPI', `BULK2 group [${group.join(',')}] failed: ${err.message}`);
    }
    if (i + 3 < coins.length) await sleep(config.taapi.rateDelayMs);
  }

  // BULK 3/4/5: Candlestick patterns
  for (let batchIdx = 0; batchIdx < ALL_PATTERN_BATCHES.length; batchIdx++) {
    const patternBatch = ALL_PATTERN_BATCHES[batchIdx];
    logger.info('TAAPI', `Pattern batch ${batchIdx + 1}/${ALL_PATTERN_BATCHES.length}: ${patternBatch.length} patterns`);

    for (let pOffset = 0; pOffset < patternBatch.length; pOffset += PATTERNS_PER_SYMBOL_PER_REQUEST) {
      const patternChunk = patternBatch.slice(pOffset, pOffset + PATTERNS_PER_SYMBOL_PER_REQUEST);
      for (let i = 0; i < coins.length; i += 3) {
        const group = coins.slice(i, i + 3);
        try {
          const patternData = await fetchPatternBatch(group, patternChunk);
          for (const [sym, patterns] of patternData) {
            const coinData = result.get(sym);
            if (!coinData) continue;
            for (const [patternName, value] of Object.entries(patterns)) {
              if (value !== 0 && value !== null && value !== undefined) {
                coinData.candlestick_patterns.push({
                  pattern: patternName,
                  value,
                  timeframe: config.taapi.interval,
                });
              }
            }
          }
        } catch (err: any) {
          for (const sym of group) errors.get(sym)!.push(`PATTERN_B${batchIdx + 1}: ${err.message}`);
          logger.warn('TAAPI', `Pattern batch ${batchIdx + 1} group [${group.join(',')}] failed: ${err.message}`);
        }
        if (i + 3 < coins.length || pOffset + PATTERNS_PER_SYMBOL_PER_REQUEST < patternBatch.length) {
          await sleep(config.taapi.rateDelayMs);
        }
      }
    }
  }

  for (const [coin, errs] of errors) {
    if (errs.length > 0) result.get(coin)!.errors.push(...errs);
  }

  logger.info('TAAPI', `Fetch complete for ${coins.length} coins`);
  return result;
}

// ─── Response Parsers ─────────────────────────────────────────────────────────

function parseSingleConstructResponse(data: any, symbol: string): Record<string, unknown> {
  const indicators: Record<string, unknown> = {};
  if (!data?.data) {
    logger.warn('TAAPI', `${symbol}: unexpected response format`, data);
    return indicators;
  }
  for (const item of data.data) {
    const id = item.id;
    const result = item.result;
    if (!id || result === undefined || result === null) continue;
    switch (id) {
      case 'ema_8':        indicators.ema_8   = result.value ?? null; break;
      case 'ema_21':       indicators.ema_21  = result.value ?? null; break;
      case 'ema_50':       indicators.ema_50  = result.value ?? null; break;
      case 'ema_200':      indicators.ema_200 = result.value ?? null; break;
      case 'sma_50':       indicators.sma_50  = result.value ?? null; break;
      case 'sma_200':      indicators.sma_200 = result.value ?? null; break;
      case 'rsi_14':       indicators.rsi_14  = result.value ?? null; break;
      case 'macd':
        indicators.macd = {
          macd_line:   result.valueMACD       ?? null,
          signal_line: result.valueMACDSignal ?? null,
          histogram:   result.valueMACDHist   ?? null,
        };
        break;
      case 'stochrsi':
        indicators.stoch_rsi = { k: result.valueFastK ?? null, d: result.valueFastD ?? null };
        break;
      case 'adx':
        // 'adx' indicator only returns the ADX line; DI lines come from plusdi/minusdi below
        if (!indicators.adx) indicators.adx = { adx: null, plus_di: null, minus_di: null };
        (indicators.adx as any).adx = result.value ?? null;
        break;
      case 'plus_di':
        if (!indicators.adx) indicators.adx = { adx: null, plus_di: null, minus_di: null };
        (indicators.adx as any).plus_di = result.value ?? null;
        break;
      case 'minus_di':
        if (!indicators.adx) indicators.adx = { adx: null, plus_di: null, minus_di: null };
        (indicators.adx as any).minus_di = result.value ?? null;
        break;
      case 'momentum':   indicators.momentum = result.value ?? null; break;
      case 'bbands': {
        const bbUpper  = result.valueUpperBand  ?? null;
        const bbMiddle = result.valueMiddleBand ?? null;
        const bbLower  = result.valueLowerBand  ?? null;
        // Compute bandwidth if API doesn't return it: (upper - lower) / middle * 100
        const bbWidth  = result.valueBandWidth  ??
          (bbUpper != null && bbLower != null && bbMiddle != null && bbMiddle !== 0
            ? ((bbUpper - bbLower) / bbMiddle) * 100
            : null);
        indicators.bbands = { upper: bbUpper, middle: bbMiddle, lower: bbLower, bandwidth: bbWidth };
        break;
      }
      case 'atr_14':     indicators.atr_14 = result.value ?? null; break;
      case 'vwap':       indicators.vwap   = result.value ?? null; break;
      case 'obv':        indicators.obv    = result.value ?? null; break;
      case 'cmf':        indicators.cmf    = result.value ?? null; break;
      case 'ichimoku':
        // TAAPI response fields (individual & bulk): conversion, base, spanA, spanB,
        // currentSpanA, currentSpanB, laggingSpanA, laggingSpanB
        indicators.ichimoku = {
          tenkan:          result.conversion    ?? null,  // conversion line (Tenkan-sen)
          kijun:           result.base          ?? null,  // base line (Kijun-sen)
          senkou_a:        result.spanA         ?? null,  // future cloud span A (displaced +26)
          senkou_b:        result.spanB         ?? null,  // future cloud span B (displaced +26)
          current_span_a:  result.currentSpanA  ?? null,  // cloud span A at current bar
          current_span_b:  result.currentSpanB  ?? null,  // cloud span B at current bar
          lagging_span_a:  result.laggingSpanA  ?? null,  // lagging span A (chikou context)
          lagging_span_b:  result.laggingSpanB  ?? null,  // lagging span B
        };
        break;
      case 'supertrend':
        indicators.supertrend = { value: result.value ?? null, direction: result.valueAdvice ?? null };
        break;
      case 'psar':        indicators.psar = result.value ?? null; break;
      case 'pivot_points':
        logger.debug('TAAPI', `Pivot points raw: ${JSON.stringify(result)}`);
        indicators.pivot_points = {
          pp: result.valuePP ?? result.pp ?? null,
          r1: result.valueR1 ?? result.r1 ?? null,
          r2: result.valueR2 ?? result.r2 ?? null,
          r3: result.valueR3 ?? result.r3 ?? null,
          s1: result.valueS1 ?? result.s1 ?? null,
          s2: result.valueS2 ?? result.s2 ?? null,
          s3: result.valueS3 ?? result.s3 ?? null,
        };
        break;
    }
  }
  return indicators;
}

function parseMultiConstructResponse(data: any, symbols: string[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const sym of symbols) result.set(sym, {});
  if (!data?.data) return result;

  for (let ci = 0; ci < symbols.length && ci < data.data.length; ci++) {
    const sym = symbols[ci];
    const constructResults = data.data[ci];
    if (!Array.isArray(constructResults)) continue;
    const indicators: Record<string, unknown> = {};
    for (const item of constructResults) {
      const id = item.id;
      const res = item.result;
      if (!id || !res) continue;
      switch (id) {
        case 'fibonacci':
          indicators.fibonacci = {
            level_236: res.value236 ?? null,
            level_382: res.value382 ?? null,
            level_500: res.value500 ?? null,
            level_618: res.value618 ?? null,
            level_786: res.value786 ?? null,
          };
          break;
        case 'swing_high':
          indicators.swing_high = {
            price: res.value ?? null,
            timestamp: res.timestamp ? new Date(res.timestamp) : null,
          };
          break;
        case 'swing_low':
          indicators.swing_low = {
            price: res.value ?? null,
            timestamp: res.timestamp ? new Date(res.timestamp) : null,
          };
          break;
      }
    }
    result.set(sym, indicators);
  }
  return result;
}

function parsePatternResponse(data: any, symbols: string[]): Map<string, Record<string, number>> {
  const result = new Map<string, Record<string, number>>();
  for (const sym of symbols) result.set(sym, {});
  if (!data?.data) return result;

  for (let ci = 0; ci < symbols.length && ci < data.data.length; ci++) {
    const sym = symbols[ci];
    const constructResults = data.data[ci];
    if (!Array.isArray(constructResults)) continue;
    const patterns: Record<string, number> = {};
    for (const item of constructResults) {
      if (item.id && item.result?.value !== undefined) {
        patterns[item.id] = item.result.value;
      }
    }
    result.set(sym, patterns);
  }
  return result;
}
