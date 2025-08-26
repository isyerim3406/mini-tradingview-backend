import { WebSocket } from 'ws';
import { sendTelegramMessage } from './telegram.js';
import dotenv from 'dotenv';
import http from 'http';
import axios from 'axios';
import { computeSignals } from './strategy.js';

dotenv.config();

const CFG = {
  SYMBOL: process.env.SYMBOL || 'ETHUSDT',
  INTERVAL: process.env.INTERVAL || '3m',
  TG_TOKEN: process.env.TG_TOKEN,
  TG_CHAT_ID: process.env.TG_CHAT_ID,
  ENTRY_SIGNAL_TYPE: process.env.ENTRY_SIGNAL_TYPE || 'BBMC_ATR',
  SSL1LEN: parseInt(process.env.LEN) || 164,
  ATR_LEN: parseInt(process.env.ATR_LEN) || 14,
  ATR_SMOOTHING: process.env.ATR_SMOOTHING || 'SMA',
  ATR_MULT: parseFloat(process.env.ATR_MULT) || 3.2,
  MA_TYPE: process.env.MA_TYPE || 'SMA',
  BASELINE_SOURCE: process.env.BASELINE_SOURCE || 'close',
  KIDIV: parseInt(process.env.KIDIV) || 1,
  M_BARS_BUY: parseInt(process. процесс.env.M_BARS_BUY) || 1,
  N_BARS_SELL: parseInt(process.env.N_BARS_SELL) || 3,
  USE_SL_LONG: process.env.USE_SL_LONG === 'true',
  SL_LONG_PCT: parseFloat(process.env.SL_LONG_PCT) || 2.0,
  SL_LONG_ACT_BARS: parseInt(process.env.SL_LONG_ACT_BARS) || 1,
  USE_SL_SHORT: process.env.USE_SL_SHORT === 'true',
  SL_SHORT_PCT: parseFloat(process.env.SL_SHORT_PCT) || 2.0,
  SL_SHORT_ACT_BARS: parseInt(process.env.SL_SHORT_ACT_BARS) || 1,
};

const marketData = [];
let lastTelegramMessage = '';
let ws;
let reconnectTimeout = null;

let currentPosition = null;
let entryPrice = null;
let entryBarIndex = null;
let isFirstRun = true;

const getTurkishTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul' });
};

const getTurkishDateTime = (timestamp) => {
    return new Date(timestamp).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
};

function findLastHistoricalSignal(klines) {
  let lastSignal = null;
  let lastSignalTime = null;

  for (let i = 1; i < klines.length; i++) {
    const subset = klines.slice(0, i + 1);
    const signals = computeSignals(subset, CFG);

    if (signals && signals.buy) {
      lastSignal = 'BUY';
      lastSignalTime = getTurkishDateTime(klines[i].closeTime);
    } else if (signals && signals.sell) {
      lastSignal = 'SELL';
      lastSignalTime = getTurkishDateTime(klines[i].closeTime);
    }
  }

  return { signal: lastSignal, time: lastSignalTime };
}


function checkStopLossAndFlip(klines) {
  if (!currentPosition) return;

  const currentBarIndex = klines.length - 1;
  const barsSinceEntry = currentBarIndex - entryBarIndex;

  const lastClose = klines[klines.length - 1].close;

  if (currentPosition === 'long' && CFG.USE_SL_LONG) {
    if (barsSinceEntry >= CFG.SL_LONG_ACT_BARS) {
      const slLongLevel = entryPrice * (1 - CFG.SL_LONG_PCT / 100.0);
      if (lastClose <= slLongLevel) {
        const time = getTurkishDateTime(new Date().getTime());
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - LONG POZISYON STOP LOSS VURDU. POZISYON SAT'A ÇEVRİLDİ. (Flip).`);
        currentPosition = 'short';
        entryPrice = lastClose;
        entryBarIndex = currentBarIndex;
        lastTelegramMessage = 'short';
        console.log('❌ Long pozisyon stop loss vurdu ve flip yapıldı.');
      }
    }
  } else if (currentPosition === 'short' && CFG.USE_SL_SHORT) {
    if (barsSinceEntry >= CFG.SL_SHORT_ACT_BARS) {
      const slShortLevel = entryPrice * (1 + CFG.SL_SHORT_PCT / 100.0);
      if (lastClose >= slShortLevel) {
        const time = getTurkishDateTime(new Date().getTime());
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - SHORT POZISYON STOP LOSS VURDU. POZISYON AL'A ÇEVRİLDİ. (Flip).`);
        currentPosition = 'long';
        entryPrice = lastClose;
        entryBarIndex = currentBarIndex;
        lastTelegramMessage = 'long';
        console.log('❌ Short pozisyon stop loss vurdu ve flip yapıldı.');
      }
    }
  }
}

async function startBot() {
  console.log(`Geçmiş veri çekiliyor: ${CFG.SYMBOL}, ${CFG.INTERVAL}`);
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${CFG.SYMBOL}&interval=${CFG.INTERVAL}&limit=1000`;
    const response = await axios.get(url);
    const klines = response.data;
    const transformedKlines = klines.map(kline => ({
        openTime: kline[0],
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
        closeTime: kline[6],
    }));

    marketData.push(...transformedKlines);

    console.log(`✅ ${marketData.length} adet geçmiş mum verisi başarıyla yüklendi.`);

    // Geçmiş veriyi incele ve son sinyali bul
    const lastSignalInfo = findLastHistoricalSignal(marketData);
    if (lastSignalInfo.signal) {
        const message = `Bot başlatıldı. Geçmiş 1000 mum incelendi. Son sinyal: **${lastSignalInfo.signal}** (${lastSignalInfo.time})`;
        console.log(`✅ Telegram'a gönderiliyor: ${message}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    } else {
        const message = `Bot başlatıldı. Geçmiş 1000 mumda sinyal bulunamadı.`;
        console.log(`✅ Telegram'a gönderiliyor: ${message}`);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    }
    

    connectWS();

  } catch (error) {
    console.error('❌ Geçmiş veri çekilirken hata oluştu:', error.message);
    console.log('Geçmiş veri çekilemedi, bot canlı akışla başlayacak...');

    const time = getTurkishDateTime(new Date().getTime());
    const message = `${time} - Bot başlatıldı ancak geçmiş veriler alınamadı. Canlı veriler bekleniyor.`;
    console.log(`✅ Telegram'a gönderiliyor: ${message}`);
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
    connectWS();
  }
}

function connectWS() {
  ws = new WebSocket(
    `wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`
  );

  ws.onopen = () => {
    console.log('✅ WebSocket connected');
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  };

  ws.onclose = () => {
    console.log('⚠️ WebSocket closed, reconnecting in 5s...');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('❌ WebSocket error:', err.message);
    ws.close();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const kline = data.k;
    if (!kline || !kline.x) return;

    // Mumun kapanış zamanını alıp yerel saate dönüştürme
    const closeTime = getTurkishTime(kline.T);

    console.log(
      `Yeni mum verisi alındı: Sembol = ${kline.s}, Periyot = ${kline.i}, Kapanış Fiyatı = ${kline.c}, Mum kapanıyor mu? = ${kline.x}`
    );
    console.log(`Güncel veri sayısı: ${marketData.length}`);

    marketData.push({
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
      volume: parseFloat(kline.v),
    });

    if (marketData.length > 1000) marketData.shift();

    const signals = computeSignals(marketData, CFG);

    checkStopLossAndFlip(marketData);

    // Her mum kapandığında durumu konsola yaz ve zamanını ekle
    if (signals) {
      if (signals.buy) {
        console.log(`🟢 [${closeTime}] Güncel durum: AL sinyali mevcut.`);
      } else if (signals.sell) {
        console.log(`🔴 [${closeTime}] Güncel durum: SAT sinyali mevcut.`);
      } else {
        console.log(`⚪ [${closeTime}] Güncel durum: Sinyal yok.`);
      }
    } else {
      console.log(`⚠️ [${closeTime}] Sinyal hesaplanamıyor.`);
    }


    if (!currentPosition) {
        if (signals && signals.buy) {
            const time = getTurkishDateTime(kline.T);
            const message = `${time} - BUY signal for ${CFG.SYMBOL}!`;
            console.log(`✅ Telegram'a gönderiliyor: ${message}`);
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
            currentPosition = 'long';
            entryPrice = kline.c;
            entryBarIndex = marketData.length - 1;
            lastTelegramMessage = 'long';
            console.log('✅ BUY signal sent!');
        } else if (signals && signals.sell) {
            const time = getTurkishDateTime(kline.T);
            const message = `${time} - SELL signal for ${CFG.SYMBOL}!`;
            console.log(`✅ Telegram'a gönderiliyor: ${message}`);
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
            currentPosition = 'short';
            entryPrice = kline.c;
            entryBarIndex = marketData.length - 1;
            lastTelegramMessage = 'short';
            console.log('✅ SELL signal sent!');
        }
    }
    
    console.log(`Güncel pozisyon durumu: ${currentPosition ? currentPosition.toUpperCase() : 'Yok'}`);
  };
}

function scheduleReconnect() {
  if (reconnectTimeout) return;
  reconnectTimeout = setTimeout(() => {
    console.log('🔄 Trying to reconnect...');
    connectWS();
  }, 5000);
}

startBot();

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Websocket client is running...\n');
}).listen(port, () => console.log(`Server running on port ${port}`));
