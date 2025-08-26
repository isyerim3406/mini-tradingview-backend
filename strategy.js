import { movingAverage, atr, ssl1 } from './indicators.js';

let consecutive_closes_above_entry_target = 0;
let consecutive_closes_below_entry_target = 0;
let lastSignalType = null; // En son üretilen sinyal türünü tutar (buy, sell veya null)

export function computeSignals(klines, CFG) {
    if (klines.length < CFG.LEN) {
        return { buy: false, sell: false };
    }

    const baselineSource = getBaselineSource(klines, CFG.BASELINE_SOURCE);
    const BBMC = movingAverage(baselineSource, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
    const atrValue = atr(klines, CFG.ATR_LEN, CFG.ATR_SMOOTHING);

    if (isNaN(BBMC) || isNaN(atrValue)) {
        return { buy: false, sell: false };
    }

    const BBMC_upper_atr = BBMC + atrValue * CFG.ATR_MULT;
    const BBMC_lower_atr = BBMC - atrValue * CFG.ATR_MULT;
    const currentClose = klines[klines.length - 1].close;

    let buySignal = false;
    let sellSignal = false;

    // Giriş Sinyallerini Seç
    if (CFG.ENTRY_SIGNAL_TYPE === 'BBMC_ATR_BANDS') {
        if (currentClose > BBMC_upper_atr) {
            consecutive_closes_above_entry_target++;
            consecutive_closes_below_entry_target = 0;
        } else if (currentClose < BBMC_lower_atr) {
            consecutive_closes_below_entry_target++;
            consecutive_closes_above_entry_target = 0;
        } else {
            consecutive_closes_above_entry_target = 0;
            consecutive_closes_below_entry_target = 0;
        }

        if (consecutive_closes_above_entry_target >= CFG.M_BARS_BUY) {
            buySignal = true;
        }
        if (consecutive_closes_below_entry_target >= CFG.N_BARS_SELL) {
            sellSignal = true;
        }
    } else if (CFG.ENTRY_SIGNAL_TYPE === 'SSL1_KESISIMI') {
        const ssl1Result = ssl1(klines, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);
        const previousClose = klines[klines.length - 2].close;

        // Pine'ın `ta.crossover` ve `ta.crossunder` fonksiyonlarının mantığı
        if (currentClose > ssl1Result.ssl1Line && previousClose <= ssl1Result.ssl1Line) {
            buySignal = true;
        }
        if (currentClose < ssl1Result.ssl1Line && previousClose >= ssl1Result.ssl1Line) {
            sellSignal = true;
        }
    }

    // Bir sonraki mumda tekrar sinyal göndermesini engellemek için
    if (buySignal && lastSignalType === 'buy') {
        buySignal = false;
    }
    if (sellSignal && lastSignalType === 'sell') {
        sellSignal = false;
    }

    if (buySignal) {
        lastSignalType = 'buy';
    } else if (sellSignal) {
        lastSignalType = 'sell';
    } else {
        lastSignalType = null;
    }

    return { buy: buySignal, sell: sellSignal };
}

function getBaselineSource(klines, sourceStr) {
    switch (sourceStr) {
        case 'open':
            return klines.map(b => b.open);
        case 'high':
            return klines.map(b => b.high);
        case 'low':
            return klines.map(b => b.low);
        case 'hl2':
            return klines.map(b => (b.high + b.low) / 2);
        case 'hlc3':
            return klines.map(b => (b.high + b.low + b.close) / 3);
        case 'ohlc4':
            return klines.map(b => (b.open + b.high + b.low + b.close) / 4);
        case 'close':
        default:
            return klines.map(b => b.close);
    }
}
