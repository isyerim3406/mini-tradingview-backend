import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
// Binance API'yi doğru şekilde içe aktarıyoruz.
import { Binance } from 'binance-api-node';

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
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
};

// =========================================================================================
// GLOBAL STATE
// =========================================================================================
let botCurrentPosition = 'none';
let klines = [];
let longEntryPrice = null;
let longEntryBarIndex = -1;
let shortEntryPrice = null;
let shortEntryBarIndex = -1;
let currentCapital = CFG.INITIAL_CAPITAL;
let totalNetProfit = 0;

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
// TECHNICAL INDICATORS
// =========================================================================================
function getMovingAverage(series, length, maType) {
    if (series.length < length) {
        return [];
    }
    const subSeries = series.slice(-length);
    const sum = subSeries.reduce((acc, val) => acc + val, 0);
    const ma = sum / length;
    return [ma];
}

function getRMA(series, length) {
    if (series.length < length) {
        return [];
    }
    let rma = [series[0]];
    let alpha = 1 / length;
    for (let i = 1; i < series.length; i++) {
        let prevRma = rma[i - 1] || series[i];
        let newRma = alpha * series[i] + (1 - alpha) * prevRma;
        rma.push(newRma);
    }
    return rma;
}

function getATR(highs, lows, closes, length, smoothing) {
    const trs = highs.map((high, i) => Math.max(high - lows[i], Math.abs(high - closes[i - 1] || 0), Math.abs(lows[i] - closes[i - 1] || 0)));
    if (smoothing === 'RMA') {
        const rma = getRMA(trs, length);
        return rma[rma.length - 1];
    } else {
        const atr = getMovingAverage(trs, length, 'SMA');
        return atr.length > 0 ? atr[0] : 0;
    }
}

function getSSL1Line(klines, length, maType, kidiv) {
    const maHighs = klines.map(k => getMovingAverage(klines.slice(0, klines.indexOf(k) + 1).map(c => c.high), length, maType)[0] || k.high);
    const maLows = klines.map(k => getMovingAverage(klines.slice(0, klines.indexOf(k) + 1).map(c => c.low), length, maType)[0] || k.low);

    let hlv = [];
    for (let i = 0; i < klines.length; i++) {
        if (klines[i].close > maHighs[i]) {
            hlv.push(1);
        } else if (klines[i].close < maLows[i]) {
            hlv.push(-1);
        } else {
            hlv.push(hlv.length > 0 ? hlv[hlv.length - 1] : 0);
        }
    }
    
    let ssl1Line = [];
    for (let i = 0; i < klines.length; i++) {
        ssl1Line.push(hlv[i] === -1 ? maHighs[i] : maLows[i]);
    }
    return ssl1Line;
}

function cross(series1, series2) {
    if (series1.length < 2 || series2.length < 2) return false;
    return series1[series1.length - 2] < series2[series2.length - 2] && series1[series1.length - 1] > series2[series2.length - 1];
}

function crossunder(series1, series2) {
    if (series1.length < 2 || series2.length < 2) return false;
    return series1[series1.length - 2] > series2[series2.length - 2] && series1[series1.length - 1] < series2[series2.length - 1];
}

// =========================================================================================
// MAIN STRATEGY
// =========================================================================================
function computeSignals() {
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN) + 1) {
        return { type: 'none', message: 'Yetersiz veri' };
    }

    const closePrices = klines.map(k => k.close);
    const highPrices = klines.map(k => k.high);
    const lowPrices = klines.map(k => k.low);
    const lastClose = closePrices[closePrices.length - 1];
    const lastBarIndex = klines.length - 1;

    // --- STOP LOSS CHECK ---
    if (botCurrentPosition === 'long' && CFG.USE_STOPLOSS_AL && longEntryPrice !== null) {
        const stopLossLevel = longEntryPrice * (1 - CFG.STOPLOSS_AL_PERCENT / 100);
        const barsSinceEntry = lastBarIndex - longEntryBarIndex;
        if (barsSinceEntry >= CFG.STOPLOSS_AL_ACTIVATION_BARS && lastClose <= stopLossLevel) {
            return { type: 'flip_short', message: 'UZUN POZISYON SL VURDU. SAT' };
        }
    }

    if (botCurrentPosition === 'short' && CFG.USE_STOPLOSS_SAT && shortEntryPrice !== null) {
        const stopLossLevel = shortEntryPrice * (1 + CFG.STOPLOSS_SAT_PERCENT / 100);
        const barsSinceEntry = lastBarIndex - shortEntryBarIndex;
        if (barsSinceEntry >= CFG.STOPLOSS_SAT_ACTIVATION_BARS && lastClose >= stopLossLevel) {
            return { type: 'flip_long', message: 'KISA POZISYON SL VURDU. AL' };
        }
    }

    // --- ENTRY SIGNAL CHECK ---
    const atrValue = getATR(highPrices, lowPrices, closePrices, CFG.ATR_LEN, CFG.ATR_SMOOTHING);
    const baseLine = getMovingAverage(closePrices, CFG.LEN, CFG.MA_TYPE);
    const bbmcUpper = baseLine[0] + (atrValue * CFG.ATR_MULT);
    const bbmcLower = baseLine[0] - (atrValue * CFG.ATR_MULT);
    const ssl1Line = getSSL1Line(klines, CFG.LEN, CFG.MA_TYPE, CFG.KIDIV);

    if (CFG.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
        const consecutiveAbove = closePrices.slice(-CFG.M_BARS_BUY).every(c => c > bbmcUpper);
        const consecutiveBelow = closePrices.slice(-CFG.N_BARS_SELL).every(c => c < bbmcLower);

        if (consecutiveAbove && botCurrentPosition !== 'long') {
            return { type: 'long', message: "AL sinyali: BBMC+ATR bands üzeri" };
        }
        if (consecutiveBelow && botCurrentPosition !== 'short') {
            return { type: 'short', message: "SAT sinyali: BBMC+ATR bands altı" };
        }
    } else if (CFG.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
        const closeSeries = [closePrices[closePrices.length - 2], closePrices[closePrices.length - 1]];
        const ssl1Series = [ssl1Line[ssl1Line.length - 2], ssl1Line[ssl1Line.length - 1]];

        if (cross(closeSeries, ssl1Series) && botCurrentPosition !== 'long') {
            return { type: 'long', message: "AL sinyali: SSL1 Kesişimi" };
        }
        if (crossunder(closeSeries, ssl1Series) && botCurrentPosition !== 'short') {
            return { type: 'short', message: "SAT sinyali: SSL1 Kesişimi" };
        }
    }

    return { type: 'none', message: 'Bekleniyor' };
}

// =========================================================================================
// ORDER PLACEMENT & TRADING LOGIC
// =========================================================================================
const binanceClient = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY,
    // test: CFG.IS_TESTNET,
});

async function placeOrder(side, signalMessage) {
    console.log(`📜 Sinyal Alındı: ${side} - ${signalMessage}`);

    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        try {
            const positions = await binanceClient.futuresAccountBalance();
            const position = positions.find(p => p.asset === CFG.SYMBOL.replace('USDT', ''));

            if (position && parseFloat(position.availableBalance) > 0) {
                 const closingSide = botCurrentPosition === 'long' ? 'SELL' : 'BUY';
                 const quantity = parseFloat(position.availableBalance);
                 await binanceClient.futuresMarketOrder({
                     symbol: CFG.SYMBOL,
                     side: closingSide,
                     quantity: quantity,
                 });
                 console.log(`✅ Mevcut pozisyon (${botCurrentPosition}) kapatıldı.`);
                 botCurrentPosition = 'none';
            }
        } catch (error) {
            console.error('Mevcut pozisyonu kapatırken hata oluştu:', error.body || error);
            // Hata durumunda işlemi sonlandır
            return;
        }
    }

    if (botCurrentPosition === 'none') {
        try {
            const ticker = await binanceClient.prices({ symbol: CFG.SYMBOL });
            const currentPrice = parseFloat(ticker[CFG.SYMBOL]);
            const accountInfo = await binanceClient.futuresAccountBalance();
            const usdtBalance = parseFloat(accountInfo.find(a => a.asset === 'USDT').availableBalance);
            const quantity = (usdtBalance * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;

            const order = await binanceClient.futuresMarketOrder({
                symbol: CFG.SYMBOL,
                side: side,
                quantity: quantity.toFixed(4)
            });

            if (side === 'BUY') {
                botCurrentPosition = 'long';
                longEntryPrice = currentPrice;
                longEntryBarIndex = klines.length - 1;
            } else if (side === 'SELL') {
                botCurrentPosition = 'short';
                shortEntryPrice = currentPrice;
                shortEntryBarIndex = klines.length - 1;
            }

            console.log(`🟢 ${side} emri başarıyla verildi. Fiyat: ${currentPrice}`);
            sendTelegramMessage(`🚀 **${side} Emri Gerçekleşti!**\n\n**Sinyal:** ${signalMessage}\n**Sembol:** ${CFG.SYMBOL}\n**Fiyat:** ${currentPrice}\n**Miktar:** ${quantity.toFixed(4)}`);
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
            close: parseFloat(k.close),
            volume: parseFloat(k.volume),
            closeTime: k.closeTime
        }));
        console.log(`✅ İlk ${klines.length} mum verisi yüklendi.`);
        
        sendTelegramMessage(`✅ Bot başlatıldı!\n\n**Sembol:** ${CFG.SYMBOL}\n**Zaman Aralığı:** ${CFG.INTERVAL}\n**Başlangıç Sermayesi:** ${CFG.INITIAL_CAPITAL} USDT`);

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
        
        klines.push(newBar);
        if (klines.length > 500) {
            klines.shift();
        }

        const signal = computeSignals();
        console.log(`Yeni mum verisi geldi. Fiyat: ${newBar.close}. Sinyal: ${signal.type}`);

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
