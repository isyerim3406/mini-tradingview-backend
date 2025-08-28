import { movingAverage, atr, ssl1, crossover, crossunder } from './indicators.js';

export function computeSignals(klines, CFG, position, longEntryPrice, longEntryBarIndex, shortEntryPrice, shortEntryBarIndex) {
    if (klines.length < CFG.LEN) return { type: 'none', message: 'Not enough data' };

    const closePrices = klines.map(k => k.close);
    const sourcePrices = CFG.BASELINE_SOURCE === 'close' ? closePrices
        : CFG.BASELINE_SOURCE === 'open' ? klines.map(k => k.open)
        : CFG.BASELINE_SOURCE === 'high' ? klines.map(k => k.high)
        : klines.map(k => k.low);

    const lastClose = closePrices.at(-1);
    const baseline = movingAverage(sourcePrices, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
    const atrValue = atr(klines, CFG.ATR_LEN, CFG.ATR_SMOOTHING);

    const bbmcUpperATR = baseline + atrValue * CFG.ATR_MULT;
    const bbmcLowerATR = baseline - atrValue * CFG.ATR_MULT;
    
    const ssl1Result = ssl1(klines, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
    const ssl1Line = ssl1Result.ssl1Line;

    // Stop-loss logic for long position
    if (position === 'long' && longEntryPrice && CFG.USE_STOPLOSS_AL) {
        const stopLossPrice = longEntryPrice * (1 - CFG.STOPLOSS_AL_PERCENT / 100);
        const consecutiveBars = klines.slice(longEntryBarIndex).slice(-CFG.STOPLOSS_AL_ACTIVATION_BARS);
        const stopLossTriggered = consecutiveBars.every(bar => bar.close < stopLossPrice);

        if (stopLossTriggered) {
            return { type: 'close', message: 'Stop-loss triggered on long position' };
        }
    }

    // Stop-loss logic for short position
    if (position === 'short' && shortEntryPrice && CFG.USE_STOPLOSS_SAT) {
        const stopLossPrice = shortEntryPrice * (1 + CFG.STOPLOSS_SAT_PERCENT / 100);
        const consecutiveBars = klines.slice(shortEntryBarIndex).slice(-CFG.STOPLOSS_SAT_ACTIVATION_BARS);
        const stopLossTriggered = consecutiveBars.every(bar => bar.close > stopLossPrice);
        
        if (stopLossTriggered) {
            return { type: 'close', message: 'Stop-loss triggered on short position' };
        }
    }

    // Entry signal logic
    let entryAction = { type: 'none', message: 'Neutral' };
    if (CFG.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
        const consecutiveClosesAbove = closePrices.slice(-CFG.M_BARS_BUY).every(c => c > bbmcUpperATR);
        const consecutiveClosesBelow = closePrices.slice(-CFG.N_BARS_SELL).every(c => c < bbmcLowerATR);
        
        if (consecutiveClosesAbove && position !== 'long') {
            entryAction = { type: position === 'short' ? 'flip_long' : 'buy', message: 'AL sinyali: BBMC+ATR bands üzeri' };
        } else if (consecutiveClosesBelow && position !== 'short') {
            entryAction = { type: position === 'long' ? 'flip_short' : 'sell', message: 'SAT sinyali: BBMC+ATR bands altı' };
        }
    } else if (CFG.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
        const prevClose = closePrices.at(-2);
        const prevSsl1 = ssl1(klines.slice(0, -1), CFG.LEN, CFG.MA_TYPE, CFG.KIDIV).ssl1Line;
        
        if (crossover([prevClose, lastClose], [prevSsl1, ssl1Line]) && position !== 'long') {
            entryAction = { type: position === 'short' ? 'flip_long' : 'buy', message: 'AL sinyali: SSL1 kesişimi' };
        } else if (crossunder([prevClose, lastClose], [prevSsl1, ssl1Line]) && position !== 'short') {
            entryAction = { type: position === 'long' ? 'flip_short' : 'sell', message: 'SAT sinyali: SSL1 kesişimi' };
        }
    }

    // If an entry or flip signal is found, return it. Otherwise, stay neutral.
    if (entryAction.type !== 'none') {
        return entryAction;
    }

    // Default return for no action
    return { type: 'none', message: 'Neutral' };
}
