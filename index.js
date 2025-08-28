import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Binance from 'binance-api-node';

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
    TRADE_SIZE_PERCENT: 100, // New configuration for 100% of balance
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY
};

// =========================================================================================
// INDICATORS - Extracted from 3.html
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
    return { ssl1Line: hlv < 0 ? ssl1_emaHigh : ssl1_emaLow, hlv };
};

// =========================================================================================
// STRATEGY CLASS - EXACTLY as in 3.html
// This class holds the state for backtesting and live trading.
// =========================================================================================
class SSLHybridStrategy {
    constructor(initialKlines, params) {
        this.klines = [...initialKlines];
        this.params = params;
        this.consecutive_closes_above_entry_target = 0;
        this.consecutive_closes_below_entry_target = 0;
        this.currentPosition = 'none';
        this.longEntryPrice = null;
        this.longEntryBarIndex = null;
        this.shortEntryPrice = null;
        this.shortEntryBarIndex = null;
    }

    addBar(newBar) {
        this.klines.push(newBar);
        if (this.klines.length > 1000) {
            this.klines.shift();
        }
    }

    computeSignals() {
        if (this.klines.length < Math.max(this.params.LEN, this.params.ATR_LEN)) {
            return { type: 'none', message: 'Not enough data' };
        }

        const lastBar = this.klines.at(-1);
        const currentBarIndex = this.klines.length - 1;
        const closePrices = this.klines.map(k => k.close);
        
        // Calculate indicators
        const sourcePrices = this.params.BASELINE_SOURCE === 'close' ? closePrices
            : this.params.BASELINE_SOURCE === 'open' ? this.klines.map(k => k.open)
            : this.params.BASELINE_SOURCE === 'high' ? this.klines.map(k => k.high)
            : this.klines.map(k => k.low);

        const baseline = movingAverage(sourcePrices, this.params.LEN, this.params.MA_TYPE);
        const atrValue = atr(this.klines, this.params.ATR_LEN, this.params.ATR_SMOOTHING);
        const bbmcUpperATR = baseline + atrValue * this.params.ATR_MULT;
        const bbmcLowerATR = baseline - atrValue * this.params.ATR_MULT;
        const ssl1Result = ssl1(this.klines, this.params.LEN, this.params.MA_TYPE);
        
        // Check for stop-loss and exit signals first
        if (this.currentPosition === 'long' && this.params.USE_STOPLOSS_AL && this.longEntryPrice !== null) {
            const stopLossPrice = this.longEntryPrice * (1 - this.params.STOPLOSS_AL_PERCENT / 100);
            if (currentBarIndex >= this.longEntryBarIndex + this.params.STOPLOSS_AL_ACTIVATION_BARS && lastBar.close <= stopLossPrice) {
                return { type: 'close', message: `POZİSYON KAPAT: Uzun SL (${this.params.STOPLOSS_AL_PERCENT}% düşüş)` };
            }
        } else if (this.currentPosition === 'short' && this.params.USE_STOPLOSS_SAT && this.shortEntryPrice !== null) {
            const stopLossPrice = this.shortEntryPrice * (1 + this.params.STOPLOSS_SAT_PERCENT / 100);
            if (currentBarIndex >= this.shortEntryBarIndex + this.params.STOPLOSS_SAT_ACTIVATION_BARS && lastBar.close >= stopLossPrice) {
                return { type: 'close', message: `POZİSYON KAPAT: Kısa SL (${this.params.STOPLOSS_SAT_PERCENT}% yükseliş)` };
            }
        }

        let entryAction = { type: 'none', message: '' };

        // Update consecutive counter
        if (lastBar.close > bbmcUpperATR) {
            this.consecutive_closes_above_entry_target++;
            this.consecutive_closes_below_entry_target = 0;
        } else if (lastBar.close < bbmcLowerATR) {
            this.consecutive_closes_below_entry_target++;
            this.consecutive_closes_above_entry_target = 0;
        } else {
            this.consecutive_closes_above_entry_target = 0;
            this.consecutive_closes_below_entry_target = 0;
        }

        // Entry conditions
        const longCondition = this.consecutive_closes_above_entry_target === this.params.M_BARS_BUY && this.params.M_BARS_BUY > 0;
        const shortCondition = this.consecutive_closes_below_entry_target === this.params.N_BARS_SELL && this.params.N_BARS_SELL > 0;

        if (longCondition && this.currentPosition !== 'long') {
            entryAction = { type: 'long', message: `AL: ${this.params.M_BARS_BUY} bar BBMC+ATR üstü` };
        } else if (shortCondition && this.currentPosition !== 'short') {
            entryAction = { type: 'short', message: `SAT: ${this.params.N_BARS_SELL} bar BBMC+ATR altı` };
        }

        // SSL1 check if BBMC doesn't provide a signal
        if (entryAction.type === 'none' && this.params.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
            const hlv = ssl1Result.hlv;
            if (hlv === 1 && this.currentPosition !== 'long') {
                entryAction = { type: 'long', message: 'AL: SSL1 Kesişimi (Yükseliş)' };
            } else if (hlv === -1 && this.currentPosition !== 'short') {
                entryAction = { type: 'short', message: 'SAT: SSL1 Kesişimi (Düşüş)' };
            }
        }
        
        // Update position based on entry action
        if (entryAction.type === 'long') {
            this.currentPosition = 'long';
            this.longEntryPrice = lastBar.close;
            this.longEntryBarIndex = currentBarIndex;
            this.shortEntryPrice = null;
            this.shortEntryBarIndex = null;
        } else if (entryAction.type === 'short') {
            this.currentPosition = 'short';
            this.shortEntryPrice = lastBar.close;
            this.shortEntryBarIndex = currentBarIndex;
            this.longEntryPrice = null;
            this.longEntryBarIndex = null;
        } else if (entryAction.type === 'none' && this.currentPosition !== 'none') {
            // Check for cross-over signals that close a position
            if (this.currentPosition === 'long' && lastBar.close < bbmcUpperATR) {
                entryAction = { type: 'close', message: 'POZISYON KAPAT: Yükseliş trendi sonu' };
                this.currentPosition = 'none';
            } else if (this.currentPosition === 'short' && lastBar.close > bbmcLowerATR) {
                entryAction = { type: 'close', message: 'POZISYON KAPAT: Düşüş trendi sonu' };
                this.currentPosition = 'none';
            }
        }
        
        return entryAction;
    }

    run() {
        if (this.klines.length < Math.max(this.params.LEN, this.params.ATR_LEN)) {
            console.log("Insufficient historical data to run strategy.");
            return [];
        }

        const signals = [];
        // Simulate trading bar by bar
        for (let i = 0; i < this.klines.length; i++) {
            const subKlines = this.klines.slice(0, i + 1);
            const strat = new SSLHybridStrategy(subKlines, this.params);
            
            // Re-run from the beginning to maintain state
            for(let j=0; j<subKlines.length; j++) {
                strat.computeSignals();
            }

            const signal = strat.computeSignals();
            if (signal.type !== 'none') {
                signals.push({
                    bar: i + 1,
                    type: signal.type,
                    message: signal.message,
                    price: this.klines[i].close
                });
            }
        }
        return signals;
    }
}

// =========================================================================================
// MAIN BOT LOGIC
// =========================================================================================
const client = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY,
});

let klines = [];
let strategyInstance = null;
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

async function getBalance() {
    try {
        const balanceResponse = await client.futuresBalance();
        const usdtBalance = balanceResponse.find(b => b.asset === 'USDT');
        if (usdtBalance) {
            return parseFloat(usdtBalance.availableBalance);
        }
    } catch (error) {
        console.error('Error fetching balance:', error.message);
    }
    return 0;
}

async function placeOrder(side, message) {
    try {
        const balance = await getBalance();
        if (balance > 0) {
            const tradeSizeUSDT = balance * (CFG.TRADE_SIZE_PERCENT / 100);
            const lastBar = klines.at(-1);
            if (!lastBar) {
                console.error("No recent bar data to calculate trade size.");
                return;
            }
            const symbolPrice = lastBar.close;
            const quantity = tradeSizeUSDT / symbolPrice;

            if (quantity <= 0) {
                console.error("Calculated quantity is zero or less. Not placing order.");
                return;
            }

            // Here you would implement your real order placement logic using client.futuresOrder
            console.log(`Simulating order: ${side} - Quantity: ${quantity} - Message: ${message}`);
            // Simulating position update after successful order
            if (side === 'BUY') {
                strategyInstance.currentPosition = 'long';
                strategyInstance.longEntryPrice = symbolPrice;
                strategyInstance.longEntryBarIndex = klines.length - 1;
                strategyInstance.shortEntryPrice = null;
                strategyInstance.shortEntryBarIndex = null;
            } else if (side === 'SELL') {
                strategyInstance.currentPosition = 'short';
                strategyInstance.shortEntryPrice = symbolPrice;
                strategyInstance.shortEntryBarIndex = klines.length - 1;
                strategyInstance.longEntryPrice = null;
                strategyInstance.longEntryBarIndex = null;
            }

            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `📊 Order placed: ${side} ${quantity.toFixed(4)} ${CFG.SYMBOL}`);
        } else {
            console.log('Insufficient balance to place an order.');
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, '❌ Order failed: Insufficient balance.');
        }
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
    
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN)) {
        console.log("Insufficient historical data, minimum bar count for processing not reached.");
        return;
    }

    const strat = new SSLHybridStrategy(klines, CFG);
    const results = strat.run();
    
    // Filter for unique entry/exit events
    const entrySignals = results.filter(s => s.type === 'long' || s.type === 'short');
    const lastSignal = entrySignals.at(-1);

    console.log(`Historical data processed. Total Signals: ${entrySignals.length}, Last Signal: ${lastSignal ? lastSignal.type.toUpperCase() : 'None'} (Bar: ${lastSignal ? lastSignal.bar : 'N/A'})`);
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `Bot successfully started. Historical data loaded. Total ${entrySignals.length} signals found.`);
}

const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', () => {
    console.log('WebSocket connection opened.');
    fetchHistoricalData().then(() => {
        if (klines.length > 0) {
            // Initialize the strategy instance with historical data
            strategyInstance = new SSLHybridStrategy(klines, CFG);
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
        
        if (strategyInstance) {
            strategyInstance.addBar(newBar);
            const signal = strategyInstance.computeSignals();

            const barIndex = strategyInstance.klines.length - 1;
            const barTime = new Date(newBar.closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
            console.log(`New candle data received. Bar No: ${barIndex + 1}, Time: ${barTime}, Closing Price: ${newBar.close}`);
            
            if (signal.type !== 'none') {
                if (signal.type === 'long') {
                    if (strategyInstance.currentPosition === 'long') {
                        // Already in long position, do nothing
                    } else if (strategyInstance.currentPosition === 'short') {
                        // Close short position and open long
                        await placeOrder('SELL', `YÖN DEĞİŞTİR: Mevcut SAT pozisyonu kapatılıyor`);
                        await placeOrder('BUY', `YÖN DEĞİŞTİR: Yeni AL pozisyonu açılıyor`);
                    } else {
                        // Open new long position
                        await placeOrder('BUY', signal.message);
                    }
                } else if (signal.type === 'short') {
                    if (strategyInstance.currentPosition === 'short') {
                        // Already in short position, do nothing
                    } else if (strategyInstance.currentPosition === 'long') {
                        // Close long position and open short
                        await placeOrder('SELL', `YÖN DEĞİŞTİR: Mevcut AL pozisyonu kapatılıyor`);
                        await placeOrder('BUY', `YÖN DEĞİŞTİR: Yeni SAT pozisyonu açılıyor`);
                    } else {
                        // Open new short position
                        await placeOrder('SELL', signal.message);
                    }
                } else if (signal.type === 'close') {
                    await placeOrder(strategyInstance.currentPosition === 'long' ? 'SELL' : 'BUY', signal.message);
                }
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
