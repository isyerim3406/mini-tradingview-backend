import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Binance from 'binance-api-node';
import pkg from 'technicalindicators';
const { sma, ema, wma, rma } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================================
// STRATEGY CONFIGURATION (from .env or defaults)
// =========================================================================================
const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
    TRADE_SIZE: 0.001,
    // Strategy settings (to be overridden on Render.com or in the .env file)
    ATR_LEN: parseFloat(process.env.ATR_LEN) || 14,
    ATR_MULT: parseFloat(process.env.ATR_MULT) || 1.0,
    ATR_SMOOTHING: process.env.ATR_SMOOTHING || 'WMA',
    MA_TYPE: process.env.MA_TYPE || 'HMA',
    BASELINE_SOURCE: process.env.BASELINE_SOURCE || 'close',
    LEN: parseFloat(process.env.LEN) || 60,
    KIDIV: parseFloat(process.env.KIDIV) || 1,
    ENTRY_SIGNAL_TYPE: process.env.ENTRY_SIGNAL_TYPE || 'SSL1 Kesişimi',
    M_BARS_BUY: parseFloat(process.env.M_BARS_BUY) || 1,
    N_BARS_SELL: parseFloat(process.env.N_BARS_SELL) || 1,
    USE_STOP_LOSS_AL: process.env.USE_STOP_LOSS_AL === 'true',
    STOP_LOSS_AL_PERCENT: parseFloat(process.env.STOP_LOSS_AL_PERCENT) || 2.0,
    STOP_LOSS_AL_ACTIVATION_BARS: parseFloat(process.env.STOP_LOSS_AL_ACTIVATION_BARS) || 1,
    USE_STOP_LOSS_SAT: process.env.USE_STOP_LOSS_SAT === 'true',
    STOP_LOSS_SAT_PERCENT: parseFloat(process.env.STOP_LOSS_SAT_PERCENT) || 2.0,
    STOP_LOSS_SAT_ACTIVATION_BARS: parseFloat(process.env.STOP_LOSS_SAT_ACTIVATION_BARS) || 1,
};

// =========================================================================================
// INDICATORS & HELPER FUNCTIONS
// All logic from indicators.js is moved here.
// =========================================================================================

const getAvg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const getLowest = (arr) => Math.min(...arr);
const getHighest = (arr) => Math.max(...arr);

const movingAverage = (source, length, type, k) => {
    if (source.length < length) return NaN;
    const values = source.slice(-length);
    switch (type) {
        case 'SMA': return sma({ period: length, values: values }).at(-1);
        case 'EMA': return ema({ period: length, values: values }).at(-1);
        case 'WMA': return wma({ period: length, values: values }).at(-1);
        case 'RMA': return rma({ period: length, values: values }).at(-1);
        case 'HMA':
            const wma1_vals = source.slice(-Math.round(length / 2));
            const wma1 = wma({ period: Math.round(length / 2), values: wma1_vals }).at(-1);
            const wma2 = wma({ period: length, values: source.slice(-length) }).at(-1);
            if (isNaN(wma1) || isNaN(wma2)) return NaN;
            const wmaDiff = wma1 * 2 - wma2;
            return wma({ period: Math.round(Math.sqrt(length)), values: [wmaDiff] }).at(-1);
        case 'Kijun v2':
            const kijun = (getLowest(values.map(b => b.low)) + getHighest(values.map(b => b.high))) / 2;
            const conversion = (getLowest(values.slice(-Math.max(1, Math.floor(length / k))).map(b => b.low)) + getHighest(values.slice(-Math.max(1, Math.floor(length / k))).map(b => b.high))) / 2;
            return (kijun + conversion) / 2;
        default: return sma({ period: length, values: values }).at(-1);
    }
};

const atr = (klines, length, smoothing) => {
    if (klines.length < length + 1) return NaN;
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);
    const tr = [];
    for (let i = 1; i < klines.length; i++) {
        tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i-1]), Math.abs(low[i] - close[i-1])));
    }
    const trueRange = tr;
    const values = trueRange.slice(-length);
    switch (smoothing) {
        case 'RMA': return rma({ period: length, values: values }).at(-1);
        case 'SMA': return sma({ period: length, values: values }).at(-1);
        case 'EMA': return ema({ period: length, values: values }).at(-1);
        case 'WMA': return wma({ period: length, values: values }).at(-1);
        default: return sma({ period: length, values: values }).at(-1);
    }
};

const crossover = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    return series1.at(-2) <= series2.at(-2) && series1.at(-1) > series2.at(-1);
};

const crossunder = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    return series1.at(-2) >= series2.at(-2) && series1.at(-1) < series2.at(-1);
};


// =========================================================================================
// STRATEGY CLASS
// All logic from strategy.js is moved here.
// =========================================================================================
class SSLHybridStrategy {
    constructor(cfg) {
        this.cfg = cfg;
        this.klines = [];
        this.position = 'none';
        this.lastHlv = 0;
        this.lastSSL1Line = NaN;
    }

    onNewBar(newBar) {
        this.klines.push(newBar);
        if (this.klines.length > this.cfg.LEN * 2) {
            this.klines.shift();
        }

        if (this.klines.length < this.cfg.LEN) {
            return { buy: false, sell: false };
        }

        return this.computeSignals();
    }

    computeSignals() {
        const closePrices = this.klines.map(k => k.close);
        const highPrices = this.klines.map(k => k.high);
        const lowPrices = this.klines.map(k => k.low);

        const lastClose = closePrices.at(-1);

        const baseline = movingAverage(closePrices, this.cfg.LEN, this.cfg.MA_TYPE, this.cfg.KIDIV);
        const atrValue = atr(this.klines, this.cfg.ATR_LEN, this.cfg.ATR_SMOOTHING);

        const bbmcUpperATR = baseline + atrValue * this.cfg.ATR_MULT;
        const bbmcLowerATR = baseline - atrValue * this.cfg.ATR_MULT;

        const ssl1EmaHigh = movingAverage(highPrices, this.cfg.LEN, this.cfg.MA_TYPE, this.cfg.KIDIV);
        const ssl1EmaLow = movingAverage(lowPrices, this.cfg.LEN, this.cfg.MA_TYPE, this.cfg.KIDIV);
        
        const currentHlv = lastClose > ssl1EmaHigh ? 1 : lastClose < ssl1EmaLow ? -1 : this.lastHlv;
        const ssl1Line = currentHlv < 0 ? ssl1EmaHigh : ssl1EmaLow;

        this.lastHlv = currentHlv;
        
        let buySignal = false;
        let sellSignal = false;
        
        if (this.cfg.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
            const consecutiveClosesAbove = closePrices.slice(-this.cfg.M_BARS_BUY).every(c => c > bbmcUpperATR);
            const consecutiveClosesBelow = closePrices.slice(-this.cfg.N_BARS_SELL).every(c => c < bbmcLowerATR);
            buySignal = consecutiveClosesAbove;
            sellSignal = consecutiveClosesBelow;
        } else if (this.cfg.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
            buySignal = crossover(closePrices, [this.lastSSL1Line, ssl1Line]);
            sellSignal = crossunder(closePrices, [this.lastSSL1Line, ssl1Line]);
        }
        
        this.lastSSL1Line = ssl1Line;
        
        return { buy: buySignal, sell: sellSignal };
    }
}

// =========================================================================================
// MAIN SERVER LOGIC
// =========================================================================================
const client = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY,
});

async function sendTelegramMessage(token, chatId, message) {
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message
            })
        });
    } catch (error) {
        console.error('Error sending Telegram message:', error);
    }
}

async function placeOrder(side, size) {
    try {
        const order = await client.order({
            symbol: CFG.SYMBOL,
            side: side,
            quantity: size,
            type: 'MARKET'
        });
        console.log(`${side} order placed:`, order);
        return order;
    } catch (error) {
        console.error('Error placing order:', error);
        return null;
    }
}

const strategy = new SSLHybridStrategy(CFG);

const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', () => {
    console.log('✅ WebSocket connection established.');
});

ws.on('message', async (data) => {
    const event = JSON.parse(data);
    const kline = event.k;
    if (kline.x) { // Candle close
        const newBar = {
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            closeTime: kline.T
        };

        const signals = strategy.onNewBar(newBar);
        const barTime = new Date(newBar.closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        console.log(`New bar data received. Bar Time: ${barTime}, Close Price: ${newBar.close}`);

        if (signals.buy) {
            console.log(`--- BUY Signal Triggered! ---`);
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `AL sinyali geldi! Fiyat: ${newBar.close}`);
            await placeOrder('BUY', CFG.TRADE_SIZE);
        } else if (signals.sell) {
            console.log(`--- SELL Signal Triggered! ---`);
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `SAT sinyali geldi! Fiyat: ${newBar.close}`);
            await placeOrder('SELL', CFG.TRADE_SIZE);
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket connection closed. Reconnecting...');
    setTimeout(() => {
        // Reconnection logic can go here
    }, 5000);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}.`);
});
