import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Binance from 'binance-api-node';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================================
// STRATEGY CONFIGURATION - ALL IN ONE PLACE
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
    TRADE_SIZE: 0.001,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY
};

// =========================================================================================
// INDICATORS - COPIED DIRECTLY FROM 3.HTML AND INDICATORS.JS
// =========================================================================================
import pkg from 'technicalindicators';
const { sma, ema, wma, rma } = pkg;

const getLowest = (arr) => Math.min(...arr);
const getHighest = (arr) => Math.max(...arr);

const movingAverage = (source, length, type) => {
    if (source.length < length) return NaN;
    switch (type) {
        case 'SMA': return sma({ period: length, values: source }).at(-1);
        case 'EMA': return ema({ period: length, values: source }).at(-1);
        case 'WMA': return wma({ period: length, values: source }).at(-1);
        case 'RMA': return rma({ period: length, values: source }).at(-1);
        default: return sma({ period: length, values: source }).at(-1);
    }
};

const atr = (klines, period, smoothingType) => {
    if (klines.length < period) return NaN;
    const trs = klines.slice(1).map((k, i) =>
        Math.max(k.high - k.low, Math.abs(k.high - klines[i].close), Math.abs(k.low - klines[i].close))
    );
    return movingAverage(trs, period, smoothingType);
};

const ssl1 = (klines, length, maType) => {
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);

    const ssl1_emaHigh = movingAverage(high, length, maType);
    const ssl1_emaLow = movingAverage(low, length, maType);

    if (isNaN(ssl1_emaHigh) || isNaN(ssl1_emaLow)) return { ssl1Line: NaN, hlv: 0 };
    
    const hlv = close.at(-1) > ssl1_emaHigh ? 1 : close.at(-1) < ssl1_emaLow ? -1 : 0;
    const ssl1_down = hlv < 0 ? ssl1_emaHigh : ssl1_emaLow;
    return { ssl1Line: ssl1_down, hlv };
};

// =========================================================================================
// STRATEGY LOGIC - COPIED DIRECTLY FROM 3.HTML AND STRATEGY.JS
// =========================================================================================
const computeSignals = (klines, currentPosition, longEntryPrice, longEntryBarIndex, shortEntryPrice, shortEntryBarIndex) => {
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN)) {
        return { type: 'none', message: 'Not enough data' };
    }

    const closePrices = klines.map(k => k.close);
    const lastClose = closePrices.at(-1);
    const currentBarIndex = klines.length - 1;

    const sourcePrices = CFG.BASELINE_SOURCE === 'close' ? closePrices
        : CFG.BASELINE_SOURCE === 'open' ? klines.map(k => k.open)
        : CFG.BASELINE_SOURCE === 'high' ? klines.map(k => k.high)
        : klines.map(k => k.low);

    const baseline = movingAverage(sourcePrices, CFG.LEN, CFG.MA_TYPE);
    const atrValue = atr(klines, CFG.ATR_LEN, CFG.ATR_SMOOTHING);
    const bbmcUpperATR = baseline + atrValue * CFG.ATR_MULT;
    const bbmcLowerATR = baseline - atrValue * CFG.ATR_MULT;
    const ssl1Result = ssl1(klines, CFG.LEN, CFG.MA_TYPE);

    let signalType = 'none';
    let message = '';

    // Check for stop-loss and exit signals first
    if (currentPosition === 'long' && CFG.USE_STOPLOSS_AL && longEntryPrice !== null) {
        const stopLossPrice = longEntryPrice * (1 - CFG.STOPLOSS_AL_PERCENT / 100);
        if (currentBarIndex >= longEntryBarIndex + CFG.STOPLOSS_AL_ACTIVATION_BARS && lastClose <= stopLossPrice) {
            signalType = 'close';
            message = `POZİSYON KAPAT: Uzun SL (${CFG.STOPLOSS_AL_PERCENT}% düşüş)`;
            return { type: signalType, message: message };
        }
    } else if (currentPosition === 'short' && CFG.USE_STOPLOSS_SAT && shortEntryPrice !== null) {
        const stopLossPrice = shortEntryPrice * (1 + CFG.STOPLOSS_SAT_PERCENT / 100);
        if (currentBarIndex >= shortEntryBarIndex + CFG.STOPLOSS_SAT_ACTIVATION_BARS && lastClose >= stopLossPrice) {
            signalType = 'close';
            message = `POZİSYON KAPAT: Kısa SL (${CFG.STOPLOSS_SAT_PERCENT}% yükseliş)`;
            return { type: signalType, message: message };
        }
    }

    // Check for entry signals if no stop-loss triggered
    if (CFG.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
        const consecutiveClosesAbove = closePrices.slice(-CFG.M_BARS_BUY).every(c => c > bbmcUpperATR);
        const consecutiveClosesBelow = closePrices.slice(-CFG.N_BARS_SELL).every(c => c < bbmcLowerATR);

        if (consecutiveClosesAbove && currentPosition !== 'long') {
            signalType = 'buy';
            message = `AL: ${CFG.M_BARS_BUY} bar BBMC+ATR üstü`;
        } else if (consecutiveClosesBelow && currentPosition !== 'short') {
            signalType = 'sell';
            message = `SAT: ${CFG.N_BARS_SELL} bar BBMC+ATR altı`;
        }
    } else if (CFG.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
        const hlv = ssl1Result.hlv;
        if (hlv === 1 && currentPosition !== 'long') {
            signalType = 'buy';
            message = 'AL: SSL1 Kesişimi (Yükseliş)';
        } else if (hlv === -1 && currentPosition !== 'short') {
            signalType = 'sell';
            message = 'SAT: SSL1 Kesişimi (Düşüş)';
        }
    }
    
    // Check for position flips, which are a different type of signal
    if (signalType === 'buy' && currentPosition === 'short') {
        signalType = 'flip_long';
        message = 'YÖN DEĞİŞTİR: SAT pozisyonundan AL pozisyonuna geçiliyor.';
    } else if (signalType === 'sell' && currentPosition === 'long') {
        signalType = 'flip_short';
        message = 'YÖN DEĞİŞTİR: AL pozisyonundan SAT pozisyonuna geçiliyor.';
    }

    return { type: signalType, message: message };
};

// =========================================================================================
// MAIN BOT LOGIC - COMBINED FROM INDEX.JS
// =========================================================================================

// Initialize Binance API client
const client = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY,
});

// Position status and entry price/bar info
let position = 'none';
let longEntryPrice = null;
let longEntryBarIndex = null;
let shortEntryPrice = null;
let shortEntryBarIndex = null;

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
        console.log("Telegram message sent successfully.");
    } catch (err) {
        console.error("Failed to send Telegram message:", err.message);
    }
}

async function placeOrder(side, message) {
    try {
        // Here you would implement your real order placement logic
        // For now, we will just simulate it by updating the position state
        console.log(`Simulating order: ${side} - Message: ${message}`);
        
        // Update position and entry data based on the simulated order
        const currentBarIndex = klines.length - 1;
        if (side === 'BUY') {
            position = 'long';
            longEntryPrice = klines[currentBarIndex].close;
            longEntryBarIndex = currentBarIndex;
            shortEntryPrice = null;
            shortEntryBarIndex = null;
        } else if (side === 'SELL') {
            position = 'short';
            shortEntryPrice = klines[currentBarIndex].close;
            shortEntryBarIndex = currentBarIndex;
            longEntryPrice = null;
            longEntryBarIndex = null;
        } else { // This handles closing a position
            position = 'none';
            longEntryPrice = null;
            longEntryBarIndex = null;
            shortEntryPrice = null;
            shortEntryBarIndex = null;
        }

        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `📊 ${message}`);
    } catch (error) {
        console.error('Error placing order:', error.body);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `❌ Order Error: ${error.message}`);
    }
}

async function fetchHistoricalData() {
    console.log(`Fetching historical data: ${CFG.SYMBOL}, ${CFG.INTERVAL}`);
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${CFG.SYMBOL.toUpperCase()}&interval=${CFG.INTERVAL}&limit=1000`);
        const data = await response.json();
        klines = data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: d[6]
        }));
        console.log(`${klines.length} historical candle data successfully loaded.`);
    } catch (error) {
        console.error('Error fetching historical data:', error.message);
        klines = [];
    }
}

async function processData() {
    console.log(`Processing historical data...`);
    
    let signalCount = 0;
    
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN)) {
        console.log("Insufficient historical data, minimum bar count for processing not reached.");
        return;
    }

    // Initialize temporary position states for backtesting
    let tempPosition = 'none';
    let tempLongEntryPrice = null;
    let tempLongEntryBarIndex = null;
    let tempShortEntryPrice = null;
    let tempShortEntryBarIndex = null;
    
    for (let i = 0; i < klines.length; i++) {
        const subKlines = klines.slice(0, i + 1);
        const signal = computeSignals(subKlines, tempPosition, tempLongEntryPrice, tempLongEntryBarIndex, tempShortEntryPrice, tempShortEntryBarIndex);
        
        // Update temporary position based on signals
        if (signal.type !== 'none') {
            signalCount++;
        }
        
        if (signal.type === 'buy' || signal.type === 'flip_long') {
            if (tempPosition !== 'long') {
                tempPosition = 'long';
                tempLongEntryPrice = subKlines.at(-1).close;
                tempLongEntryBarIndex = i;
                tempShortEntryPrice = null;
                tempShortEntryBarIndex = null;
            }
        } else if (signal.type === 'sell' || signal.type === 'flip_short') {
            if (tempPosition !== 'short') {
                tempPosition = 'short';
                tempShortEntryPrice = subKlines.at(-1).close;
                tempShortEntryBarIndex = i;
                tempLongEntryPrice = null;
                tempLongEntryBarIndex = null;
            }
        } else if (signal.type === 'close') {
            if (tempPosition !== 'none') {
                tempPosition = 'none';
                tempLongEntryPrice = null;
                tempLongEntryBarIndex = null;
                tempShortEntryPrice = null;
                tempShortEntryBarIndex = null;
            }
        }
    }

    console.log(`Historical data processed. Total Signals: ${signalCount}`);
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `Bot successfully started. Historical data loaded. Total ${signalCount} signals found.`);
}

const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', () => {
    console.log('WebSocket connection opened.');
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

        const signal = computeSignals(klines, position, longEntryPrice, longEntryBarIndex, shortEntryPrice, shortEntryBarIndex);

        const barIndex = klines.length - 1;
        const barTime = new Date(newBar.closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        console.log(`New candle data received. Bar No: ${barIndex + 1}, Time: ${barTime}, Closing Price: ${newBar.close}`);
        
        if (signal.type !== 'none') {
            switch (signal.type) {
                case 'buy':
                case 'flip_long':
                    if (position === 'none' || position === 'short') {
                        placeOrder('BUY', signal.message);
                    }
                    break;
                case 'sell':
                case 'flip_short':
                    if (position === 'none' || position === 'long') {
                        placeOrder('SELL', signal.message);
                    }
                    break;
                case 'close':
                    if (position !== 'none') {
                        placeOrder(position === 'long' ? 'SELL' : 'BUY', signal.message);
                    }
                    break;
            }
        }
    }
});

ws.on('close', () => {
    console.log('WebSocket connection closed. Reconnecting...');
    setTimeout(() => {
        // Reconnection function can go here
    }, 5000);
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
});

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
});
