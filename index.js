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
  M_BARS_BUY: parseInt(process.env.M_BARS_BUY) || 1,
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

function checkStopLossAndFlip(klines) {
  if (!currentPosition) return;

  const currentBarIndex = klines.length - 1;
  const barsSinceEntry = currentBarIndex - entryBarIndex;

  const lastClose = klines[klines.length - 1].close;

  if (currentPosition === 'long' && CFG.USE_SL_LONG) {
    if (barsSinceEntry >= CFG.SL_LONG_ACT_BARS) {
      const slLongLevel = entryPrice * (1 - CFG.SL_LONG_PCT / 100.0);
      if (lastClose <= slLongLevel) {
        const time = new Date().toLocaleString();
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
        const time = new Date().toLocaleString();
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

    klines.forEach(kline => {
      marketData.push({
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
      });
    });

    console.log(`✅ ${marketData.length} adet geçmiş mum verisi başarıyla yüklendi.`);

    // Bot başladığında anlık durumu kontrol et ve Telegram'a gönder
    const signals = computeSignals(marketData, CFG);
    const time = new Date().toLocaleString();
    let statusMessage = `${time} - Bot başlatıldı. Güncel durum: `;

    if (signals) {
      if (signals.buy) {
        statusMessage += `Alış sinyali mevcut.`;
      } else if (signals.sell) {
        statusMessage += `Satış sinyali mevcut.`;
      } else {
        statusMessage += `Sinyal yok.`;
      }
    } else {
      statusMessage += `Sinyal hesaplanamadı.`;
    }
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, statusMessage);


    connectWS();

  } catch (error) {
    console.error('❌ Geçmiş veri çekilirken hata oluştu:', error.message);
    console.log('Geçmiş veri çekilemedi, bot canlı akışla başlayacak...');
    
    // Geçmiş veri çekilemezse bile botu başlat ve durumu bildir
    const time = new Date().toLocaleString();
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - Bot başlatıldı ancak geçmiş veriler alınamadı. Canlı veriler bekleniyor.`);
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

    if (!currentPosition) {
        if (signals && signals.buy) {
            const time = new Date().toLocaleString();
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - BUY signal for ${CFG.SYMBOL}!`);
            currentPosition = 'long';
            entryPrice = kline.c;
            entryBarIndex = marketData.length - 1;
            lastTelegramMessage = 'long';
            console.log('✅ BUY signal sent!');
        } else if (signals && signals.sell) {
            const time = new Date().toLocaleString();
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - SELL signal for ${CFG.SYMBOL}!`);
            currentPosition = 'short';
            entryPrice = kline.c;
            entryBarIndex = marketData.length - 1;
            lastTelegramMessage = 'short';
            console.log('✅ SELL signal sent!');
        }
    }
    
    console.log(`Güncel pozisyon durumu: ${currentPosition ? currentPosition.toUpperCase() : 'Yok'}`);
    console.log(`Güncel sinyal durumu: ${signals ? (signals.buy ? 'buy' : signals.sell ? 'sell' : 'null') : 'null'}`);
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
