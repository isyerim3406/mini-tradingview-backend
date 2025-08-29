import WebSocket from 'ws';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Binance from 'binance-api-node';
import pkg from 'technicalindicators';
const { sma, ema, wma, rma } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================================================
// STRATEJI VE BOT AYARLARI
// =========================================================================================
const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
    // Finansal Ayarlar
    INITIAL_CAPITAL: 100, // Başlangıç sermayesi USDT
    // Strateji Ayarları
    LEN: 164,
    ATR_LEN: 14,
    ATR_MULT: 1.0,
    ATR_SMOOTHING: 'WMA',
    MA_TYPE: 'HMA',
    BASELINE_SOURCE: 'close',
    KIDIV: 1,
    ENTRY_SIGNAL_TYPE: 'SSL1 Kesişimi',
    M_BARS_BUY: 1,
    N_BARS_SELL: 1,
    // Stop Loss Ayarları
    USE_STOP_LOSS_AL: process.env.USE_STOP_LOSS_AL === 'true',
    STOP_LOSS_AL_PERCENT: parseFloat(process.env.STOP_LOSS_AL_PERCENT) || 2.0,
    STOP_LOSS_AL_ACTIVATION_BARS: parseFloat(process.env.STOP_LOSS_AL_ACTIVATION_BARS) || 1,
    USE_STOP_LOSS_SAT: process.env.USE_STOP_LOSS_SAT === 'true',
    STOP_LOSS_SAT_PERCENT: parseFloat(process.env.STOP_LOSS_SAT_PERCENT) || 2.0,
    STOP_LOSS_SAT_ACTIVATION_BARS: parseFloat(process.env.STOP_LOSS_SAT_ACTIVATION_BARS) || 1,
};

// =========================================================================================
// GÖSTERGELER VE YARDIMCI FONKSIYONLAR
// =========================================================================================

const getAvg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const getLowest = (arr) => Math.min(...arr);
const getHighest = (arr) => Math.max(...arr);

const movingAverage = (source, length, type, k) => {
    if (source.length < length) return NaN;
    const values = source.slice(-length);
    switch (type) {
        case 'SMA': return sma({ period: length, values: values }).at(-1);
        case 'EMA': return ema({ period: length, values: values }).at(-1);
        case 'WMA': return wma({ period: length, values: values }).at(-1);
        case 'RMA': return rma({ period: length, values: values }).at(-1);
        case 'HMA':
            const wma1_vals = source.slice(-Math.round(length / 2));
            const wma1 = wma({ period: Math.round(length / 2), values: wma1_vals }).at(-1);
            const wma2 = wma({ period: length, values: source.slice(-length) }).at(-1);
            if (isNaN(wma1) || isNaN(wma2)) return NaN;
            const wmaDiff = wma1 * 2 - wma2;
            return wma({ period: Math.round(Math.sqrt(length)), values: [wmaDiff] }).at(-1);
        case 'Kijun v2':
            const kijun = (getLowest(values.map(b => b.low)) + getHighest(values.map(b => b.high))) / 2;
            const conversion = (getLowest(values.slice(-Math.max(1, Math.floor(length / k))).map(b => b.low)) + getHighest(values.slice(-Math.max(1, Math.floor(length / k))).map(b => b.high))) / 2;
            return (kijun + conversion) / 2;
        default: return sma({ period: length, values: values }).at(-1);
    }
};

const atr = (klines, length, smoothing) => {
    if (klines.length < length + 1) return NaN;
    const high = klines.map(k => k.high);
    const low = klines.map(k => k.low);
    const close = klines.map(k => k.close);
    const tr = [];
    for (let i = 1; i < klines.length; i++) {
        tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    }
    const trueRange = tr;
    const values = trueRange.slice(-length);
    switch (smoothing) {
        case 'RMA': return rma({ period: length, values: values }).at(-1);
        case 'SMA': return sma({ period: length, values: values }).at(-1);
        case 'EMA': return ema({ period: length, values: values }).at(-1);
        case 'WMA': return wma({ period: length, values: values }).at(-1);
        default: return sma({ period: length, values: values }).at(-1);
    }
};

const crossover = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    const s1Prev = Array.isArray(series1) ? series1.at(-2) : series1;
    const s2Prev = Array.isArray(series2) ? series2.at(-2) : series2;
    const s1Curr = Array.isArray(series1) ? series1.at(-1) : series1;
    const s2Curr = Array.isArray(series2) ? series2.at(-1) : series2;
    return s1Prev <= s2Prev && s1Curr > s2Curr;
};

const crossunder = (series1, series2) => {
    if (series1.length < 2 || series2.length < 2) return false;
    const s1Prev = Array.isArray(series1) ? series1.at(-2) : series1;
    const s2Prev = Array.isArray(series2) ? series2.at(-2) : series2;
    const s1Curr = Array.isArray(series1) ? series1.at(-1) : series1;
    const s2Curr = Array.isArray(series2) ? series2.at(-1) : series2;
    return s1Prev >= s2Prev && s1Curr < s2Curr;
};

// =========================================================================================
// STRATEJI SINIFI (Pine Script mantığını yönetir)
// =========================================================================================
class SSLHybridStrategy {
    constructor(cfg) {
        this.cfg = cfg;
        this.klines = [];
        this.position = 'none';
        this.lastHlv = 0;
        this.lastSSL1Line = NaN;
        this.entryPrice = NaN;
        this.longProfit = 0;
        this.shortProfit = 0;
    }

    onNewBar(newBar) {
        this.klines.push(newBar);
        if (this.klines.length > this.cfg.LEN * 2) {
            this.klines.shift();
        }

        if (this.klines.length < this.cfg.LEN) {
            return { buy: false, sell: false, signalType: 'none' };
        }

        return this.computeSignals();
    }

    computeSignals() {
        const closePrices = this.klines.map(k => k.close);
        const highPrices = this.klines.map(k => k.high);
        const lowPrices = this.klines.map(k => k.low);

        const lastClose = closePrices.at(-1);

        const baseline = movingAverage(closePrices, this.cfg.LEN, this.cfg.MA_TYPE, this.cfg.KIDIV);
        const atrValue = atr(this.klines, this.cfg.ATR_LEN, this.cfg.ATR_SMOOTHING);

        const bbmcUpperATR = baseline + atrValue * this.cfg.ATR_MULT;
        const bbmcLowerATR = baseline - atrValue * this.cfg.ATR_MULT;

        const ssl1EmaHigh = movingAverage(highPrices, this.cfg.LEN, this.cfg.MA_TYPE, this.cfg.KIDIV);
        const ssl1EmaLow = movingAverage(lowPrices, this.cfg.LEN, this.cfg.MA_TYPE, this.cfg.KIDIV);

        const currentHlv = lastClose > ssl1EmaHigh ? 1 : lastClose < ssl1EmaLow ? -1 : this.lastHlv;
        const ssl1Line = currentHlv < 0 ? ssl1EmaHigh : ssl1EmaLow;

        this.lastHlv = currentHlv;

        let buySignal = false;
        let sellSignal = false;

        if (this.cfg.ENTRY_SIGNAL_TYPE === "BBMC+ATR Bands") {
            const consecutiveClosesAbove = closePrices.slice(-this.cfg.M_BARS_BUY).every(c => c > bbmcUpperATR);
            const consecutiveClosesBelow = closePrices.slice(-this.cfg.N_BARS_SELL).every(c => c < bbmcLowerATR);
            buySignal = consecutiveClosesAbove;
            sellSignal = consecutiveClosesBelow;
        } else if (this.cfg.ENTRY_SIGNAL_TYPE === "SSL1 Kesişimi") {
            buySignal = crossover(closePrices, [this.lastSSL1Line, ssl1Line]);
            sellSignal = crossunder(closePrices, [this.lastSSL1Line, ssl1Line]);
        }
        this.lastSSL1Line = ssl1Line;

        return {
            buy: buySignal,
            sell: sellSignal
        };
    }
    
    // İşlem takibi ve PnL hesaplaması
    handlePosition(newBar, signal) {
        const lastPrice = newBar.close;
        let pnl = 0;
        let message = '';

        if (signal.buy && this.position !== 'long') {
            if (this.position === 'short') {
                pnl = (this.entryPrice - lastPrice) * (this.cfg.INITIAL_CAPITAL / this.entryPrice);
                this.shortProfit += pnl;
                message = `Pozisyon kapatıldı: SELL -> BUY. Kar/Zarar: ${pnl.toFixed(2)} USDT. Toplam Net Kar: ${(this.longProfit + this.shortProfit).toFixed(2)} USDT.`;
            }
            this.position = 'long';
            this.entryPrice = lastPrice;
            console.log(`LONG pozisyon açıldı. Giriş Fiyatı: ${this.entryPrice}`);
            message = `${message} AL sinyali geldi! Yeni LONG pozisyon açılıyor.`;
        } else if (signal.sell && this.position !== 'short') {
            if (this.position === 'long') {
                pnl = (lastPrice - this.entryPrice) * (this.cfg.INITIAL_CAPITAL / this.entryPrice);
                this.longProfit += pnl;
                message = `Pozisyon kapatıldı: BUY -> SELL. Kar/Zarar: ${pnl.toFixed(2)} USDT. Toplam Net Kar: ${(this.longProfit + this.shortProfit).toFixed(2)} USDT.`;
            }
            this.position = 'short';
            this.entryPrice = lastPrice;
            console.log(`SHORT pozisyon açıldı. Giriş Fiyatı: ${this.entryPrice}`);
            message = `${message} SAT sinyali geldi! Yeni SHORT pozisyon açılıyor.`;
        }

        return message;
    }
}

// =========================================================================================
// ANA SUNUCU VE BOT MANTIĞI
// =========================================================================================
const client = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY,
});

async function sendTelegramMessage(token, chatId, message) {
    if (!token || !chatId || !message.trim()) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message
            })
        });
    } catch (error) {
        console.error('Telegram mesajı gönderilirken hata:', error);
    }
}

async function placeOrder(side) {
    // Bu kısım, %100 sermaye ile işlem yapacak şekilde ayarlandı
    const quantity = (CFG.INITIAL_CAPITAL / CFG.klines.at(-1).close).toFixed(3);
    console.log(`Piyasa emri veriliyor: ${side} ${quantity} ${CFG.SYMBOL}`);
    // Binance API ile gerçek emir gönderme
    try {
        const order = await client.order({
            symbol: CFG.SYMBOL,
            side: side,
            quantity: quantity,
            type: 'MARKET'
        });
        console.log(`${side} emri başarıyla verildi:`, order);
        return order;
    } catch (error) {
        console.error('Emir verilirken hata:', error);
        return null;
    }
}

// Strateji sınıfını başlatıyoruz
const strategy = new SSLHybridStrategy(CFG);
let lastTelegramMessage = '';

// Başlangıçta geçmiş mum verilerini çek
const fetchInitialData = async () => {
    try {
        const klines = await client.candles({ symbol: CFG.SYMBOL, interval: CFG.INTERVAL, limit: 500 });
        klines.forEach(kline => {
            const newBar = {
                open: parseFloat(kline.open),
                high: parseFloat(kline.high),
                low: parseFloat(kline.low),
                close: parseFloat(kline.close),
                volume: parseFloat(kline.volume),
                closeTime: kline.closeTime
            };
            strategy.klines.push(newBar);
        });
        console.log(`✅ ${strategy.klines.length} geçmiş mum verisi başarıyla yüklendi.`);
    } catch (error) {
        console.error('Geçmiş veri çekilirken hata:', error);
        // Hata durumunda bile botun devam etmesi için boş bir dizi ile devam et
        strategy.klines = [];
    }
};

// WebSocket bağlantısı ve ana mantık
const startBot = async () => {
    await fetchInitialData();
    
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

    ws.on('open', () => {
        console.log('✅ WebSocket bağlantısı kuruldu.');
    });

    ws.on('message', async (data) => {
        const event = JSON.parse(data);
        const kline = event.k;
        if (kline.x) { // Mum kapanışı
            const newBar = {
                open: parseFloat(kline.o),
                high: parseFloat(kline.h),
                low: parseFloat(kline.l),
                close: parseFloat(kline.c),
                volume: parseFloat(kline.v),
                closeTime: kline.T
            };

            const signals = strategy.onNewBar(newBar);
            const telegramMessage = strategy.handlePosition(newBar, signals);
            
            if (telegramMessage) {
                sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, telegramMessage);
            }

            if (signals.buy && strategy.position === 'long') {
                await placeOrder('BUY');
            } else if (signals.sell && strategy.position === 'short') {
                await placeOrder('SELL');
            }
        }
    });

    ws.on('close', () => {
        console.log('❌ WebSocket bağlantısı kesildi. 5 saniye sonra tekrar deneniyor...');
        setTimeout(() => startBot(), 5000);
    });

    ws.on('error', (error) => {
        console.error('WebSocket hatası:', error.message);
    });
};

startBot();

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});

