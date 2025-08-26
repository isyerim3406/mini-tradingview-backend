import pkg from 'technicalindicators';
const { sma, ema, wma, tr, rma } = pkg;

// Hareketli Ortalama Hesaplaması
export const movingAverage = (data, period, type, options = {}) => {
    const { kidiv = 1 } = options;
    if (!data || data.length < period) return NaN;

    const values = data.map(d => typeof d === 'object' ? d.close : d);
    if (values.length < period) return NaN;

    let result;
    switch(type) {
        case 'SMA':
            result = sma({ period, values });
            break;
        case 'EMA':
            result = ema({ period, values });
            break;
        case 'WMA':
            result = wma({ period, values });
            break;
        case 'DEMA':
            const ema1 = ema({ period, values });
            if (ema1.length < period) return NaN;
            const ema2 = ema({ period, values: ema1 });
            if (ema2.length === 0) return NaN;
            result = ema1.map((val, i) => val && ema2[i] ? 2 * val - ema2[i] : NaN);
            break;
        case 'TEMA':
            const ema1_t = ema({ period, values });
            if (ema1_t.length < period) return NaN;
            const ema2_t = ema({ period, values: ema1_t });
            if (ema2_t.length < period) return NaN;
            const ema3_t = ema({ period, values: ema2_t });
            if (ema3_t.length === 0) return NaN;
            result = ema1_t.map((val, i) => val && ema2_t[i] && ema3_t[i] ? 3 * (val - ema2_t[i]) + ema3_t[i] : NaN);
            break;
        case 'TMA':
            const sma1 = sma({ period: Math.ceil(period / 2), values });
            if (sma1.length === 0) return NaN;
            result = sma({ period: Math.floor(period / 2) + 1, values: sma1 });
            break;
        case 'HMA':
            const wma1_h = wma({ period: Math.round(period / 2), values });
            const wma2_h = wma({ period, values });
            if (wma1_h.length === 0 || wma2_h.length === 0) return NaN;
            const diff = wma1_h.map((val, i) => 2 * (val || 0) - (wma2_h[i] || 0));
            result = wma({ period: Math.round(Math.sqrt(period)), values: diff });
            break;
        case 'LSMA':
            const lsmaValues = values.slice(-period);
            const n = lsmaValues.length;
            const sumX = (n * (n - 1)) / 2;
            const sumY = lsmaValues.reduce((a, b) => a + b, 0);
            const sumXY = lsmaValues.reduce((sum, y, x) => sum + x * y, 0);
            const sumX2 = lsmaValues.reduce((sum, _, x) => sum + x * x, 0);
            const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
            const intercept = (sumY - slope * sumX) / n;
            result = [intercept + slope * (n - 1)]; // Sadece son değeri döndür
            break;
        case 'Kijun v2':
            const kijunLength = period;
            const convLength = Math.max(1, Math.floor(period / kidiv));
            const highest = Math.max(...values.slice(-kijunLength));
            const lowest = Math.min(...values.slice(-kijunLength));
            const kijun = (highest + lowest) / 2;
            
            const convHighest = Math.max(...values.slice(-convLength));
            const convLowest = Math.min(...values.slice(-convLength));
            const conversionLine = (convHighest + convLowest) / 2;
            result = [(kijun + conversionLine) / 2]; // Sadece son değeri döndür
            break;
        case 'McGinley':
            // McGinley için özel hesaplama
            const mcginleyResult = [];
            let prev = sma({ period, values })[period - 1];
            mcginleyResult.push(prev);

            for(let i = period; i < values.length; i++) {
                const factor = period * Math.pow(values[i] / prev, 4);
                prev = prev + (values[i] - prev) / factor;
                mcginleyResult.push(prev);
            }
            result = mcginleyResult;
            break;
        default:
            result = sma({ period, values });
            break;
    }
    
    return result[result.length - 1];
};

// True Range Hesaplaması
const calculateTR = (high, low, close) => {
    const trArray = [];
    for (let i = 0; i < high.length; i++) {
        if (i === 0) {
            trArray.push(high[i] - low[i]);
        } else {
            const hl = high[i] - low[i];
            const hc = Math.abs(high[i] - close[i - 1]);
            const lc = Math.abs(low[i] - close[i - 1]);
            trArray.push(Math.max(hl, hc, lc));
        }
    }
    return trArray;
};

// ATR Hesaplaması
export const atr = (klines, length, smoothing) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);
    
    if (high.length < length) return NaN;

    const trueRange = calculateTR(high, low, close);

    let atrResult;
    switch (smoothing) {
        case 'RMA':
            atrResult = rma({ period: length, values: trueRange });
            break;
        case 'SMA':
            atrResult = sma({ period: length, values: trueRange });
            break;
        case 'EMA':
            atrResult = ema({ period: length, values: trueRange });
            break;
        case 'WMA':
        default:
            atrResult = wma({ period: length, values: trueRange });
            break;
    }

    if (!atrResult || atrResult.length === 0) return NaN;
    return atrResult[atrResult.length - 1];
};

// SSL1 Hesaplaması
export const ssl1 = (klines, length, maType, kidiv) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);

    const ssl1_emaHigh = movingAverage(high, length, maType, { kidiv });
    const ssl1_emaLow = movingAverage(low, length, maType, { kidiv });

    if (isNaN(ssl1_emaHigh) || isNaN(ssl1_emaLow)) return { ssl1Line: NaN, hlv: 0 };
    
    const lastClose = close[close.length - 1];
    const hlv = lastClose > ssl1_emaHigh ? 1 : lastClose < ssl1_emaLow ? -1 : 0;
    const ssl1_down = hlv < 0 ? ssl1_emaHigh : ssl1_emaLow;
    
    return { ssl1Line: ssl1_down, hlv };
};

// Kesişim Kontrolü
export const crossover = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    const current1 = series1[series1.length - 1];
    const current2 = series2[series2.length - 1];
    const prev1 = series1[series1.length - 2];
    const prev2 = series2[series2.length - 2];
    return prev1 <= prev2 && current1 > current2;
};

export const crossunder = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    const current1 = series1[series1.length - 1];
    const current2 = series2[series2.length - 1];
    const prev1 = series1[series1.length - 2];
    const prev2 = series2[series2.length - 2];
    return prev1 >= prev2 && current1 < current2;
};
