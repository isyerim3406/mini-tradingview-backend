import WebSocket from 'ws';
import { computeSignals } from './strategy.js';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Binance from 'binance-api-node'; // ✅ Correct import

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// All CFG parameters are moved to strategy.js for better modularity
// We will now pass the CFG object to computeSignals.
const CFG = {
    SYMBOL: process.env.SYMBOL || 'ETHUSDT',
    INTERVAL: process.env.INTERVAL || '1m',
    TG_TOKEN: process.env.TG_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID,
    BINANCE_API_KEY: process.env.BINANCE_API_KEY,
    BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY,
    TRADE_SIZE: 0.001,
    // Stop-loss and strategy parameters
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
    KIDIV: 1,
    ENTRY_SIGNAL_TYPE: 'BBMC+ATR Bands',
    M_BARS_BUY: 1,
    N_BARS_SELL: 3
};

// ✅ Initialize Binance API client
const client = Binance({
    apiKey: CFG.BINANCE_API_KEY,
    apiSecret: CFG.BINANCE_SECRET_KEY,
});

// Position status and entry price/bar info
let position = 'none';
let longEntryPrice = null;
let longEntryBarIndex = null;
let shortEntryPrice = null;
let shortEntryBarIndex = null;

let klines = [];
let lastTelegramMessage = '';

async function sendTelegramMessage(token, chatId, message) {
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message })
        });
        console.log("✅ Telegram message sent successfully.");
    } catch (err) {
        console.error("❌ Failed to send Telegram message:", err.message);
    }
}

async function getFuturesBalance(symbol) {
    try {
        const balances = await client.futuresAccountBalance();
        const asset = balances.find(b => b.asset === symbol);
        if (asset) {
            return parseFloat(asset.availableBalance);
        }
        return 0;
    } catch (error) {
        console.error('❌ Error fetching balance:', error.body);
        return 0;
    }
}

async function placeOrder(side, message) {
    try {
        // Fetch available balance dynamically
        const balance = await getFuturesBalance('USDT'); // Assuming USDT as base currency
        if (balance <= 0) {
            console.log('❌ Insufficient balance to place order.');
            sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `❌ Emir verilemedi: Yetersiz bakiye.`);
            return;
        }

        // Use the entire available balance for the trade
        // Note: The quantity needs to be calculated based on the price of the asset
        // This is a simplified example, you may need to handle lot size and precision
        const marketPrice = klines.at(-1).close;
        const quantity = balance / marketPrice;

        console.log(`🤖 Placing order: ${side} ${quantity} ${CFG.SYMBOL} - Message: ${message}`);
        const order = await client.futuresOrder({
            symbol: CFG.SYMBOL,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantity,
        });

        console.log(`✅ Order placed successfully: ID: ${order.orderId}, Price: ${order.avgPrice}`);
        
        // Update position and entry data
        const currentBarIndex = klines.length - 1;
        if (side === 'BUY') {
            position = 'long';
            longEntryPrice = klines[currentBarIndex].close;
            longEntryBarIndex = currentBarIndex;
            shortEntryPrice = null;
            shortEntryBarIndex = null;
        } else if (side === 'SELL') {
            position = 'short';
            shortEntryPrice = klines[currentBarIndex].close;
            shortEntryBarIndex = currentBarIndex;
            longEntryPrice = null;
            longEntryBarIndex = null;
        } else if (side === 'CLOSE') {
            position = 'none';
            longEntryPrice = null;
            longEntryBarIndex = null;
            shortEntryPrice = null;
            shortEntryBarIndex = null;
        }

        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `📊 ${message}`);
    } catch (error) {
        console.error('❌ Error placing order:', error.body);
        sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `❌ Order Error: ${error.message}`);
    }
}

async function fetchHistoricalData() {
    console.log(`Fetching historical data: ${CFG.SYMBOL}, ${CFG.INTERVAL}`);
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${CFG.SYMBOL}&interval=${CFG.INTERVAL}&limit=1000`);
        const data = await response.json();
        klines = data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: d[6]
        }));
        console.log(`✅ ${klines.length} historical candle data successfully loaded.`);
    } catch (error) {
        console.error('❌ Error fetching historical data:', error.message);
        klines = [];
    }
}

async function processData() {
    console.log(`Processing historical data...`);
    
    let lastNonNeutralSignal = null;
    let signalCount = 0;
    
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN)) {
        console.log("Insufficient historical data, minimum bar count for processing not reached.");
        return;
    }

    let currentPosition = 'none';
    let currentLongEntryPrice = null;
    let currentLongEntryBarIndex = null;
    let currentShortEntryPrice = null;
    let currentShortEntryBarIndex = null;
    
    for (let i = 0; i < klines.length; i++) {
        const subKlines = klines.slice(0, i + 1);
        const signal = computeSignals(subKlines, CFG, currentPosition, currentLongEntryPrice, currentLongEntryBarIndex, currentShortEntryPrice, currentShortEntryBarIndex);
        
        if (signal.type !== 'none') {
            signalCount++;
            lastNonNeutralSignal = `Last signal: ${signal.type.toUpperCase()} - ${signal.message}`;
        }
        
        // Simulation position update
        if (signal.type === 'buy' || signal.type === 'flip_long') {
            currentPosition = 'long';
            currentLongEntryPrice = subKlines.at(-1).close;
            currentLongEntryBarIndex = i;
            currentShortEntryPrice = null;
            currentShortEntryBarIndex = null;
        } else if (signal.type === 'sell' || signal.type === 'flip_short') {
            currentPosition = 'short';
            currentShortEntryPrice = subKlines.at(-1).close;
            currentShortEntryBarIndex = i;
            currentLongEntryPrice = null;
            currentLongEntryBarIndex = null;
        } else if (signal.type === 'close') {
            currentPosition = 'none';
            currentLongEntryPrice = null;
            currentLongEntryBarIndex = null;
            currentShortEntryPrice = null;
            currentShortEntryBarIndex = null;
        }
    }

    console.log(`✅ Historical data processed. Total Signals: ${signalCount}, Last Signal: ${lastNonNeutralSignal || 'Neutral'}`);
    sendTelegramMessage(CFG.TG_TOKEN, CFG.TG_CHAT_ID, `Bot successfully started. Historical data loaded. Total ${signalCount} signals found.`);
}

const ws = new WebSocket(`wss://fstream.binance.com/ws/${CFG.SYMBOL.toLowerCase()}@kline_${CFG.INTERVAL}`);

ws.on('open', () => {
    console.log('✅ WebSocket connection opened.');
    fetchHistoricalData().then(() => {
        if (klines.length > 0) {
            processData();
        }
    });
});

ws.on('message', async (data) => {
    const klineData = JSON.parse(data.toString());
    const kline = klineData.k;

    // When the candle closes
    if (kline.x) {
        const newBar = {
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            closeTime: kline.T
        };
        
        // Add the newest bar and remove the oldest
        klines.push(newBar);
        if (klines.length > 1000) {
            klines.shift();
        }

        // Calculate the new signal, passing position data as well
        const signal = computeSignals(klines, CFG, position, longEntryPrice, longEntryBarIndex, shortEntryPrice, shortEntryBarIndex);

        const barIndex = klines.length - 1;
        const barTime = new Date(newBar.closeTime).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
        console.log(`New candle data received. Bar No: ${barIndex + 1}, Time: ${barTime}, Closing Price: ${newBar.close}`);
        
        // Act based on the signal
        if (signal.type !== 'none') {
            switch (signal.type) {
                case 'buy':
                case 'flip_long':
                    if (position === 'none' || position === 'short') {
                        placeOrder('BUY', signal.message);
                    }
                    break;
                case 'sell':
                case 'flip_short':
                    if (position === 'none' || position === 'long') {
                        placeOrder('SELL', signal.message);
                    }
                    break;
                case 'close':
                    if (position !== 'none') {
                        // Close position based on current position
                        placeOrder(position === 'long' ? 'SELL' : 'BUY', signal.message);
                    }
                    break;
            }
        }
    }
});

ws.on('close', () => {
    console.log('❌ WebSocket connection closed. Reconnecting...');
    setTimeout(() => {
        // Reconnection function can go here
    }, 5000);
});

ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
});

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`✅ Server listening at http://localhost:${PORT}`);
});
