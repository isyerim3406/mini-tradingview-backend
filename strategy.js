// strategy.js
import { movingAverage, atr, ssl1, crossover, crossunder } from './indicators.js';

export function computeSignals(klines, CFG) {
    if (klines.length < CFG.LEN) {
        return { buy: false, sell: false };
    }

    // Baseline kaynağı seçimi (close, hl2, ohlc4)
    let source;
    switch (CFG.BASELINE_SOURCE) {
        case 'hl2':
            source = klines.map(k => (k.high + k.low) / 2);
            break;
        case 'ohlc4':
            source = klines.map(k => (k.open + k.high + k.low + k.close) / 4);
            break;
        default: // close
            source = klines.map(k => k.close);
    }

    const lastClose = source[source.length - 1];

    // Baseline hesaplama
    const baseline = movingAverage(source, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);

    // ATR ve BBMC üst-alt band
    const atrValue = atr(klines, CFG.ATR_LEN, CFG.ATR_SMOOTHING);
    const bbmcUpperATR = baseline + atrValue * CFG.ATR_MULT;
    const bbmcLowerATR = baseline - atrValue * CFG.ATR_MULT;

    // SSL1 hesaplama
    const ssl1Result = ssl1(klines, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
    const ssl1Line = ssl1Result.ssl1Line;

    let buySignal = false;
    let sellSignal = false;

    if (CFG.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
        const consecutiveClosesAbove = source.slice(-CFG.M_BARS_BUY).every(c => c > bbmcUpperATR);
        const consecutiveClosesBelow = source.slice(-CFG.N_BARS_SELL).every(c => c < bbmcLowerATR);

        if (consecutiveClosesAbove) buySignal = true;
        if (consecutiveClosesBelow) sellSignal = true;

    } else if (CFG.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
        if (klines.length < 2) return { buy: false, sell: false };
        const prevSource = source[source.length - 2];
        const prevSsl1Line = ssl1(klines.slice(0, -1), CFG.LEN, CFG.MA_TYPE, CFG.KIDIV).ssl1Line;

        if (crossover([prevSource, lastClose], [prevSsl1Line, ssl1Line])) buySignal = true;
        if (crossunder([prevSource, lastClose], [prevSsl1Line, ssl1Line])) sellSignal = true;
    }

    return { buy: buySignal, sell: sellSignal };
}

