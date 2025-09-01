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
    // --- Trading Settings ---
    TRADE_SIZE_PERCENT: 100,
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '3m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    IS_TESTNET: process.env.IS_TESTNET === 'true',
    INITIAL_CAPITAL: 100,

    // --- MACD Settings (Pine Script'ten gelen) ---
    fastLength: 12,
    slowLength: 26,
    signalLength: 9,
    adxThreshold: 20.0,
    macdFilterEnabled: true,
    len: 5,

    // --- HH/LH/LL/HL Filters (Pine Script'ten gelen, Flip özelliği eklendi) ---
    exitLongOnLH: true,
    flipToShortOnLH: false,
    exitShortOnHH: true,
    flipToLongOnHH: false,
    exitLongOnLL: false,
    flipToShortOnLL: false,
    exitShortOnHL: false,
    flipToLongOnHL: false,
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

// Simülasyon modu için sahte bir Binance istemcisi oluşturma
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
// TECHNICAL INDICATORS (PINE SCRIPT TRANSLATION)
// =========================================================================================
function getEMA(series, length) {
    if (series.length < length) {
        return [];
    }
    let ema = [];
    let alpha = 2 / (length + 1);
    ema.push(series[0]); // Initial value is the first data point
    for (let i = 1; i < series.length; i++) {
        let prevEma = ema[i - 1] !== undefined ? ema[i - 1] : series[i];
        let newEma = alpha * series[i] + (1 - alpha) * prevEma;
        ema.push(newEma);
    }
    return ema;
}

function getSMA(series, length) {
    if (series.length < length) {
        return [];
    }
    let sma = [];
    for (let i = length - 1; i < series.length; i++) {
        const subSeries = series.slice(i - length + 1, i + 1);
        const sum = subSeries.reduce((acc, val) => acc + val, 0);
        sma.push(sum / length);
    }
    return sma;
}

function getADX(highs, lows, closes, length) {
    if (highs.length < length + 1) {
        return { adx: 0, plusDI: 0, minusDI: 0 };
    }

    const tr = [];
    const plusDM = [];
    const minusDM = [];
    for (let i = 1; i < highs.length; i++) {
        let h = highs[i], l = lows[i], prevC = closes[i - 1];
        tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
        plusDM.push(h - highs[i - 1] > lows[i - 1] - l ? Math.max(h - highs[i - 1], 0) : 0);
        minusDM.push(lows[i - 1] - l > h - highs[i - 1] ? Math.max(lows[i - 1] - l, 0) : 0);
    }

    const rmaTR = getRMA(tr, length);
    const rmaPlusDM = getRMA(plusDM, length);
    const rmaMinusDM = getRMA(minusDM, length);

    const plusDI = rmaPlusDM.map((val, i) => (val / rmaTR[i]) * 100);
    const minusDI = rmaMinusDM.map((val, i) => (val / rmaTR[i]) * 100);

    const dx = plusDI.map((val, i) => Math.abs(val - minusDI[i]) / (val + minusDI[i]) * 100);
    const adx = getRMA(dx, length);

    return {
        adx: adx.length > 0 ? adx[adx.length - 1] : 0,
        plusDI: plusDI.length > 0 ? plusDI[plusDI.length - 1] : 0,
        minusDI: minusDI.length > 0 ? minusDI[minusDI.length - 1] : 0,
    };
}

function getRMA(series, length) {
    let rma = [series[0]];
    let alpha = 1 / length;
    for (let i = 1; i < series.length; i++) {
        let prevRma = rma[i - 1] !== undefined ? rma[i - 1] : series[i];
        let newRma = alpha * series[i] + (1 - alpha) * prevRma;
        rma.push(newRma);
    }
    return rma;
}

function cross(series1, series2) {
    if (series1.length < 2 || series2.length < 2) return false;
    return series1[series1.length - 2] < series2[series2.length - 2] && series1[series1.length - 1] > series2[series2.length - 1];
}

function crossunder(series1, series2) {
    if (series1.length < 2 || series2.length < 2) return false;
    return series1[series1.length - 2] > series2[series2.length - 2] && series1[series2.length - 1] < series2[series2.length - 1];
}

// =========================================================================================
// MAIN STRATEGY LOGIC
// =========================================================================================
function computeSignals() {
    // --- Yetersiz veri kontrolü ---
    if (klines.length < Math.max(CFG.slowLength, CFG.signalLength, CFG.len, 14) + 1) {
        return { type: 'none', message: 'Yetersiz veri' };
    }

    const closePrices = klines.map(k => k.close);
    const highPrices = klines.map(k => k.high);
    const lowPrices = klines.map(k => k.low);
    const lastBarIndex = klines.length - 1;

    // --- Gösterge Hesaplamaları ---
    const macdSeries = getEMA(closePrices, CFG.fastLength).map((emaFast, i) => emaFast - getEMA(closePrices, CFG.slowLength)[i]);
    const signalSeries = getSMA(macdSeries, CFG.signalLength);
    const adxResult = getADX(highPrices, lowPrices, closePrices, 14);
    const adxFilter = adxResult.adx > CFG.adxThreshold;

    const lastMacd = macdSeries[macdSeries.length - 1];
    const lastSignal = signalSeries[signalSeries.length - 1];

    // --- HH/LH/LL/HL Tespiti (Pine Script'teki mantığın çevirisi) ---
    const macdHigh = Math.max(...macdSeries.slice(-CFG.len));
    const macdLow = Math.min(...macdSeries.slice(-CFG.len));
    
    const lhDetected = macdSeries[macdSeries.length - 2] < macdSeries[macdSeries.length - 3] && macdSeries[macdSeries.length - 3] > macdSeries[macdSeries.length - 4] && macdSeries[macdSeries.length - 3] < macdHigh;
    const hhDetected = macdSeries[macdSeries.length - 2] > macdSeries[macdSeries.length - 3] && macdSeries[macdSeries.length - 3] < macdSeries[macdSeries.length - 4] && macdSeries[macdSeries.length - 3] > macdLow;
    // LL ve HL için Pine Script mantığı, son 3 barı ve geçmiş `len` barı kullanır.
    const llDetected = macdSeries[macdSeries.length-2] > macdSeries[macdSeries.length-3] && macdSeries[macdSeries.length-3] < macdSeries[macdSeries.length-4] && macdSeries[macdSeries.length-3] < macdLow;
    const hlDetected = macdSeries[macdSeries.length-2] > macdSeries[macdSeries.length-3] && macdSeries[macdSeries.length-3] < macdSeries[macdSeries.length-4] && macdSeries[macdSeries.length-3] > macdLow;

    // --- Filtrelere göre pozisyon kapatma veya tersine çevirme ---
    if (CFG.macdFilterEnabled) {
        if (botCurrentPosition === 'long' && lhDetected) {
            if (CFG.flipToShortOnLH) {
                return { type: 'flip_short', message: "LH tespiti: Pozisyonu tersine çevir" };
            } else if (CFG.exitLongOnLH) {
                return { type: 'short', message: "LH tespiti: Uzun pozisyonu kapat" };
            }
        }
        if (botCurrentPosition === 'short' && hhDetected) {
            if (CFG.flipToLongOnHH) {
                return { type: 'flip_long', message: "HH tespiti: Pozisyonu tersine çevir" };
            } else if (CFG.exitShortOnHH) {
                return { type: 'long', message: "HH tespiti: Kısa pozisyonu kapat" };
            }
        }
        if (botCurrentPosition === 'long' && llDetected) {
            if (CFG.flipToShortOnLL) {
                return { type: 'flip_short', message: "LL tespiti: Pozisyonu tersine çevir" };
            } else if (CFG.exitLongOnLL) {
                return { type: 'short', message: "LL tespiti: Uzun pozisyonu kapat" };
            }
        }
        if (botCurrentPosition === 'short' && hlDetected) {
            if (CFG.flipToLongOnHL) {
                return { type: 'flip_long', message: "HL tespiti: Pozisyonu tersine çevir" };
            } else if (CFG.exitShortOnHL) {
                return { type: 'long', message: "HL tespiti: Kısa pozisyonu kapat" };
            }
        }
    }

    // --- Normal Giriş Şartları ---
    if (cross(macdSeries, signalSeries) && adxFilter) {
        if (botCurrentPosition !== 'long') {
            return { type: 'long', message: "AL sinyali: MACD/Sinyal kesişimi ve ADX Filtresi" };
        }
    }
    
    if (crossunder(macdSeries, signalSeries) && !adxFilter) {
        if (botCurrentPosition !== 'short') {
            return { type: 'short', message: "SAT sinyali: MACD/Sinyal kesişimi ve ADX Filtresi" };
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
    if (botCurrentPosition === 'none' || (side === 'BUY' && botCurrentPosition === 'short') || (side === 'SELL' && botCurrentPosition === 'long')) {
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
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.close),
            volume: parseFloat(k.v),
            closeTime: k.closeTime
        }));
        console.log(`✅ İlk ${klines.length} mum verisi yüklendi.`);

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
