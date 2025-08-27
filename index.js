import WebSocket from 'ws';
import { SSLHybridStrategy } from './strategy.js';
import { TechnicalIndicators } from './indicator.js';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Sınıfları başlat
const indicators = new TechnicalIndicators();
const strategy = new SSLHybridStrategy(indicators);

// Çevresel değişkenlerden yapılandırmayı al
strategy.updateConfig({
    entrySignalType: process.env.ENTRY_SIGNAL_TYPE || "BBMC+ATR Bands", // Varsayılanı 'BBMC+ATR Bands' olarak değiştirdim
    maType: process.env.MA_TYPE || "SMA",
    len: parseInt(process.env.LEN) || 20,
    atrlen: parseInt(process.env.ATR_LEN) || 14,
    mult: parseFloat(process.env.ATR_MULT) || 1.5,
    smoothing: process.env.ATR_SMOOTHING || "WMA",
    kidiv: parseInt(process.env.KIDIV) || 1,
    m_bars_buy: parseInt(process.env.M_BARS_BUY) || 2,
    n_bars_sell: parseInt(process.env.N_BARS_SELL) || 2,
    useStopLossAl: process.env.USE_SL_LONG === 'true',
    stopLossAlPercent: parseFloat(process.env.SL_LONG_PCT) || 2.0,
    stopLossAlActivationBars: parseInt(process.env.SL_LONG_ACT_BARS) || 1,
    useStopLossSat: process.env.USE_SL_SHORT === 'true',
    stopLossSatPercent: parseFloat(process.env.SL_SHORT_PCT) || 2.0,
    stopLossSatActivationBars: parseInt(process.env.SL_SHORT_ACT_BARS) || 1
});

const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m', 
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
};

let klines = [];
let lastTelegramMessage = '';

// Yardımcı fonksiyon: Telegram mesajı gönderme
async function sendTelegramMessage(token, chatId, message) {
    if (!token || !chatId) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message })
        });
        if (res.ok) console.log("✅ Telegram mesajı başarıyla gönderildi.");
    } catch (err) {
        console.error("❌ Telegram mesajı gönderilemedi:", err.message);
    }
}

// Geçmiş veriyi çekme fonksiyonu
async function fetchHistoricalData() {
    console.log(`Geçmiş veri çekiliyor: ${CFG.SYMBOL}, ${CFG.INTERVAL}`);
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${CFG.SYMBOL}&interval=${CFG.INTERVAL}&limit=1000`);
        const data = await response.json();
        klines = data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: d[6]
        }));
        console.log(`✅ ${klines.length} adet geçmiş mum verisi başarıyla yüklendi.`);
    } catch (error) {
        console.error('❌ Geçmiş veri çekilirken hata oluştu:', error.message);
        klines = [];
    }
}

// Sinyal hesaplaması ve işlem fonksiyonu
async function processData() {
    const ohlcData = {
        open: klines.map(k => k.open),
        high: klines.map(k => k.high),
        low: klines.map(k => k.low),
        close: klines.map(k => k.close)
    };
    
    // Geçmiş verileri bar bar işleyerek strateji durumunu güncel tut
    let lastNonNeutralSignal = null;
    let signalCount = 0;

    for (let i = 0; i < klines.length; i++) {
        const subData = {
            open: ohlcData.open.slice(0, i + 1),
            high: ohlcData.high.slice(0, i + 1),
            low: ohlcData.low.slice(0, i + 1),
            close: ohlcData.close.slice(0, i + 1)
        };

        const calculatedData = strategy.calculate(subData);
        const entrySignals = strategy.calculateEntrySignals(calculatedData, subData);

        const currentLongSignal = entrySignals.long[entrySignals.long.length - 1];
        const currentShortSignal = entrySignals.short[entrySignals.short.length - 1];

        if (currentLongSignal) {
            lastNonNeutralSignal = 'AL';
            signalCount++;
        } else if (currentShortSignal) {
            lastNonNeutralSignal = 'SAT';
            signalCount++;
        }
    }
    
    console.log(`✅ Geçmiş veriler işlendi. Toplam Sinyal: ${signalCount}, Son Sinyal: ${lastNonNeutralSignal || 'Nötr'}`);
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `Bot başarıyla başlatıldı. Geçmiş veriler yüklendi. Toplam ${signalCount} sinyal bulundu.`);
}

// WebSocket bağlantısı
const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', () => {
    console.log('✅ WebSocket bağlantısı açıldı.');
    fetchHistoricalData().then(() => {
        if (klines.length > 0) {
            processData();
        }
    });
});

ws.on('message', async (data) => {
    const klineData = JSON.parse(data.toString());
    const kline = klineData.k;
    
    if (kline.x) { // Mum kapanışını kontrol et
        const newBar = {
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            closeTime: kline.T
        };
        
        klines.push(newBar);
        if (klines.length > 1000) {
            klines.shift();
        }

        const ohlcData = {
            open: klines.map(k => k.open),
            high: klines.map(k => k.high),
            low: klines.map(k => k.low),
            close: klines.map(k => k.close)
        };
        
        // Sadece son barı işleyerek sinyal hesapla
        const calculatedData = strategy.calculate(ohlcData);
        const entrySignals = strategy.calculateEntrySignals(calculatedData, ohlcData);
        
        const currentLongSignal = entrySignals.long[entrySignals.long.length - 1];
        const currentShortSignal = entrySignals.short[entrySignals.short.length - 1];
        
        const time = new Date().toLocaleString();
        
        if (currentLongSignal && lastTelegramMessage !== 'buy') {
            const message = `${time} - AL sinyali geldi! Sembol: ${CFG.SYMBOL}, Periyot: ${CFG.INTERVAL}, Fiyat: ${newBar.close}`;
            console.log(message);
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
            lastTelegramMessage = 'buy';
        } else if (currentShortSignal && lastTelegramMessage !== 'sell') {
            const message = `${time} - SAT sinyali geldi! Sembol: ${CFG.SYMBOL}, Periyot: ${CFG.INTERVAL}, Fiyat: ${newBar.close}`;
            console.log(message);
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
            lastTelegramMessage = 'sell';
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket bağlantısı kesildi. Yeniden bağlanılıyor...');
    setTimeout(() => {
        // Yeniden bağlanma mekanizması
    }, 5000);
});

ws.on('error', (error) => {
    console.error('❌ WebSocket hatası:', error.message);
});

// Render'ın uygulamayı sonlandırmasını önlemek için basit bir web sunucusu başlat
app.get('/', (req, res) => {
    res.send('Bot çalışıyor!');
});

app.listen(PORT, () => {
    console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`);
});
