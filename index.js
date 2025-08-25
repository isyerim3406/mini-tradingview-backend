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
  SYMBOL: process.env.SYMBOL || 'BTCUSDT',
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
    case 'SMA':
      return calculateSMA(source, len);
    case 'EMA':
      return calculateEMA(source, len);
    case 'DEMA':
      return calculateDEMA(source, len);
    case 'TEMA':
      return calculateTEMA(source, len);
    case 'LSMA':
      return calculateLSMA(source, len);
    case 'WMA':
      return calculateWMA(source, len);
    case 'TMA':
      return calculateTMA(source, len);
    case 'HMA':
      return calculateHMA(source, len);
    case 'KIJUN2':
      return calculateKiJun(source, len, CFG.KIDIV);
    case 'MCGINLEY':
      return McGinley(source, len);
    default:
      return null;
  }
};

function getAtr(source, len) {
  let trs = [];
  let atrs = [];

  for (let i = 1; i < source.length; i++) {
    let tr = Math.max(
      source[i].high - source[i].low,
      Math.abs(source[i].high - source[i - 1].close),
      Math.abs(source[i].low - source[i - 1].close)
    );
    trs.push(tr);
  }

  if (CFG.ATR_SMOOTHING === 'RMA') {
    atrs = calculateRMA(trs, len);
  } else if (CFG.ATR_SMOOTHING === 'EMA') {
    atrs = calculateEMA(trs, len);
  } else if (CFG.ATR_SMOOTHING === 'WMA') {
    atrs = calculateWMA(trs, len);
  } else {
    atrs = calculateSMA(trs, len);
  }

  return atrs;
}

function getSsl(source, len) {
  const ma = getIndicator(source, len);
  if (!ma) return;
  const hlv = [];
  for (let i = 0; i < ma.length; i++) {
    if (i === 0) {
      hlv.push(1);
    } else {
      hlv.push(ma[i] > ma[i - 1] ? 1 : -1);
    }
  }

  return hlv;
}

const getAtrMultiplier = () => {
  let m = 0;
  if (CFG.ENTRY_SIGNAL_TYPE === 'BBMC_ATR') {
    m = CFG.ATR_MULT;
  }
  return m;
};

const getSslSignal = () => {
  const hlv = getSsl(marketData, CFG.SSL1LEN);
  if (!hlv) return;
  const isBuySignal = hlv[hlv.length - 1] === 1 && hlv[hlv.length - 2] === -1;
  const isSellSignal = hlv[hlv.length - 1] === -1 && hlv[hlv.length - 2] === 1;

  if (isBuySignal) return 'buy';
  if (isSellSignal) return 'sell';

  return null;
};

const getBbmcATR = () => {
  const ma = getIndicator(marketData, CFG.SSL1LEN);
  if (!ma) return;

  const atr = getAtr(marketData, CFG.ATR_LEN);
  const up = [];
  const down = [];
  for (let i = 0; i < ma.length; i++) {
    up.push(ma[i] + atr[i] * CFG.ATR_MULT);
    down.push(ma[i] - atr[i] * CFG.ATR_MULT);
  }

  let buySignal = false;
  let sellSignal = false;
  let buyCount = 0;
  let sellCount = 0;

  for (let i = marketData.length - CFG.M_BARS_BUY; i < marketData.length; i++) {
    if (marketData[i].close > up[i]) {
      buyCount++;
    }
  }

  for (
    let i = marketData.length - CFG.N_BARS_SELL;
    i < marketData.length;
    i++
  ) {
    if (marketData[i].close < down[i]) {
      sellCount++;
    }
  }

  if (buyCount >= CFG.M_BARS_BUY) buySignal = true;
  if (sellCount >= CFG.N_BARS_SELL) sellSignal = true;

  if (buySignal) return 'buy';
  if (sellSignal) return 'sell';
};

const getSignal = () => {
  if (CFG.ENTRY_SIGNAL_TYPE === 'BBMC_ATR') {
    return getBbmcATR();
  }
  if (CFG.ENTRY_SIGNAL_TYPE === 'SSL1') {
    return getSslSignal();
  }
  return null;
};

const ws = new WebSocket(
  `wss://stream.binance.com:9443/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`
);

ws.onopen = () => {
  console.log('WS open');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  const kline = data.k;

  if (kline.x) {
    marketData.push({
      open: parseFloat(kline.o),
      high: parseFloat(kline.h),
      low: parseFloat(kline.l),
      close: parseFloat(kline.c),
      volume: parseFloat(kline.v),
    });

    if (marketData.length > 200) {
      marketData.shift();
    }

    const signal = getSignal();
    const time = new Date().toLocaleString();

    if (signal === 'buy' && lastTelegramMessage !== 'buy') {
      sendTelegramMessage(
        CFG.TG_TOKEN,
        CFG.TG_CHAT_ID,
        `${time} - BUY signal for ${CFG.SYMBOL} on ${CFG.INTERVAL} timeframe!`
      );
      lastTelegramMessage = 'buy';
      console.log('BUY signal sent!');
    } else if (signal === 'sell' && lastTelegramMessage !== 'sell') {
      sendTelegramMessage(
        CFG.TG_TOKEN,
        CFG.TG_CHAT_ID,
        `${time} - SELL signal for ${CFG.SYMBOL} on ${CFG.INTERVAL} timeframe!`
      );
      lastTelegramMessage = 'sell';
      console.log('SELL signal sent!');
    }
  }
};

ws.onclose = () => {
  console.log('WS closed');
};

const port = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Websocket client is running...\n');
  })
  .listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });