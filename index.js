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
        // Strategy Parameters
        this.ema_period = options.ema_period || 20;
        this.rsi_period = options.rsi_period || 14;
        this.rsi_threshold = options.rsi_threshold || 50;
        this.use_filter = options.use_filter !== undefined ? options.use_filter : true;
        this.atr_ma_period = options.atr_ma_period || 100;
        this.atr_threshold = options.atr_threshold || 0.7;

        // Trading Parameters
        this.initial_capital = options.initial_capital || 100;
        this.qty_percent = options.qty_percent || 100;

        // Internal State
        this.klines = [];
        this.emaValues = [];
        this.rsiValues = [];
        this.avgGains = [];
        this.avgLosses = [];
        this.trueRanges = [];
        this.atrValues = [];
        this.atrMaValues = [];
        this.pos = 0;
        this.capital = this.initial_capital;
        this.trades = [];
        this.position_size = 0;
    }

    // Helper functions for indicators
    calculateEMA(values, period) {
        if (values.length < period) return null;
        const emaMultiplier = 2 / (period + 1);
        if (this.emaValues.length === 0) {
            const sum = values.slice(0, period).reduce((a, b) => a + b, 0);
            return sum / period;
        } else {
            return (values[values.length - 1] * emaMultiplier) + (this.emaValues[this.emaValues.length - 1] * (1 - emaMultiplier));
        }
    }

    calculateRSI(period) {
        if (this.klines.length < period + 1) return null;
        const currentCandle = this.klines[this.klines.length - 1];
        const prevCandle = this.klines[this.klines.length - 2];
        const change = currentCandle.close - prevCandle.close;
        const gain = Math.max(0, change);
        const loss = Math.max(0, -change);

        if (this.klines.length === period + 1) {
            // First calculation, simple average
            const initialGains = this.klines.slice(1).reduce((sum, k, i) => sum + Math.max(0, k.close - this.klines[i].close), 0);
            const initialLosses = this.klines.slice(1).reduce((sum, k, i) => sum + Math.max(0, this.klines[i].close - k.close), 0);
            this.avgGains.push(initialGains / period);
            this.avgLosses.push(initialLosses / period);
        } else if (this.klines.length > period + 1) {
            // Smoothed average
            this.avgGains.push(((this.avgGains[this.avgGains.length - 1] * (period - 1)) + gain) / period);
            this.avgLosses.push(((this.avgLosses[this.avgLosses.length - 1] * (period - 1)) + loss) / period);
        }

        const avgGain = this.avgGains[this.avgGains.length - 1];
        const avgLoss = this.avgLosses[this.avgLosses.length - 1];
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    calculateATR(period) {
        if (this.trueRanges.length < period) return null;
        const slice = this.trueRanges.slice(-period);
        const sum = slice.reduce((a, b) => a + b, 0);
        return sum / period;
    }

    calculateSMA(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        const sum = slice.reduce((a, b) => a + b, 0);
        return sum / period;
    }

    processCandle(timestamp, open, high, low, close) {
        this.klines.push({ timestamp, open, high, low, close });
        if (this.klines.length > 500) {
            this.klines.shift();
        }

        const currentClose = this.klines[this.klines.length - 1].close;
        const prevClose = this.klines.length > 1 ? this.klines[this.klines.length - 2].close : currentClose;
        const prevHigh = this.klines.length > 1 ? this.klines[this.klines.length - 2].high : high;
        const prevLow = this.klines.length > 1 ? this.klines[this.klines.length - 2].low : low;

        const trueRange = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        this.trueRanges.push(trueRange);

        const currentEma = this.calculateEMA(this.klines.map(k => k.close), this.ema_period);
        if (currentEma !== null) this.emaValues.push(currentEma);

        const currentRsi = this.calculateRSI(this.rsi_period);
        if (currentRsi !== null) this.rsiValues.push(currentRsi);

        // Sideways Filter
        const currentAtr = this.calculateATR(this.atr_ma_period);
        if (currentAtr !== null) this.atrValues.push(currentAtr);

        const longTermAtrMa = this.calculateSMA(this.atrValues, this.atr_ma_period);
        if (longTermAtrMa !== null) this.atrMaValues.push(longTermAtrMa);

        const isSideways = this.use_filter && longTermAtrMa !== null && (currentAtr < longTermAtrMa * this.atr_threshold);

        let signal = null;
        if (currentEma !== null && currentRsi !== null) {
            if (currentClose > currentEma && currentRsi > this.rsi_threshold && !isSideways) {
                signal = { type: 'BUY', message: 'IFTSMI: BUY signal' };
            } else if (currentClose < currentEma && currentRsi < this.rsi_threshold && !isSideways) {
                signal = { type: 'SELL', message: 'IFTSMI: SELL signal' };
            }
        }

        return { signal };
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
    // IFTSMI Strategy Parameters
    ema_period: 20,
    rsi_period: 14,
    rsi_threshold: 50,
    
    // Sideways Filter Parameters
    use_filter: true,
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
    ema_period: CFG.ema_period,
    rsi_period: CFG.rsi_period,
    rsi_threshold: CFG.rsi_threshold,
    use_filter: CFG.use_filter,
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

    // Close the current position before opening a new one
    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        try {
            // P&L calculation and position closing are handled within the strategy class
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

    // Open a new position
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

            sendTelegramMessage(`🚀 **${side} Order Executed!**\n\n**Signal:** ${signalMessage}\n**Price:** ${currentPrice}\n**Quantity:** ${quantity.toFixed(4)}\n**Total Net Profit: ${totalNetProfit.toFixed(2)} USDT**`);
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

        console.log(`✅ Initial ${iftsmiStrategy.klines.length} candle data loaded.`);

        if (!isBotInitialized) {
            sendTelegramMessage(`✅ Bot started!\n\n**Mode:** ${isSimulationMode ? 'Simulation' : 'Live Trading'}\n**Symbol:** ${CFG.SYMBOL}\n**Timeframe:** ${CFG.INTERVAL}\n**Initial Capital:** ${CFG.INITIAL_CAPITAL} USDT`);
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

    if (klineData.x) {
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
        
        console.log(`New candle data arrived. Price: ${newBar.close}. Signal: ${signal?.type || 'none'}.`);

        if (signal?.type === 'BUY' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', signal.message);
        } else if (signal?.type === 'SELL' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', signal.message);
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket connection closed. Reconnecting...');
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
});

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
