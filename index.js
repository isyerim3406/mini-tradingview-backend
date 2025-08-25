import { WebSocket } from 'ws';
import { sendTelegramMessage } from './telegram.js';
import dotenv from 'dotenv';
import http from 'http';
import {
  calculateEMA,
  calculateSMA,
  calculateRMA,
  calculateWMA,
  calculateDEMA,
  calculateTEMA,
  calculateTMA,
  calculateHMA,
  calculateLSMA,
  calculateKiJun,
} from './indicators.js';

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
};

const marketData = [];
let lastTelegramMessage = '';

const getIndicator = (source, len) => {
  switch (CFG.MA_TYPE) {
    case 'SMA': return calculateSMA(source, len);
    case 'EMA': return calculateEMA(source, len);
    case 'DEMA': return calculateDEMA(source, len);
    case 'TEMA': return calculateTEMA(source, len);
    case 'LSMA': return calculateLSMA(source, len);
    case 'WMA': return calculateWMA(source, len);
    case 'TMA': return calculateTMA(source, len);
    case 'HMA': return calculateHMA(source, len);
    case 'KIJUN2': return calculateKiJun(source, len, CFG.KIDIV);
    default: return null;
  }
};

const getSignal = () => {
  if (CFG.ENTRY_SIGNAL_TYPE === 'BBMC_ATR') return getBbmcATR();
  if (CFG.ENTRY_SIGNAL_TYPE === 'SSL1') return getSslSignal();
  return null;
};

// 🔹 Reconnect mantığı
let ws;
let reconnectTimeout = null;

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

    marketData.push({
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
      volume: parseFloat(kline.v),
    });

    if (marketData.length > 200) marketData.shift();

    const signal = getSignal();
    const time = new Date().toLocaleString();

    if (signal === 'buy' && lastTelegramMessage !== 'buy') {
      sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - BUY signal for ${CFG.SYMBOL}!`);
      lastTelegramMessage = 'buy';
      console.log('BUY signal sent!');
    } else if (signal === 'sell' && lastTelegramMessage !== 'sell') {
      sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `${time} - SELL signal for ${CFG.SYMBOL}!`);
      lastTelegramMessage = 'sell';
      console.log('SELL signal sent!');
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimeout) return;
  reconnectTimeout = setTimeout(() => {
    console.log('🔄 Trying to reconnect...');
    connectWS();
  }, 5000); // 5 saniye sonra tekrar bağlanmayı dene
}

// Başlat
connectWS();

// Basit HTTP server, Koyeb keep-alive
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Websocket client is running...\n');
}).listen(port, () => console.log(`Server running on port ${port}`));
