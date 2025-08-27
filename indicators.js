import pkg from 'technicalindicators';
const { sma, ema, wma, rma } = pkg;

// Yardımcı fonksiyonlar
const getAvg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const getLowest = (arr) => Math.min(...arr);
const getHighest = (arr) => Math.max(...arr);

// Hareketli Ortalama Fonksiyonu
export const movingAverage = (source, length, type, k) => {
    if (source.length < length) return NaN;
    switch (type) {
        case 'SMA': return sma({ period: length, values: source }).at(-1);
        case 'EMA': return ema({ period: length, values: source }).at(-1);
        case 'WMA': return wma({ period: length, values: source }).at(-1);
        case 'RMA': return rma({ period: length, values: source }).at(-1);
        case 'Kijun v2':
            const length1 = length;
            const length2 = Math.max(1, Math.floor(length / k));
            const kijun = (getLowest(source.slice(-length1).map(b => b.low)) + getHighest(source.slice(-length1).map(b => b.high))) / 2;
            const conversion = (getLowest(source.slice(-length2).map(b => b.low)) + getHighest(source.slice(-length2).map(b => b.high))) / 2;
            return (kijun + conversion) / 2;
        default: return sma({ period: length, values: source }).at(-1);
    }
};

// True Range Hesaplaması
const calculateTR = (klines) => {
    const trArray = [];
    for (let i = 0; i < klines.length; i++) {
        if (i === 0) trArray.push(klines[i].high - klines[i].low);
        else {
            const hl = klines[i].high - klines[i].low;
            const hpc = Math.abs(klines[i].high - klines[i-1].close);
            const lpc = Math.abs(klines[i].low - klines[i-1].close);
            trArray.push(Math.max(hl, hpc, lpc));
        }
    }
    return trArray;
};

// ATR Hesaplaması
export const atr = (klines, length, smoothing) => {
    const trueRange = calculateTR(klines);
    if (trueRange.length < length) return NaN;
    switch (smoothing) {
        case 'RMA': return rma({ period: length, values: trueRange }).at(-1);
        case 'SMA': return sma({ period: length, values: trueRange }).at(-1);
        case 'EMA': return ema({ period: length, values: trueRange }).at(-1);
        case 'WMA': return wma({ period: length, values: trueRange }).at(-1);
        default: return sma({ period: length, values: trueRange }).at(-1);
    }
};

// SSL1 Hesaplaması
export const ssl1 = (klines, length, maType, kidiv) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);

    const ssl1_emaHigh = movingAverage(high, length, maType, kidiv);
    const ssl1_emaLow = movingAverage(low, length, maType, kidiv);

    if (isNaN(ssl1_emaHigh) || isNaN(ssl1_emaLow)) return { ssl1Line: NaN, hlv: 0 };
    const hlv = close.at(-1) > ssl1_emaHigh ? 1 : close.at(-1) < ssl1_emaLow ? -1 : 0;
    const ssl1_down = hlv < 0 ? ssl1_emaHigh : ssl1_emaLow;
    return { ssl1Line: ssl1_down, hlv };
};

export const crossover = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    const current1 = series1.at(-1), current2 = series2.at(-1);
    const prev1 = series1.at(-2), prev2 = series2.at(-2);
    return prev1 <= prev2 && current1 > current2;
};

export const crossunder = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    const current1 = series1.at(-1), current2 = series2.at(-1);
    const prev1 = series1.at(-2), prev2 = series2.at(-2);
    return prev1 >= prev2 && current1 < current2;
};
