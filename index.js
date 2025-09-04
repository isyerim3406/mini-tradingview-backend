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
  LEN: 164,               // ana ortalama uzunluğu
  ATR_LEN: 14,
  ATR_MULT: 3.2,
  ATR_SMOOTHING: 'SMA',
  MA_TYPE: 'SMA',         // bu sürümde SMA kullanıyoruz
  BASELINE_SOURCE: 'close',
  ENTRY_SIGNAL_TYPE: 'SMA Cross',
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
  BOT_NAME: 'SSHL Strategy JS'
};

// =========================================================================================
/** GLOBAL STATE */
// =========================================================================================
let botCurrentPosition = 'none';
let klines = []; // {open, high, low, close, closeTime}
let longEntryPrice = null;
let longEntryBarIndex = -1;
let shortEntryPrice = null;
let shortEntryBarIndex = -1;
let totalNetProfit = 0;
let isBotInitialized = false;

const isSimulationMode = !process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY;

const mockBinanceClient = {
  futuresAccountBalance: async () => [{ asset: 'USDT', availableBalance: '1000' }],
  futuresMarketOrder: async ({ side, quantity }) => {
    console.log(`[SİMÜLASYON] ${side} emri başarıyla oluşturuldu: ${quantity}`);
    return { status: 'FILLED' };
  },
  candles: async ({ symbol, interval, limit }) => {
    const mockCandles = [];
    let price = 4300;
    let now = Date.now();
    const stepMs =
      interval.endsWith('m') ? parseInt(interval) * 60 * 1000 :
      interval.endsWith('h') ? parseInt(interval) * 60 * 60 * 1000 :
      60 * 1000;
    for (let i = 0; i < limit; i++) {
      const open = price;
      const close = open + (Math.random() - 0.5) * 10;
      const high = Math.max(open, close) + Math.random() * 3;
      const low = Math.min(open, close) - Math.random() * 3;
      mockCandles.push({
        open: open.toFixed(2),
        high: high.toFixed(2),
        low: low.toFixed(2),
        close: close.toFixed(2),
        closeTime: now - (limit - i) * stepMs,
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

const binanceClient = isSimulationMode ? mockBinanceClient : Binance({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_SECRET_KEY,
  test: CFG.IS_TESTNET,
});

// =========================================================================================
// TELEGRAM
// =========================================================================================
async function sendTelegramMessage(text) {
  if (!CFG.TG_TOKEN || !CFG.TG_CHAT_ID) return;
  const telegramApiUrl = `https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`;
  const payload = { chat_id: CFG.TG_CHAT_ID, text, parse_mode: 'Markdown' };
  try {
    await fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('Telegram mesajı gönderilemedi:', error);
  }
}

// =========================================================================================
// INDICATORS (SMA, ATR) — basit ve sağlam
// =========================================================================================
function sma(arr, len) {
  if (arr.length < len) return null;
  let sum = 0;
  for (let i = arr.length - len; i < arr.length; i++) sum += arr[i];
  return sum / len;
}

function trueRange(h, l, prevClose) {
  if (prevClose == null) return h - l;
  const tr1 = h - l;
  const tr2 = Math.abs(h - prevClose);
  const tr3 = Math.abs(l - prevClose);
  return Math.max(tr1, tr2, tr3);
}

function atrFromKlines(kl, len) {
  if (kl.length < len + 1) return null;
  const start = kl.length - len;
  let trs = 0;
  for (let i = start; i < kl.length; i++) {
    const prevClose = kl[i - 1]?.close ?? kl[i].close;
    trs += trueRange(kl[i].high, kl[i].low, prevClose);
  }
  return trs / len;
}

// =========================================================================================
// MAIN STRATEGY (computeSignals) — basit SMA cross + ATR filtre
// =========================================================================================
function computeSignals() {
  // close serisini al
  const closes = klines.map(k => k.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  const baseNow = sma(closes, CFG.LEN);
  const basePrev = closes.length > CFG.LEN ? sma(closes.slice(0, -1), CFG.LEN) : null;

  if (baseNow == null || basePrev == null || prev == null) {
    return { type: 'none', message: '' };
  }

  // ATR filtrasyonu (isteğe bağlı)
  const atr = atrFromKlines(klines, CFG.ATR_LEN);
  let atrOk = true;
  if (atr != null) {
    // basit bir volatilite eşiği: ATR fiyatın %0.05'inden büyükse trade et (örnek)
    atrOk = atr > last * 0.0005;
  }

  let signal = { type: 'none', message: '' };

  // cross up: close(prev)<=base(prev) & close(now)>base(now)
  if (prev <= basePrev && last > baseNow && atrOk) {
    signal = { type: 'buy', message: 'AL Sinyali (SMA Cross)' };
  }
  // cross down
  else if (prev >= basePrev && last < baseNow && atrOk) {
    signal = { type: 'sell', message: 'SAT Sinyali (SMA Cross)' };
  }

  return signal;
}

// =========================================================================================
// ORDER PLACEMENT & TRADING LOGIC (Telegram bildirimi)
// =========================================================================================
async function placeOrder(side, signalMessage) {
  const lastClosePrice = klines[klines.length - 1]?.close || 0;

  // Önce zıt pozisyonu kapatıp PnL yaz
  if (botCurrentPosition !== 'none' && botCurrentPosition !== side.toLowerCase()) {
    const entryPrice = botCurrentPosition === 'long' ? longEntryPrice : shortEntryPrice;
    const profit = botCurrentPosition === 'long'
      ? (lastClosePrice - entryPrice)
      : (entryPrice - lastClosePrice);
    totalNetProfit += profit;

    const profitPct = entryPrice ? ((profit / entryPrice) * 100).toFixed(2) : '0.00';
    await sendTelegramMessage(
      `📉 Pozisyon kapatıldı! ${botCurrentPosition.toUpperCase()}\n\n` +
      `Bot Adı: ${CFG.BOT_NAME}\n` +
      `Sembol: ${CFG.SYMBOL}\n` +
      `Zaman Aralığı: ${CFG.INTERVAL}\n` +
      `Kapanış Fiyatı: ${lastClosePrice}\n` +
      `Bu İşlemden K/Z: % ${profitPct} (${profit.toFixed(2)} USDT)\n` +
      `Toplam Net K/Z: ${totalNetProfit.toFixed(2)} USDT`
    );
    botCurrentPosition = 'none';
  }

  // Yeni pozisyon
  if (botCurrentPosition === 'none') {
    const currentPrice = lastClosePrice;
    const qty = (CFG.INITIAL_CAPITAL * (CFG.TRADE_SIZE_PERCENT / 100)) / Math.max(currentPrice, 1e-9);

    if (side === 'BUY') {
      botCurrentPosition = 'long';
      longEntryPrice = currentPrice;
      longEntryBarIndex = klines.length - 1;
      shortEntryPrice = null;
      shortEntryBarIndex = -1;
    } else if (side === 'SELL') {
      botCurrentPosition = 'short';
      shortEntryPrice = currentPrice;
      shortEntryBarIndex = klines.length - 1;
      longEntryPrice = null;
      longEntryBarIndex = -1;
    }

    const nowStr = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    await sendTelegramMessage(
      `🚀 ${side} Emri Gerçekleşti!\n\n` +
      `Bot Adı: ${CFG.BOT_NAME}\n` +
      `Sembol: ${CFG.SYMBOL}\n` +
      `Zaman Aralığı: ${CFG.INTERVAL}\n` +
      `Sinyal: ${signalMessage}\n` +
      `Fiyat: ${currentPrice}\n` +
      `Miktar: ${qty.toFixed(4)}\n` +
      `Zaman : ${nowStr}\n` +
      `Toplam Net K/Z: ${totalNetProfit.toFixed(2)} USDT`
    );
  }
}

// =========================================================================================
// DATA FETCH — başlangıç verisi ve “Bot Başlatıldı” mesajı
// =========================================================================================
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
      closeTime: k.closeTime
    }));

    console.log(`✅ İlk ${klines.length} mum verisi yüklendi.`);

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
  } catch (err) {
    console.error('İlk verileri çekerken hata:', err);
  }
}

// =========================================================================================
// WEBSOCKET — bar kapanışında sinyal üret
// =========================================================================================
function startWs() {
  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

  ws.on('open', () => console.log('🔌 WebSocket bağlandı.'));
  ws.on('close', () => {
    console.log('❌ WebSocket kapandı. 5s sonra yeniden bağlanıyor...');
    setTimeout(startWs, 5000);
  });
  ws.on('error', (e) => console.error('WebSocket hatası:', e.message));

  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    const k = data.k;
    if (!k) return;

    // sadece bar kapandığında
    if (k.x) {
      const bar = {
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        closeTime: k.T
      };
      klines.push(bar);
      if (klines.length > 1200) klines.shift();

      const tsStr = new Date(bar.closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
      console.log(`🕒 Yeni bar alındı | ${CFG.SYMBOL} ${CFG.INTERVAL} | close=${bar.close} | ${tsStr}`);

      const sig = computeSignals();
      if (sig.type === 'buy' && botCurrentPosition !== 'long') {
        await placeOrder('BUY', sig.message);
      } else if (sig.type === 'sell' && botCurrentPosition !== 'short') {
        await placeOrder('SELL', sig.message);
      }
    }
  });
}

// =========================================================================================
// SERVER
// =========================================================================================
app.get('/', (req, res) => {
  const last = klines[klines.length - 1];
  res.json({
    bot: CFG.BOT_NAME,
    mode: isSimulationMode ? 'simulation' : 'live',
    symbol: CFG.SYMBOL,
    interval: CFG.INTERVAL,
    pos: botCurrentPosition,
    lastClose: last?.close ?? null,
    netPnL: Number(totalNetProfit.toFixed(2)),
    bars: klines.length
  });
});

app.listen(PORT, async () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
  await fetchInitialData();
  startWs();
});
