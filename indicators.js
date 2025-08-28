import pkg from 'technicalindicators';
const { sma, ema, wma, rma } = pkg;

// Helper functions to find min/max in an array
const getLowest = (arr) => Math.min(...arr);
const getHighest = (arr) => Math.max(...arr);

// A flexible moving average function that supports SMA, EMA, WMA, and RMA
export const movingAverage = (source, length, type) => {
    if (source.length < length) return NaN;
    switch (type) {
        case 'SMA': return sma({ period: length, values: source }).at(-1);
        case 'EMA': return ema({ period: length, values: source }).at(-1);
        case 'WMA': return wma({ period: length, values: source }).at(-1);
        case 'RMA': return rma({ period: length, values: source }).at(-1);
        default: return sma({ period: length, values: source }).at(-1); // Default to SMA
    }
};

// ATR calculation using the same logic as the HTML file
export const atr = (klines, period, smoothingType) => {
    if (klines.length < period) return NaN;
    const trs = klines.slice(1).map((k, i) =>
        Math.max(k.high - k.low, Math.abs(k.high - klines[i].close), Math.abs(k.low - klines[i].close))
    );
    return movingAverage(trs, period, smoothingType);
};

// SSL1 calculation, simplified to match the HTML logic
export const ssl1 = (klines, length, maType) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);

    const ssl1_emaHigh = movingAverage(high, length, maType);
    const ssl1_emaLow = movingAverage(low, length, maType);

    if (isNaN(ssl1_emaHigh) || isNaN(ssl1_emaLow)) return { ssl1Line: NaN, hlv: 0 };
    
    // HLV (High/Low Value) check to determine the line's position
    const hlv = close.at(-1) > ssl1_emaHigh ? 1 : close.at(-1) < ssl1_emaLow ? -1 : 0;
    const ssl1_down = hlv < 0 ? ssl1_emaHigh : ssl1_emaLow;
    return { ssl1Line: ssl1_down, hlv };
};
