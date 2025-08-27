// index.js
import express from 'express';
import fetch from 'node-fetch'; // Telegram için
import WebSocket from 'ws';
import { computeSignals } from './strategy.js';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 10000;

// CFG ayarları
const CFG = {
    ENTRY_SIGNAL_TYPE: "SSL1 Kesişimi", // veya "BBMC+ATR Bands"
    LEN: 20,
    MA_TYPE: "SMA", // SMA, EMA vb.
    BASELINE_SOURCE: "close", // close, hl2, ohlc4
    KIDIV: 1,
    ATR_LEN: 14,
    ATR_SMOOTHING: 1,
    ATR_MULT: 1.5,
    M_BARS_BUY: 2,
    N_BARS_SELL: 2
};

let klines = []; // geçmiş bar verisi
let lastSignal = { type: null, barTime: null };

async function sendTelegram(msg) {
    const token = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHATID;
    if (!token || !chatId) return;

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg })
        });
        if (res.ok) console.log("✅ Telegram mesajı başarıyla gönderildi.");
    } catch (err) {
        console.error("❌ Telegram mesajı gönderilemedi:", err.message);
    }
}

// Başlangıçta son sinyali geçmiş barlarla hesapla
function computeLastSignal() {
    if (klines.length === 0) return;

    const signal = computeSignals(klines, CFG);
    if (signal.buy) lastSignal = { type: 'BUY', barTime: klines[klines.length -1].closeTime };
    else if (signal.sell) lastSignal = { type: 'SELL', barTime: klines[klines.length -1].closeTime };

    if (lastSignal.type)
        console.log(`⏱ Başlangıçta son sinyal: ${lastSignal.type}, Bar zamanı: ${new Date(lastSignal.barTime).toISOString()}`);
    else
        console.log("⛔ Geçmiş 1000 bar veride sinyal oluşmamış.");
}

// WebSocket ile canlı veri simülasyonu
function startLiveBot() {
    const ws = new WebSocket('wss://example.com/stream'); // Gerçek endpoint ile değiştir

    ws.on('open', () => console.log("✅ WebSocket bağlantısı açıldı."));
    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        const kline = {
            openTime: data.t,
            open: parseFloat(data.o),
            high: parseFloat(data.h),
            low: parseFloat(data.l),
            close: parseFloat(data.c),
            volume: parseFloat(data.v),
            closeTime: data.T
        };
        klines.push(kline);
        if (klines.length > 1000) klines.shift();

        console.log(`🕒 Yeni mum geldi: Sembol=${data.s}, Periyot=3m, Kapanış=${kline.close}, Mum kapanıyor mu?=${data.x}`);
        console.log(`Güncel veri sayısı: ${klines.length}`);

        const signal = computeSignals(klines, CFG);

        if (signal.buy) {
            lastSignal = { type: 'BUY', barTime: kline.closeTime };
            console.log(`🟢 BUY sinyali üretildi: ${new Date(kline.closeTime).toISOString()}`);
            sendTelegram(`🟢 BUY sinyali: ${new Date(kline.closeTime).toISOString()}`);
        } else if (signal.sell) {
            lastSignal = { type: 'SELL', barTime: kline.closeTime };
            console.log(`🔴 SELL sinyali üretildi: ${new Date(kline.closeTime).toISOString()}`);
            sendTelegram(`🔴 SELL sinyali: ${new Date(kline.closeTime).toISOString()}`);
        }
    });
}

// Express server
app.get('/', (req, res) => res.send("Mini TradingView Backend Çalışıyor ✅"));

app.listen(PORT, () => {
    console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`);
    console.log("==> Your service is live 🎉");
    console.log("==> Başlangıç geçmişi ile son sinyal hesaplanıyor...");
    // 1000 bar veriyi oku veya fetch et (simülasyon)
    // Örnek JSON: klines = [...];
    computeLastSignal();
    startLiveBot();
});
