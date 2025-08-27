import { movingAverage, atr, ssl1, crossover, crossunder } from './indicators.js';

export function computeSignals(klines, CFG) {
    if (klines.length < CFG.LEN) {
        return { buy: false, sell: false };
    }

    const closePrices = klines.map(k => k.close);
    const lastClose = closePrices[closePrices.length - 1];

    const baseline = movingAverage(closePrices, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
    const atrValue = atr(klines, CFG.ATR_LEN, CFG.ATR_SMOOTHING);

    const bbmcUpperATR = baseline + atrValue * CFG.ATR_MULT;
    const bbmcLowerATR = baseline - atrValue * CFG.ATR_MULT;

    const ssl1Result = ssl1(klines, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
    const ssl1Line = ssl1Result.ssl1Line;

    let buySignal = false;
    let sellSignal = false;

    if (CFG.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
        let consecutiveClosesAbove = 0;
        for (let i = closePrices.length - 1; i >= 0 && i >= closePrices.length - CFG.M_BARS_BUY; i--) {
            if (closePrices[i] > bbmcUpperATR) {
                consecutiveClosesAbove++;
            }
        }
        let consecutiveClosesBelow = 0;
        for (let i = closePrices.length - 1; i >= 0 && i >= closePrices.length - CFG.N_BARS_SELL; i--) {
            if (closePrices[i] < bbmcLowerATR) {
                consecutiveClosesBelow++;
            }
        }

        buySignal = consecutiveClosesAbove >= CFG.M_BARS_BUY;
        sellSignal = consecutiveClosesBelow >= CFG.N_BARS_SELL;
    } 
    else if (CFG.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
        const prevClose = closePrices[closePrices.length - 2];
        const prevSsl1 = ssl1(klines.slice(0, -1), CFG.LEN, CFG.MA_TYPE, CFG.KIDIV).ssl1Line;

        if (crossover([prevClose, lastClose], [prevSsl1, ssl1Line])) {
            buySignal = true;
        }
        if (crossunder([prevClose, lastClose], [prevSsl1, ssl1Line])) {
            sellSignal = true;
        }
    }

    return { buy: buySignal, sell: sellSignal };
}
