import pkg from 'binance-api-node';
import { getTurkishDateTime, sendTelegramMessage } from './utils.js';
import { computeSignals } from './strategy.js';
import dotenv from 'dotenv';

dotenv.config();
const Binance = pkg.default;

const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '3m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    API_KEY: process.env.API_KEY,
    API_SECRET: process.env.API_SECRET,
    ENTRY_SIGNAL_TYPE: process.env.ENTRY_SIGNAL_TYPE,
    LEN: parseInt(process.env.LEN),
    ATR_LEN: parseInt(process.env.ATR_LEN),
    ATR_SMOOTHING: process.env.ATR_SMOOTHING,
    ATR_MULT: parseFloat(process.env.ATR_MULT),
    MA_TYPE: process.env.MA_TYPE,
    BASELINE_SOURCE: process.env.BASELINE_SOURCE,
    KIDIV: parseInt(process.env.KIDIV),
    M_BARS_BUY: parseInt(process.env.M_BARS_BUY),
    N_BARS_SELL: parseInt(process.env.N_BARS_SELL),
};

const binance = Binance({
    apiKey: CFG.API_KEY,
    apiSecret: CFG.API_SECRET,
});

let klines = [];

async function fetchHistoricalData() {
    try {
        const historicalData = await binance.futuresCandles({
            symbol: CFG.SYMBOL,
            interval: CFG.INTERVAL,
            limit: 1000
        });

        klines = historicalData.map(d => ({
            open: parseFloat(d.open),
            high: parseFloat(d.high),
            low: parseFloat(d.low),
            close: parseFloat(d.close),
            volume: parseFloat(d.volume),
            closeTime: d.closeTime
        }));

        console.log(`✅ ${klines.length} adet geçmiş mum verisi yüklendi.`);

        // Geçmiş veride son sinyali bul
        let lastSignal = { type: 'Nötr', index: null, price: null };
        for (let i = 0; i < klines.length; i++) {
            const tempKlines = klines.slice(0, i + 1);
            const signal = computeSignals(tempKlines, CFG);

            if (signal.buy) {
                lastSignal = { type: 'AL', index: i, price: tempKlines[i].close };
            } else if (signal.sell) {
                lastSignal = { type: 'SAT', index: i, price: tempKlines[i].close };
            }
        }

        if (lastSignal.type === 'Nötr') {
            console.log('⛔ Geçmiş 1000 bar veride sinyal oluşmamış.');
        } else {
            console.log(`✅ Son sinyal: ${lastSignal.type} | Bar indeksi: ${lastSignal.index} | Fiyat: ${lastSignal.price}`);
        }

    } catch (error) {
        console.error('❌ Geçmiş veri çekilirken hata:', error.message);
    }
}

async function startLiveBot() {
    const WebSocket = (await import('ws')).default;
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

    ws.on('open', () => console.log('✅ WebSocket connected'));

    ws.on('message', async (data) => {
        const klineData = JSON.parse(data.toString());
        const kline = klineData.k;

        if (kline.x) {
            klines.push({
                open: parseFloat(kline.o),
                high: parseFloat(kline.h),
                low: parseFloat(kline.l),
                close: parseFloat(kline.c),
                volume: parseFloat(kline.v),
                closeTime: kline.T
            });

            if (klines.length > 2000) klines = klines.slice(klines.length - 1000);

            const signal = computeSignals(klines, CFG);
            const time = getTurkishDateTime(new Date().getTime());

            if (signal.buy) {
                const message = `${time} - AL SİNYALİ! Fiyat: ${klines[klines.length-1].close.toFixed(2)}`;
                console.log(message);
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
            } else if (signal.sell) {
                const message = `${time} - SAT SİNYALİ! Fiyat: ${klines[klines.length-1].close.toFixed(2)}`;
                console.log(message);
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
            }
        }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket kapandı, yeniden bağlanılıyor...');
        setTimeout(startLiveBot, 5000);
    });

    ws.on('error', (err) => console.error('❌ WebSocket hatası:', err.message));
}

(async () => {
    await fetchHistoricalData();
    await startLiveBot();
})();
