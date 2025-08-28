import WebSocket from 'ws';
import { computeSignals, CFG } from './strategy.js';
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';
import Binance from 'binance-api-node'; // Correct import

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// All CFG parameters are now imported from strategy.js for better modularity
// We will now pass the CFG object to computeSignals.

// Initialize Binance API client
const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
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
        console.log("Telegram message sent successfully.");
    } catch (err) {
        console.error("Failed to send Telegram message:", err.message);
    }
}

async function placeOrder(side, message) {
    try {
        // Here you would implement your real order placement logic
        // For now, we will just simulate it by updating the position state
        console.log(`Simulating order: ${side} - Message: ${message}`);
        
        // Update position and entry data based on the simulated order
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
        } else { // This handles closing a position
            position = 'none';
            longEntryPrice = null;
            longEntryBarIndex = null;
            shortEntryPrice = null;
            shortEntryBarIndex = null;
        }

        sendTelegramMessage(process.env.TG_TOKEN, process.env.TG_CHAT_ID, `📊 ${message}`);
    } catch (error) {
        console.error('Error placing order:', error.body);
        sendTelegramMessage(process.env.TG_TOKEN, process.env.TG_CHAT_ID, `❌ Order Error: ${error.message}`);
    }
}

async function fetchHistoricalData() {
    console.log(`Fetching historical data: ${process.env.SYMBOL || 'ETHUSDT'}, ${process.env.INTERVAL || '1m'}`);
    try {
        const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${process.env.SYMBOL || 'ETHUSDT'}&interval=${process.env.INTERVAL || '1m'}&limit=1000`);
        const data = await response.json();
        klines = data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            closeTime: d[6]
        }));
        console.log(`${klines.length} historical candle data successfully loaded.`);
    } catch (error) {
        console.error('Error fetching historical data:', error.message);
        klines = [];
    }
}

async function processData() {
    console.log(`Processing historical data...`);
    
    let signalCount = 0;
    
    if (klines.length < Math.max(CFG.LEN, CFG.ATR_LEN)) {
        console.log("Insufficient historical data, minimum bar count for processing not reached.");
        return;
    }

    // Initialize temporary position states for backtesting
    let tempPosition = 'none';
    let tempLongEntryPrice = null;
    let tempLongEntryBarIndex = null;
    let tempShortEntryPrice = null;
    let tempShortEntryBarIndex = null;
    
    for (let i = 0; i < klines.length; i++) {
        const subKlines = klines.slice(0, i + 1);
        const signal = computeSignals(subKlines, tempPosition, tempLongEntryPrice, tempLongEntryBarIndex, tempShortEntryPrice, tempShortEntryBarIndex);
        
        // Update temporary position based on signals
        if (signal.type !== 'none') {
            signalCount++;
        }
        
        if (signal.type === 'buy' || signal.type === 'flip_long') {
            tempPosition = 'long';
            tempLongEntryPrice = subKlines.at(-1).close;
            tempLongEntryBarIndex = i;
            tempShortEntryPrice = null;
            tempShortEntryBarIndex = null;
        } else if (signal.type === 'sell' || signal.type === 'flip_short') {
            tempPosition = 'short';
            tempShortEntryPrice = subKlines.at(-1).close;
            tempShortEntryBarIndex = i;
            tempLongEntryPrice = null;
            tempLongEntryBarIndex = null;
        } else if (signal.type === 'close') {
            tempPosition = 'none';
            tempLongEntryPrice = null;
            tempLongEntryBarIndex = null;
            tempShortEntryPrice = null;
            tempShortEntryBarIndex = null;
        }
    }

    console.log(`Historical data processed. Total Signals: ${signalCount}`);
    sendTelegramMessage(process.env.TG_TOKEN, process.env.TG_CHAT_ID, `Bot successfully started. Historical data loaded. Total ${signalCount} signals found.`);
}

const ws = new WebSocket(`wss://fstream.binance.com/ws/${process.env.SYMBOL.toLowerCase() || 'ethusdt'}@kline_${process.env.INTERVAL || '1m'}`);

ws.on('open', () => {
    console.log('WebSocket connection opened.');
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
        const signal = computeSignals(klines, position, longEntryPrice, longEntryBarIndex, shortEntryPrice, shortEntryBarIndex);

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
    console.log('WebSocket connection closed. Reconnecting...');
    setTimeout(() => {
        // Reconnection function can go here
    }, 5000);
});

ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
});

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`Server listening at http://localhost:${PORT}`);
});
