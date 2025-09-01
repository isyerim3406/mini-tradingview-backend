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
    // IFTSMI Strategy Parameters (Pine Script defaults)
    SMIL: 54,
    wmalength: 6,
    IEMA: 5,
    OEMA: 5,
    level_buy: -0.5,
    level_sell: 0.8,
    use_filter: true,
    atr_period: 14,
    atr_ma_period: 100,
    atr_threshold: 0.7,

    // Bot Configuration
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '3m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,
};

// =========================================================================================
// GLOBAL STATE
// =========================================================================================
let botCurrentPosition = 'none';
let klines = [];
let totalNetProfit = 0;
let isBotInitialized = false;

// API anahtarlarının varlığına göre simülasyon modunu belirliyoruz.
const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

// Simülasyon modu için sahte bir Binance istemcisi oluşturma
const mockBinanceClient = {
    futuresAccountBalance: async () => {
        // Mock verisi döndür
        return [{ asset: 'USDT', availableBalance: '1000' }];
    },
    futuresMarketOrder: async ({ side, quantity }) => {
        console.log(`[SİMÜLASYON] ${side} emri başarıyla oluşturuldu: ${quantity}`);
        return { status: 'FILLED' };
    },
    candles: async ({ symbol, interval, limit }) => {
        // Simülasyon modunda sembol için sahte mum verileri üret
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

// Mod durumuna göre doğru istemciyi atama
const binanceClient = isSimulationMode ? mockBinanceClient : Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
    test: CFG.IS_TESTNET,
});

// IFTSMIStrategy Class
class IFTSMIStrategy {
    constructor(options = {}) {
        // Default parameters (matching Pine Script defaults)
        this.SMIL = options.SMIL || 54;
        this.wmalength = options.wmalength || 6;
        this.IEMA = options.IEMA || 5;
        this.OEMA = options.OEMA || 5;
        this.level_buy = options.level_buy || -0.5;
        this.level_sell = options.level_sell || 0.8;
        
        // Filter settings
        this.use_filter = options.use_filter !== undefined ? options.use_filter : true;
        this.atr_period = options.atr_period || 14;
        this.atr_ma_period = options.atr_ma_period || 100;
        this.atr_threshold = options.atr_threshold || 0.7;
        
        // Strategy settings
        this.initial_capital = options.initial_capital || 10000;
        this.qty_percent = options.qty_percent || 100;
        
        // Internal state
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
    }
    
    // EMA calculation helper
    calculateEMA(value, period, key) {
        if (!this.ema_states[key]) {
            this.ema_states[key] = {
                values: [],
                ema: null
            };
        }
        
        const state = this.ema_states[key];
        state.values.push(value);
        
        if (state.values.length === 1) {
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
    
    // Process new candle data
    processCandle(timestamp, open, high, low, close) {
        // Store OHLC data
        this.closes.push(close);
        this.highs.push(high);
        this.lows.push(low);
        
        // Calculate True Range
        const prevClose = this.closes.length > 1 ? this.closes[this.closes.length - 2] : null;
        const tr = this.calculateTrueRange(high, low, prevClose);
        this.true_ranges.push(tr);
        
        // SM calculation (Stochastic Momentum)
        const LLow = this.getLowest(this.lows, this.SMIL);
        const HHigh = this.getHighest(this.highs, this.SMIL);
        const SM = close - 0.5 * (HHigh + LLow);
        this.sm_values.push(SM);
        
        // SMI calculations
        const avgsm = this.calculateEMA(
            this.calculateEMA(SM, this.IEMA, `sm_inner_${this.closes.length}`),
            this.OEMA,
            `sm_outer_${this.closes.length}`
        );
        
        const diff = HHigh - LLow;
        this.diff_values.push(diff);
        
        const avgdiff = this.calculateEMA(
            this.calculateEMA(diff, this.IEMA, `diff_inner_${this.closes.length}`),
            this.OEMA,
            `diff_outer_${this.closes.length}`
        );
        
        const SMI = avgdiff !== 0 ? 100 * (avgsm / (0.5 * avgdiff)) : 0;
        this.smi_values.push(SMI);
        
        // Inverse Fisher Transform calculations
        const v1 = 0.1 * SMI;
        this.v1_values.push(v1);
        
        const v2 = this.calculateWMA(this.v1_values, this.wmalength);
        this.v2_values.push(v2 || 0);
        
        const INV = v2 !== null ? (Math.exp(2 * v2) - 1) / (Math.exp(2 * v2) + 1) : 0;
        this.inv_values.push(INV);
        
        // ATR calculations for sideways filter
        const current_atr = this.calculateATR(this.atr_period);
        if (current_atr !== null) {
            this.atr_values.push(current_atr);
        }
        
        const long_term_atr_ma = this.calculateSMA(this.atr_values, this.atr_ma_period);
        if (long_term_atr_ma !== null) {
            this.atr_ma_values.push(long_term_atr_ma);
        }
        
        // Sideways market detection
        const is_sideways = this.use_filter && 
                           current_atr !== null && 
                           long_term_atr_ma !== null && 
                           (current_atr < long_term_atr_ma * this.atr_threshold);
        
        // Signal generation
        let buy_condition = false;
        let sell_condition = false;
        
        if (this.inv_values.length >= 2) {
            const current_inv = this.inv_values[this.inv_values.length - 1];
            const previous_inv = this.inv_values[this.inv_values.length - 2];
            
            buy_condition = this.checkCrossover(current_inv, previous_inv, this.level_buy) && !is_sideways;
            sell_condition = this.checkCrossunder(current_inv, previous_inv, this.level_sell) && !is_sideways;
        }
        
        // Execute strategy
        const signal = this.executeStrategy(timestamp, close, buy_condition, sell_condition, INV, is_sideways);
        
        return {
            timestamp,
            close,
            inv: INV,
            smi: SMI,
            buy_condition,
            sell_condition,
            is_sideways,
            position_size: this.position_size,
            signal,
            atr: current_atr,
            atr_ma: long_term_atr_ma
        };
    }
    
    // Strategy execution logic
    executeStrategy(timestamp, price, buy_condition, sell_condition, inv, is_sideways) {
        let signal = null;
        
        if (buy_condition) {
            // Close any short position first
            if (this.position_size < 0) {
                this.closePosition(timestamp, price, 'Close Short');
            }
            
            // Open long position
            const qty = this.calculateQuantity(price);
            this.position_size = qty;
            signal = {
                type: 'BUY',
                price,
                quantity: qty,
                timestamp,
                inv_value: inv
            };
            
            this.trades.push({
                ...signal,
                action: 'entry'
            });
        }
        
        if (sell_condition) {
            // Close any long position first
            if (this.position_size > 0) {
                this.closePosition(timestamp, price, 'Close Long');
            }
            
            // Open short position
            const qty = -this.calculateQuantity(price);
            this.position_size = qty;
            signal = {
                type: 'SELL',
                price,
                quantity: Math.abs(qty),
                timestamp,
                inv_value: inv
            };
            
            this.trades.push({
                ...signal,
                action: 'entry'
            });
        }
        
        return signal;
    }
    
    // Calculate position quantity based on equity percentage
    calculateQuantity(price) {
        const equity_to_use = this.capital * (this.qty_percent / 100);
        return Math.floor(equity_to_use / price);
    }
    
    // Close current position
    closePosition(timestamp, price, reason) {
        if (this.position_size === 0) return;
        
        const pnl = this.position_size * (price - this.getAvgEntryPrice());
        this.capital += pnl;
        
        this.trades.push({
            type: this.position_size > 0 ? 'SELL' : 'BUY',
            price,
            quantity: Math.abs(this.position_size),
            timestamp,
            action: 'exit',
            pnl,
            reason
        });
        
        this.position_size = 0;
    }
    
    // Get average entry price (simplified)
    getAvgEntryPrice() {
        const entryTrades = this.trades.filter(t => t.action === 'entry');
        if (entryTrades.length === 0) return 0;
        
        const lastEntry = entryTrades[entryTrades.length - 1];
        return lastEntry.price;
    }
    
    // Get current strategy state
    getState() {
        return {
            position_size: this.position_size,
            capital: this.capital,
            total_trades: this.trades.length,
            current_inv: this.inv_values[this.inv_values.length - 1] || 0,
            is_sideways: this.atr_values.length > 0 && this.atr_ma_values.length > 0 ? 
                        (this.atr_values[this.atr_values.length - 1] < 
                         this.atr_ma_values[this.atr_ma_values.length - 1] * this.atr_threshold) : false
        };
    }
    
    // Get all trades
    getTrades() {
        return [...this.trades];
    }
    
    // Reset strategy
    reset() {
        this.position_size = 0;
        this.capital = this.initial_capital;
        this.trades = [];
        this.closes = [];
        this.highs = [];
        this.lows = [];
        this.true_ranges = [];
        this.sm_values = [];
        this.diff_values = [];
        this.smi_values = [];
        this.v1_values = [];
        this.v2_values = [];
        this.inv_values = [];
        this.atr_values = [];
        this.atr_ma_values = [];
        this.ema_states = {};
    }
    
    // Update parameters
    updateParameters(newParams) {
        Object.assign(this, newParams);
    }
}
// Initialize the new strategy
const iftsmiStrategy = new IFTSMIStrategy({
    initial_capital: CFG.INITIAL_CAPITAL
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
    const lastClosePrice = klines[klines.length - 1]?.close || 0;

    // Mevcut pozisyonu kapatma
    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        try {
            const entryPrice = botCurrentPosition === 'long' ? longEntryPrice : shortEntryPrice;
            const profit = botCurrentPosition === 'long' ? (lastClosePrice - entryPrice) : (entryPrice - lastClosePrice);
            totalNetProfit += profit;
            
            // Eğer gerçek modda değilsek, API çağrısı yapma
            if (!isSimulationMode) {
                const positions = await binanceClient.futuresAccountBalance();
                const position = positions.find(p => p.asset === CFG.SYMBOL.replace('USDT', ''));
                
                if (position && parseFloat(position.balance) > 0) {
                     const closingSide = botCurrentPosition === 'long' ? 'SELL' : 'BUY';
                     const quantity = parseFloat(position.balance);
                     
                     await binanceClient.futuresMarketOrder({
                         symbol: CFG.SYMBOL,
                         side: closingSide,
                         quantity: quantity,
                     });
                     console.log(`✅ Gerçek pozisyon (${botCurrentPosition}) kapatıldı.`);
                }
            } else {
                console.log(`[SİMÜLASYON] Mevcut pozisyon (${botCurrentPosition}) kapatıldı.`);
            }

            const profitMessage = profit >= 0 ? `+${profit.toFixed(2)} USDT` : `${profit.toFixed(2)} USDT`;
            const positionCloseMessage = `📉 Pozisyon kapatıldı! ${botCurrentPosition.toUpperCase()}\n\nSon Kapanış Fiyatı: ${lastClosePrice}\nBu İşlemden Kâr/Zarar: ${profitMessage}\n**Toplam Net Kâr: ${totalNetProfit.toFixed(2)} USDT**`;
            sendTelegramMessage(positionCloseMessage);
            
            botCurrentPosition = 'none';
        } catch (error) {
            console.error('Mevcut pozisyonu kapatırken hata oluştu:', error.body || error);
            return;
        }
    }

    // Yeni pozisyonu açma
    if (botCurrentPosition === 'none') {
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
                console.log(`🟢 ${side} emri başarıyla verildi. Fiyat: ${currentPrice}`);
            } else {
                quantity = (CFG.INITIAL_CAPITAL * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;
                console.log(`[SİMÜLASYON] ${side} emri verildi. Fiyat: ${currentPrice}`);
            }

            if (side === 'BUY') {
                botCurrentPosition = 'long';
                longEntryPrice = currentPrice;
                longEntryBarIndex = klines.length - 1;
            } else if (side === 'SELL') {
                botCurrentPosition = 'short';
                shortEntryPrice = currentPrice;
                shortEntryBarIndex = klines.length - 1;
            }

            sendTelegramMessage(`🚀 **${side} Emri Gerçekleşti!**\n\n**Sinyal:** ${signalMessage}\n**Fiyat:** ${currentPrice}\n**Miktar:** ${quantity.toFixed(4)}\n**Toplam Net Kâr: ${totalNetProfit.toFixed(2)} USDT**`);
        } catch (error) {
            console.error('Emir verirken hata oluştu:', error.body || error);
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

        klines = initialKlines.map(k => ({
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            closeTime: k.closeTime
        }));
        console.log(`✅ İlk ${klines.length} mum verisi yüklendi.`);

        // Yeni strateji ile geçmiş verileri işleyin
        klines.forEach(k => {
            iftsmiStrategy.processCandle(k.closeTime, k.open, k.high, k.low, k.close);
        });

        if (!isBotInitialized) {
            sendTelegramMessage(`✅ Bot başlatıldı!\n\n**Mod:** ${isSimulationMode ? 'Simülasyon' : 'Canlı İşlem'}\n**Sembol:** ${CFG.SYMBOL}\n**Zaman Aralığı:** ${CFG.INTERVAL}\n**Başlangıç Sermayesi:** ${CFG.INITIAL_CAPITAL} USDT`);
            isBotInitialized = true;
        }

    } catch (error) {
        console.error('İlk verileri çekerken hata:', error);
    }
}

fetchInitialData();

ws.on('message', async (message) => {
    const data = JSON.parse(message);
    const klineData = data.k;

    if (klineData.x) { // If the bar is closed
        const newBar = {
            open: parseFloat(klineData.o),
            high: parseFloat(klineData.h),
            low: parseFloat(klineData.l),
            close: parseFloat(klineData.c),
            volume: parseFloat(klineData.v),
            closeTime: klineData.T
        };
        
        klines.push(newBar);
        if (klines.length > 500) {
            klines.shift();
        }

        // Process the new candle and get the signal from the IFTSMI strategy
        const result = iftsmiStrategy.processCandle(
            newBar.closeTime,
            newBar.open,
            newBar.high,
            newBar.low,
            newBar.close
        );
        
        const signal = result.signal;
        const botState = iftsmiStrategy.getState();

        console.log(`Yeni mum verisi geldi. Fiyat: ${newBar.close}. Sinyal: ${signal?.type || 'none'}. Pozisyon: ${botState.position_size}`);

        if (signal?.type === 'BUY' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', 'AL sinyali: IFTSMI');
        } else if (signal?.type === 'SELL' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', 'SAT sinyali: IFTSMI');
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket bağlantısı kapandı. Yeniden bağlanıyor...');
});

ws.on('error', (error) => {
    console.error('WebSocket hatası:', error.message);
});

app.get('/', (req, res) => {
    res.send('Bot çalışıyor!');
});

app.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});
