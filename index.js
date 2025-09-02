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
// IFTSMI STRATEGY CLASS (Pine Script'ten tam uyarlama)
// =========================================================================================

class IFTSMIStrategy {
    constructor(options = {}) {
        // IFTSMI Strategy Parameters (Pine Script ile birebir aynı)
        this.SMIL = options.SMIL || 54;
        this.wmalength = options.wmalength || 6;
        this.IEMA = options.IEMA || 5;
        this.OEMA = options.OEMA || 5;
        this.level_buy = options.level_buy || -0.5;
        this.level_sell = options.level_sell || 0.8;
        
        // Sideways Market Filter
        this.use_filter = options.use_filter !== undefined ? options.use_filter : true;
        this.atr_period = options.atr_period || 14;
        this.atr_ma_period = options.atr_ma_period || 100;
        this.atr_threshold = options.atr_threshold || 0.7;

        // Trading Parameters
        this.initial_capital = options.initial_capital || 100;
        this.qty_percent = options.qty_percent || 100;

        // Internal State
        this.position_size = 0;
        this.capital = this.initial_capital;
        this.trades = [];
        
        // Data arrays for calculations
        this.closes = [];
        this.highs = [];
        this.lows = [];
        this.true_ranges = [];
        
        // Calculation arrays
        this.sm_values = [];
        this.diff_values = [];
        this.smi_values = [];
        this.v1_values = [];
        this.v2_values = [];
        this.inv_values = [];
        this.atr_values = [];
        this.atr_ma_values = [];
        
        // EMA calculation states
        this.ema_states = {};
        
        // Keep track of candles for WebSocket
        this.klines = [];
    }

    // EMA calculation helper
    calculateEMA(value, period, key) {
        if (!this.ema_states[key]) {
            this.ema_states[key] = {
                ema: null
            };
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
    
    // SMA calculation helper
    calculateSMA(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        return slice.reduce((sum, val) => sum + val, 0) / period;
    }
    
    // WMA calculation helper
    calculateWMA(values, period) {
        if (values.length < period) return null;
        
        const slice = values.slice(-period);
        let weightedSum = 0;
        let weightSum = 0;
        
        for (let i = 0; i < slice.length; i++) {
            const weight = i + 1;
            weightedSum += slice[i] * weight;
            weightSum += weight;
        }
        
        return weightedSum / weightSum;
    }
    
    // Lowest value in period
    getLowest(values, period) {
        if (values.length < period) return Math.min(...values);
        const slice = values.slice(-period);
        return Math.min(...slice);
    }
    
    // Highest value in period
    getHighest(values, period) {
        if (values.length < period) return Math.max(...values);
        const slice = values.slice(-period);
        return Math.max(...slice);
    }
    
    // True Range calculation
    calculateTrueRange(high, low, prevClose) {
        if (prevClose === null) return high - low;
        
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        
        return Math.max(tr1, tr2, tr3);
    }
    
    // ATR calculation
    calculateATR(period) {
        if (this.true_ranges.length < period) return null;
        return this.calculateSMA(this.true_ranges, period);
    }
    
    // Check for crossover
    checkCrossover(current, previous, level) {
        return previous <= level && current > level;
    }
    
    // Check for crossunder
    checkCrossunder(current, previous, level) {
        return previous >= level && current < level;
    }

    processCandle(timestamp, open, high, low, close) {
        // Store OHLC data
        this.closes.push(close);
        this.highs.push(high);
        this.lows.push(low);
        
        // Keep klines for WebSocket compatibility
        this.klines.push({ timestamp, open, high, low, close });
        if (this.klines.length > 500) {
            this.klines.shift();
        }
        
        // Keep arrays manageable
        if (this.closes.length > 500) {
            this.closes.shift();
            this.highs.shift();
            this.lows.shift();
        }
        
        // Calculate True Range
        const prevClose = this.closes.length > 1 ? this.closes[this.closes.length - 2] : null;
        const tr = this.calculateTrueRange(high, low, prevClose);
        this.true_ranges.push(tr);
        if (this.true_ranges.length > 500) this.true_ranges.shift();
        
        // SM calculation (Stochastic Momentum)
        const LLow = this.getLowest(this.lows, this.SMIL);
        const HHigh = this.getHighest(this.highs, this.SMIL);
        const SM = close - 0.5 * (HHigh + LLow);
        this.sm_values.push(SM);
        if (this.sm_values.length > 500) this.sm_values.shift();
        
        // SMI calculations
        const index = this.closes.length;
        const avgsm = this.calculateEMA(
            this.calculateEMA(SM, this.IEMA, `sm_inner_${index % 100}`),
            this.OEMA,
            `sm_outer_${index % 100}`
        );
        
        const diff = HHigh - LLow;
        this.diff_values.push(diff);
        if (this.diff_values.length > 500) this.diff_values.shift();
        
        const avgdiff = this.calculateEMA(
            this.calculateEMA(diff, this.IEMA, `diff_inner_${index % 100}`),
            this.OEMA,
            `diff_outer_${index % 100}`
        );
        
        const SMI = avgdiff !== 0 ? 100 * (avgsm / (0.5 * avgdiff)) : 0;
        this.smi_values.push(SMI);
        if (this.smi_values.length > 500) this.smi_values.shift();
        
        // Inverse Fisher Transform calculations
        const v1 = 0.1 * SMI;
        this.v1_values.push(v1);
        if (this.v1_values.length > 500) this.v1_values.shift();
        
        const v2 = this.calculateWMA(this.v1_values, this.wmalength);
        this.v2_values.push(v2 || 0);
        if (this.v2_values.length > 500) this.v2_values.shift();
        
        const INV = v2 !== null ? (Math.exp(2 * v2) - 1) / (Math.exp(2 * v2) + 1) : 0;
        this.inv_values.push(INV);
        if (this.inv_values.length > 500) this.inv_values.shift();
        
        // ATR calculations for sideways filter
        const current_atr = this.calculateATR(this.atr_period);
        if (current_atr !== null) {
            this.atr_values.push(current_atr);
            if (this.atr_values.length > 500) this.atr_values.shift();
        }
        
        const long_term_atr_ma = this.calculateSMA(this.atr_values, this.atr_ma_period);
        if (long_term_atr_ma !== null) {
            this.atr_ma_values.push(long_term_atr_ma);
            if (this.atr_ma_values.length > 500) this.atr_ma_values.shift();
        }
        
        // Sideways market detection
        const is_sideways = this.use_filter && 
                           current_atr !== null && 
                           long_term_atr_ma !== null && 
                           (current_atr < long_term_atr_ma * this.atr_threshold);
        
        // Signal generation
        let signal = null;
        
        if (this.inv_values.length >= 2) {
            const current_inv = this.inv_values[this.inv_values.length - 1];
            const previous_inv = this.inv_values[this.inv_values.length - 2];
            
            const buy_condition = this.checkCrossover(current_inv, previous_inv, this.level_buy) && !is_sideways;
            const sell_condition = this.checkCrossunder(current_inv, previous_inv, this.level_sell) && !is_sideways;
            
            if (buy_condition) {
                signal = { type: 'BUY', message: 'IFTSMI: BUY signal - INV crossed above buy level' };
            } else if (sell_condition) {
                signal = { type: 'SELL', message: 'IFTSMI: SELL signal - INV crossed below sell level' };
            }
        }
        
        return { 
            signal,
            inv: INV,
            smi: SMI,
            is_sideways,
            atr: current_atr,
            atr_ma: long_term_atr_ma
        };
    }

    calculateQuantity(price) {
        const equity_to_use = this.capital * (this.qty_percent / 100);
        return equity_to_use / price;
    }
    
    closePosition(price) {
        if (this.position_size === 0) return;
        const pnl = this.position_size * (price - this.getAvgEntryPrice());
        this.capital += pnl;
        const reason = this.position_size > 0 ? 'Close Long' : 'Close Short';
        this.trades.push({
            type: this.position_size > 0 ? 'SELL' : 'BUY',
            price,
            quantity: Math.abs(this.position_size),
            action: 'exit',
            pnl,
            reason
        });
        this.position_size = 0;
    }

    openPosition(side, price) {
        const qty = this.calculateQuantity(price);
        this.position_size = side === 'BUY' ? qty : -qty;
        this.trades.push({
            type: side,
            price,
            quantity: qty,
            action: 'entry'
        });
    }

    getAvgEntryPrice() {
        const entryTrades = this.trades.filter(t => t.action === 'entry');
        if (entryTrades.length === 0) return 0;
        const lastEntry = entryTrades[entryTrades.length - 1];
        return lastEntry.price;
    }
}

// =========================================================================================
// STRATEGY CONFIGURATION
// =========================================================================================
const CFG = {
    // IFTSMI Strategy Parameters (Pine Script defaults)
    SMIL: 54,
    wmalength: 6,
    IEMA: 5,
    OEMA: 5,
    level_buy: -0.5,
    level_sell: 0.8,
    
    // Sideways Filter Parameters
    use_filter: true,
    atr_period: 14,
    atr_ma_period: 100,
    atr_threshold: 0.7,
    
    // Bot Configuration
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,
};

// =========================================================================================
// GLOBAL STATE
// =========================================================================================
let botCurrentPosition = 'none';
let totalNetProfit = 0;
let isBotInitialized = false;

const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

const mockBinanceClient = {
    futuresAccountBalance: async () => {
        return [{ asset: 'USDT', availableBalance: '1000' }];
    },
    futuresMarketOrder: async ({ side, quantity }) => {
        console.log(`[SIMULATION] Order placed successfully: ${side} ${quantity}`);
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
        const lastKline = iftsmiStrategy.klines[iftsmiStrategy.klines.length - 1];
        const lastPrice = lastKline ? lastKline.close : 4300;
        return { [symbol]: lastPrice.toString() };
    }
};

const binanceClient = isSimulationMode ? mockBinanceClient : Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
    test: CFG.IS_TESTNET,
});

const iftsmiStrategy = new IFTSMIStrategy({
    SMIL: CFG.SMIL,
    wmalength: CFG.wmalength,
    IEMA: CFG.IEMA,
    OEMA: CFG.OEMA,
    level_buy: CFG.level_buy,
    level_sell: CFG.level_sell,
    use_filter: CFG.use_filter,
    atr_period: CFG.atr_period,
    atr_ma_period: CFG.atr_ma_period,
    atr_threshold: CFG.atr_threshold,
    initial_capital: CFG.INITIAL_CAPITAL,
    qty_percent: CFG.TRADE_SIZE_PERCENT
});

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
        const response = await fetch(telegramApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error(`Telegram API error: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('Failed to send Telegram message:', error);
    }
}

// =========================================================================================
// ORDER PLACEMENT & TRADING LOGIC
// =========================================================================================
async function placeOrder(side, signalMessage) {
    const lastClosePrice = iftsmiStrategy.klines[iftsmiStrategy.klines.length - 1]?.close || 0;

    // Close the current position before opening a new one (Pine Script logic)
    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        try {
            const prevPosition = botCurrentPosition;
            iftsmiStrategy.closePosition(lastClosePrice);
            totalNetProfit = iftsmiStrategy.trades.filter(t => t.action === 'exit').reduce((sum, t) => sum + t.pnl, 0);
            
            if (!isSimulationMode) {
                const positions = await binanceClient.futuresAccountBalance();
                const position = positions.find(p => p.asset === CFG.SYMBOL.replace('USDT', ''));
                
                if (position && parseFloat(position.balance) > 0) {
                     const closingSide = prevPosition === 'long' ? 'SELL' : 'BUY';
                     const quantity = parseFloat(position.balance);
                     
                     await binanceClient.futuresMarketOrder({
                         symbol: CFG.SYMBOL,
                         side: closingSide,
                         quantity: quantity,
                     });
                     console.log(`✅ Real position (${prevPosition}) closed.`);
                }
            } else {
                console.log(`[SIMULATION] Current position (${prevPosition}) closed.`);
            }

            const profit = iftsmiStrategy.trades[iftsmiStrategy.trades.length - 1].pnl;
            const profitMessage = profit >= 0 ? `+${profit.toFixed(2)} USDT` : `${profit.toFixed(2)} USDT`;
            const positionCloseMessage = `📉 Position closed! ${prevPosition.toUpperCase()}\n\nLast Close Price: ${lastClosePrice}\nProfit/Loss from this trade: ${profitMessage}\n**Total Net Profit: ${totalNetProfit.toFixed(2)} USDT**`;
            sendTelegramMessage(positionCloseMessage);
            
            botCurrentPosition = 'none';
        } catch (error) {
            console.error('Error closing current position:', error.body || error);
            return;
        }
    }

    // Open a new position only if we don't have the same position type
    if (botCurrentPosition === 'none' || botCurrentPosition !== side.toLowerCase()) {
        try {
            const currentPrice = lastClosePrice;
            let quantity = 0;

            if (!isSimulationMode) {
                const accountInfo = await binanceClient.futuresAccountBalance();
                const usdtBalance = parseFloat(accountInfo.find(a => a.asset === 'USDT').availableBalance);
                quantity = (usdtBalance * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;

                await binanceClient.futuresMarketOrder({
                    symbol: CFG.SYMBOL,
                    side: side,
                    quantity: quantity.toFixed(4)
                });
                console.log(`🟢 ${side} order successfully placed. Price: ${currentPrice}`);
            } else {
                quantity = (CFG.INITIAL_CAPITAL * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;
                console.log(`[SIMULATION] ${side} order placed. Price: ${currentPrice}`);
            }
            
            iftsmiStrategy.openPosition(side, currentPrice);
            botCurrentPosition = side.toLowerCase();

            sendTelegramMessage(`🚀 **${side} Order Executed!**\n\n**Signal:** ${signalMessage}\n**Price:** ${currentPrice}\n**Quantity:** ${quantity.toFixed(4)}\n**INV Value:** ${iftsmiStrategy.inv_values[iftsmiStrategy.inv_values.length - 1]?.toFixed(4) || 'N/A'}\n**Total Net Profit: ${totalNetProfit.toFixed(2)} USDT**`);
        } catch (error) {
            console.error('Error placing order:', error.body || error);
        }
    }
}

// =========================================================================================
// DATA HANDLING
// =========================================================================================
const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

async function fetchInitialData() {
    try {
        const initialKlines = await binanceClient.candles({
            symbol: CFG.SYMBOL,
            interval: CFG.INTERVAL,
            limit: 500
        });

        initialKlines.forEach(k => {
            iftsmiStrategy.processCandle(k.closeTime, parseFloat(k.open), parseFloat(k.high), parseFloat(k.low), parseFloat(k.close));
        });

        console.log(`✅ Initial ${iftsmiStrategy.klines.length} candle data loaded for IFTSMI strategy.`);

        if (!isBotInitialized) {
            sendTelegramMessage(`✅ **IFTSMI Strategy Bot Started!**\n\n**Mode:** ${isSimulationMode ? 'Simulation' : 'Live Trading'}\n**Symbol:** ${CFG.SYMBOL}\n**Timeframe:** ${CFG.INTERVAL}\n**Strategy:** Inverse Fisher Transform SMI\n**Buy Level:** ${CFG.level_buy}\n**Sell Level:** ${CFG.level_sell}\n**Sideways Filter:** ${CFG.use_filter ? 'Enabled' : 'Disabled'}\n**Initial Capital:** ${CFG.INITIAL_CAPITAL} USDT`);
            isBotInitialized = true;
        }

    } catch (error) {
        console.error('Error fetching initial data:', error);
    }
}

fetchInitialData();

ws.on('message', async (message) => {
    const data = JSON.parse(message);
    const klineData = data.k;

    if (klineData.x) { // Kline is closed
        const newBar = {
            open: parseFloat(klineData.o),
            high: parseFloat(klineData.h),
            low: parseFloat(klineData.l),
            close: parseFloat(klineData.c),
            volume: parseFloat(klineData.v),
            closeTime: klineData.T
        };
        
        const result = iftsmiStrategy.processCandle(newBar.closeTime, newBar.open, newBar.high, newBar.low, newBar.close);
        const signal = result.signal;
        
        const invValue = result.inv ? result.inv.toFixed(4) : 'N/A';
        const sidewaysStatus = result.is_sideways ? '[SIDEWAYS]' : '';
        
        console.log(`📊 New candle: ${newBar.close} | INV: ${invValue} | Signal: ${signal?.type || 'NONE'} ${sidewaysStatus}`);

        // Execute trades based on IFTSMI signals with Pine Script logic
        if (signal?.type === 'BUY' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', signal.message);
        } else if (signal?.type === 'SELL' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', signal.message);
        }
    }
});

ws.on('close', () => {
    console.log('⚠ WebSocket connection closed. Reconnecting...');
    setTimeout(() => {
        // Reconnect logic could be implemented here
    }, 5000);
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
});

// =========================================================================================
// EXPRESS SERVER
// =========================================================================================
app.get('/', (req, res) => {
    const status = {
        bot: 'IFTSMI Strategy Bot',
        status: 'Running',
        mode: isSimulationMode ? 'Simulation' : 'Live Trading',
        symbol: CFG.SYMBOL,
        interval: CFG.INTERVAL,
        currentPosition: botCurrentPosition,
        totalProfit: totalNetProfit.toFixed(2) + ' USDT',
        lastINV: iftsmiStrategy.inv_values[iftsmiStrategy.inv_values.length - 1]?.toFixed(4) || 'N/A',
        strategyParams: {
            SMIL: CFG.SMIL,
            buyLevel: CFG.level_buy,
            sellLevel: CFG.level_sell,
            sidewaysFilter: CFG.use_filter
        }
    };
    
    res.json(status);
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`🚀 IFTSMI Strategy Bot server running on port ${PORT}`);
    console.log(`📊 Trading ${CFG.SYMBOL} on ${CFG.INTERVAL} timeframe`);
    console.log(`🤖 Mode: ${isSimulationMode ? 'SIMULATION' : 'LIVE TRADING'}`);
});
