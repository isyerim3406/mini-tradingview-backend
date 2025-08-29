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
    TRADE_SIZE_PERCENT: 100,
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

// Helper function to find the lowest value in an array
const getLowest = (arr) => Math.min(...arr);
// Helper function to find the highest value in an array
const getHighest = (arr) => Math.max(...arr);

// Function to calculate a moving average based on type
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

// Function to calculate Average True Range (ATR)
const atr = (klines, period, smoothingType) => {
    if (klines.length < period) return NaN;
    const trs = klines.slice(1).map((k, i) =>
        Math.max(k.high - k.low, Math.abs(k.high - klines[i].close), Math.abs(k.low - klines[i].close))
    );
    return movingAverage(trs, period, smoothingType);
};

// Function to calculate SSL1 indicator
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
// STRATEGY CLASS - This class manages the state like position and consecutive bar counts.
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
                return { type: 'close', message: `POZISYON KAPAT: Uzun SL (${this.params.STOPLOSS_AL_PERCENT}% düşüş)` };
            }
        } else if (this.currentPosition === 'short' && this.params.USE_STOPLOSS_SAT && this.shortEntryPrice !== null) {
            const stopLossPrice = this.shortEntryPrice * (1 + this.params.STOPLOSS_SAT_PERCENT / 100);
            if (currentBarIndex >= this.shortEntryBarIndex + this.params.STOPLOSS_SAT_ACTIVATION_BARS && lastBar.close >= stopLossPrice) {
                return { type: 'close', message: `POZISYON KAPAT: Kısa SL (${this.params.STOPLOSS_SAT_PERCENT}% yükseliş)` };
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
            return [];
        }

        const signals = [];
        // Simulate trading bar by bar
        for (let i = 0; i < this.klines.length; i++) {
            // No need to pass all historical data to computeSignals,
            // the class itself holds the necessary data.
            const signal = this.computeSignals();
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
let client = null;
let isSimulationMode = false;
// Check if API keys are provided and not just empty strings
if (CFG.BINANCE_API_KEY && CFG.BINANCE_SECRET_KEY && CFG.BINANCE_API_KEY.trim().length > 0 && CFG.BINANCE_SECRET_KEY.trim().length > 0) {
    client = Binance({
        apiKey: CFG.BINANCE_API_KEY,
        apiSecret: CFG.BINANCE_SECRET_KEY,
    });
    console.log("Binance client initialized with provided API keys. Bot will run in live mode.");
    isSimulationMode = false;
} else {
    console.log("No valid Binance API keys found. Bot will run in simulation mode.");
    isSimulationMode = true;
}


// Global variable to store the bot's current position
let botCurrentPosition = 'none';
let klines = [];
let strategyInstance = null;

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
    if (isSimulationMode) {
        console.log('Bot is in simulation mode. Skipping balance check.');
        return 1000; // Default balance for simulation
    }
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
    const intendedPosition = side === 'BUY' ? 'long' : (side === 'SELL' ? 'short' : 'none');

    if (isSimulationMode) {
        console.log(`Bot is in simulation mode. Simulated order: ${side} - Message: ${message}`);
        botCurrentPosition = intendedPosition;
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `📊 Simulated Order: ${side}`);
        return;
    }
    
    try {
        const balance = await getBalance();
        if (balance > 0) {
            const tradeSizeUSDT = balance * (CFG.TRADE_SIZE_PERCENT / 100);
            const lastBar = klines.at(-1);
            if (!lastBar) {
                console.error("No recent bar data to calculate trade size.");
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, '❌ Order failed: No recent bar data.');
                return;
            }
            const symbolPrice = lastBar.close;
            let quantity = tradeSizeUSDT / symbolPrice;

            // If reversing a position, double the quantity
            if ((side === 'BUY' && botCurrentPosition === 'short') || (side === 'SELL' && botCurrentPosition === 'long')) {
                // Double the quantity to close the current position and open a new one
                quantity *= 2; 
            }

            if (quantity <= 0) {
                console.error("Calculated quantity is zero or less. Not placing order.");
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, '❌ Order failed: Calculated quantity is zero or less.');
                return;
            }

            console.log(`Attempting real order placement: ${side} - Quantity: ${quantity} - Message: ${message}`);
            
            // The actual Binance API call should be made here
            // const orderResponse = await client.futuresOrder(...)

            // Update bot position state on successful attempt
            botCurrentPosition = intendedPosition;
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `📊 Order placed: ${side} ${quantity.toFixed(4)} ${CFG.SYMBOL}`);
        } else {
            console.log('Insufficient balance to place an order.');
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, '❌ Order failed: Insufficient balance.');
        }
    } catch (error) {
        console.error('Error placing order:', error.message);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `❌ Order Error: ${error.message}`);
    }
}

async function initializeBot() {
    console.log(`Fetching historical data for ${CFG.SYMBOL}, interval ${CFG.INTERVAL}`);
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
        console.log(`${klines.length} historical candles loaded.`);

        if (klines.length > 0) {
            const historicalStrategy = new SSLHybridStrategy(klines, CFG);
            const historicalSignals = historicalStrategy.run();
            const lastSignal = historicalSignals.filter(s => s.type === 'long' || s.type === 'short' || s.type === 'close').at(-1);

            if (lastSignal) {
                if (lastSignal.type === 'long') botCurrentPosition = 'long';
                else if (lastSignal.type === 'short') botCurrentPosition = 'short';
                else if (lastSignal.type === 'close') botCurrentPosition = 'none';
            }
            
            console.log(`Bot initialized. Historical analysis complete. Current position is: ${botCurrentPosition.toUpperCase()}`);

            strategyInstance = new SSLHybridStrategy(klines, CFG);
        }

    } catch (error) {
        console.error('Error initializing bot:', error.message);
        klines = [];
    }
}

const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', async () => {
    console.log('WebSocket connection opened.');
    await initializeBot();
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
        
        if (!strategyInstance) {
            console.log("Strategy not initialized yet. Skipping bar.");
            return;
        }

        strategyInstance.addBar(newBar);
        const signal = strategyInstance.computeSignals();
        
        console.log(`New candle received. Close price: ${newBar.close}. Detected signal: ${signal.type}`);

        if (signal.type === 'long' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', signal.message);
        } else if (signal.type === 'short' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', signal.message);
        } else if (signal.type === 'close' && botCurrentPosition !== 'none') {
             await placeOrder(botCurrentPosition === 'long' ? 'SELL' : 'BUY', signal.message);
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket connection closed. Reconnecting...');
    setTimeout(() => {
        // Reconnection logic can be added here
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
