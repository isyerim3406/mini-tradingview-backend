import WebSocket from 'ws';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { computeSignals } from './strategy.js'; // Senin strategy dosyan

dotenv.config();

const SYMBOL = 'ETHUSDT';
const INTERVAL = '3m';
const MAX_KLINES = 1000;

let klines = [];
let lastSignal = { buy: false, sell: false };

// Telegram mesaj fonksiyonu
async function sendTelegramMessage(message) {
    if (!process.env.TG_BOT_TOKEN || !process.env.TG_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text: message })
        });
        console.log('✅ Telegram mesajı başarıyla gönderildi.');
    } catch (err) {
        console.error('❌ Telegram gönderim hatası:', err);
    }
}

// Trade fonksiyonu
function trade(signal) {
    if (signal.buy) {
        console.log('🟢 BUY sinyali oluştu!');
        sendTelegramMessage(`BUY sinyali: ${SYMBOL} ${klines[klines.length-1].close}`);
    }
    if (signal.sell) {
        console.log('🔴 SELL sinyali oluştu!');
        sendTelegramMessage(`SELL sinyali: ${SYMBOL} ${klines[klines.length-1].close}`);
    }
}

// WebSocket bağlantısı
function startLiveBot() {
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@kline_${INTERVAL}`);

    ws.on('open', () => console.log('✅ WebSocket bağlandı.'));
    ws.on('close', () => console.log('⚠️ WebSocket kapandı, yeniden bağlanılıyor...'));
    ws.on('error', (err) => console.error('WebSocket Hatası:', err));

    ws.on('message', (data) => {
        const parsed = JSON.parse(data);
        const k = parsed.k;
        processNewKline(k);
    });
}

// Yeni mum işleme
function processNewKline(kline) {
    const newKline = {
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c),
        volume: parseFloat(kline.v),
        closeTime: kline.T
    };

    const isNewBar = klines.length === 0 || klines[klines.length - 1].closeTime !== newKline.closeTime;

    if (isNewBar) klines.push(newKline);
    else klines[klines.length - 1] = newKline;

    if (klines.length > MAX_KLINES) klines = klines.slice(-MAX_KLINES);

    console.log(`📈 Yeni mum: Close=${newKline.close.toFixed(2)}, Kapanıyor mu?=${kline.x}`);
    console.log(`Toplam mum: ${klines.length}`);

    const signal = computeSignals(klines);

    if ((signal.buy && !lastSignal.buy) || (signal.sell && !lastSignal.sell)) {
        trade(signal);
    }

    lastSignal = signal;
}

// Başlangıç: geçmiş veriyi al
async function fetchHistoricalData() {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${MAX_KLINES}`;
    const response = await fetch(url);
    const data = await response.json();
    klines = data.map(d => ({
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5]),
        closeTime: d[6]
    }));

    console.log(`📊 Başlangıçta ${klines.length} mum yüklendi.`);

    // Son sinyali hesapla
    const lastSignalCheck = computeSignals(klines);
    if (lastSignalCheck.buy) console.log(`🟢 Geçmiş veride son BUY sinyali: Bar Time=${new Date(klines[klines.length-1].closeTime)}`);
    if (lastSignalCheck.sell) console.log(`🔴 Geçmiş veride son SELL sinyali: Bar Time=${new Date(klines[klines.length-1].closeTime)}`);
}

// Botu başlat
(async () => {
    await fetchHistoricalData();
    startLiveBot();
})();
