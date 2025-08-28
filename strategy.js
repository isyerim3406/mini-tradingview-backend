import { movingAverage, atr, ssl1 } from './indicators.js';

// All strategy parameters are now defined here for better modularity
export const CFG = {
    USE_STOPLOSS_AL: true,
    STOPLOSS_AL_PERCENT: 1.4,
    STOPLOSS_AL_ACTIVATION_BARS: 1,
    USE_STOPLOSS_SAT: true,
    STOPLOSS_SAT_PERCENT: 1.3,
    STOPLOSS_SAT_ACTIVATION_BARS: 1,
    LEN: 164,
    ATR_LEN: 14,
    ATR_MULT: 3.2,
    ATR_SMOOTHING: 'SMA',
    MA_TYPE: 'SMA',
    BASELINE_SOURCE: 'close',
    ENTRY_SIGNAL_TYPE: 'BBMC+ATR Bands',
    M_BARS_BUY: 1,
    N_BARS_SELL: 3
};

// Main function to compute signals based on current market data and position
export function computeSignals(klines, currentPosition, longEntryPrice, longEntryBarIndex, shortEntryPrice, shortEntryBarIndex) {
    // Check if there is enough data to calculate indicators
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN)) {
        return { type: 'none', message: 'Not enough data' };
    }

    const closePrices = klines.map(k => k.close);
    const lastClose = closePrices.at(-1);
    const currentBarIndex = klines.length - 1;

    // Determine the source prices for the baseline
    const sourcePrices = CFG.BASELINE_SOURCE === 'close' ? closePrices
        : CFG.BASELINE_SOURCE === 'open' ? klines.map(k => k.open)
        : CFG.BASELINE_SOURCE === 'high' ? klines.map(k => k.high)
        : klines.map(k => k.low);

    // Calculate indicators
    const baseline = movingAverage(sourcePrices, CFG.LEN, CFG.MA_TYPE);
    const atrValue = atr(klines, CFG.ATR_LEN, CFG.ATR_SMOOTHING);
    const bbmcUpperATR = baseline + atrValue * CFG.ATR_MULT;
    const bbmcLowerATR = baseline - atrValue * CFG.ATR_MULT;
    const ssl1Result = ssl1(klines, CFG.LEN, CFG.MA_TYPE);

    let signalType = 'none';
    let message = '';

    // Check for stop-loss and exit signals first
    if (currentPosition === 'long' && CFG.USE_STOPLOSS_AL && longEntryPrice !== null) {
        const stopLossPrice = longEntryPrice * (1 - CFG.STOPLOSS_AL_PERCENT / 100);
        if (currentBarIndex >= longEntryBarIndex + CFG.STOPLOSS_AL_ACTIVATION_BARS && lastClose <= stopLossPrice) {
            signalType = 'close';
            message = `POZİSYON KAPAT: Uzun SL (%${CFG.STOPLOSS_AL_PERCENT} düşüş)`;
            return { type: signalType, message: message };
        }
    } else if (currentPosition === 'short' && CFG.USE_STOPLOSS_SAT && shortEntryPrice !== null) {
        const stopLossPrice = shortEntryPrice * (1 + CFG.STOPLOSS_SAT_PERCENT / 100);
        if (currentBarIndex >= shortEntryBarIndex + CFG.STOPLOSS_SAT_ACTIVATION_BARS && lastClose >= stopLossPrice) {
            signalType = 'close';
            message = `POZİSYON KAPAT: Kısa SL (%${CFG.STOPLOSS_SAT_PERCENT} yükseliş)`;
            return { type: signalType, message: message };
        }
    }

    // Check for entry signals if no stop-loss triggered
    if (CFG.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
        const consecutiveClosesAbove = closePrices.slice(-CFG.M_BARS_BUY).every(c => c > bbmcUpperATR);
        const consecutiveClosesBelow = closePrices.slice(-CFG.N_BARS_SELL).every(c => c < bbmcLowerATR);

        if (consecutiveClosesAbove && currentPosition !== 'long') {
            signalType = 'buy';
            message = `AL: ${CFG.M_BARS_BUY} bar BBMC+ATR üstü`;
        } else if (consecutiveClosesBelow && currentPosition !== 'short') {
            signalType = 'sell';
            message = `SAT: ${CFG.N_BARS_SELL} bar BBMC+ATR altı`;
        }
    } else if (CFG.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
        const hlv = ssl1Result.hlv;
        if (hlv === 1 && currentPosition !== 'long') {
            signalType = 'buy';
            message = 'AL: SSL1 Kesişimi (Yükseliş)';
        } else if (hlv === -1 && currentPosition !== 'short') {
            signalType = 'sell';
            message = 'SAT: SSL1 Kesişimi (Düşüş)';
        }
    }
    
    // Check for position flips, which are a different type of signal
    if (signalType === 'buy' && currentPosition === 'short') {
        signalType = 'flip_long';
        message = 'YÖN DEĞİŞTİR: SAT pozisyonundan AL pozisyonuna geçiliyor.';
    } else if (signalType === 'sell' && currentPosition === 'long') {
        signalType = 'flip_short';
        message = 'YÖN DEĞİŞTİR: AL pozisyonundan SAT pozisyonuna geçiliyor.';
    }

    return { type: signalType, message: message };
}
