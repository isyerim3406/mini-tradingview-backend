import { calculateSSLHybrid } from './indicator.js';

export function computeSignals(klines, CFG) {
    // .env değerlerini al
    const {
        ENTRY_SIGNAL_TYPE,
        LEN,
        ATR_LEN,
        ATR_SMOOTHING,
        ATR_MULT,
        MA_TYPE,
        BASELINE_SOURCE,
        KIDIV,
        M_BARS_BUY,
        N_BARS_SELL
    } = CFG;

    // SSL Hybrid hesaplamasını yap
    const sslData = calculateSSLHybrid(klines, {
        entrySignalType: ENTRY_SIGNAL_TYPE,
        len: parseInt(LEN),
        atrLen: parseInt(ATR_LEN),
        atrSmoothing: ATR_SMOOTHING,
        atrMult: parseFloat(ATR_MULT),
        maType: MA_TYPE,
        baseSource: BASELINE_SOURCE,
        kiDiv: parseInt(KIDIV),
        mBarsBuy: parseInt(M_BARS_BUY),
        nBarsSell: parseInt(N_BARS_SELL)
    });

    // Son bar sinyali
    const last = sslData[sslData.length - 1] || {};
    return { buy: !!last.buy, sell: !!last.sell };
}
