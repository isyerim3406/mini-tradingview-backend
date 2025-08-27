import pkg from 'binance-api-node';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import { computeSignals } from './strategy.js';
import { getTurkishDateTime, sendTelegramMessage } from './utils.js';

dotenv.config();

const Binance = pkg.default;
const app = express();
const PORT = process.env.PORT || 3000;

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
let lastSignal = { buy: false, sell: false };

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

        // Son sinyali hesapla
        let lastNonNeutralSignal = { type: 'Nötr', time: null };
        for (let i = 0; i < klines.length; i++) {
            const tempKlines = klines.slice(0, i + 1);
            const signal = computeSignals(tempKlines, CFG);
            if (signal.buy) lastNonNeutralSignal = { type: 'AL', time: klines[i].closeTime };
            else if (signal.sell) lastNonNeutralSignal = { type: 'SAT', time: klines[i].closeTime };
        }

        if (lastNonNeutralSignal.type !== 'Nötr') {
            console.log(`📊 Geçmiş 1000 bar veride son sinyal: ${lastNonNeutralSignal.type} | Bar zamanı: ${getTurkishDateTime(lastNonNeutralSignal.time)}`);
        } else {
            console.log(`⛔ Geçmiş 1000 bar veride sinyal oluşmamış.`);
        }

    } catch (error) {
        console.error('❌ Geçmiş veri çekilirken hata oluştu:', error.message);
        klines = [];
    }
}

function trade(signal) {
    const time = getTurkishDateTime(new Date().getTime());
    if (signal.buy) {
        const message = `${time} - AL SİNYALİ! Sembol: ${CFG.SYMBOL}, Fiyat: ${klines[klines.length - 1].close.toFixed(2)}`;
        console.log(`✅ ${message}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    } else if (signal.sell) {
        const message = `${time} - SAT SİNYALİ! Sembol: ${CFG.SYMBOL}, Fiyat: ${klines[klines.length - 1].close.toFixed(2)}`;
        console.log(`✅ ${message}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    }
}

function processNewKline(kline) {
    klines.push({
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        closeTime: kline.T
    });

    if (klines.length > 2000) klines = klines.slice(-1000);

    const signal = computeSignals(klines, CFG);

    // Sadece değişen sinyalleri bildir
    if (signal.buy && !lastSignal.buy) trade({ buy: true, sell: false });
    if (signal.sell && !lastSignal.sell) trade({ buy: false, sell: true });

    lastSignal = signal;
}

function startLiveBot() {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

    ws.on('open', () => console.log('✅ WebSocket connected'));
    ws.on('message', data => {
        const klineData = JSON.parse(data.toString()).k;
        if (klineData.x) processNewKline(klineData); // Sadece kapanan bar
    });

    ws.on('close', () => {
        console.log('❌ WebSocket kapandı, yeniden bağlanılıyor...');
        setTimeout(startLiveBot, 5000);
    });

    ws.on('error', error => console.error('❌ WebSocket hatası:', error.message));
}

async function startBot() {
    await fetchHistoricalData();
    startLiveBot();
    console.log(`✅ Bot başlatıldı ve 3m bar akışı dinleniyor...`);
}

startBot();

app.get('/', (req, res) => res.send('Bot çalışıyor!'));
app.listen(PORT, () => console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`));
