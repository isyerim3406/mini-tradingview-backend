import { moving, ssl1Line, atr, calculateRMA, calculateSMA, calculateEMA, calculateWMA, calculateDEMA, calculateTEMA, calculateTMA, calculateHMA, calculateLSMA } from './indicators.js';

export function computeSignals(klines, cfg) {
  const close = klines.map(k => k.close);
  const high = klines.map(k => k.high);
  const low = klines.map(k => k.low);
  const volume = klines.map(k => k.volume);
  const open = klines.map(k => k.open);

  const atrCalc = atr(klines, cfg.ATR_LEN, cfg.ATR_SMOOTHING);
  if (!atrCalc || atrCalc.length === 0) return null;
  const atrLast = atrCalc[atrCalc.length - 1];

  const baselineSourceKey = cfg.BASELINE_SOURCE ? cfg.BASELINE_SOURCE.toLowerCase() : 'close';
  const baselineSource = klines.map(k => k[baselineSourceKey]);

  const bbmc = moving(cfg.MA_TYPE, baselineSource, cfg.SSL1LEN, {
    high: high,
    low: low,
    kidiv: cfg.KIDIV,
  });
  if (!bbmc || bbmc.length === 0) return null;
  const bbmcLast = bbmc[bbmc.length - 1];

  const upperAtr = bbmcLast + atrLast * cfg.ATR_MULT;
  const lowerAtr = bbmcLast - atrLast * cfg.ATR_MULT;

  const ssl = ssl1Line(klines, cfg.SSL1LEN, cfg.MA_TYPE);
  if (!ssl || ssl.length < 2) return null;
  const ssl1Last = ssl[ssl.length - 1];
  const ssl1Prev = ssl[ssl.length - 2];
  
  let buySignal = false;
  let sellSignal = false;

  if (cfg.ENTRY_SIGNAL_TYPE === 'BBMC_ATR') {
    const consecutiveClosesAbove = close.slice(-cfg.M_BARS_BUY).every(c => c > upperAtr);
    const consecutiveClosesBelow = close.slice(-cfg.N_BARS_SELL).every(c => c < lowerAtr);

    buySignal = consecutiveClosesAbove && cfg.M_BARS_BUY > 0;
    sellSignal = consecutiveClosesBelow && cfg.N_BARS_SELL > 0;

  } else if (cfg.ENTRY_SIGNAL_TYPE === 'SSL1_CROSSOVER') {
    const lastClose = close[close.length - 1];
    const prevClose = close[close.length - 2];
    
    buySignal = lastClose > ssl1Last && prevClose <= ssl1Prev;
    sellSignal = lastClose < ssl1Last && prevClose >= ssl1Prev;
  }

  const signals = {
    buy: buySignal,
    sell: sellSignal,
    atr_bands: {
      upper: upperAtr,
      lower: lowerAtr
    },
    bbmc: bbmcLast,
    ssl1: ssl1Last,
  };

  return signals;
}
