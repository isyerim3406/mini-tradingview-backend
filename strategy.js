import { moving, ssl1Line, atr } from './indicators.js';

export function computeSignals(klines, cfg) {
  const close = klines.map(k => k.close);
  const high = klines.map(k => k.high);
  const low = klines.map(k => k.low);
  const volume = klines.map(k => k.volume);
  const open = klines.map(k => k.open);

  const atrCalc = atr(klines, cfg.ATR_LEN, cfg.ATR_SMOOTHING);
  const atrLast = atrCalc[atrCalc.length - 1];

  // Pine Script'ten gelen 'Baseline Source'u burada kullanıyoruz.
  // Varsayılan olarak 'close'u kullanır. Eğer .env'de farklı bir değer varsa onu alır.
  const baselineSourceKey = cfg.BASELINE_SOURCE ? cfg.BASELINE_SOURCE.toLowerCase() : 'close';
  const baselineSource = klines.map(k => k[baselineSourceKey]);

  // Baseline (BBMC) - Artık dinamik olarak seçilen kaynağı kullanacak.
  const bbmc = moving(cfg.MA_TYPE, baselineSource, cfg.LEN, {
    high,
    low,
    kidiv: cfg.KIDIV,
  });
  const bbmcLast = bbmc[bbmc.length - 1];

  // Bands - Diğer kısımlar aynı kalacak
  const upperAtr = bbmcLast + atrLast * cfg.ATR_MULT;
  const lowerAtr = bbmcLast - atrLast * cfg.ATR_MULT;

  // SSL1
  const ssl = ssl1Line(high, low, close, cfg.SSL1LEN, cfg.MA_TYPE, {
    high,
    low,
    kidiv: cfg.KIDIV,
  });
  const ssl1Last = ssl[ssl.length - 1];
  const ssl1Prev = ssl[ssl.length - 2];

  // Sinyaller
  let buySignal = false;
  let sellSignal = false;

  if (cfg.ENTRY_SIGNAL_TYPE === 'BBMC_ATR') {
    const consecutiveClosesAbove = close.slice(-cfg.M_BARS_BUY).every(c => c > upperAtr);
    const consecutiveClosesBelow = close.slice(-cfg.N_BARS_SELL).every(c => c < lowerAtr);

    buySignal = consecutiveClosesAbove && cfg.M_BARS_BUY > 0;
    sellSignal = consecutiveClosesBelow && cfg.N_BARS_SELL > 0;

  } else if (cfg.ENTRY_SIGNAL_TYPE === 'SSL1_CROSSOVER') {
    buySignal = close[close.length - 1] > ssl1Last && close[close.length - 2] < ssl1Prev;
    sellSignal = close[close.length - 1] < ssl1Last && close[close.length - 2] > ssl1Prev;
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