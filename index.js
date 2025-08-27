import { SMA, EMA, WMA } from 'technicalindicators';

function ma(source, length, type = 'SMA') {
    switch (type) {
        case 'EMA': return EMA.calculate({ period: length, values: source });
        case 'WMA': return WMA.calculate({ period: length, values: source });
        case 'SMA':
        default: return SMA.calculate({ period: length, values: source });
    }
}

function calculateATR(klines, atrLen, smoothing) {
    const tr = klines.map((k, i) => {
        if (i === 0) return k.high - k.low;
        const prevClose = klines[i - 1].close;
        return Math.max(
            k.high - k.low,
            Math.abs(k.high - prevClose),
            Math.abs(k.low - prevClose)
        );
    });
    return ma(tr, atrLen, smoothing);
}

export function computeSignals(klines, CFG) {
    const { LEN, ATR_LEN, ATR_SMOOTHING, ATR_MULT, MA_TYPE, BASELINE_SOURCE,
            M_BARS_BUY, N_BARS_SELL, ENTRY_SIGNAL_TYPE } = CFG;

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const baseSource = BASELINE_SOURCE === 'close' ? closes : lows;

    // BBMC hesaplama
    const BBMC = ma(baseSource, LEN, MA_TYPE);

    // ATR hesaplama
    const atrFull = calculateATR(klines, ATR_LEN, ATR_SMOOTHING);

    // BBMC_upper_atr & BBMC_lower_atr
    const BBMC_upper_atr = BBMC.map((v, i) => v + (atrFull[i] || 0) * ATR_MULT);
    const BBMC_lower_atr = BBMC.map((v, i) => v - (atrFull[i] || 0) * ATR_MULT);

    // Ardışık kapanış sayıları
    let consecutiveClosesAbove = 0;
    let consecutiveClosesBelow = 0;

    const lastIndex = klines.length - 1;
    let buySignal = false;
    let sellSignal = false;

    for (let i = 0; i <= lastIndex; i++) {
        const close = closes[i];
        const upper = BBMC_upper_atr[i] || 0;
        const lower = BBMC_lower_atr[i] || 0;

        if (ENTRY_SIGNAL_TYPE === 'BBMC_ATR_BANDS') {
            // Üst band üzeri
            if (close > upper) {
                consecutiveClosesAbove++;
            } else {
                consecutiveClosesAbove = 0;
            }
            // Alt band altı
            if (close < lower) {
                consecutiveClosesBelow++;
            } else {
                consecutiveClosesBelow = 0;
            }

            // Sinyal kontrolü sadece son bar
            if (i === lastIndex) {
                buySignal = consecutiveClosesAbove >= M_BARS_BUY;
                sellSignal = consecutiveClosesBelow >= N_BARS_SELL;
            }
        }
    }

    // Konsolda değerleri yazdır
    console.log({
        close: closes[lastIndex],
        BBMC_upper_atr: BBMC_upper_atr[lastIndex],
        BBMC_lower_atr: BBMC_lower_atr[lastIndex],
        consecutiveClosesAbove,
        consecutiveClosesBelow,
        buySignal,
        sellSignal
    });

    return { buy: buySignal, sell: sellSignal };
}
