import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import pkg from 'binance-api-node';
const Binance = pkg.default || pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================================
// BOT ADI
// =========================================================================================
const BOT_NAME = "UTBOT STRATEGY JS";

// =========================================================================================
// UT BOT STRATEGY CLASS (değişmedi)
// =========================================================================================
// ... (UTBotStrategy sınıfın senin verdiğin haliyle korunuyor)

// =========================================================================================
// STRATEGY CONFIGURATION
// =========================================================================================
const CFG = {
    a: 1, 
    c: 10,
    h: false,
    use_filter: true,
    atr_ma_period: 100,
    atr_threshold: 0.7,
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,
};

let botCurrentPosition = 'none';
let totalNetProfit = 0;
let isBotInitialized = false;
const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

// =========================================================================================
// TELEGRAM
// =========================================================================================
async function sendTelegramMessage(text) {
    if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) {
        console.warn('Telegram API token or chat ID not set. Skipping message.');
        return;
    }
    const telegramApiUrl = `https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`;
    const payload = {
        chat_id: CFG.TG_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
    };
    try {
        await fetch(telegramApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error('Failed to send Telegram message:', error);
    }
}

// =========================================================================================
// ORDER PLACEMENT & TRADING LOGIC
// =========================================================================================
async function placeOrder(side, signalMessage) {
    const lastClosePrice = utBotStrategy.klines[utBotStrategy.klines.length - 1]?.close || 0;

    // Pozisyon kapat
    if (utBotStrategy.position_size !== 0) {
        utBotStrategy.closePosition(lastClosePrice);
        totalNetProfit = utBotStrategy.trades.filter(t => t.action === 'exit')
                          .reduce((sum, t) => sum + t.pnl, 0);
        const lastTrade = utBotStrategy.trades[utBotStrategy.trades.length - 1];
        const pnl = lastTrade.pnl;
        const percentPnl = (pnl / CFG.INITIAL_CAPITAL) * 100;
        const totalPercent = (totalNetProfit / CFG.INITIAL_CAPITAL) * 100;

        const msg = 
`📉 Pozisyon Kapatıldı!

Bot Adı: ${BOT_NAME}
Sembol: ${CFG.SYMBOL}
Zaman Aralığı: ${CFG.INTERVAL}
Son Fiyat: ${lastClosePrice}
Bu İşlemden Kar/Zarar: % ${percentPnl.toFixed(2)} (${pnl.toFixed(2)} USDT)
Toplam Net Kar/Zarar: % ${totalPercent.toFixed(2)} (${totalNetProfit.toFixed(2)} USDT)`;

        await sendTelegramMessage(msg);
        botCurrentPosition = 'none';
    }

    // Yeni pozisyon aç
    utBotStrategy.openPosition(side, lastClosePrice);
    botCurrentPosition = side.toLowerCase();

    const percentTotal = (totalNetProfit / CFG.INITIAL_CAPITAL) * 100;
    const ts = new Date().toISOString().replace("T", " ").split(".")[0];

    const openMsg = 
`${side} Emri Gerçekleşti!

Bot Adı: ${BOT_NAME}
Sembol: ${CFG.SYMBOL}
Zaman Aralığı: ${CFG.INTERVAL}
Sinyal: ${signalMessage}
Fiyat: ${lastClosePrice}
Zaman : ${ts}
Toplam Net Kar/Zarar : % ${percentTotal.toFixed(2)} (${totalNetProfit.toFixed(2)} USDT)`;

    await sendTelegramMessage(openMsg);
}

// =========================================================================================
// DATA HANDLING
// =========================================================================================
const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

async function fetchInitialData() {
    const initialKlines = await binanceClient.candles({
        symbol: CFG.SYMBOL,
        interval: CFG.INTERVAL,
        limit: 500
    });

    let lastSignal = null;
    initialKlines.forEach(k => {
        const result = utBotStrategy.processCandle(k.closeTime, parseFloat(k.open), parseFloat(k.high), parseFloat(k.low), parseFloat(k.close));
        if (result.signal) lastSignal = result.signal;
    });

    const initMsg = 
`Bot Başlatıldı!
Mod: ${isSimulationMode ? 'Simülasyon' : 'Canlı İşlem'}
Sembol: ${CFG.SYMBOL}
Zaman Aralığı: ${CFG.INTERVAL}
Son Oluşan Sinyal: ${lastSignal ? lastSignal.message : 'Yok'}`;

    await sendTelegramMessage(initMsg);
    isBotInitialized = true;
}

fetchInitialData();

ws.on('message', async (message) => {
    const data = JSON.parse(message);
    const klineData = data.k;

    if (klineData.x) {
        const result = utBotStrategy.processCandle(klineData.T, parseFloat(klineData.o), parseFloat(klineData.h), parseFloat(klineData.l), parseFloat(klineData.c));
        const signal = result.signal;

        if (signal?.type === 'BUY' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', signal.message);
        } else if (signal?.type === 'SELL' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', signal.message);
        }
    }
});

app.get('/', (req, res) => {
    res.send('Bot çalışıyor!');
});

app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});
