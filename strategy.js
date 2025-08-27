import { calculateMACD } from './indicator.js';

export function computeSignals(klines, CFG) {
    // Pine Script'teki varsayılan değerleri kullanıyoruz
    const fastLength = 12;
    const slowLength = 26;
    const signalLength = 9;

    // MACD değerlerini hesapla
    const macdData = calculateMACD(klines, fastLength, slowLength, signalLength);

    // Yeterli veri yoksa sinyal üretme
    if (macdData.length < 2) {
        return { buy: false, sell: false };
    }

    // Son ve bir önceki MACD ve Sinyal çizgisi değerlerini al
    const lastBar = macdData[macdData.length - 1];
    const prevBar = macdData[macdData.length - 2];

    const macdLineLast = lastBar.MACD;
    const signalLineLast = lastBar.signal;
    const macdLinePrev = prevBar.MACD;
    const signalLinePrev = prevBar.signal;
    
    // Alım ve Satım sinyalleri için kesişim kontrolü
    const buySignal = (macdLinePrev <= signalLinePrev) && (macdLineLast > signalLineLast);
    const sellSignal = (macdLinePrev >= signalLinePrev) && (macdLineLast < signalLineLast);

    return { buy: buySignal, sell: sellSignal };
}
