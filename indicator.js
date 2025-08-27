import { SMA, EMA, WMA } from 'technicalindicators';

function movingAverage(type, data, length) {
    if (type === 'SMA') return SMA.calculate({ period: length, values: data });
    if (type === 'EMA') return EMA.calculate({ period: length, values: data });
    if (type === 'WMA') return WMA.calculate({ period: length, values: data });
    // Basit şekilde diğer MA tipleri için SMA fallback
    return SMA.calculate({ period: length, values: data });
}

// SSL Hybrid hesaplaması
export function calculateSSLHybrid(klines, cfg) {
    const len = cfg.len;
    const atrLen = cfg.atrLen;
    const atrMult = cfg.atrMult;
    const maType = cfg.maType;
    const entrySignalType = cfg.entrySignalType;
    const mBarsBuy = cfg.mBarsBuy;
    const nBarsSell = cfg.nBarsSell;

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);

    const BBMC = movingAverage(maType, closes, len);

    // ATR hesaplama
    let tr = [];
    for (let i = 1; i < klines.length; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    const atr = movingAverage(cfg.atrSmoothing, tr, atrLen);

    const BBMC_upper_atr = BBMC.map((v, i) => v + (atr[i] || 0) * atrMult);
    const BBMC_lower_atr = BBMC.map((v, i) => v - (atr[i] || 0) * atrMult);

    // SSL1 çizgisi
    const sslHigh = movingAverage(maType, highs, len);
    const sslLow = movingAverage(maType, lows, len);
    let Hlv1 = [];
    let ssl1Down = [];
    for (let i = 0; i < closes.length; i++) {
        const prevHlv = Hlv1[i - 1] || 0;
        Hlv1[i] = closes[i] > (sslHigh[i] || closes[i]) ? 1 :
                  closes[i] < (sslLow[i] || closes[i]) ? -1 : prevHlv;
        ssl1Down[i] = Hlv1[i] < 0 ? (sslHigh[i] || closes[i]) : (sslLow[i] || closes[i]);
    }

    // BBMC+ATR giriş sayacı
    let consecutiveAbove = 0;
    let consecutiveBelow = 0;

    let result = [];

    for (let i = 0; i < closes.length; i++) {
        let buy = false, sell = false;

        if (entrySignalType === 'BBMC_ATR_BANDS') {
            if (closes[i] > (BBMC_upper_atr[i] || closes[i])) {
                consecutiveAbove++;
            } else {
                consecutiveAbove = 0;
            }
            if (closes[i] < (BBMC_lower_atr[i] || closes[i])) {
                consecutiveBelow++;
            } else {
                consecutiveBelow = 0;
            }
            if (consecutiveAbove >= mBarsBuy) buy = true;
            if (consecutiveBelow >= nBarsSell) sell = true;
        } else if (entrySignalType === 'SSL1_KESISIMI') {
            if (i > 0) {
                buy = closes[i - 1] < ssl1Down[i - 1] && closes[i] > ssl1Down[i];
                sell = closes[i - 1] > ssl1Down[i - 1] && closes[i] < ssl1Down[i];
            }
        }

        result.push({ buy, sell });
    }

    return result;
}
