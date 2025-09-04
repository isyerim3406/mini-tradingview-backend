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
// IFTSMI STRATEGY CLASS
// =========================================================================================
class IFTSMIStrategy {
    constructor(options = {}) {
        this.SMIL = options.SMIL || 54;
        this.wmalength = options.wmalength || 6;
        this.IEMA = options.IEMA || 5;
        this.OEMA = options.OEMA || 5;
        this.level_buy = options.level_buy || -0.5;
        this.level_sell = options.level_sell || 0.8;

        this.use_filter = options.use_filter !== undefined ? options.use_filter : true;
        this.atr_period = options.atr_period || 14;
        this.atr_ma_period = options.atr_ma_period || 100;
        this.atr_threshold = options.atr_threshold || 0.7;

        this.initial_capital = options.initial_capital || 100;
        this.qty_percent = options.qty_percent || 100;

        this.position_size = 0;
        this.capital = this.initial_capital;
        this.trades = [];

        this.closes = [];
        this.highs = [];
        this.lows = [];
        this.true_ranges = [];

        this.smi_values = [];
        this.v1_values = [];
        this.inv_values = [];
        this.atr_values = [];
        this.atr_ma_values = [];
        this.ema_states = {};
        this.klines = [];
    }

    calculateEMA(value, period, key) {
        if (!this.ema_states[key]) {
            this.ema_states[key] = { ema: null };
        }
        const state = this.ema_states[key];
        if (state.ema === null) {
            state.ema = value;
        } else {
            const multiplier = 2 / (period + 1);
            state.ema = (value * multiplier) + (state.ema * (1 - multiplier));
        }
        return state.ema;
    }

    calculateSMA(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        return slice.reduce((sum, v) => sum + v, 0) / period;
    }

    calculateWMA(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        let ws = 0, sum = 0;
        for (let i = 0; i < slice.length; i++) {
            ws += (i + 1) * slice[i];
            sum += (i + 1);
        }
        return ws / sum;
    }

    getLowest(values, period) {
        if (values.length < period) return Math.min(...values);
        return Math.min(...values.slice(-period));
    }

    getHighest(values, period) {
        if (values.length < period) return Math.max(...values);
        return Math.max(...values.slice(-period));
    }

    calculateTrueRange(high, low, prevClose) {
        if (prevClose === null) return high - low;
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        return Math.max(tr1, tr2, tr3);
    }

    processCandle(timestamp, open, high, low, close) {
        this.closes.push(close);
        this.highs.push(high);
        this.lows.push(low);
        this.klines.push({ timestamp, open, high, low, close });
        if (this.klines.length > 500) this.klines.shift();

        const prevClose = this.closes.length > 1 ? this.closes[this.closes.length - 2] : null;
        const tr = this.calculateTrueRange(high, low, prevClose);
        this.true_ranges.push(tr);

        const LLow = this.getLowest(this.lows, this.SMIL);
        const HHigh = this.getHighest(this.highs, this.SMIL);
        const SM = close - 0.5 * (HHigh + LLow);

        const avgsm = this.calculateEMA(
            this.calculateEMA(SM, this.IEMA, 'sm_inner'),
            this.OEMA,
            'sm_outer'
        );

        const diff = HHigh - LLow;
        const avgdiff = this.calculateEMA(
            this.calculateEMA(diff, this.IEMA, 'diff_inner'),
            this.OEMA,
            'diff_outer'
        );

        const SMI = avgdiff !== 0 ? 100 * (avgsm / (0.5 * avgdiff)) : 0;
        this.smi_values.push(SMI);

        const v1 = 0.1 * SMI;
        this.v1_values.push(v1);
        const v2 = this.calculateWMA(this.v1_values, this.wmalength);
        const INV = v2 !== null ? (Math.exp(2 * v2) - 1) / (Math.exp(2 * v2) + 1) : 0;
        this.inv_values.push(INV);

        const atr = this.calculateSMA(this.true_ranges, this.atr_period);
        if (atr) this.atr_values.push(atr);
        const atr_ma = this.calculateSMA(this.atr_values, this.atr_ma_period);
        if (atr_ma) this.atr_ma_values.push(atr_ma);

        const is_sideways = this.use_filter && atr && atr_ma && atr < atr_ma * this.atr_threshold;

        let signal = null;
        if (this.inv_values.length >= 2) {
            const cur = this.inv_values[this.inv_values.length - 1];
            const prev = this.inv_values[this.inv_values.length - 2];
            if (prev <= this.level_buy && cur > this.level_buy && !is_sideways) {
                signal = { type: 'BUY', message: 'AL Sinyali' };
            } else if (prev >= this.level_sell && cur < this.level_sell && !is_sideways) {
                signal = { type: 'SELL', message: 'SAT Sinyali' };
            }
        }

        return { signal };
    }

    getAvgEntryPrice() {
        const entries = this.trades.filter(t => t.action === 'entry');
        if (!entries.length) return 0;
        return entries[entries.length - 1].price;
    }

    openPosition(side, price) {
        const qty = (this.capital * (this.qty_percent / 100)) / price;
        this.position_size = side === 'BUY' ? qty : -qty;
        this.trades.push({ type: side, price, quantity: qty, action: 'entry' });
    }

    closePosition(price) {
        if (this.position_size === 0) return 0;
        const pnl = this.position_size * (price - this.getAvgEntryPrice());
        this.capital += pnl;
        this.trades.push({
            type: this.position_size > 0 ? 'SELL' : 'BUY',
            price,
            quantity: Math.abs(this.position_size),
            action: 'exit',
            pnl
        });
        this.position_size = 0;
        return pnl;
    }
}

// =========================================================================================
// CONFIG
// =========================================================================================
const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1h',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    INITIAL_CAPITAL: 100,
    TRADE_SIZE_PERCENT: 100,
    BOT_NAME: "IFTSMI Strategy JS"
};

let botCurrentPosition = 'none';
let totalNetProfit = 0;
let isBotInitialized = false;

const iftsmiStrategy = new IFTSMIStrategy({
    initial_capital: CFG.INITIAL_CAPITAL,
    qty_percent: CFG.TRADE_SIZE_PERCENT,
});

// =========================================================================================
// TELEGRAM
// =========================================================================================
async function sendTelegramMessage(text) {
    if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`;
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CFG.TG_CHAT_ID, text })
    });
}

// =========================================================================================
// INITIAL DATA
// =========================================================================================
async function fetchInitialData() {
    // Binance'ten geçmiş verileri çekmiyoruz, sadece log ve mesaj
    let lastSignal = null;
    if (iftsmiStrategy.inv_values.length > 0) {
        const last = iftsmiStrategy.inv_values[iftsmiStrategy.inv_values.length - 1];
        lastSignal = last > 0 ? { message: "AL Sinyali" } : { message: "SAT Sinyali" };
    }

    if (!isBotInitialized) {
        await sendTelegramMessage(
            `✅ Bot Başlatıldı!\n` +
            `Bot Adı: ${CFG.BOT_NAME}\n` +
            `Sembol: ${CFG.SYMBOL.replace('USDT','/USDT')}\n` +
            `Zaman Aralığı: ${CFG.INTERVAL}\n` +
            `Son Oluşan Sinyal: ${lastSignal ? lastSignal.message : "Yok"}`
        );
        isBotInitialized = true;
    }
}
fetchInitialData();

// =========================================================================================
// TRADING LOGIC
// =========================================================================================
async function placeOrder(side, signalMessage, price) {
    const nowStr = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        const pnl = iftsmiStrategy.closePosition(price);
        totalNetProfit += pnl;
        const profitPct = ((pnl / CFG.INITIAL_CAPITAL) * 100).toFixed(2);
        const netPct = ((totalNetProfit / CFG.INITIAL_CAPITAL) * 100).toFixed(2);

        await sendTelegramMessage(
            `${side} Emri Gerçekleşti!\n\n` +
            `Bot Adı: ${CFG.BOT_NAME}\n` +
            `Sembol: ${CFG.SYMBOL.replace('USDT','/USDT')}\n` +
            `Zaman Aralığı: ${CFG.INTERVAL}\n` +
            `Sinyal:${signalMessage}\n` +
            `Fiyat:${price}\n` +
            `Zaman : ${nowStr}\n` +
            `Bu İşlemden Kar/Zarar : % ${profitPct} (${pnl.toFixed(2)} USDT)\n` +
            `Toplam Net Kar/Zarar : % ${netPct} (${totalNetProfit.toFixed(2)} USDT)`
        );
    }

    iftsmiStrategy.openPosition(side, price);
    botCurrentPosition = side.toLowerCase();
}

// =========================================================================================
// WEBSOCKET
// =========================================================================================
const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('message', async (message) => {
    const data = JSON.parse(message);
    const k = data.k;
    if (k.x) {
        console.log(`📊 Yeni bar alındı. Kapanış: ${k.c}`);
        const res = iftsmiStrategy.processCandle(k.t, parseFloat(k.o), parseFloat(k.h), parseFloat(k.l), parseFloat(k.c));
        if (res.signal) {
            await placeOrder(res.signal.type, res.signal.message, parseFloat(k.c));
        }
    }
});

// =========================================================================================
// EXPRESS
// =========================================================================================
app.get('/', (req, res) => {
    res.json({ bot: CFG.BOT_NAME, pos: botCurrentPosition, net: totalNetProfit });
});

app.listen(PORT, () => console.log(`🚀 Bot running on port ${PORT}`));
