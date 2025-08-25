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
