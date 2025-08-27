import pkg from 'binance-api-node';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import { getTurkishDateTime, sendTelegramMessage } from './utils.js';
import { computeSignals } from './strategy.js';

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
    BASELINE_SOURCE: process.env.BASELINE_SOURCE || 'close',
    KIDIV: parseInt(process.env.KIDIV),
    M_BARS_BUY: parseInt(process.env.M_BARS_BUY),
    N_BARS_SELL: parseInt(process.env.N_BARS_SELL)
};

const binance = Binance({ apiKey: CFG.API_KEY, apiSecret: CFG.API_SECRET });
const app = express();
let klines = [];

async function startBot() {
    // 1️⃣ Geçmiş 1000 bar
    const historicalData = await binance.futuresCandles({ symbol: CFG.SYMBOL, interval: CFG.INTERVAL, limit: 1000 });
    klines = historicalData.map(d => ({
        open: parseFloat(d.open),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        close: parseFloat(d.close),
        volume: parseFloat(d.volume),
        closeTime: d.closeTime
    }));

    // 2️⃣ Son sinyali bul
    let lastSignal = { type: 'Nötr', time: null };
    for (let i = 0; i < klines.length; i++) {
        const tempKlines = klines.slice(0, i + 1);
        const signal = computeSignals(tempKlines, CFG);
        if (signal.buy) lastSignal = { type: 'AL', time: klines[i].closeTime };
        if (signal.sell) lastSignal = { type: 'SAT', time: klines[i].closeTime };
    }

    if (lastSignal.type === 'Nötr') console.log('⛔ Geçmiş 1000 bar veride sinyal oluşmamış.');
    else console.log(`✅ Son sinyal: ${lastSignal.type} | Bar zamanı: ${getTurkishDateTime(lastSignal.time)}`);

    // 3️⃣ Canlı WebSocket başlat
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);
    ws.on('message', async (data) => {
        const klineData = JSON.parse(data.toString()).k;
        if (klineData.x) {
            klines.push({
                open: parseFloat(klineData.o),
                high: parseFloat(klineData.h),
                low: parseFloat(klineData.l),
                close: parseFloat(klineData.c),
                volume: parseFloat(klineData.v),
                closeTime: klineData.T
            });
            if (klines.length > 2000) klines = klines.slice(-1000);
            const signal = computeSignals(klines, CFG);
            if (signal.buy) console.log(`AL sinyali! Fiyat: ${klines.at(-1).close}`);
            if (signal.sell) console.log(`SAT sinyali! Fiyat: ${klines.at(-1).close}`);
        }
    });
}

startBot();

// Basit sunucu
app.get('/', (req, res) => res.send('Bot çalışıyor!'));
app.listen(process.env.PORT || 3000, () => console.log(`✅ Sunucu http://localhost:${process.env.PORT || 3000} adresinde dinliyor`));
