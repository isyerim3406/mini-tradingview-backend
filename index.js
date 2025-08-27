import pkg from 'binance-api-node';
import WebSocket from 'ws';
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

function trade(signal) {
    const time = getTurkishDateTime(new Date().getTime());
    
    if (signal.buy) {
        const message = `${time} - AL SİNYALİ GELDİ! Sembol: ${CFG.SYMBOL}, Fiyat: ${klines[klines.length - 1].close.toFixed(2)}`;
        console.log(`✅ Telegram'a gönderiliyor: ${message}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    } else if (signal.sell) {
        const message = `${time} - SAT SİNYALİ GELDİ! Sembol: ${CFG.SYMBOL}, Fiyat: ${klines[klines.length - 1].close.toFixed(2)}`;
        console.log(`✅ Telegram'a gönderiliyor: ${message}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    }
}

async function checkSignals() {
    const newSignal = computeSignals(klines, CFG);

    if (newSignal.buy && !lastSignal.buy) {
        trade({ buy: true, sell: false });
    }
    if (newSignal.sell && !lastSignal.sell) {
        trade({ buy: false, sell: true });
    }
    
    lastSignal = newSignal;
}

const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', () => {
    console.log('✅ WebSocket connected');
});

ws.on('message', async (data) => {
    const klineData = JSON.parse(data.toString());
    const kline = klineData.k;
    
    if (kline.x) { 
        // Mum kapandığında log yazdır
        console.log(`✅ Telegram mesajı başarıyla gönderildi. Yeni mum verisi alındı: Sembol = ${kline.s}, Periyot = ${kline.i}, Kapanış Fiyatı = ${kline.c}, Mum kapanıyor mu? = ${kline.x} Güncel veri sayısı: ${klines.length + 1}`);
        
        klines.push({
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            closeTime: kline.T
        });

        if (klines.length > 2000) {
            klines = klines.slice(klines.length - 1000);
        }

        await checkSignals();
    }
});

ws.on('close', (code, reason) => {
    console.log(`❌ WebSocket bağlantısı kesildi. Kod: ${code}, Neden: ${reason.toString()}`);
    console.log('Yeniden bağlanılıyor...');
    setTimeout(startBot, 5000); 
});

ws.on('error', (error) => {
    console.error('❌ WebSocket hatası:', error.message);
});

async function startBot() {
    console.log(`Geçmiş veri çekiliyor: ${CFG.SYMBOL}, ${CFG.INTERVAL}`);
    try {
        const historicalData = await binance.futuresCandles({ symbol: CFG.SYMBOL, interval: CFG.INTERVAL, limit: 1000 });
        klines = historicalData.map(d => ({
            open: parseFloat(d.open),
            high: parseFloat(d.high),
            low: parseFloat(d.low),
            close: parseFloat(d.close),
            volume: parseFloat(d.volume),
            closeTime: d.closeTime
        }));
        console.log(`✅ ${klines.length} adet geçmiş mum verisi başarıyla yüklendi.`);
        
        let lastNonNeutralSignal = { type: 'Nötr', time: null };

        for (let i = 0; i < klines.length; i++) {
            const tempKlines = klines.slice(0, i + 1);
            const signal = computeSignals(tempKlines, CFG);
            
            if (signal.buy) {
                lastNonNeutralSignal = { type: 'AL', time: klines[i].closeTime };
            } else if (signal.sell) {
                lastNonNeutralSignal = { type: 'SAT', time: klines[i].closeTime };
            }
        }
        
        const lastSignalTime = lastNonNeutralSignal.time ? getTurkishDateTime(lastNonNeutralSignal.time) : 'Belirtilmemiş';

        console.log(`✅ Geçmiş veriler işlendi. Son Sinyal: ${lastNonNeutralSignal.type} | Bar Zamanı: ${lastSignalTime}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${getTurkishDateTime(new Date().getTime())} - Bot başarıyla başlatıldı. Geçmiş veriler yüklendi.`);

    } catch (error) {
        console.error('❌ Geçmiş veri çekilirken hata oluştu:', error.message);
        console.log('Geçmiş veri çekilemedi, bot canlı akışla başlayacak...');
        klines = [];
        
        const time = getTurkishDateTime(new Date().getTime());
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - Bot başlatıldı ancak geçmiş veriler alınamadı. Canlı veriler bekleniyor.`);
    }
}

startBot();

// Render'ın uygulamayı sonlandırmasını önlemek için basit bir web sunucusu başlat
app.get('/', (req, res) => {
    res.send('Bot çalışıyor!');
});

app.listen(PORT, () => {
    console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`);
});
