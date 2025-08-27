import { MACD } from 'technicalindicators';

export function calculateMACD(klines, fastPeriod, slowPeriod, signalPeriod) {
    const closes = klines.map(k => k.close);
    const macdResult = MACD.calculate({
        values: closes,
        fastPeriod: fastPeriod,
        slowPeriod: slowPeriod,
        signalPeriod: signalPeriod,
    });
    return macdResult;
}
