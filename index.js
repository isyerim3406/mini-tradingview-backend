import WebSocket from 'ws';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import Binance from 'binance-api-node';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import pkg from 'technicalindicators';
const { BBand, ATR } = pkg;

dotenv.config();

// ENV değişkenleri kontrolü
const requiredEnv = ['BINANCE_API_KEY', 'BINANCE_API_SECRET'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error(`Fatal Hata: .env dosyasında aşağıdaki değişkenler eksik: ${missingEnv.join(', ')}`);
    // Uygulamanın daha fazla ilerlemesini engellemek için buradan çıkış yapıyoruz
    process.exit(1);
}

// Global durum değişkenleri
let positions = {};
let longEntryPrice = {};
let shortEntryPrice = {};
let isLongPositionOpen = false;
let isShortPositionOpen = false;
let longPositionQuantity = 0;
let shortPositionQuantity = 0;
let lastLongEntryTime = null;
let lastShortEntryTime = null;
let stopLossHit = false;
let takeProfitHit = false;

// Kütüphane entegrasyonu
const app = express();
const binance = Binance.default({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
});

// Ayarlar
const SYMBOL = 'BTCUSDT';
const INTERVAL = '15m';

// BBMC+ATR Strateji parametreleri
const BBMC_length = 50; // BBMC için Moving Average Period
const ATR_period = 14;  // ATR için Periyot
const ATR_multiplier = 2; // ATR için çarpan
const ATR_stoploss_multiplier = 1; // Stoploss için ATR çarpanı
const ATR_takeprofit_multiplier = 3; // Kar al için ATR çarpanı

let prices = [];
let BBMC_lines = [];
let ATR_values = [];
let trueRanges = [];

let isSideWays = false;
let inTrade = false;
let positionType = 'none';

// IFTSMI Strateji parametreleri
const SMIL = 54;
const wmalength = 6;
const IEMA = 5;
const OEMA = 5;
const level_buy = -0.5;
const level_sell = 0.8;
const use_filter = true;
const atr_period = 14;
const atr_ma_period = 100;
const atr_threshold = 0.7;

// IFTSMI için gerekli veri dizileri
let iftsmi_closes = [];
let iftsmi_highs = [];
let iftsmi_lows = [];
let iftsmi_true_ranges = [];
let iftsmi_v1_values = [];
let iftsmi_smi_values = [];
let iftsmi_inv_values = [];
let iftsmi_atr_values = [];
let iftsmi_atr_ma_values = [];
let iftsmi_ema_states = {};

async function initialize() {
    try {
        console.log("Bot başlatılıyor...");
        await setupBinanceStreams();
        await fetchInitialData();
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(`Web sunucusu ${port} portunda çalışıyor.`));
    } catch (e) {
        console.error("Fatal Hata: Bot başlatılamadı.", e);
        process.exit(1);
    }
}

async function fetchInitialData() {
    console.log("Geçmiş veri çekiliyor...");
    try {
        const klines = await binance.futuresCandles({ symbol: SYMBOL, interval: INTERVAL, limit: 1000 });
        for (const kline of klines) {
            processNewCandle(kline);
        }
        console.log("Geçmiş veri başarıyla yüklendi.");
    } catch (error) {
        console.error("Geçmiş veri çekme hatası:", error);
    }
}

async function setupBinanceStreams() {
    try {
        await binance.ws.futuresCandles(SYMBOL, INTERVAL, (kline) => {
            if (kline.isFinal) {
                processNewCandle(kline);
            }
        });
        console.log("WebSocket bağlantısı kuruldu. Canlı veri bekleniyor...");
    } catch (error) {
        console.error("WebSocket bağlantı hatası:", error);
    }
}

function processNewCandle(kline) {
    const close = parseFloat(kline.close);
    const high = parseFloat(kline.high);
    const low = parseFloat(kline.low);
    const open = parseFloat(kline.open);

    // BBMC+ATR Strateji hesaplamaları
    prices.push(close);
    if (prices.length > BBMC_length) prices.shift();

    if (prices.length >= BBMC_length) {
        const bands = BBand.calculate({
            period: BBMC_length,
            values: prices,
            stdDev: 2,
        });
        const bbmc = bands[bands.length - 1];
        BBMC_lines.push(bbmc);
    }

    const atrInput = {
        high: [high],
        low: [low],
        close: [close],
        period: ATR_period
    };
    const newATR = ATR.calculate(atrInput);
    if (newATR.length > 0) {
        ATR_values.push(newATR[0]);
    }

    const trend = getBBMCtrend(high, low, close);
    isSideWays = isSidewaysMarket();

    if (inTrade) {
        const currentATR = newATR[0];
        if (positionType === 'long' && close < longEntryPrice[SYMBOL] - currentATR * ATR_stoploss_multiplier) {
            console.log("Stop-Loss: Uzun pozisyon ATR ile kapandı.");
            // Pozisyonu kapatma komutu
            inTrade = false;
            positionType = 'none';
        }
        // ... (kısa pozisyon için stop-loss kontrolü)
    }

    // IFTSMI Strateji hesaplamaları
    const iftsmi_result = calculateIFTSMI(open, high, low, close);
    const iftsmi_signal = iftsmi_result.signal;

    // Sinyal yönetimi
    let finalSignal = 'none';
    if (inTrade === false && !isSideWays) {
        if (iftsmi_signal === 'buy' && trend === 'bullish') {
            finalSignal = 'buy';
        } else if (iftsmi_signal === 'sell' && trend === 'bearish') {
            finalSignal = 'sell';
        }
    }

    handleSignal(finalSignal, close);

    console.log(`Yeni mum verisi geldi. Fiyat: ${close}. Sinyal: ${finalSignal}. Pozisyon: ${positionType}`);
}

function handleSignal(signal, price) {
    if (signal === 'buy' && !inTrade) {
        // Alım sinyali geldi
        // ...
        inTrade = true;
        positionType = 'long';
        // Gerçek alım emri burada verilir
        console.log(`AL sinyali: ${price} fiyatından uzun pozisyon açıldı.`);
    } else if (signal === 'sell' && !inTrade) {
        // Satım sinyali geldi
        // ...
        inTrade = true;
        positionType = 'short';
        // Gerçek satım emri burada verilir
        console.log(`SAT sinyali: ${price} fiyatından kısa pozisyon açıldı.`);
    }
}

function getBBMCtrend(high, low, close) {
    if (BBMC_lines.length < 2) return 'none';
    
    const lastBBMC = BBMC_lines[BBMC_lines.length - 1];
    const prevBBMC = BBMC_lines[BBMC_lines.length - 2];

    const currentPrice = close;
    const upperBand = lastBBMC.upper;
    const lowerBand = lastBBMC.lower;

    if (currentPrice > upperBand) {
        if (lastBBMC.middle > prevBBMC.middle) {
            return 'bullish';
        }
    } else if (currentPrice < lowerBand) {
        if (lastBBMC.middle < prevBBMC.middle) {
            return 'bearish';
        }
    }
    return 'none';
}

function isSidewaysMarket() {
    if (ATR_values.length < 100) return false;
    const lastATR = ATR_values[ATR_values.length - 1];
    const avgATR = ATR_values.slice(-100).reduce((a, b) => a + b) / 100;
    return lastATR < avgATR * 0.7;
}


// IFTSMI Yardımcı fonksiyonları (Python dosyasından çevrilmiştir)
function getLowest(values, period) {
    if (values.length < period) return Math.min(...values);
    return Math.min(...values.slice(-period));
}

function getHighest(values, period) {
    if (values.length < period) return Math.max(...values);
    return Math.max(...values.slice(-period));
}

function calculateEMA(value, period, key) {
    if (!iftsmi_ema_states[key]) {
        iftsmi_ema_states[key] = { values: [], ema: null };
    }
    const state = iftsmi_ema_states[key];
    state.values.push(value);

    if (state.values.length === 1) {
        state.ema = value;
    } else {
        const multiplier = 2 / (period + 1);
        state.ema = (value * multiplier) + (state.ema * (1 - multiplier));
    }
    return state.ema;
}

function calculateWMA(values, period) {
    if (values.length < period) return null;

    const slice = values.slice(-period);
    let weightedSum = 0;
    let weightSum = 0;
    for (let i = 0; i < period; i++) {
        weightedSum += slice[i] * (i + 1);
        weightSum += (i + 1);
    }
    return weightedSum / weightSum;
}

function calculateTrueRange(high, low, prev_close) {
    if (prev_close === undefined) {
        return high - low;
    }
    const tr1 = high - low;
    const tr2 = Math.abs(high - prev_close);
    const tr3 = Math.abs(low - prev_close);
    return Math.max(tr1, tr2, tr3);
}

function calculateIFTSMI(open, high, low, close) {
    const prev_close = iftsmi_closes.length > 0 ? iftsmi_closes[iftsmi_closes.length - 1] : undefined;

    iftsmi_closes.push(close);
    iftsmi_highs.push(high);
    iftsmi_lows.push(low);

    // True Range
    const tr = calculateTrueRange(high, low, prev_close);
    iftsmi_true_ranges.push(tr);

    // SM (Stochastic Momentum)
    const LLow = getLowest(iftsmi_lows, SMIL);
    const HHigh = getHighest(iftsmi_highs, SMIL);
    const SM = close - 0.5 * (HHigh + LLow);

    // SMI
    const avgsm = calculateEMA(calculateEMA(SM, IEMA, 'sm_inner'), OEMA, 'sm_outer');
    const diff = HHigh - LLow;
    const avgdiff = calculateEMA(calculateEMA(diff, IEMA, 'diff_inner'), OEMA, 'diff_outer');
    const SMI = avgdiff !== 0 ? 100 * (avgsm / (0.5 * avgdiff)) : 0;
    iftsmi_smi_values.push(SMI);

    // Inverse Fisher Transform
    const v1 = 0.1 * SMI;
    iftsmi_v1_values.push(v1);
    const v2 = calculateWMA(iftsmi_v1_values, wmalength);

    const inv = v2 !== null ? (Math.exp(2 * v2) - 1) / (Math.exp(2 * v2) + 1) : 0;
    iftsmi_inv_values.push(inv);

    // ATR ve Pazar Filtresi
    const atr = iftsmi_true_ranges.length >= atr_period ? iftsmi_true_ranges.slice(-atr_period).reduce((a, b) => a + b) / atr_period : null;
    if (atr !== null) {
        iftsmi_atr_values.push(atr);
    }

    const atr_ma = iftsmi_atr_values.length >= atr_ma_period ? iftsmi_atr_values.slice(-atr_ma_period).reduce((a, b) => a + b) / atr_ma_period : null;

    const is_sideways = use_filter && atr !== null && atr_ma !== null && (atr < atr_ma * atr_threshold);

    // Sinyal üretimi
    let signal = null;
    if (iftsmi_inv_values.length >= 2) {
        const current_inv = iftsmi_inv_values[iftsmi_inv_values.length - 1];
        const previous_inv = iftsmi_inv_values[iftsmi_inv_values.length - 2];

        if (previous_inv <= level_buy && current_inv > level_buy) {
            signal = 'buy';
        } else if (previous_inv >= level_sell && current_inv < level_sell) {
            signal = 'sell';
        }
    }

    return {
        inv: inv,
        smi: SMI,
        atr: atr,
        atr_ma: atr_ma,
        is_sideways: is_sideways,
        signal: signal
    };
}

initialize();
