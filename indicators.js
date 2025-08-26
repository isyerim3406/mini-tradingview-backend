import pkg from 'technicalindicators';

const {
  SMA,
  EMA,
  WMA,
  DEMA,
  TEMA,
  TMA,
  HMA,
  LSMA,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  Stochastic,
  MovingAverage,
} = pkg;

// Hatalı RMA hesaplaması düzeltildi
export const calculateRMA = (source, len) => {
    if (source.length < len) return null;
    let rma = [EMA.calculate({ period: len, values: source.slice(0, len) })[0]];
    for (let i = len; i < source.length; i++) {
        let prevRMA = rma[rma.length - 1];
        let newRMA = (source[i] * (1 / len)) + prevRMA * (1 - (1 / len));
        rma.push(newRMA);
    }
    return rma;
};

// KiJun v2 hesaplaması TradingView mantığına uyarlandı
export const calculateKiJun = (klines, len, kidiv) => {
    if (klines.length < len) return null;
    const len1 = len;
    const len2 = Math.max(1, Math.floor(len / kidiv));
    
    let kijunLine = [];
    let conversionLine = [];
    
    for (let i = len1 - 1; i < klines.length; i++) {
        let highestHigh = 0;
        let lowestLow = Infinity;
        for (let j = i - len1 + 1; j <= i; j++) {
            highestHigh = Math.max(highestHigh, klines[j].high);
            lowestLow = Math.min(lowestLow, klines[j].low);
        }
        kijunLine.push((highestHigh + lowestLow) / 2);
    }

    for (let i = len2 - 1; i < klines.length; i++) {
        let highestHigh = 0;
        let lowestLow = Infinity;
        for (let j = i - len2 + 1; j <= i; j++) {
            highestHigh = Math.max(highestHigh, klines[j].high);
            lowestLow = Math.min(lowestLow, klines[j].low);
        }
        conversionLine.push((highestHigh + lowestLow) / 2);
    }

    let result = [];
    for (let i = 0; i < kijunLine.length; i++) {
        let delta = (kijunLine[i] + conversionLine[i]) / 2;
        result.push(delta);
    }

    return result;
};

export const moving = (type, source, len, { high, low, kidiv }) => {
    if (source.length < len) return null;
    let ma;

    switch (type.toLowerCase()) {
        case 'sma':
            ma = SMA.calculate({ period: len, values: source });
            break;
        case 'ema':
            ma = EMA.calculate({ period: len, values: source });
            break;
        case 'dema':
            ma = DEMA.calculate({ period: len, values: source });
            break;
        case 'tema':
            ma = TEMA.calculate({ period: len, values: source });
            break;
        case 'lsma':
            ma = LSMA.calculate({ period: len, values: source });
            break;
        case 'wma':
            ma = WMA.calculate({ period: len, values: source });
            break;
        case 'tma':
            ma = TMA.calculate({ period: len, values: source });
            break;
        case 'hma':
            ma = HMA.calculate({ period: len, values: source });
            break;
        case 'kijun v2':
            ma = calculateKiJun({ high, low }, len, kidiv);
            break;
        default:
            ma = null;
    }
    return ma;
};

export const ssl1Line = (klines, len, maType) => {
    const close = klines.map(k => k.close);
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);

    const ssl1_emaHigh = moving(maType, high, len);
    const ssl1_emaLow = moving(maType, low, len);

    let ssl1_down = [];
    let hlv1 = 0;
    
    for (let i = 0; i < klines.length; i++) {
        let currentClose = close[i];
        let currentEmaHigh = ssl1_emaHigh[i];
        let currentEmaLow = ssl1_emaLow[i];
        
        if (currentClose > currentEmaHigh) {
            hlv1 = 1;
        } else if (currentClose < currentEmaLow) {
            hlv1 = -1;
        }

        if (hlv1 === -1) {
            ssl1_down.push(currentEmaHigh);
        } else {
            ssl1_down.push(currentEmaLow);
        }
    }
    
    return ssl1_down;
};

export function atr(klines, period, smoothing) {
    if (klines.length < period + 1) return null;

    const trs = klines.slice(1).map((kline, i) => {
        const prevClose = klines[i].close;
        return Math.max(
            kline.high - kline.low,
            Math.abs(kline.high - prevClose),
            Math.abs(kline.low - prevClose)
        );
    });

    let atrs;
    switch (smoothing.toUpperCase()) {
        case 'RMA':
            atrs = calculateRMA(trs, period);
            break;
        case 'EMA':
            atrs = EMA.calculate({ period: period, values: trs });
            break;
        case 'SMA':
            atrs = SMA.calculate({ period: period, values: trs });
            break;
        case 'WMA':
            atrs = WMA.calculate({ period: period, values: trs });
            break;
        default:
            atrs = SMA.calculate({ period: period, values: trs });
            break;
    }

    return atrs;
}import pkg from 'technicalindicators';

const {
  SMA,
  EMA,
  WMA,
  DEMA,
  TEMA,
  TMA,
  HMA,
  LSMA,
  ATR,
  RSI,
  MACD,
  BollingerBands,
  Stochastic,
  MovingAverage,
} = pkg;

export const calculateSMA = (source, len) => {
  if (source.length < len) return null;
  return SMA.calculate({ period: len, values: source });
};

export const calculateEMA = (source, len) => {
  if (source.length < len) return null;
  return EMA.calculate({ period: len, values: source });
};

export const calculateRMA = (source, len) => {
  if (source.length < len) return null;
  return EMA.calculate({ period: len, values: source });
};

export const calculateWMA = (source, len) => {
  if (source.length < len) return null;
  return WMA.calculate({ period: len, values: source });
};

export const calculateDEMA = (source, len) => {
  if (source.length < len) return null;
  return DEMA.calculate({ period: len, values: source });
};

export const calculateTEMA = (source, len) => {
  if (source.length < len) return null;
  return TEMA.calculate({ period: len, values: source });
};

export const calculateTMA = (source, len) => {
  if (source.length < len) return null;
  return TMA.calculate({ period: len, values: source });
};

export const calculateHMA = (source, len) => {
  if (source.length < len) return null;
  return HMA.calculate({ period: len, values: source });
};

export const calculateLSMA = (source, len) => {
  if (source.length < len) return null;
  return LSMA.calculate({ period: len, values: source });
};

export const calculateKiJun = (source, len) => {
  // TradingView stratejinizdeki Kijun-sen mantığı
  if (source.length < len) return null;
  let high = 0;
  let low = Infinity;
  for (let i = source.length - len; i < source.length; i++) {
    if (source[i].high > high) high = source[i].high;
    if (source[i].low < low) low = source[i].low;
  }
  return (high + low) / 2;
};

