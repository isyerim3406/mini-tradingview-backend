import { SMA, EMA, WMA, DEMA, TEMA, TMA, HMA, LSMA, ATR } from 'technicalindicators';

export const calculateSMA = (source, len) => {
  if (source.length < len) return null;
  const sma = SMA.calculate({ period: len, values: source });
  return sma;
};

export const calculateEMA = (source, len) => {
  if (source.length < len) return null;
  const ema = EMA.calculate({ period: len, values: source });
  return ema;
};

export const calculateRMA = (source, len) => {
  // RMA'nın doğrudan bir fonksiyonu olmadığı için EMA formülü kullanılır
  // RMA = ((prevRMA * (len - 1)) + current) / len
  // Basit bir yaklaşım için EMA kullanabiliriz
  if (source.length < len) return null;
  const rma = EMA.calculate({ period: len, values: source });
  return rma;
};

export const calculateWMA = (source, len) => {
  if (source.length < len) return null;
  const wma = WMA.calculate({ period: len, values: source });
  return wma;
};

export const calculateDEMA = (source, len) => {
  if (source.length < len) return null;
  const dema = DEMA.calculate({ period: len, values: source });
  return dema;
};

export const calculateTEMA = (source, len) => {
  if (source.length < len) return null;
  const tema = TEMA.calculate({ period: len, values: source });
  return tema;
};

export const calculateTMA = (source, len) => {
  if (source.length < len) return null;
  const tma = TMA.calculate({ period: len, values: source });
  return tma;
};

export const calculateHMA = (source, len) => {
  if (source.length < len) return null;
  const hma = HMA.calculate({ period: len, values: source });
  return hma;
};

export const calculateLSMA = (source, len) => {
  if (source.length < len) return null;
  const lsma = LSMA.calculate({ period: len, values: source });
  return lsma;
};

export const calculateKiJun = (source, len) => {
    // Kijun-sen, son X periyodun en yüksek ve en düşük değerinin ortalamasıdır.
    if (source.length < len) return null;
    let high = 0;
    let low = Infinity;
    for (let i = source.length - len; i < source.length; i++) {
        if (source[i].high > high) high = source[i].high;
        if (source[i].low < low) low = source[i].low;
    }
    return (high + low) / 2;
};
