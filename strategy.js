export function computeSignals(klines, CFG) {
    const len = CFG.LEN || 14;
    const atrLen = CFG.ATR_LEN || 14;
    const atrMult = CFG.ATR_MULT || 1.0;
    const maType = CFG.MA_TYPE || "SMA";
    const baselineSource = CFG.BASELINE_SOURCE || "close";

    const closes = klines.map(k => parseFloat(k.close));
    const highs = klines.map(k => parseFloat(k.high));
    const lows = klines.map(k => parseFloat(k.low));

    function SMA(arr, period) {
        if (arr.length < period) return null;
        const sum = arr.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
    }

    function EMA(arr, period) {
        if (arr.length < period) return null;
        const k = 2 / (period + 1);
        let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (let i = period; i < arr.length; i++) {
            ema = arr[i] * k + ema * (1 - k);
        }
        return ema;
    }

    function getMA(arr, period) {
        return maType === "EMA" ? EMA(arr, period) : SMA(arr, period);
    }

    // Baseline hesaplama
    const sourceArr = baselineSource === "close" ? closes :
                      baselineSource === "open" ? klines.map(k => k.open) :
                      baselineSource === "high" ? highs :
                      baselineSource === "low" ? lows : closes;

    const baseline = getMA(sourceArr, len);

    // ATR hesaplama (basit)
    function ATR(highs, lows, closes, period) {
        if (closes.length < period + 1) return null;
        let trs = [];
        for (let i = closes.length - period; i < closes.length; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
            trs.push(tr);
        }
        return trs.reduce((a, b) => a + b, 0) / period;
    }

    const atr = ATR(highs, lows, closes, atrLen);

    // Sinyal mantığı (örnek: SSL1 cross)
    let buy = false;
    let sell = false;
    if (klines.length >= 2) {
        const prevClose = closes[closes.length - 2];
        const lastClose = closes[closes.length - 1];

        if (prevClose < baseline && lastClose > baseline) buy = true;
        if (prevClose > baseline && lastClose < baseline) sell = true;
    }

    return { buy, sell, baseline, atr };
}
