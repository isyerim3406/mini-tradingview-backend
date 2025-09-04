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
        this.prevPos = 0; // Önceki pozisyonu takip et
        this.capital = this.initial_capital;
        this.trades = [];
        this.position_size = 0;
        this.entry_price = 0;
        this.total_pnl = 0;
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
        if (this.trueRanges.length > 500) this.trueRanges.shift();

        const xATR = this.calculateATR(this.c);
        if (!xATR) return { signal: null };
        const nLoss = this.a * xATR;

        // ATR Trailing Stop hesaplaması (PineScript'e uygun)
        const prevXATRTrailingStop = this.xATRTrailingStop !== null ? this.xATRTrailingStop : src - nLoss;

        if (src > prevXATRTrailingStop && prevClose > prevXATRTrailingStop) {
            this.xATRTrailingStop = Math.max(prevXATRTrailingStop, src - nLoss);
        } else if (src < prevXATRTrailingStop && prevClose < prevXATRTrailingStop) {
            this.xATRTrailingStop = Math.min(prevXATRTrailingStop, src + nLoss);
        } else if (src > prevXATRTrailingStop) {
            this.xATRTrailingStop = src - nLoss;
        } else {
            this.xATRTrailingStop = src + nLoss;
        }

        // Pozisyon mantığı (PineScript'e uygun)
        this.prevPos = this.pos;

        if (prevClose < prevXATRTrailingStop && src > prevXATRTrailingStop) {
            this.pos = 1;
        } else if (prevClose > prevXATRTrailingStop && src < prevXATRTrailingStop) {
            this.pos = -1;
        }
        // Else durumunda pos değişmez (PineScript'teki gibi)

        // ATR değerlerini sakla
        const currentAtr = this.calculateATR(this.c);
        if (currentAtr !== null) {
            this.atrValues.push(currentAtr);
            if (this.atrValues.length > 500) this.atrValues.shift();
        }

        // Sideways filter
        const longTermAtrMa = this.calculateSMA(this.atrValues, this.atr_ma_period);
        const isSideways = this.use_filter && longTermAtrMa !== null && (currentAtr < longTermAtrMa * this.atr_threshold);

        // Sinyal üretimi (PineScript'e uygun)
        let signal = null;
        const longCondition = this.pos === 1 && this.prevPos === -1;
        const shortCondition = this.pos === -1 && this.prevPos === 1;

        if (longCondition && !isSideways) {
            signal = { type: 'BUY', message: 'UT Bot: AL sinyali', price: src };
        } else if (shortCondition && !isSideways) {
            signal = { type: 'SELL', message: 'UT Bot: SAT sinyali', price: src };
        }

        return { signal, pos: this.pos, prevPos: this.prevPos };
    }

    openPosition(side, price) {
        // Önceki pozisyon varsa kapat
        if (this.position_size !== 0) {
            this.closePosition(price);
        }

        // Yeni pozisyon aç
        const equity_to_use = this.capital * (this.qty_percent / 100);
        const qty = equity_to_use / price;
        this.position_size = side === 'BUY' ? qty : -qty;
        this.entry_price = price;
        
        this.trades.push({
            type: side,
            price,
            quantity: qty,
            action: 'entry',
            timestamp: Date.now()
        });
    }

    closePosition(price) {
        if (this.position_size === 0) return { pnl: 0, side: 'none' };

        const side = this.position_size > 0 ? 'LONG' : 'SHORT';
        const pnl = this.position_size > 0 
            ? this.position_size * (price - this.entry_price)
            : Math.abs(this.position_size) * (this.entry_price - price);
        
        this.capital += pnl;
        this.total_pnl += pnl;
        
        this.trades.push({
            type: this.position_size > 0 ? 'SELL' : 'BUY',
            price,
            quantity: Math.abs(this.position_size),
            action: 'exit',
            pnl,
            timestamp: Date.now()
        });

        this.position_size = 0;
        this.entry_price = 0;

        return { pnl, side };
    }

    getCurrentPositionSide() {
        if (this.position_size > 0) return 'LONG';
        if (this.position_size < 0) return 'SHORT';
        return 'none';
    }

    getTotalPnL() {
        return this.total_pnl;
    }
}

// =========================================================================================
// CONFIG
// =========================================================================================
const CFG = {
    a: 1,        // PineScript default values
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
    INITIAL_CAPITAL: 10000, // PineScript default
    BOT_NAME: 'UT Bot Strategy'
};

// =========================================================================================
// STATE
// =========================================================================================
let isBotInitialized = false;

const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

const binanceClient = isSimulationMode ? {
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
            });
            price = close;
        }
        return mockCandles;
    }
} : Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
    test: CFG.IS_TESTNET,
});

const utBotStrategy = new UTBotStrategy(CFG);

// =========================================================================================
// TELEGRAM
// =========================================================================================
async function sendTelegramMessage(text) {
    if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) {
        console.log("Telegram mesajı:", text);
        return;
    }
    const url = `https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`;
    const payload = { chat_id: CFG.TG_CHAT_ID, text, parse_mode: 'Markdown' };
    try {
        await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) {
        console.error('Telegram mesajı gönderilemedi:', e);
    }
}

// =========================================================================================
// INITIAL DATA
// =========================================================================================
async function fetchInitialData() {
    try {
        const klines = await binanceClient.candles({
            symbol: CFG.SYMBOL,
            interval: CFG.INTERVAL,
            limit: 500
        });

        let lastSignal = null;
        klines.forEach(k => {
            const res = utBotStrategy.processCandle(
                k.closeTime, 
                parseFloat(k.open), 
                parseFloat(k.high), 
                parseFloat(k.low), 
                parseFloat(k.close)
            );
            if (res.signal) lastSignal = res.signal;
        });

        console.log(`✅ İlk ${utBotStrategy.klines.length} mum yüklendi.`);
        console.log(`Son pos: ${utBotStrategy.pos}, prevPos: ${utBotStrategy.prevPos}`);

        if (!isBotInitialized) {
            await sendTelegramMessage(
                `✅ *${CFG.BOT_NAME} Başlatıldı!*\n\n` +
                `**Mod:** ${isSimulationMode ? 'Simülasyon' : 'Canlı İşlem'}\n` +
                `**Sembol:** ${CFG.SYMBOL}\n` +
                `**Zaman Aralığı:** ${CFG.INTERVAL}\n` +
                `**Başlangıç Sermayesi:** ${CFG.INITIAL_CAPITAL} USDT\n` +
                `**Son Pozisyon:** ${utBotStrategy.pos === 1 ? 'LONG' : utBotStrategy.pos === -1 ? 'SHORT' : 'YOK'}\n` +
                `**Son Sinyal:** ${lastSignal ? lastSignal.message : "Henüz sinyal yok"}`
            );
            isBotInitialized = true;
        }
    } catch (error) {
        console.error('İlk veri yükleme hatası:', error);
        setTimeout(fetchInitialData, 5000); // 5 saniye sonra tekrar dene
    }
}

fetchInitialData();

// =========================================================================================
// WEBSOCKET
// =========================================================================================
const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('message', async msg => {
    try {
        const data = JSON.parse(msg);
        const k = data.k;
        
        if (k.x) { // Mum kapandığında
            const newBar = {
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                closeTime: k.T
            };

            console.log(`📊 Yeni bar: ${newBar.close} | Pos: ${utBotStrategy.pos} | PrevPos: ${utBotStrategy.prevPos}`);

            const res = utBotStrategy.processCandle(
                newBar.closeTime, 
                newBar.open, 
                newBar.high, 
                newBar.low, 
                newBar.close
            );

            if (res.signal) {
                const currentPosition = utBotStrategy.getCurrentPositionSide();
                
                if (res.signal.type === 'BUY') {
                    // Önce mevcut pozisyonu kapat (varsa)
                    const closeResult = utBotStrategy.closePosition(newBar.close);
                    if (closeResult.side !== 'none') {
                        const pnlText = closeResult.pnl >= 0 ? `+${closeResult.pnl.toFixed(2)}` : closeResult.pnl.toFixed(2);
                        await sendTelegramMessage(
                            `📉 *${closeResult.side} Pozisyon Kapatıldı!*\n\n` +
                            `**Kapanış Fiyatı:** ${newBar.close}\n` +
                            `**Bu İşlemden Kar/Zarar:** ${pnlText} USDT\n` +
                            `**Toplam Net Kar/Zarar:** ${utBotStrategy.getTotalPnL().toFixed(2)} USDT`
                        );
                    }
                    
                    // Yeni LONG pozisyon aç
                    utBotStrategy.openPosition('BUY', newBar.close);
                    await sendTelegramMessage(
                        `🟢 *LONG Pozisyon Açıldı!*\n\n` +
                        `**Bot:** ${CFG.BOT_NAME}\n` +
                        `**Sinyal:** ${res.signal.message}\n` +
                        `**Giriş Fiyatı:** ${newBar.close}\n` +
                        `**Toplam Net Kar/Zarar:** ${utBotStrategy.getTotalPnL().toFixed(2)} USDT`
                    );
                    
                } else if (res.signal.type === 'SELL') {
                    // Önce mevcut pozisyonu kapat (varsa)
                    const closeResult = utBotStrategy.closePosition(newBar.close);
                    if (closeResult.side !== 'none') {
                        const pnlText = closeResult.pnl >= 0 ? `+${closeResult.pnl.toFixed(2)}` : closeResult.pnl.toFixed(2);
                        await sendTelegramMessage(
                            `📉 *${closeResult.side} Pozisyon Kapatıldı!*\n\n` +
                            `**Kapanış Fiyatı:** ${newBar.close}\n` +
                            `**Bu İşlemden Kar/Zarar:** ${pnlText} USDT\n` +
                            `**Toplam Net Kar/Zarar:** ${utBotStrategy.getTotalPnL().toFixed(2)} USDT`
                        );
                    }
                    
                    // Yeni SHORT pozisyon aç
                    utBotStrategy.openPosition('SELL', newBar.close);
                    await sendTelegramMessage(
                        `🔴 *SHORT Pozisyon Açıldı!*\n\n` +
                        `**Bot:** ${CFG.BOT_NAME}\n` +
                        `**Sinyal:** ${res.signal.message}\n` +
                        `**Giriş Fiyatı:** ${newBar.close}\n` +
                        `**Toplam Net Kar/Zarar:** ${utBotStrategy.getTotalPnL().toFixed(2)} USDT`
                    );
                }
            }
        }
    } catch (error) {
        console.error('WebSocket mesaj işleme hatası:', error);
    }
});

ws.on('open', () => {
    console.log('✅ WebSocket bağlantısı kuruldu');
});

ws.on('close', () => {
    console.log('❌ WebSocket kapandı, yeniden bağlanılıyor...');
    setTimeout(() => {
        // Yeniden bağlan
        const newWs = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);
        // Event listeners'ları yeniden ekle...
    }, 5000);
});

ws.on('error', e => console.error('WebSocket hatası:', e.message));

// =========================================================================================
// SERVER
// =========================================================================================
app.get('/', (req, res) => {
    const status = {
        status: 'Bot çalışıyor 🚀',
        currentPosition: utBotStrategy.getCurrentPositionSide(),
        totalPnL: utBotStrategy.getTotalPnL().toFixed(2),
        pos: utBotStrategy.pos,
        prevPos: utBotStrategy.prevPos,
        totalTrades: utBotStrategy.trades.length
    };
    res.json(status);
});

app.listen(PORT, () => console.log(`🚀 Sunucu http://localhost:${PORT} adresinde çalışıyor`));
