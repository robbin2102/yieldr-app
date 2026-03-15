"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCoreIndicators = fetchCoreIndicators;
exports.fetchStructureIndicators = fetchStructureIndicators;
exports.fetchPatternBatch = fetchPatternBatch;
exports.fetchAllForCoin = fetchAllForCoin;
exports.fetchAllCoins = fetchAllCoins;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const BULK_URL = `${config_1.config.taapi.baseUrl}/bulk`;
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
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Direct GET request for indicators that return null in /bulk on binancefutures
// (psar, squeeze, fibonacciretracement, priorswinghigh, priorswinglow all affected)
async function getDirect(endpoint, params, retries = 5) {
    const url = new URL(`${config_1.config.taapi.baseUrl}/${endpoint}`);
    url.searchParams.set('secret', config_1.config.taapi.apiKey);
    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(url.toString());
            if (res.status === 429) {
                const waitMs = 15000 * Math.pow(2, attempt);
                logger_1.logger.warn('TAAPI', `Rate limited (429) on ${endpoint}, waiting ${waitMs / 1000}s`);
                await sleep(waitMs);
                continue;
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`TAAPI ${endpoint} ${res.status}: ${text.slice(0, 200)}`);
            }
            return await res.json();
        }
        catch (err) {
            if (attempt === retries - 1)
                throw err;
            const cause = err.cause ? ` (cause: ${err.cause?.message ?? err.cause})` : '';
            logger_1.logger.warn('TAAPI', `${endpoint} attempt ${attempt + 1} failed: ${err.message}${cause}, retrying...`);
            await sleep(2000 * (attempt + 1));
        }
    }
}
async function postBulk(body, retries = 5) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(BULK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 429) {
                // TAAPI rate limit windows reset every 15s; wait 15s × 2^attempt
                const waitMs = 15000 * Math.pow(2, attempt); // 15s, 30s, 60s, 120s, 240s
                logger_1.logger.warn('TAAPI', `Rate limited (429), waiting ${waitMs / 1000}s before retry ${attempt + 1}/${retries}`);
                await sleep(waitMs);
                continue;
            }
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`TAAPI ${res.status}: ${text.slice(0, 200)}`);
            }
            return await res.json();
        }
        catch (err) {
            if (attempt === retries - 1)
                throw err;
            const cause = err.cause ? ` (cause: ${err.cause?.message ?? err.cause})` : '';
            logger_1.logger.warn('TAAPI', `Attempt ${attempt + 1} failed: ${err.message}${cause}, retrying...`);
            await sleep(2000 * (attempt + 1));
        }
    }
}
async function fetchCoreIndicators(symbol) {
    const taapiSymbol = `${symbol}/USDT`;
    const body = {
        secret: config_1.config.taapi.apiKey,
        construct: {
            exchange: config_1.config.taapi.exchange,
            symbol: taapiSymbol,
            interval: config_1.config.taapi.interval,
            indicators: [
                { id: 'ema_8', indicator: 'ema', period: 8 },
                { id: 'ema_21', indicator: 'ema', period: 21 },
                { id: 'ema_50', indicator: 'ema', period: 50 },
                { id: 'ema_200', indicator: 'ema', period: 200 },
                { id: 'sma_50', indicator: 'sma', period: 50 },
                { id: 'sma_200', indicator: 'sma', period: 200 },
                { id: 'rsi_14', indicator: 'rsi' },
                { id: 'macd', indicator: 'macd' },
                { id: 'stochrsi', indicator: 'stochrsi' },
                { id: 'adx', indicator: 'adx' },
                { id: 'plus_di', indicator: 'plus_di' },
                { id: 'minus_di', indicator: 'minus_di' },
                { id: 'momentum', indicator: 'mom' },
                { id: 'bbands', indicator: 'bbands' },
                { id: 'atr_14', indicator: 'atr' },
                { id: 'vwap', indicator: 'vwap' },
                { id: 'obv', indicator: 'obv' },
                { id: 'cmf', indicator: 'cmf' },
                { id: 'ichimoku', indicator: 'ichimoku' },
                { id: 'supertrend', indicator: 'supertrend' },
                // psar/squeeze/fibonacciretracement/priorswinghigh/priorswinglow: fetched via direct GET
                //   (TAAPI /bulk returns null for these on binancefutures — same issue as pivot_points)
                // pivot_points: computed locally from Binance prev-day OHLC
            ],
        },
    };
    const data = await postBulk(body);
    return parseSingleConstructResponse(data, symbol);
}
async function fetchStructureIndicators(symbols) {
    const result = new Map();
    // psar, squeeze, fibonacciretracement, priorswinghigh, priorswinglow all return null
    // when fetched via /bulk on binancefutures — same issue as pivot_points. Use direct GETs.
    for (const sym of symbols) {
        const base = {
            exchange: config_1.config.taapi.exchange,
            symbol: `${sym}/USDT`,
            interval: config_1.config.taapi.interval,
        };
        const indicators = {};
        // psar → { value }
        try {
            const r = await getDirect('psar', base);
            indicators.psar = r?.value ?? null;
        }
        catch (err) {
            logger_1.logger.warn('TAAPI', `${sym} psar failed: ${err.message}`);
        }
        await sleep(config_1.config.taapi.rateDelayMs);
        // squeeze → { value, squeeze }
        try {
            const r = await getDirect('squeeze', base);
            indicators.squeeze = { value: r?.value ?? null, is_squeeze: r?.squeeze ?? null };
        }
        catch (err) {
            logger_1.logger.warn('TAAPI', `${sym} squeeze failed: ${err.message}`);
        }
        await sleep(config_1.config.taapi.rateDelayMs);
        // fibonacciretracement → { value, trend, startPrice, endPrice, ... }
        try {
            const r = await getDirect('fibonacciretracement', { ...base, period: 50, trend: 'auto' });
            indicators.fibonacci = parseFibonacci(r);
        }
        catch (err) {
            logger_1.logger.warn('TAAPI', `${sym} fibonacciretracement failed: ${err.message}`);
        }
        await sleep(config_1.config.taapi.rateDelayMs);
        // priorswinghigh → { valueClose, valueHigh }
        try {
            const r = await getDirect('priorswinghigh', base);
            indicators.swing_high = { close: r?.valueClose ?? null, high: r?.valueHigh ?? null };
        }
        catch (err) {
            logger_1.logger.warn('TAAPI', `${sym} priorswinghigh failed: ${err.message}`);
        }
        await sleep(config_1.config.taapi.rateDelayMs);
        // priorswinglow → { valueClose, valueLow }
        try {
            const r = await getDirect('priorswinglow', base);
            indicators.swing_low = { close: r?.valueClose ?? null, low: r?.valueLow ?? null };
        }
        catch (err) {
            logger_1.logger.warn('TAAPI', `${sym} priorswinglow failed: ${err.message}`);
        }
        result.set(sym, indicators);
    }
    return result;
}
async function fetchPatternBatch(symbols, patterns) {
    const patternsChunk = patterns.slice(0, PATTERNS_PER_SYMBOL_PER_REQUEST);
    const constructs = symbols.map(sym => ({
        exchange: config_1.config.taapi.exchange,
        symbol: `${sym}/USDT`,
        interval: config_1.config.taapi.interval,
        indicators: patternsChunk.map(p => ({ id: p, indicator: p })),
    }));
    const body = { secret: config_1.config.taapi.apiKey, construct: constructs };
    const data = await postBulk(body);
    return parsePatternResponse(data, symbols);
}
async function fetchAllForCoin(symbol) {
    const errors = [];
    let indicators = {};
    try {
        indicators = await fetchCoreIndicators(symbol);
        await sleep(config_1.config.taapi.rateDelayMs);
    }
    catch (err) {
        errors.push(`BULK1: ${err.message}`);
        logger_1.logger.warn('TAAPI', `${symbol} BULK1 failed: ${err.message}`);
    }
    try {
        const structureData = await fetchStructureIndicators([symbol]);
        const extra = structureData.get(symbol);
        if (extra)
            indicators = { ...indicators, ...extra };
        await sleep(config_1.config.taapi.rateDelayMs);
    }
    catch (err) {
        errors.push(`BULK2: ${err.message}`);
        logger_1.logger.warn('TAAPI', `${symbol} BULK2 failed: ${err.message}`);
    }
    return { indicators, candlestick_patterns: [], errors };
}
async function fetchAllCoins(coins) {
    const result = new Map();
    const errors = new Map();
    for (const coin of coins) {
        result.set(coin, { indicators: {}, candlestick_patterns: [], errors: [] });
        errors.set(coin, []);
    }
    logger_1.logger.info('TAAPI', `Starting fetch for ${coins.length} coins`);
    // BULK 1: Core indicators
    logger_1.logger.info('TAAPI', `BULK 1: Fetching core indicators (${coins.length} requests)`);
    for (let i = 0; i < coins.length; i++) {
        const coin = coins[i];
        try {
            const indicators = await fetchCoreIndicators(coin);
            result.get(coin).indicators = indicators;
            logger_1.logger.debug('TAAPI', `BULK1 ${i + 1}/${coins.length} ${coin} ✓`);
        }
        catch (err) {
            errors.get(coin).push(`BULK1: ${err.message}`);
            logger_1.logger.warn('TAAPI', `BULK1 ${coin} failed: ${err.message}`);
        }
        if (i < coins.length - 1)
            await sleep(config_1.config.taapi.rateDelayMs);
    }
    // BULK 2: Structure indicators (3 coins per request)
    logger_1.logger.info('TAAPI', `BULK 2: Fetching structure indicators (${Math.ceil(coins.length / 3)} requests)`);
    for (let i = 0; i < coins.length; i += 3) {
        const group = coins.slice(i, i + 3);
        try {
            const structureData = await fetchStructureIndicators(group);
            for (const [sym, data] of structureData) {
                const existing = result.get(sym);
                if (existing)
                    existing.indicators = { ...existing.indicators, ...data };
            }
            logger_1.logger.debug('TAAPI', `BULK2 group ${Math.floor(i / 3) + 1}/${Math.ceil(coins.length / 3)} ✓`);
        }
        catch (err) {
            for (const sym of group)
                errors.get(sym).push(`BULK2: ${err.message}`);
            logger_1.logger.warn('TAAPI', `BULK2 group [${group.join(',')}] failed: ${err.message}`);
        }
        if (i + 3 < coins.length)
            await sleep(config_1.config.taapi.rateDelayMs);
    }
    // BULK 3/4/5: Candlestick patterns
    for (let batchIdx = 0; batchIdx < ALL_PATTERN_BATCHES.length; batchIdx++) {
        const patternBatch = ALL_PATTERN_BATCHES[batchIdx];
        logger_1.logger.info('TAAPI', `Pattern batch ${batchIdx + 1}/${ALL_PATTERN_BATCHES.length}: ${patternBatch.length} patterns`);
        for (let pOffset = 0; pOffset < patternBatch.length; pOffset += PATTERNS_PER_SYMBOL_PER_REQUEST) {
            const patternChunk = patternBatch.slice(pOffset, pOffset + PATTERNS_PER_SYMBOL_PER_REQUEST);
            for (let i = 0; i < coins.length; i += 3) {
                const group = coins.slice(i, i + 3);
                try {
                    const patternData = await fetchPatternBatch(group, patternChunk);
                    for (const [sym, patterns] of patternData) {
                        const coinData = result.get(sym);
                        if (!coinData)
                            continue;
                        for (const [patternName, value] of Object.entries(patterns)) {
                            if (value !== 0 && value !== null && value !== undefined) {
                                coinData.candlestick_patterns.push({
                                    pattern: patternName,
                                    value,
                                    timeframe: config_1.config.taapi.interval,
                                });
                            }
                        }
                    }
                }
                catch (err) {
                    for (const sym of group)
                        errors.get(sym).push(`PATTERN_B${batchIdx + 1}: ${err.message}`);
                    logger_1.logger.warn('TAAPI', `Pattern batch ${batchIdx + 1} group [${group.join(',')}] failed: ${err.message}`);
                }
                if (i + 3 < coins.length || pOffset + PATTERNS_PER_SYMBOL_PER_REQUEST < patternBatch.length) {
                    await sleep(config_1.config.taapi.rateDelayMs);
                }
            }
        }
    }
    for (const [coin, errs] of errors) {
        if (errs.length > 0)
            result.get(coin).errors.push(...errs);
    }
    logger_1.logger.info('TAAPI', `Fetch complete for ${coins.length} coins`);
    return result;
}
// ─── Response Parsers ─────────────────────────────────────────────────────────
// API response: { value, trend, startPrice, endPrice, startTimestamp, endTimestamp }
// `value` is the level at the requested retracement param (default 0.618).
// Compute all standard levels from startPrice/endPrice instead.
function parseFibonacci(res) {
    const startPrice = res.startPrice ?? null;
    const endPrice = res.endPrice ?? null;
    if (startPrice == null || endPrice == null)
        return null;
    const trend = (res.trend ?? '').toUpperCase();
    // DOWNTREND: startPrice=high, endPrice=low  |  UPTREND: startPrice=low, endPrice=high
    const high = trend === 'UPTREND' ? endPrice : startPrice;
    const low = trend === 'UPTREND' ? startPrice : endPrice;
    const range = high - low;
    return {
        trend,
        level_236: low + range * 0.236,
        level_382: low + range * 0.382,
        level_500: low + range * 0.500,
        level_618: low + range * 0.618,
        level_786: low + range * 0.786,
    };
}
function parseSingleConstructResponse(data, symbol) {
    const indicators = {};
    if (!data?.data) {
        logger_1.logger.warn('TAAPI', `${symbol}: unexpected response format`, data);
        return indicators;
    }
    for (const item of data.data) {
        const id = item.id;
        const result = item.result;
        if (!id || result === undefined || result === null)
            continue;
        switch (id) {
            case 'ema_8':
                indicators.ema_8 = result.value ?? null;
                break;
            case 'ema_21':
                indicators.ema_21 = result.value ?? null;
                break;
            case 'ema_50':
                indicators.ema_50 = result.value ?? null;
                break;
            case 'ema_200':
                indicators.ema_200 = result.value ?? null;
                break;
            case 'sma_50':
                indicators.sma_50 = result.value ?? null;
                break;
            case 'sma_200':
                indicators.sma_200 = result.value ?? null;
                break;
            case 'rsi_14':
                indicators.rsi_14 = result.value ?? null;
                break;
            case 'macd':
                indicators.macd = {
                    macd_line: result.valueMACD ?? null,
                    signal_line: result.valueMACDSignal ?? null,
                    histogram: result.valueMACDHist ?? null,
                };
                break;
            case 'stochrsi':
                indicators.stoch_rsi = { k: result.valueFastK ?? null, d: result.valueFastD ?? null };
                break;
            case 'adx':
                // 'adx' indicator only returns the ADX line; DI lines come from plusdi/minusdi below
                if (!indicators.adx)
                    indicators.adx = { adx: null, plus_di: null, minus_di: null };
                indicators.adx.adx = result.value ?? null;
                break;
            case 'plus_di':
                if (!indicators.adx)
                    indicators.adx = { adx: null, plus_di: null, minus_di: null };
                indicators.adx.plus_di = result.value ?? null;
                break;
            case 'minus_di':
                if (!indicators.adx)
                    indicators.adx = { adx: null, plus_di: null, minus_di: null };
                indicators.adx.minus_di = result.value ?? null;
                break;
            case 'momentum':
                indicators.momentum = result.value ?? null;
                break;
            case 'bbands': {
                const bbUpper = result.valueUpperBand ?? null;
                const bbMiddle = result.valueMiddleBand ?? null;
                const bbLower = result.valueLowerBand ?? null;
                // Compute bandwidth if API doesn't return it: (upper - lower) / middle * 100
                const bbWidth = result.valueBandWidth ??
                    (bbUpper != null && bbLower != null && bbMiddle != null && bbMiddle !== 0
                        ? ((bbUpper - bbLower) / bbMiddle) * 100
                        : null);
                indicators.bbands = { upper: bbUpper, middle: bbMiddle, lower: bbLower, bandwidth: bbWidth };
                break;
            }
            case 'atr_14':
                indicators.atr_14 = result.value ?? null;
                break;
            case 'vwap':
                indicators.vwap = result.value ?? null;
                break;
            case 'obv':
                indicators.obv = result.value ?? null;
                break;
            case 'cmf':
                indicators.cmf = result.value ?? null;
                break;
            case 'ichimoku':
                // TAAPI response fields (individual & bulk): conversion, base, spanA, spanB,
                // currentSpanA, currentSpanB, laggingSpanA, laggingSpanB
                indicators.ichimoku = {
                    tenkan: result.conversion ?? null, // conversion line (Tenkan-sen)
                    kijun: result.base ?? null, // base line (Kijun-sen)
                    senkou_a: result.spanA ?? null, // future cloud span A (displaced +26)
                    senkou_b: result.spanB ?? null, // future cloud span B (displaced +26)
                    current_span_a: result.currentSpanA ?? null, // cloud span A at current bar
                    current_span_b: result.currentSpanB ?? null, // cloud span B at current bar
                    lagging_span_a: result.laggingSpanA ?? null, // lagging span A (chikou context)
                    lagging_span_b: result.laggingSpanB ?? null, // lagging span B
                };
                break;
            case 'supertrend':
                indicators.supertrend = { value: result.value ?? null, direction: result.valueAdvice ?? null };
                break;
            case 'psar':
                indicators.psar = result.value ?? null;
                break;
            case 'squeeze':
                // TAAPI squeeze response: { value, squeeze }
                indicators.squeeze = { value: result.value ?? null, is_squeeze: result.squeeze ?? null };
                break;
            case 'swing_high':
                // priorswinghigh response: { valueClose, valueHigh }
                indicators.swing_high = {
                    close: result.valueClose ?? null,
                    high: result.valueHigh ?? null,
                };
                break;
            case 'swing_low':
                // priorswinglow response: { valueClose, valueLow }
                indicators.swing_low = {
                    close: result.valueClose ?? null,
                    low: result.valueLow ?? null,
                };
                break;
            case 'fibonacci':
                logger_1.logger.debug('TAAPI', `Fibonacci raw: ${JSON.stringify(result)}`);
                indicators.fibonacci = parseFibonacci(result);
                break;
            case 'pivot_points':
                logger_1.logger.debug('TAAPI', `Pivot points raw: ${JSON.stringify(result)}`);
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
function parseMultiConstructResponse(data, symbols) {
    const result = new Map();
    for (const sym of symbols)
        result.set(sym, {});
    if (!data?.data)
        return result;
    for (let ci = 0; ci < symbols.length && ci < data.data.length; ci++) {
        const sym = symbols[ci];
        const constructResults = data.data[ci];
        if (!Array.isArray(constructResults))
            continue;
        const indicators = {};
        for (const item of constructResults) {
            const id = item.id;
            const res = item.result;
            if (!id || !res)
                continue;
            switch (id) {
                case 'fibonacci':
                    logger_1.logger.debug('TAAPI', `Fibonacci raw: ${JSON.stringify(res)}`);
                    indicators.fibonacci = parseFibonacci(res);
                    break;
                case 'psar':
                    indicators.psar = res.value ?? null;
                    break;
                case 'squeeze':
                    indicators.squeeze = { value: res.value ?? null, is_squeeze: res.squeeze ?? null };
                    break;
                case 'swing_high':
                    indicators.swing_high = {
                        close: res.valueClose ?? null,
                        high: res.valueHigh ?? null,
                    };
                    break;
                case 'swing_low':
                    indicators.swing_low = {
                        close: res.valueClose ?? null,
                        low: res.valueLow ?? null,
                    };
                    break;
            }
        }
        result.set(sym, indicators);
    }
    return result;
}
function parsePatternResponse(data, symbols) {
    const result = new Map();
    for (const sym of symbols)
        result.set(sym, {});
    if (!data?.data)
        return result;
    for (let ci = 0; ci < symbols.length && ci < data.data.length; ci++) {
        const sym = symbols[ci];
        const constructResults = data.data[ci];
        if (!Array.isArray(constructResults))
            continue;
        const patterns = {};
        for (const item of constructResults) {
            if (item.id && item.result?.value !== undefined) {
                patterns[item.id] = item.result.value;
            }
        }
        result.set(sym, patterns);
    }
    return result;
}
//# sourceMappingURL=taapi.js.map