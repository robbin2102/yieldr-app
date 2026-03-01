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
// All 42 candlestick patterns split into 3 batches
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
// Max indicators per bulk request
const MAX_CALCS_PER_REQUEST = 20;
// Patterns per symbol in multi-construct (3 symbols × 6 patterns = 18 calcs ≤ 20)
const PATTERNS_PER_SYMBOL_PER_REQUEST = 6;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function postBulk(body, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(BULK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.status === 429) {
                const waitMs = 15000 * (attempt + 1);
                logger_1.logger.warn('TAAPI', `Rate limited (429), waiting ${waitMs}ms before retry ${attempt + 1}/${retries}`);
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
            logger_1.logger.warn('TAAPI', `Attempt ${attempt + 1} failed: ${err.message}, retrying...`);
            await sleep(2000 * (attempt + 1));
        }
    }
}
/**
 * Fetch BULK 1 — 20 core indicators for a single coin.
 * Returns structured indicator data.
 */
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
                { id: 'momentum', indicator: 'mom' },
                { id: 'bbands', indicator: 'bbands' },
                { id: 'atr_14', indicator: 'atr' },
                { id: 'vwap', indicator: 'vwap' },
                { id: 'obv', indicator: 'obv' },
                { id: 'cmf', indicator: 'cmf' },
                { id: 'ichimoku', indicator: 'ichimoku' },
                { id: 'supertrend', indicator: 'supertrend' },
                { id: 'psar', indicator: 'psar' },
                { id: 'pivot_points', indicator: 'pivotpoints' },
            ],
        },
    };
    const data = await postBulk(body);
    return parseSingleConstructResponse(data, symbol);
}
/**
 * Fetch BULK 2 — fibonacci + swing high/low for a group of 3 coins (multi-construct).
 * Returns map of { symbol → indicator data }.
 */
async function fetchStructureIndicators(symbols) {
    const constructs = symbols.map(sym => ({
        exchange: config_1.config.taapi.exchange,
        symbol: `${sym}/USDT`,
        interval: config_1.config.taapi.interval,
        indicators: [
            { id: 'fibonacci', indicator: 'fibretrace' },
            { id: 'swing_high', indicator: 'priorswingigh' },
            { id: 'swing_low', indicator: 'priorswinglow' },
        ],
    }));
    const body = { secret: config_1.config.taapi.apiKey, construct: constructs };
    const data = await postBulk(body);
    return parseMultiConstructResponse(data, symbols);
}
/**
 * Fetch a batch of candlestick patterns for a group of up to 3 coins (multi-construct).
 * patternsChunk: up to 6 patterns per symbol (3 × 6 = 18 calcs ≤ 20).
 */
async function fetchPatternBatch(symbols, patterns) {
    // Limit to 6 patterns per symbol to stay under 20 calc limit
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
    // BULK 1: core indicators (single coin)
    try {
        indicators = await fetchCoreIndicators(symbol);
        await sleep(config_1.config.taapi.rateDelayMs);
    }
    catch (err) {
        errors.push(`BULK1: ${err.message}`);
        logger_1.logger.warn('TAAPI', `${symbol} BULK1 failed: ${err.message}`);
    }
    // BULK 2: structure indicators (done in batches via fetchStructureForBatch)
    // Structure indicators are fetched in groups of 3 coins by the orchestrator.
    // This function only fetches BULK 1 and returns. Structure is merged externally.
    return { indicators, candlestick_patterns: [], errors };
}
/**
 * Orchestrator: fetch all TAAPI data for all 100 coins.
 * Returns map of { symbol → TaapiCoinData }.
 */
async function fetchAllCoins(coins) {
    const result = new Map();
    const errors = new Map();
    // Initialize results
    for (const coin of coins) {
        result.set(coin, { indicators: {}, candlestick_patterns: [], errors: [] });
        errors.set(coin, []);
    }
    logger_1.logger.info('TAAPI', `Starting fetch for ${coins.length} coins`);
    // ── BULK 1: Core indicators (1 request per coin) ──────────────────────────
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
    // ── BULK 2: Structure indicators (multi-construct, 3 coins per request) ───
    logger_1.logger.info('TAAPI', `BULK 2: Fetching structure indicators (${Math.ceil(coins.length / 3)} requests)`);
    for (let i = 0; i < coins.length; i += 3) {
        const group = coins.slice(i, i + 3);
        try {
            const structureData = await fetchStructureIndicators(group);
            for (const [sym, data] of structureData) {
                const existing = result.get(sym);
                if (existing) {
                    existing.indicators = { ...existing.indicators, ...data };
                }
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
    // ── BULK 3/4/5: Candlestick patterns (multi-construct, 3 coins × 6 patterns) ──
    for (let batchIdx = 0; batchIdx < ALL_PATTERN_BATCHES.length; batchIdx++) {
        const patternBatch = ALL_PATTERN_BATCHES[batchIdx];
        logger_1.logger.info('TAAPI', `Pattern batch ${batchIdx + 1}/${ALL_PATTERN_BATCHES.length}: ${patternBatch.length} patterns`);
        // Split patterns into chunks of PATTERNS_PER_SYMBOL_PER_REQUEST (6)
        for (let pOffset = 0; pOffset < patternBatch.length; pOffset += PATTERNS_PER_SYMBOL_PER_REQUEST) {
            const patternChunk = patternBatch.slice(pOffset, pOffset + PATTERNS_PER_SYMBOL_PER_REQUEST);
            // Process coins in groups of 3
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
                                    value: value,
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
    // Merge errors into results
    for (const [coin, errs] of errors) {
        if (errs.length > 0)
            result.get(coin).errors.push(...errs);
    }
    logger_1.logger.info('TAAPI', `Fetch complete for ${coins.length} coins`);
    return result;
}
// ─── Response Parsers ─────────────────────────────────────────────────────────
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
                indicators.stoch_rsi = {
                    k: result.valueFastK ?? null,
                    d: result.valueFastD ?? null,
                };
                break;
            case 'adx':
                indicators.adx = {
                    adx: result.value ?? null,
                    plus_di: result.valuePDI ?? null,
                    minus_di: result.valueMDI ?? null,
                };
                break;
            case 'momentum':
                indicators.momentum = result.value ?? null;
                break;
            case 'bbands':
                indicators.bbands = {
                    upper: result.valueUpperBand ?? null,
                    middle: result.valueMiddleBand ?? null,
                    lower: result.valueLowerBand ?? null,
                    bandwidth: result.valueBandWidth ?? null,
                };
                break;
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
                indicators.ichimoku = {
                    tenkan: result.valueTenkan ?? null,
                    kijun: result.valueKijun ?? null,
                    senkou_a: result.valueSenkouA ?? null,
                    senkou_b: result.valueSenkouB ?? null,
                    chikou: result.valueChikou ?? null,
                };
                break;
            case 'supertrend':
                indicators.supertrend = {
                    value: result.value ?? null,
                    direction: result.valueAdvice ?? null,
                };
                break;
            case 'psar':
                indicators.psar = result.value ?? null;
                break;
            case 'pivot_points':
                indicators.pivot_points = {
                    pp: result.valuePP ?? null,
                    r1: result.valueR1 ?? null,
                    r2: result.valueR2 ?? null,
                    r3: result.valueR3 ?? null,
                    s1: result.valueS1 ?? null,
                    s2: result.valueS2 ?? null,
                    s3: result.valueS3 ?? null,
                };
                break;
            default:
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
    // Multi-construct response: data.data is an array of arrays, indexed by construct
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
                default:
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