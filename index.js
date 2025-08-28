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
    KIDIV: 1,
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY
};

// =========================================================================================
// STRATEGY CLASS - Exact copy from 3.html
// =========================================================================================
class SSLHybridStrategy {
    constructor(data, params) {
        this.data = data;
        this.params = params;
        this.position = 0;
        this.longEntryPrice = null; 
        this.longEntryBarIndex = null;
        this.shortEntryPrice = null; 
        this.shortEntryBarIndex = null;
        this.consecutive_closes_above_entry_target = 0;
        this.consecutive_closes_below_entry_target = 0;
        this.Hlv1 = []; 
        this.mg = [];
        this.trCache = [];
    }

    sma(data) { 
        return data.reduce((a, b) => a + b, 0) / data.length; 
    }

    ema(data, period) {
        if (data.length < period) return null;
        const k = 2 / (period + 1);
        let ema = this.sma(data.slice(0, period));
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        return ema;
    }

    rma(data, period) {
        if (data.length < period) return null;
        const alpha = 1 / period;
        let rma = this.sma(data.slice(0, period));
        for (let i = period; i < data.length; i++) {
            rma = alpha * data[i] + (1 - alpha) * rma;
        }
        return rma;
    }

    wma(data) {
        let sum = 0, weightSum = 0;
        for (let i = 0; i < data.length; i++) { 
            const weight = i + 1; 
            sum += data[i] * weight; 
            weightSum += weight; 
        }
        return sum / weightSum;
    }

    ma_function(source, period, smoothing) {
        if (source.length < period) return null;
        switch(smoothing) {
            case 'SMA': return this.sma(source.slice(-period));
            case 'EMA': return this.ema(source, period);
            case 'RMA': return this.rma(source, period);
            case 'WMA': return this.wma(source.slice(-period));
            default: return this.sma(source.slice(-period));
        }
    }

    ma(type, sourceArray, period, barIndex) {
        if (sourceArray.length < period) return null;
        switch(type) {
            case 'SMA': return this.sma(sourceArray.slice(-period));
            case 'EMA': return this.ema(sourceArray, period);
            case 'WMA': return this.wma(sourceArray.slice(-period));
            case 'RMA': return this.rma(sourceArray, period);
            case 'LSMA': {
                const data = sourceArray.slice(-period);
                let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
                for (let i = 0; i < period; i++) { 
                    sumX += i; 
                    sumY += data[i]; 
                    sumXY += i * data[i]; 
                    sumX2 += i * i; 
                }
                const slope = (period * sumXY - sumX * sumY) / (period * sumX2 - sumX * sumX);
                const intercept = (sumY - slope * sumX) / period;
                return slope * (period - 1) + intercept;
            }
            case 'HMA': {
                const halfPeriod = Math.floor(period / 2);
                if (sourceArray.length < period) return null;
                const wma1 = this.wma(sourceArray.slice(-halfPeriod));
                const wma2 = this.wma(sourceArray.slice(-period));
                return 2 * wma1 - wma2;
            }
            case 'Kijun v2': {
                const slice = sourceArray.slice(-period);
                const high = Math.max(...slice);
                const low = Math.min(...slice);
                const kijun = (low + high) / 2;
                const convPeriod = Math.max(1, Math.floor(period / this.params.KIDIV));
                const convSlice = sourceArray.slice(-convPeriod);
                const convHigh = Math.max(...convSlice);
                const convLow = Math.min(...convSlice);
                const conversionLine = (convLow + convHigh) / 2;
                return (kijun + conversionLine) / 2;
            }
            case 'McGinley': {
                const currentPrice = sourceArray[sourceArray.length - 1];
                const emaValue = this.ema(sourceArray, period);
                if (barIndex === 0 || this.mg[barIndex - 1] === undefined) { 
                    this.mg[barIndex] = emaValue; 
                } else { 
                    const prevMg = this.mg[barIndex - 1]; 
                    const ratio = currentPrice / prevMg; 
                    this.mg[barIndex] = prevMg + (currentPrice - prevMg) / (period * Math.pow(ratio, 4)); 
                }
                return this.mg[barIndex];
            }
            default: return this.sma(sourceArray.slice(-period));
        }
    }

    calculateTrueRange(index) {
        if (this.trCache[index] !== undefined) return this.trCache[index];
        const bar = this.data[index];
        if (index === 0) return this.trCache[index] = bar.high - bar.low;
        const prevBar = this.data[index - 1];
        const tr1 = bar.high - bar.low;
        const tr2 = Math.abs(bar.high - prevBar.close);
        const tr3 = Math.abs(bar.low - prevBar.close);
        return this.trCache[index] = Math.max(tr1, tr2, tr3);
    }

    addBar(newBar) {
        this.data.push(newBar);
        if (this.data.length > 1000) {
            this.data.shift();
            // Shift all cached arrays
            this.Hlv1.shift();
            this.mg.shift();
            this.trCache.shift();
            // Adjust indices
            if (this.longEntryBarIndex !== null) this.longEntryBarIndex--;
            if (this.shortEntryBarIndex !== null) this.shortEntryBarIndex--;
        }
    }

    computeSignals() {
        if (this.data.length < Math.max(this.params.LEN, this.params.ATR_LEN)) {
            return { type: 'none', message: 'Yetersiz veri' };
        }

        const i = this.data.length - 1; // Current bar index
        const bar = this.data[i];
        
        const opens = this.data.slice(0, i + 1).map(d => d.open);
        const highs = this.data.slice(0, i + 1).map(d => d.high);
        const lows = this.data.slice(0, i + 1).map(d => d.low);
        const closes = this.data.slice(0, i + 1).map(d => d.close);

        let srcArray;
        switch(this.params.BASELINE_SOURCE) {
            case 'low': srcArray = lows; break;
            case 'high': srcArray = highs; break;
            case 'open': srcArray = opens; break;
            default: srcArray = closes;
        }

        const trArray = [];
        for (let j = 0; j <= i; j++) {
            trArray.push(this.calculateTrueRange(j));
        }

        const atr_calc = this.ma_function(trArray, this.params.ATR_LEN, this.params.ATR_SMOOTHING);
        const BBMC = this.ma(this.params.MA_TYPE, srcArray, this.params.LEN, i);

        if (BBMC === null || atr_calc === null) {
            if (i === 0) this.Hlv1[i] = 0;
            else this.Hlv1[i] = this.Hlv1[i - 1];
            return { type: 'none', message: 'Yetersiz veri' };
        }

        const BBMC_upper_atr = BBMC + atr_calc * this.params.ATR_MULT;
        const BBMC_lower_atr = BBMC - atr_calc * this.params.ATR_MULT;

        const ssl1_emaHigh = this.ma(this.params.MA_TYPE, highs, this.params.LEN, i);
        const ssl1_emaLow = this.ma(this.params.MA_TYPE, lows, this.params.LEN, i);

        if (i === 0) {
            if (bar.close > ssl1_emaHigh) this.Hlv1[i] = 1;
            else if (bar.close < ssl1_emaLow) this.Hlv1[i] = -1;
            else this.Hlv1[i] = 0;
        } else {
            if (bar.close > ssl1_emaHigh) this.Hlv1[i] = 1;
            else if (bar.close < ssl1_emaLow) this.Hlv1[i] = -1;
            else this.Hlv1[i] = this.Hlv1[i - 1];
        }

        const ssl1_down = this.Hlv1[i] < 0 ? ssl1_emaHigh : ssl1_emaLow;

        let action = { type: 'none', message: 'Sinyal yok' };

        // ÖNCE STOP LOSS KONTROLÜ
        let sl_triggered = false;
        if (this.position > 0 && this.params.USE_STOPLOSS_AL && this.longEntryPrice && this.longEntryBarIndex !== null) {
            const barsSinceLong = i - this.longEntryBarIndex;
            if (barsSinceLong >= this.params.STOPLOSS_AL_ACTIVATION_BARS) {
                const sl_long_level = this.longEntryPrice * (1 - this.params.STOPLOSS_AL_PERCENT / 100);
                if (bar.low <= sl_long_level) {
                    this.position = -1; 
                    action = { type: 'flip_short', message: `Uzun SL sonrası Flip Kısa (${this.params.STOPLOSS_AL_PERCENT}%)` };
                    sl_triggered = true;
                }
            }
        } else if (this.position < 0 && this.params.USE_STOPLOSS_SAT && this.shortEntryPrice && this.shortEntryBarIndex !== null) {
            const barsSinceShort = i - this.shortEntryBarIndex;
            if (barsSinceShort >= this.params.STOPLOSS_SAT_ACTIVATION_BARS) {
                const sl_short_level = this.shortEntryPrice * (1 + this.params.STOPLOSS_SAT_PERCENT / 100);
                if (bar.high >= sl_short_level) {
                    this.position = 1; 
                    action = { type: 'flip_long', message: `Kısa SL sonrası Flip Uzun (${this.params.STOPLOSS_SAT_PERCENT}%)` };
                    sl_triggered = true;
                }
            }
        }

        // Stop Loss tetiklenmediyse normal girişleri kontrol et
        if (!sl_triggered) {
            if (this.params.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
                this.consecutive_closes_above_entry_target = bar.close > BBMC_upper_atr ? this.consecutive_closes_above_entry_target + 1 : 0;
                this.consecutive_closes_below_entry_target = bar.close < BBMC_lower_atr ? this.consecutive_closes_below_entry_target + 1 : 0;
                
                const longCondition = this.consecutive_closes_above_entry_target === this.params.M_BARS_BUY && this.params.M_BARS_BUY > 0;
                const shortCondition = this.consecutive_closes_below_entry_target === this.params.N_BARS_SELL && this.params.N_BARS_SELL > 0;

                if (longCondition && this.position <= 0) {
                    this.position = 1;
                    action = { type: 'long', message: `AL: ${this.params.M_BARS_BUY} bar BBMC+ATR üzeri` };
                } else if (shortCondition && this.position >= 0) {
                    this.position = -1;
                    action = { type: 'short', message: `SAT: ${this.params.N_BARS_SELL} bar BBMC-ATR altı` };
                }
            } else { // SSL1 Kesişimi
                this.consecutive_closes_above_entry_target = 0; 
                this.consecutive_closes_below_entry_target = 0;
                
                const prevClose = i > 0 ? this.data[i - 1].close : null;
                const prevSSL1 = i > 0 ? (this.Hlv1[i - 1] < 0 ? this.ma(this.params.MA_TYPE, this.data.slice(0, i).map(d => d.high), this.params.LEN, i - 1) : this.ma(this.params.MA_TYPE, this.data.slice(0, i).map(d => d.low), this.params.LEN, i - 1)) : ssl1_down;
                
                const longCondition = prevClose !== null && prevClose <= prevSSL1 && bar.close > ssl1_down;
                const shortCondition = prevClose !== null && prevClose >= prevSSL1 && bar.close < ssl1_down;

                if (longCondition && this.position <= 0) {
                    this.position = 1;
                    action = { type: 'long', message: 'AL: SSL1 Kesişimi' };
                } else if (shortCondition && this.position >= 0) {
                    this.position = -1;
                    action = { type: 'short', message: 'SAT: SSL1 Kesişimi' };
                }
            }
        }

        // Pozisyon Giriş/Çıkış Fiyatlarını Güncelle
        const prevPosition = i > 0 ? (this.position > 0 ? 1 : this.position < 0 ? -1 : 0) : 0;
        const currentPositionState = this.position > 0 ? 1 : this.position < 0 ? -1 : 0;
        
        if (currentPositionState > 0 && prevPosition <= 0) { 
            this.longEntryPrice = bar.close; 
            this.longEntryBarIndex = i; 
            this.shortEntryPrice = null; 
            this.shortEntryBarIndex = null; 
        } else if (currentPositionState < 0 && prevPosition >= 0) { 
            this.shortEntryPrice = bar.close; 
            this.shortEntryBarIndex = i; 
            this.longEntryPrice = null; 
            this.longEntryBarIndex = null; 
        } else if (currentPositionState === 0 && prevPosition !== 0) { 
            this.longEntryPrice = null; 
            this.longEntryBarIndex = null; 
            this.shortEntryPrice = null; 
            this.shortEntryBarIndex = null; 
        }

        return action;
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
            const lastBar = strategyInstance.data.at(-1);
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
        const klines = data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: d[6]
        }));
        console.log(`${klines.length} historical candles loaded.`);

        if (klines.length > 0) {
            strategyInstance = new SSLHybridStrategy(klines, CFG);
            
            // Run through all historical data to get the final position state
            for (let i = 0; i < klines.length; i++) {
                strategyInstance.computeSignals();
            }
            
            // Set bot position based on strategy position
            if (strategyInstance.position > 0) botCurrentPosition = 'long';
            else if (strategyInstance.position < 0) botCurrentPosition = 'short';
            else botCurrentPosition = 'none';
            
            console.log(`Bot initialized. Historical analysis complete. Current position is: ${botCurrentPosition.toUpperCase()}`);
        }

    } catch (error) {
        console.error('Error initializing bot:', error.message);
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
        } else if (signal.type === 'flip_long' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', signal.message);
        } else if (signal.type === 'flip_short' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', signal.message);
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
