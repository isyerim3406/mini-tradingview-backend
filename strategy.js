import { SMA } from 'technicalindicators';

// Yardımcı fonksiyon: ATR hesaplama
export function calculateATR(klines, atrLen) {
    const tr = [];
    for (let i = 1; i < klines.length; i++) {
        const high = klines[i].high;
        const low = klines[i].low;
        const prevClose = klines[i - 1].close;
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    // SMA ile ATR
    const atr = [];
    for (let i = 0; i < tr.length; i++) {
        if (i + 1 < atrLen) {
            atr.push(null); // ATR hesaplanamaz
        } else {
            const slice = tr.slice(i + 1 - atrLen, i + 1);
            const sma = slice.reduce((a, b) => a + b, 0) / atrLen;
            atr.push(sma);
        }
    }
    atr.unshift(null); // İlk bar için
    return atr;
}

// Yardımcı fonksiyon: Basit hareketli ortalama
export function calculateSMA(values, len) {
    return SMA.calculate({ period: len, values });
}

// BBMC + ATR sinyal hesaplama
export function computeSignals(klines, CFG) {
    const len = parseInt(process.env.LEN) || 164;
    const atrLen = parseInt(process.env.ATR_LEN) || 14;
    const atrMult = parseFloat(process.env.ATR_MULT) || 3.2;
    const mBarsBuy = parseInt(process.env.M_BARS_BUY) || 1;
    const nBarsSell = parseInt(process.env.N_BARS_SELL) || 3;

    if (klines.length < len + 1) return { buy: false, sell: false };

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);

    const smaClose = calculateSMA(closes, len);
    const atr = calculateATR(klines, atrLen);

    const lastIndex = klines.length - 1;
    const lastClose = closes[lastIndex];
    const lastSMA = smaClose[lastIndex] || 0;
    const lastATR = atr[lastIndex] || 0;

    const BBMC_upper_atr = lastSMA + atrMult * lastATR;
    const BBMC_lower_atr = lastSMA - atrMult * lastATR;

    // Ardışık bar sayımı
    let consecutiveClosesAbove = 0;
    let consecutiveClosesBelow = 0;

    for (let i = lastIndex; i >= 0 && i >= lastIndex - Math.max(mBarsBuy, nBarsSell) + 1; i--) {
        if (closes[i] > BBMC_upper_atr) consecutiveClosesAbove++;
        if (closes[i] < BBMC_lower_atr) consecutiveClosesBelow++;
    }

    const buySignal = consecutiveClosesAbove >= mBarsBuy;
    const sellSignal = consecutiveClosesBelow >= nBarsSell;

    return { buy: buySignal, sell: sellSignal };
}
