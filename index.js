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
        this.a = options.a || 1;
        this.c = options.c || 10;
        this.h = options.h !== undefined ? options.h : false;
        this.use_filter = options.use_filter !== undefined ? options.use_filter : true;
        this.atr_ma_period = options.atr_ma_period || 100;
        this.atr_threshold = options.atr_threshold || 0.7;

        this.initial_capital = options.initial_capital || 100;
        this.qty_percent = options.qty_percent || 100;

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

    calculateATR(period) {
        if (this.trueRanges.length < period) return null;
        const slice = this.trueRanges.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    calculateSMA(values, period) {
        if (values.length < period) return null;
        const slice = values.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

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
        if (this.klines.length > 500) this.klines.shift();

        const prevClose = this.klines.length > 1 ? this.klines[this.klines.length - 2].close : close;
        const srcCandle = this.h ? this.calculateHeikinAshi(open, high, low, close) : { close, high, low };
        if (this.h) this.heikinAshiCandles.push(srcCandle);

        const src = srcCandle.close;
        const srcHigh = srcCandle.high;
        const srcLow = srcCandle.low;

        const trueRange = Math.max(srcHigh - srcLow, Math.abs(srcHigh - prevClose), Math.abs(srcLow - prevClose));
        this.trueRanges.push(trueRange);

        const xATR = this.calculateATR(this.c);
        if (!xATR) return { signal: null };
        const nLoss = this.a * xATR;

        const prevXATRTrailingStop = this.xATRTrailingStop !== null ? this.xATRTrailingStop : src - nLoss;
        const prevPos = this.pos;

        if (src > prevXATRTrailingStop && prevClose > prevXATRTrailingStop) {
            this.xATRTrailingStop = Math.max(prevXATRTrailingStop, src - nLoss);
        } else if (src < prevXATRTrailingStop && prevClose < prevXATRTrailingStop) {
            this.xATRTrailingStop = Math.min(prevXATRTrailingStop, src + nLoss);
        } else if (src > prevXATRTrailingStop) {
            this.xATRTrailingStop = src - nLoss;
        } else {
            this.xATRTrailingStop = src + nLoss;
        }

        if (prevClose < prevXATRTrailingStop && src > prevXATRTrailingStop) {
            this.pos = 1;
        } else if (prevClose > prevXATRTrailingStop && src < prevXATRTrailingStop) {
            this.pos = -1;
        } else {
            this.pos = prevPos;
        }

        const currentAtr = this.calculateATR(this.c);
        if (currentAtr !== null) this.atrValues.push(currentAtr);

        const longTermAtrMa = this.calculateSMA(this.atrValues, this.atr_ma_period);
        if (longTermAtrMa !== null) this.atrMaValues.push(longTermAtrMa);

        const isSideways = this.use_filter && longTermAtrMa !== null && (currentAtr < longTermAtrMa * this.atr_threshold);

        let signal = null;
        if (this.pos !== prevPos) {
            if (this.pos === 1 && !isSideways) {
                signal = { type: 'BUY', message: 'AL Sinyali' };
            } else if (this.pos === -1 && !isSideways) {
                signal = { type: 'SELL', message: 'SAT Sinyali' };
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
        this.trades.push({
            type: this.position_size > 0 ? 'SELL' : 'BUY',
            price,
            quantity: Math.abs(this.position_size),
            action: 'exit',
            pnl,
        });
        this.position_size = 0;
    }

    openPosition(side, price) {
        const qty = this.calculateQuantity(price);
        this.position_size = side === 'BUY' ? qty : -qty;
        this.trades.push({ type: side, price, quantity: qty, action: 'entry' });
    }

    getAvgEntryPrice() {
        const entryTrades = this.trades.filter(t => t.action === 'entry');
        if (entryTrades.length === 0) return 0;
        return entryTrades[entryTrades.length - 1].price;
    }
}

// =========================================================================================
// STRATEGY CONFIGURATION
// =========================================================================================
const CFG = {
    a: 1,
    c: 10,
    h: false,
    use_filter: true,
    atr_ma_period: 100,
    atr_threshold: 0.7,
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,
    BOT_NAME: 'UTBOT STRATEGY JS'
};

// =========================================================================================
// GLOBAL STATE
// =========================================================================================
let botCurrentPosition = 'none';
let totalNetProfit = 0;
let isBotInitialized = false;

const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

const mockBinanceClient = {
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
    if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) return;
    const telegramApiUrl = `https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`;
    const payload = { chat_id: CFG.TG_CHAT_ID, text, parse_mode: 'Markdown' };
    try {
        await fetch(telegramApiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (error) {
        console.error('Telegram mesajı gönderilemedi:', error);
    }
}

// =========================================================================================
// DATA FETCH
// =========================================================================================
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
            await sendTelegramMessage(
                `✅ *${CFG.BOT_NAME} Başlatıldı!*\n\n` +
                `Mod: ${isSimulationMode ? 'Simülasyon' : 'Canlı İşlem'}\n` +
                `Sembol: ${CFG.SYMBOL}\n` +
                `Zaman Aralığı: ${CFG.INTERVAL}\n` +
                `Başlangıç Sermayesi: ${CFG.INITIAL_CAPITAL} USDT`
            );
            isBotInitialized = true;
        }
    } catch (error) {
        console.error('İlk verileri çekerken hata:', error);
    }
}

fetchInitialData();

// =========================================================================================
// WEBSOCKET
// =========================================================================================
const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('message', async (message) => {
    const data = JSON.parse(message);
    const klineData = data.k;

    if (klineData.x) {
        const newBar = {
            open: parseFloat(klineData.o),
            high: parseFloat(klineData.h),
            low: parseFloat(klineData.l),
            close: parseFloat(klineData.c),
            closeTime: klineData.T
        };

        const result = utBotStrategy.processCandle(newBar.closeTime, newBar.open, newBar.high, newBar.low, newBar.close);
        const signal = result.signal;

        if (signal?.type === 'BUY' && botCurrentPosition !== 'long') {
            botCurrentPosition = 'long';
            await sendTelegramMessage(`🚀 *BUY Emri Gerçekleşti!*\n\nBot Adı: ${CFG.BOT_NAME}\nSinyal: ${signal.message}\nFiyat: ${newBar.close}`);
        } else if (signal?.type === 'SELL' && botCurrentPosition !== 'short') {
            botCurrentPosition = 'short';
            await sendTelegramMessage(`🔻 *SELL Emri Gerçekleşti!*\n\nBot Adı: ${CFG.BOT_NAME}\nSinyal: ${signal.message}\nFiyat: ${newBar.close}`);
        }
    }
});

ws.on('close', () => console.log('❌ WebSocket kapandı. Yeniden bağlan...'));
ws.on('error', (error) => console.error('WebSocket hatası:', error.message));

// =========================================================================================
// SERVER
// =========================================================================================
app.get('/', (req, res) => res.send('Bot çalışıyor!'));
app.listen(PORT, () => console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`));
