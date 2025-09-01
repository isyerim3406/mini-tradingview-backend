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
// UT BOT STRATEGY CLASS
// =========================================================================================
class UTBotStrategy {
    constructor(options = {}) {
        this.a = options.a || 1; // Key Value
        this.c = options.c || 10; // ATR Period
        this.h = options.h !== undefined ? options.h : false; // Use Heikin Ashi
        this.use_filter = options.use_filter !== undefined ? options.use_filter : true;
        this.atr_ma_period = options.atr_ma_period || 100;
        this.atr_threshold = options.atr_threshold || 0.7;

        this.initial_capital = options.initial_capital || 100;
        this.qty_percent = options.qty_percent || 100;

        // Internal state
        this.klines = [];
        this.heikinAshiCandles = [];
        this.trueRanges = [];
        this.atrValues = [];
        this.atrMaValues = [];
        this.xATRTrailingStop = null;
        this.pos = 0;
        this.capital = this.initial_capital;
        this.trades = [];
        this.position_size = 0;
    }

    // Helper functions
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

    // Heikin Ashi Calculation
    calculateHeikinAshi(open, high, low, close) {
        let haOpen, haClose, haHigh, haLow;
        const prevHA = this.heikinAshiCandles.length > 0 ? this.heikinAshiCandles[this.heikinAshiCandles.length - 1] : null;

        if (!prevHA) {
            haOpen = (open + close) / 2;
        } else {
            haOpen = (prevHA.open + prevHA.close) / 2;
        }
        haClose = (open + high + low + close) / 4;
        haHigh = Math.max(high, haOpen, haClose);
        haLow = Math.min(low, haOpen, haClose);

        return { open: haOpen, high: haHigh, low: haLow, close: haClose };
    }

    processCandle(timestamp, open, high, low, close) {
        this.klines.push({ timestamp, open, high, low, close });
        if (this.klines.length > 500) {
            this.klines.shift();
        }

        const prevClose = this.klines.length > 1 ? this.klines[this.klines.length - 2].close : close;
        const srcCandle = this.h ? this.calculateHeikinAshi(open, high, low, close) : { close, high, low };
        if (this.h) this.heikinAshiCandles.push(srcCandle);
        const src = srcCandle.close;
        const srcHigh = srcCandle.high;
        const srcLow = srcCandle.low;

        const trueRange = Math.max(
            srcHigh - srcLow,
            Math.abs(srcHigh - prevClose),
            Math.abs(srcLow - prevClose)
        );
        this.trueRanges.push(trueRange);

        const xATR = this.calculateATR(this.c);
        if (!xATR) return { signal: null };
        const nLoss = this.a * xATR;

        const prevXATRTrailingStop = this.xATRTrailingStop !== null ? this.xATRTrailingStop : src - nLoss;
        const prevPos = this.pos;

        // Pine Script's Trailing Stop Logic
        if (src > prevXATRTrailingStop && prevClose > prevXATRTrailingStop) {
            this.xATRTrailingStop = Math.max(prevXATRTrailingStop, src - nLoss);
        } else if (src < prevXATRTrailingStop && prevClose < prevXATRTrailingStop) {
            this.xATRTrailingStop = Math.min(prevXATRTrailingStop, src + nLoss);
        } else if (src > prevXATRTrailingStop) {
            this.xATRTrailingStop = src - nLoss;
        } else {
            this.xATRTrailingStop = src + nLoss;
        }

        // Position Logic (1=long, -1=short)
        if (prevClose < prevXATRTrailingStop && src > prevXATRTrailingStop) {
            this.pos = 1;
        } else if (prevClose > prevXATRTrailingStop && src < prevXATRTrailingStop) {
            this.pos = -1;
        } else {
            this.pos = prevPos;
        }

        // Sideways Filter
        const currentAtr = this.calculateATR(this.c);
        if (currentAtr !== null) this.atrValues.push(currentAtr);

        const longTermAtrMa = this.calculateSMA(this.atrValues, this.atr_ma_period);
        if (longTermAtrMa !== null) this.atrMaValues.push(longTermAtrMa);

        const isSideways = this.use_filter && longTermAtrMa !== null && (currentAtr < longTermAtrMa * this.atr_threshold);

        let signal = null;
        if (this.pos !== prevPos) {
            if (this.pos === 1 && !isSideways) {
                signal = { type: 'BUY', message: 'UT Bot: AL sinyali' };
            } else if (this.pos === -1 && !isSideways) {
                signal = { type: 'SELL', message: 'UT Bot: SAT sinyali' };
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
    // UT Bot Strategy Parameters
    a: 1, 
    c: 10,
    h: false, // Heikin Ashi
    
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
        const lastKline = utBotStrategy.klines[utBotStrategy.klines.length - 1];
        const lastPrice = lastKline ? lastKline.close : 4300;
        return { [symbol]: lastPrice.toString() };
    }
};

const binanceClient = isSimulationMode ? mockBinanceClient : Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
    test: CFG.IS_TESTNET,
});

const utBotStrategy = new UTBotStrategy({
    a: CFG.a,
    c: CFG.c,
    h: CFG.h,
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
    const lastClosePrice = utBotStrategy.klines[utBotStrategy.klines.length - 1]?.close || 0;

    // Mevcut pozisyonu kapatma
    if (utBotStrategy.position_size !== 0) {
        try {
            // P&L hesaplaması ve pozisyon kapatma strateji sınıfı içinde yapılır
            utBotStrategy.closePosition(lastClosePrice);
            totalNetProfit = utBotStrategy.trades.filter(t => t.action === 'exit').reduce((sum, t) => sum + t.pnl, 0);
            
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

            const profit = utBotStrategy.trades[utBotStrategy.trades.length - 1].pnl;
            const profitMessage = profit >= 0 ? `+${profit.toFixed(2)} USDT` : `${profit.toFixed(2)} USDT`;
            const positionCloseMessage = `📉 Pozisyon kapatıldı! ${botCurrentPosition.toUpperCase()}\n\nSon Kapanış Fiyatı: ${lastClosePrice}\nBu İşlemden Kâr/Zarar: ${profitMessage}\n**Toplam Net Kâr: ${totalNetProfit.toFixed(2)} USDT****`;
            sendTelegramMessage(positionCloseMessage);
            
            botCurrentPosition = 'none';
        } catch (error) {
            console.error('Mevcut pozisyonu kapatırken hata oluştu:', error.body || error);
            return;
        }
    }

    // Yeni pozisyonu açma
    if (utBotStrategy.position_size === 0) {
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
            
            utBotStrategy.openPosition(side, currentPrice);
            botCurrentPosition = side.toLowerCase();

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

        initialKlines.forEach(k => {
            utBotStrategy.processCandle(k.closeTime, parseFloat(k.open), parseFloat(k.high), parseFloat(k.low), parseFloat(k.close));
        });

        console.log(`✅ İlk ${utBotStrategy.klines.length} mum verisi yüklendi.`);

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

    if (klineData.x) {
        const newBar = {
            open: parseFloat(klineData.o),
            high: parseFloat(klineData.h),
            low: parseFloat(klineData.l),
            close: parseFloat(klineData.c),
            volume: parseFloat(klineData.v),
            closeTime: klineData.T
        };
        
        const result = utBotStrategy.processCandle(newBar.closeTime, newBar.open, newBar.high, newBar.low, newBar.close);
        const signal = result.signal;
        
        console.log(`Yeni mum verisi geldi. Fiyat: ${newBar.close}. Sinyal: ${signal?.type || 'none'}.`);

        if (signal?.type === 'BUY' && botCurrentPosition !== 'long') {
            await placeOrder('BUY', signal.message);
        } else if (signal?.type === 'SELL' && botCurrentPosition !== 'short') {
            await placeOrder('SELL', signal.message);
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
