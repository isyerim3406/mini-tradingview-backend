import WebSocket from 'ws';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import pkg from 'binance-api-node';
import { computeSignals } from './strategy.js';

dotenv.config();
const Binance = pkg.default;

const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '3m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
    TRADE_SIZE: parseFloat(process.env.TRADE_SIZE) || 0.001
};

const client = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY
});

let klines = [];
let lastTelegramMessage = '';
let position = 'none';

// Telegram mesaj fonksiyonu
async function sendTelegramMessage(message) {
    if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CFG.TG_CHAT_ID, text: message })
        });
        console.log("✅ Telegram mesajı gönderildi:", message);
    } catch (err) {
        console.error("❌ Telegram mesajı gönderilemedi:", err.message);
    }
}

// Binance Futures emir fonksiyonu
async function placeOrder(side, quantity) {
    if (!CFG.BINANCE_API_KEY || !CFG.BINANCE_SECRET_KEY) {
        console.log("⚠️ Binance API bilgisi yok, emir atılmadı.");
        return;
    }
    try {
        console.log(`🤖 Emir veriliyor: ${side} ${quantity} ${CFG.SYMBOL}`);
        const order = await client.futuresOrder({
            symbol: CFG.SYMBOL,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantity
        });
        console.log(`✅ Emir başarıyla gönderildi: ID ${order.orderId}`);
        position = side.toUpperCase() === 'BUY' ? 'long' : 'short';
        sendTelegramMessage(`${side.toUpperCase() === 'BUY' ? 'AL' : 'SAT'} emri verildi!`);
    } catch (error) {
        console.error('❌ Emir gönderilirken hata:', error.body || error.message);
        sendTelegramMessage(`❌ Emir hatası: ${error.message}`);
    }
}

// Geçmiş veriyi çek
async function fetchHistoricalData() {
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
        console.log(`✅ ${klines.length} geçmiş mum yüklendi.`);
    } catch (error) {
        console.error('❌ Geçmiş veri çekilemedi:', error.message);
    }
}

// Geçmiş veriyi işleme
async function processHistorical() {
    if (klines.length < 27) {
        console.log("⚠️ Yeterli geçmiş veri yok, en az 27 bar gerekli.");
        return;
    }
    let signalCount = 0;
    for (let i = 0; i < klines.length; i++) {
        const subKlines = klines.slice(0, i + 1);
        const signals = computeSignals(subKlines, CFG);
        const barTime = new Date(klines[i].closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        if (signals.buy || signals.sell) signalCount++;
        console.log(`Bar ${i + 1}: Close=${klines[i].close}, Buy=${signals.buy}, Sell=${signals.sell}`);
    }
    console.log(`✅ Geçmiş veriler işlendi. Toplam sinyal: ${signalCount}`);
    sendTelegramMessage(`Bot başlatıldı. Toplam ${signalCount} sinyal bulundu.`);
}

// WebSocket canlı veri
function startWebSocket() {
    const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

    ws.on('open', () => console.log('✅ WebSocket bağlandı.'));
    ws.on('message', async (data) => {
        try {
            const klineData = JSON.parse(data.toString());
            const k = klineData.k;
            if (k.x) { // Mum kapandı
                const newBar = {
                    open: parseFloat(k.o),
                    high: parseFloat(k.h),
                    low: parseFloat(k.l),
                    close: parseFloat(k.c),
                    volume: parseFloat(k.v),
                    closeTime: k.T
                };
                klines.push(newBar);
                if (klines.length > 1000) klines.shift();
                const signals = computeSignals(klines, CFG);
                console.log(`Yeni Bar: Close=${newBar.close}, Buy=${signals.buy}, Sell=${signals.sell}`);
                if (signals.buy && (position === 'none' || position === 'short')) placeOrder('BUY', CFG.TRADE_SIZE);
                if (signals.sell && (position === 'none' || position === 'long')) placeOrder('SELL', CFG.TRADE_SIZE);
            }
        } catch (err) {
            console.error("❌ WebSocket message işlenirken hata:", err.message);
        }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket kapandı, 5 sn sonra yeniden bağlanacak...');
        setTimeout(startWebSocket, 5000);
    });
    ws.on('error', (err) => console.error('❌ WebSocket hatası:', err.message));
}

// Main async
async function main() {
    await fetchHistoricalData();
    await processHistorical();
    startWebSocket();
}

// Server
import express from 'express';
const app = express();
app.get('/', (req, res) => res.send('Bot çalışıyor!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Sunucu http://localhost:${PORT} dinliyor`));

main().catch(err => console.error('❌ Main hatası:', err));
