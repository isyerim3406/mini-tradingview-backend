import { ema, sma, wma, tr, rma } from 'technicalindicators';

// Yardımcı fonksiyonlar
const getAvg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const getLowest = (arr) => Math.min(...arr);
const getHighest = (arr) => Math.max(...arr);

// Hareketli Ortalama Fonksiyonu (Pine Script'teki 'ma' fonksiyonuna karşılık gelir)
export const movingAverage = (source, length, type, k) => {
    if (source.length < length) return NaN;

    switch (type) {
        case 'SMA':
            return sma({ period: length, values: source })[sma({ period: length, values: source }).length - 1];
        case 'EMA':
            return ema({ period: length, values: source })[ema({ period: length, values: source }).length - 1];
        case 'WMA':
            return wma({ period: length, values: source })[wma({ period: length, values: source }).length - 1];
        case 'DEMA':
            const ema1 = ema({ period: length, values: source });
            if (ema1.length < length) return NaN;
            const ema2 = ema({ period: length, values: ema1 });
            if (ema2.length < 1) return NaN;
            return 2 * ema1[ema1.length - 1] - ema2[ema2.length - 1];
        case 'TEMA':
            const ema_tema1 = ema({ period: length, values: source });
            if (ema_tema1.length < length) return NaN;
            const ema_tema2 = ema({ period: length, values: ema_tema1 });
            if (ema_tema2.length < 1) return NaN;
            const ema_tema3 = ema({ period: length, values: ema_tema2 });
            if (ema_tema3.length < 1) return NaN;
            return 3 * (ema_tema1[ema_tema1.length - 1] - ema_tema2[ema_tema2.length - 1]) + ema_tema3[ema_tema3.length - 1];
        case 'TMA':
            const sma1 = sma({ period: Math.ceil(length / 2), values: source });
            if (sma1.length < length) return NaN;
            const sma2 = sma({ period: Math.floor(length / 2) + 1, values: sma1 });
            if (sma2.length < 1) return NaN;
            return sma2[sma2.length - 1];
        case 'HMA':
            const hma_wma1 = wma({ period: Math.round(length / 2), values: source });
            const hma_wma2 = wma({ period: length, values: source });
            if (hma_wma1.length < 1 || hma_wma2.length < 1) return NaN;
            const hma_diff = hma_wma1.map((val, i) => 2 * val - hma_wma2[i]);
            return wma({ period: Math.round(Math.sqrt(length)), values: hma_diff })[hma_diff.length - 1];
        case 'LSMA':
            const values = source.slice(source.length - length);
            if (values.length < length) return NaN;
            const sumX = (length * (length - 1)) / 2;
            const sumY = getAvg(values);
            const sumXY = values.reduce((sum, y, i) => sum + (i * y), 0);
            const sumX2 = (length * (length - 1) * (2 * length - 1)) / 6;
            const m = (length * sumXY - sumX * sumY * length) / (length * sumX2 - sumX * sumX);
            return values[values.length - 1] + m;
        case 'Kijun v2':
            const length1 = length;
            const length2 = Math.max(1, Math.floor(length / k));
            const kijun = (getLowest(source.slice(source.length - length1).map(b => b.low)) + getHighest(source.slice(source.length - length1).map(b => b.high))) / 2;
            const conversion = (getLowest(source.slice(source.length - length2).map(b => b.low)) + getHighest(source.slice(source.length - length2).map(b => b.high))) / 2;
            return (kijun + conversion) / 2;
        case 'McGinley':
            // McGinley hesaplaması, geçmiş değerlere bağımlı olduğu için JS tarafında daha karmaşıktır.
            // Bu nedenle bu versiyonda desteklenmemektedir. SMA'ya düşürülecektir.
            console.warn('McGinley MA, JavaScript tarafında henüz desteklenmiyor. SMA olarak hesaplanacaktır.');
            return sma({ period: length, values: source })[sma({ period: length, values: source }).length - 1];
        default: // Default SMA
            return sma({ period: length, values: source })[sma({ period: length, values: source }).length - 1];
    }
};

// ATR Hesaplaması (Pine Script'teki 'atr' fonksiyonuna karşılık gelir)
export const atr = (klines, length, smoothing) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);
    
    if (high.length < length) return NaN;

    const trueRange = tr({ high, low, close });

    switch (smoothing) {
        case 'RMA':
            return rma({ period: length, values: trueRange })[trueRange.length - 1];
        case 'SMA':
            return sma({ period: length, values: trueRange })[trueRange.length - 1];
        case 'EMA':
            return ema({ period: length, values: trueRange })[trueRange.length - 1];
        case 'WMA':
            return wma({ period: length, values: trueRange })[trueRange.length - 1];
        default:
            return sma({ period: length, values: trueRange })[trueRange.length - 1];
    }
};

// SSL1 Çizgisi Hesaplaması
export const ssl1 = (klines, length, maType, kidiv) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);

    const ssl1_emaHigh = movingAverage(high, length, maType, kidiv);
    const ssl1_emaLow = movingAverage(low, length, maType, kidiv);

    if (isNaN(ssl1_emaHigh) || isNaN(ssl1_emaLow)) return { ssl1Line: NaN, hlv: 0 };
    
    const hlv = close[close.length - 1] > ssl1_emaHigh ? 1 : close[close.length - 1] < ssl1_emaLow ? -1 : 0;
    const ssl1_down = hlv < 0 ? ssl1_emaHigh : ssl1_emaLow;
    
    return { ssl1Line: ssl1_down, hlv: hlv };
};
