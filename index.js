import { WebSocket, WebSocketServer } from 'ws';
import { computeSignals } from './strategy.js';
import { sendTelegramMessage } from './telegram.js';
import dotenv from 'dotenv';

dotenv.config();

const CFG = {
    SYMBOL: process.env.SYMBOL || 'BTCUSDT',
    INTERVAL: process.env.INTERVAL || '3m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    ENTRY_SIGNAL_TYPE: process.env.ENTRY_SIGNAL_TYPE || 'BBMC_ATR',
    SSL1LEN: parseInt(process.env.LEN) || 164,
    ATR_LEN: parseInt(process.env.ATR_LEN) || 14,
    ATR_SMOOTHING: process.env.ATR_SMOOTHING || 'WMA',
    ATR_MULT: parseFloat(process.env.ATR_MULT) || 3.2,
    MA_TYPE: process.env.MA_TYPE || 'HMA',
    BASELINE_SOURCE: process.env.BASELINE_SOURCE || 'close',
    KIDIV: parseInt(process.env.KIDIV) || 1,
    M_BARS_BUY: parseInt(process.env.M_BARS_BUY) || 1,
    N_BARS_SELL: parseInt(process.env.N_BARS_SELL) || 1,
};

const URL = `wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`;
const klines = [];
const MAX_KLINES = 200;

let ws;

function createWebSocket() {
    ws = new WebSocket(URL);
    
    ws.onopen = () => {
        console.log('WS open');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const klineData = data.k;

            if (klineData.x) { // Kline'ın kapandığı anlamına gelir
                klines.push({
                    open: parseFloat(klineData.o),
                    high: parseFloat(klineData.h),
                    low: parseFloat(klineData.l),
                    close: parseFloat(klineData.c),
                    volume: parseFloat(klineData.v),
                    time: klineData.T,
                });
                
                if (klines.length > MAX_KLINES) {
                    klines.shift();
                }

                if (klines.length > CFG.SSL1LEN + CFG.ATR_LEN) {
                    const signals = computeSignals(klines, CFG);

                    if (signals.buy) {
                        const message = `🟢 AL sinyali!\n${CFG.SYMBOL} - ${CFG.INTERVAL}`;
                        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
                        console.log('Buy signal sent!');
                    }

                    if (signals.sell) {
                        const message = `🔴 SAT sinyali!\n${CFG.SYMBOL} - ${CFG.INTERVAL}`;
                        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, message);
                        console.log('Sell signal sent!');
                    }
                }
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    };

    ws.onclose = () => {
        console.log('WS closed. Reconnecting...');
        setTimeout(createWebSocket, 5000); // 5 saniye sonra tekrar bağlan
    };

    ws.onerror = (err) => {
        console.error('WS error:', err);
    };
}

createWebSocket();