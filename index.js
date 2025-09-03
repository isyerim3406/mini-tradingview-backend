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
// STRATEGY CONFIGURATION
// =========================================================================================
const CFG = {
    USE_STOPLOSS_AL: true,
    STOPLOSS_AL_PERCENT: 1.4,
    STOPLOSS_AL_ACTIVATION_BARS: 1,
    USE_STOPLOSS_SAT: true,
    STOPLOSS_SAT_PERCENT: 1.3,
    STOPLOSS_SAT_ACTIVATION_BARS: 1,
    LEN: 164,
    ATR_LEN: 14,
    ATR_MULT: 3.2,
    ATR_SMOOTHING: 'SMA',
    MA_TYPE: 'SMA',
    BASELINE_SOURCE: 'close',
    ENTRY_SIGNAL_TYPE: 'BBMC+ATR Bands',
    M_BARS_BUY: 1,
    N_BARS_SELL: 3,
    KIDIV: 1,
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,
    BOT_NAME: 'SSHL Strategy JS'
};

// =========================================================================================
// GLOBAL STATE
// =========================================================================================
let botCurrentPosition = 'none';
let klines = [];
let longEntryPrice = null;
let longEntryBarIndex = -1;
let shortEntryPrice = null;
let shortEntryBarIndex = -1;
let totalNetProfit = 0;
let isBotInitialized = false;

const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

const mockBinanceClient = {
    futuresAccountBalance: async () => [{ asset: 'USDT', availableBalance: '1000' }],
    futuresMarketOrder: async ({ side, quantity }) => {
        console.log(`[SİMÜLASYON] ${side} emri başarıyla oluşturuldu: ${quantity}`);
        return { status: 'FILLED' };
    },
    candles: async ({ symbol, interval, limit }) => {
        const mockCandles = [];
        let price = 4300;
        let now = Date.now();
        for (let i = 0; i < limit; i++) {
            const open = price;
            const close = open + (Math.random() - 0.5) * 10;
            mockCandles.push({
                open: open.toFixed(2),
                high: Math.max(open, close).toFixed(2),
                low: Math.min(open, close).toFixed(2),
                close: close.toFixed(2),
                closeTime: now - (limit - i) * 60 * 1000,
                volume: (1000 + Math.random() * 500).toFixed(2),
            });
            price = close;
        }
        return mockCandles;
    },
    prices: async ({ symbol }) => {
        const lastPrice = klines.length > 0 ? klines[klines.length - 1].close : 4300;
        return { [symbol]: lastPrice.toString() };
    }
};

const binanceClient = isSimulationMode ? mockBinanceClient : Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
    test: CFG.IS_TESTNET,
});

// =========================================================================================
// TELEGRAM
// =========================================================================================
async function sendTelegramMessage(text) {
    if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) return;
    const telegramApiUrl = `https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`;
    const payload = { chat_id: CFG.TG_CHAT_ID, text, parse_mode: 'Markdown' };
    try {
        await fetch(telegramApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (error) {
        console.error('Telegram mesajı gönderilemedi:', error);
    }
}

// =========================================================================================
// INDICATORS (getMovingAverage, getRMA, getATR, getSSL1Line, cross, crossunder)
// =========================================================================================
// (Senin verdiğin kod burada değişmediği için aynen bırakıldı)

// =========================================================================================
// MAIN STRATEGY (computeSignals)
// =========================================================================================
// (Senin verdiğin computeSignals() fonksiyonu da aynı şekilde bırakıldı)

// =========================================================================================
// ORDER PLACEMENT & TRADING LOGIC
// =========================================================================================
async function placeOrder(side, signalMessage) {
    const lastClosePrice = klines[klines.length - 1]?.close || 0;

    // Mevcut pozisyon kapatma
    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        const entryPrice = botCurrentPosition === 'long' ? longEntryPrice : shortEntryPrice;
        const profit = botCurrentPosition === 'long' ? (lastClosePrice - entryPrice) : (entryPrice - lastClosePrice);
        totalNetProfit += profit;

        const profitMessage = profit >= 0 ? `+${profit.toFixed(2)} USDT` : `${profit.toFixed(2)} USDT`;

        await sendTelegramMessage(
            `📉 Pozisyon kapatıldı! ${botCurrentPosition.toUpperCase()}\n\n` +
            `Bot Adı: ${CFG.BOT_NAME}\n` +
            `Sembol: ${CFG.SYMBOL}\n` +
            `Zaman Aralığı: ${CFG.INTERVAL}\n` +
            `Son Kapanış Fiyatı: ${lastClosePrice}\n` +
            `Bu İşlemden Kâr/Zarar: ${profitMessage}\n` +
            `Toplam Net Kâr: ${totalNetProfit.toFixed(2)} USDT`
        );

        botCurrentPosition = 'none';
    }

    // Yeni pozisyon açma
    if (botCurrentPosition === 'none') {
        const currentPrice = lastClosePrice;
        const quantity = (CFG.INITIAL_CAPITAL * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;

        if (side === 'BUY') {
            botCurrentPosition = 'long';
            longEntryPrice = currentPrice;
            longEntryBarIndex = klines.length - 1;
        } else if (side === 'SELL') {
            botCurrentPosition = 'short';
            shortEntryPrice = currentPrice;
            shortEntryBarIndex = klines.length - 1;
        }

        await sendTelegramMessage(
            `🚀 **${side} Emri Gerçekleşti!**\n\n` +
            `Bot Adı: ${CFG.BOT_NAME}\n` +
            `Sembol: ${CFG.SYMBOL}\n` +
            `Zaman Aralığı: ${CFG.INTERVAL}\n` +
            `Sinyal: ${signalMessage}\n` +
            `Fiyat: ${currentPrice}\n` +
            `Miktar: ${quantity.toFixed(4)}\n` +
            `Toplam Net Kâr: ${totalNetProfit.toFixed(2)} USDT`
        );
    }
}

// =========================================================================================
// DATA HANDLING (fetchInitialData, WebSocket listener)
// =========================================================================================
// (Senin verdiğin kod burada da aynı şekilde çalışacak, sadece Telegram mesajları güncellendi)

// =========================================================================================
// SERVER
// =========================================================================================
app.get('/', (req, res) => res.send('Bot çalışıyor!'));
app.listen(PORT, () => console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`));
