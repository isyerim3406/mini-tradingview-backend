import pkg from 'binance-api-node';
import { getTurkishDateTime, sendTelegramMessage } from './utils.js';
import { computeSignals } from './strategy.js';
import dotenv from 'dotenv';
import express from 'express';

const Binance = pkg.default;
const app = express();
const PORT = process.env.PORT || 3000;

dotenv.config();

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
    USE_SL_LONG: process.env.USE_SL_LONG === 'true',
    SL_LONG_PCT: parseFloat(process.env.SL_LONG_PCT),
    SL_LONG_ACT_BARS: parseInt(process.env.SL_LONG_ACT_BARS),
    USE_SL_SHORT: process.env.USE_SL_SHORT === 'true',
    SL_SHORT_PCT: parseFloat(process.env.SL_SHORT_PCT),
    SL_SHORT_ACT_BARS: parseInt(process.env.SL_SHORT_ACT_BARS),
};

const binance = Binance({
    apiKey: CFG.API_KEY,
    apiSecret: CFG.API_SECRET,
});

let klines = [];
let lastSignal = { buy: false, sell: false };

// Botu başlatmadan önce geçmiş veriyi işleyip son sinyali logla
async function analyzeHistoricalData() {
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

        let lastNonNeutralSignal = { type: 'Nötr', barIndex: null, time: null };

        for (let i = 0; i < klines.length; i++) {
            const tempKlines = klines.slice(0, i + 1);
            const signal = computeSignals(tempKlines, CFG);

            if (signal.buy) {
                lastNonNeutralSignal = { type: 'AL', barIndex: i, time: tempKlines[i].closeTime };
            } else if (signal.sell) {
                lastNonNeutralSignal = { type: 'SAT', barIndex: i, time: tempKlines[i].closeTime };
            }
        }

        if (lastNonNeutralSignal.type === 'Nötr') {
            console.log("⛔ Geçmiş 1000 bar veride sinyal oluşmamış.");
        } else {
            console.log(`✅ Geçmiş veride son sinyal: ${lastNonNeutralSignal.type}`);
            console.log(`📊 Bar Index: ${lastNonNeutralSignal.barIndex}`);
            console.log(`⏰ Bar Zamanı: ${getTurkishDateTime(lastNonNeutralSignal.time)}`);
        }

    } catch (error) {
        console.error('❌ Geçmiş veri analizinde hata oluştu:', error.message);
    }
}

// WebSocket ile canlı sinyal takibi
function startLiveBot() {
    const WebSocket = require('ws');
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

            if (klines.length > 2000) klines = klines.slice(-1000);

            const newSignal = computeSignals(klines, CFG);
            if (newSignal.buy && !lastSignal.buy) {
                console.log(`${getTurkishDateTime(new Date().getTime())} - AL SİNYALİ GELDİ! Fiyat: ${klines[klines.length - 1].close}`);
            }
            if (newSignal.sell && !lastSignal.sell) {
                console.log(`${getTurkishDateTime(new Date().getTime())} - SAT SİNYALİ GELDİ! Fiyat: ${klines[klines.length - 1].close}`);
            }

            lastSignal = newSignal;
        }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket bağlantısı kesildi, yeniden bağlanıyor...');
        setTimeout(startLiveBot, 5000);
    });

    ws.on('error', (err) => console.error('❌ WebSocket hatası:', err.message));
}

async function startBot() {
    await analyzeHistoricalData();
    startLiveBot();
}

// Web sunucusu
app.get('/', (req, res) => res.send('Bot çalışıyor!'));
app.listen(PORT, () => console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`));

startBot();
