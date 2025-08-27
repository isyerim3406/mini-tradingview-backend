import WebSocket from 'ws';
import { computeSignals } from './strategy.js';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import pkg from 'binance-api-node'; // Kütüphane varsayılan olarak içe aktarıldı
const { binance } = pkg; // binance fonksiyonu paketten ayrıştırıldı

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m', 
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
    TRADE_SIZE: 0.001
};

// Binance API istemcisini başlat
const client = binance({
  apiKey: CFG.BINANCE_API_KEY,
  apiSecret: CFG.BINANCE_SECRET_KEY
});

let position = 'none';

let klines = [];
let lastTelegramMessage = '';

async function sendTelegramMessage(token, chatId, message) {
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message })
        });
        console.log("✅ Telegram mesajı başarıyla gönderildi.");
    } catch (err) {
        console.error("❌ Telegram mesajı gönderilemedi:", err.message);
    }
}

async function placeOrder(side, quantity, entryPrice) {
    try {
        console.log(`🤖 Emir veriliyor: ${side} ${quantity} ${CFG.SYMBOL}`);
        const order = await client.futuresOrder({
            symbol: CFG.SYMBOL,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantity
        });

        console.log(`✅ Emir başarıyla gönderildi: ID: ${order.orderId}, Fiyat: ${order.avgPrice}`);
        position = side === 'BUY' ? 'long' : 'short';
        
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${side === 'BUY' ? 'AL' : 'SAT'} emri verildi!`);

    } catch (error) {
        console.error('❌ Emir gönderilirken hata oluştu:', error.body);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `❌ Emir hatası: ${error.message}`);
    }
}

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

async function processData() {
    let lastNonNeutralSignal = null;
    let signalCount = 0;
    
    if (klines.length < 27) {
        console.log("Geçmiş veri yetersiz, en az 27 bar gerekli.");
        return;
    }

    for (let i = 0; i < klines.length; i++) {
        const subKlines = klines.slice(0, i + 1);
        const signals = computeSignals(subKlines, CFG);
        
        const barTime = new Date(klines[i].closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

        if (signals.buy) {
            lastNonNeutralSignal = `AL (Bar: ${i + 1}, Zaman: ${barTime})`;
            signalCount++;
        } else if (signals.sell) {
            lastNonNeutralSignal = `SAT (Bar: ${i + 1}, Zaman: ${barTime})`;
            signalCount++;
        }
    }
    
    console.log(`✅ Geçmiş veriler işlendi. Toplam Sinyal: ${signalCount}, Son Sinyal: ${lastNonNeutralSignal || 'Nötr'}`);
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `Bot başarıyla başlatıldı. Geçmiş veriler yüklendi. Toplam ${signalCount} sinyal bulundu.`);
}

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

    if (kline.x) {
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

        const signals = computeSignals(klines, CFG);
        
        const barIndex = klines.length - 1;
        const barTime = new Date(newBar.closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        
        console.log(`Yeni mum verisi alındı. Bar No: ${barIndex + 1}, Zaman: ${barTime}, Kapanış Fiyatı: ${newBar.close}`);

        if (signals.buy) {
            if (lastTelegramMessage !== 'buy') {
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `AL sinyali geldi!`);
                lastTelegramMessage = 'buy';
            }
            if (position === 'none' || position === 'short') {
                placeOrder('BUY', CFG.TRADE_SIZE, newBar.close);
            }
        } else if (signals.sell) {
            if (lastTelegramMessage !== 'sell') {
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `SAT sinyali geldi!`);
                lastTelegramMessage = 'sell';
            }
            if (position === 'none' || position === 'long') {
                placeOrder('SELL', CFG.TRADE_SIZE, newBar.close);
            }
        } else {
            lastTelegramMessage = '';
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket bağlantısı kesildi. Yeniden bağlanılıyor...');
    setTimeout(() => {
    }, 5000);
});

ws.on('error', (error) => {
    console.error('❌ WebSocket hatası:', error.message);
});

app.get('/', (req, res) => {
    res.send('Bot çalışıyor!');
});

app.listen(PORT, () => {
    console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`);
});
