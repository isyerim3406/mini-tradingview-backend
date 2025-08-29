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
let totalNetProfit = 0;
let isBotInitialized = false;

// API anahtarlarının varlığına göre simülasyon modunu belirliyoruz.
const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

let binanceClient = null;
if (!isSimulationMode) {
    binanceClient = Binance({
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_SECRET_KEY,
        test: CFG.IS_TESTNET,
    });
} else {
    console.log('--- SİMÜLASYON MODU AKTİF: API Anahtarları Bulunamadı ---');
}


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
        return rma.length > 0 ? rma[rma.length - 1] : 0;
    } else {
        const atr = getMovingAverage(trs, length, 'SMA');
        return atr.length > 0 ? atr[0] : 0;
    }
}

function getSSL1Line(klines, length, maType, kidiv) {
    const maHighs = klines.map((k, i) => getMovingAverage(klines.slice(0, i + 1).map(c => c.high), length, maType)[0] || k.high);
    const maLows = klines.map((k, i) => getMovingAverage(klines.slice(0, i + 1).map(c => c.low), length, maType)[0] || k.low);

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
async function placeOrder(side, signalMessage) {
    const lastClosePrice = klines[klines.length - 1]?.close || 0;

    // Mevcut pozisyonu kapatma
    if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
        try {
            let profit = 0;
            const entryPrice = botCurrentPosition === 'long' ? longEntryPrice : shortEntryPrice;

            if (isSimulationMode) {
                // Simülasyon modunda kâr/zarar hesaplaması
                profit = botCurrentPosition === 'long' ? (lastClosePrice - entryPrice) : (entryPrice - lastClosePrice);
                totalNetProfit += profit;

                console.log(`SİMÜLASYON MODU: Mevcut pozisyon (${botCurrentPosition}) kapatıldı.`);
            } else {
                // Gerçek modda pozisyonu kapatma
                const positions = await binanceClient.futuresAccountBalance();
                const position = positions.find(p => p.asset === CFG.SYMBOL.replace('USDT', ''));
                
                if (position && parseFloat(position.balance) > 0) {
                     const closingSide = botCurrentPosition === 'long' ? 'SELL' : 'BUY';
                     const quantity = parseFloat(position.balance);
                     
                     // Gerçek kâr hesaplaması (sadece test amaçlı basit bir hesaplama)
                     profit = botCurrentPosition === 'long' ? (lastClosePrice - entryPrice) : (entryPrice - lastClosePrice);
                     totalNetProfit += profit;
                     
                     await binanceClient.futuresMarketOrder({
                         symbol: CFG.SYMBOL,
                         side: closingSide,
                         quantity: quantity,
                     });
                     console.log(`✅ Gerçek pozisyon (${botCurrentPosition}) kapatıldı.`);
                }
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
            const currentPrice = lastClosePrice; // Simülasyon için son kapanış fiyatını kullan
            let quantity = 0;

            if (isSimulationMode) {
                // Simülasyon modunda miktar hesaplaması
                quantity = (CFG.INITIAL_CAPITAL * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;
                console.log(`SİMÜLASYON MODU: ${side} emri verildi. Fiyat: ${currentPrice}`);
            } else {
                // Gerçek modda miktar hesaplaması
                const accountInfo = await binanceClient.futuresAccountBalance();
                const usdtBalance = parseFloat(accountInfo.find(a => a.asset === 'USDT').availableBalance);
                quantity = (usdtBalance * (CFG.TRADE_SIZE_PERCENT / 100)) / currentPrice;

                await binanceClient.futuresMarketOrder({
                    symbol: CFG.SYMBOL,
                    side: side,
                    quantity: quantity.toFixed(4)
                });
                console.log(`🟢 ${side} emri başarıyla verildi. Fiyat: ${currentPrice}`);
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
            close: parseFloat(k.close),
            volume: parseFloat(k.v),
            closeTime: k.closeTime
        }));
        console.log(`✅ İlk ${klines.length} mum verisi yüklendi.`);

        // Yalnızca bot ilk kez başlatıldığında mesaj gönder
        if (!isBotInitialized) {
            sendTelegramMessage(`✅ Bot başlatıldı!\n\n**Mod:** ${isSimulationMode ? 'Simülasyon' : 'Canlı İşlem'}\n**Sembol:** ${CFG.SYMBOL}\n**Zaman Aralığı:** ${CFG.INTERVAL}\n**Başlangıç Sermayesi:** ${CFG.INITIAL_CAPITAL} USDT`);
            isBotInitialized = true;
        }

    } catch (error) {
        console.error('İlk verileri çekerken hata:', error);
    }
}

if (!isSimulationMode) {
    fetchInitialData();
} else {
    // Simülasyon modunda ilk verileri çekmek için BinanceClient'a ihtiyacımız yok, direkt devam edebiliriz.
    // Ancak sağlıklı bir simülasyon için buraya manuel veri yükleme mantığı eklenebilir.
    // Şimdilik WebSocket bağlantısı ile canlı verileri almaya devam ediyoruz.
    sendTelegramMessage(`✅ Bot simülasyon modunda başlatıldı!\n\n**Sembol:** ${CFG.SYMBOL}\n**Zaman Aralığı:** ${CFG.INTERVAL}\n**Başlangıç Sermayesi:** ${CFG.INITIAL_CAPITAL} USDT`);
    isBotInitialized = true;
}


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
