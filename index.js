// Gerekli modülleri içe aktar
import WebSocket from 'ws';
import Binance from 'binance-api-node';
import express from 'express';
import http from 'http';

// Uygulamanın çökmesini önlemek için yakalanmamış tüm istisnaları ele al.
// Bu, uygulamanın dağıtım platformlarında kararlı kalması için çok önemlidir.
process.on('uncaughtException', err => {
    console.error(`[CRITICAL HATA] Yakalanmamış Hata: ${err.message}`);
    // Hatayı logladıktan sonra, bir izleme sistemine (Datadog, Sentry vb.) bildirim gönderebiliriz.
    // Şimdilik, sadece logluyoruz.
});

// Sunucunun düzgün bir şekilde kapanmasını sağlamak için sinyal işleyicileri
process.on('SIGINT', () => {
    console.log('\n[KAPATMA SİNYALİ] Sunucu kapatılıyor...');
    server.close(() => {
        console.log('[KAPATMA SİNYALİ] HTTP sunucu kapatıldı.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n[KAPATMA SİNYALİ] Sunucu kapatılıyor...');
    server.close(() => {
        console.log('[KAPATMA SİNYALİ] HTTP sunucu kapatıldı.');
        process.exit(0);
    });
});

// İzlenecek sembolleri tanımla
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT'];

// Ortam değişkenlerinden API anahtarlarını yapılandır
const client = Binance.default({
    apiKey: process.env.API_KEY,
    apiSecret: process.env.SECRET_KEY,
});

// Express uygulamasını oluştur
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket bağlantı ve istemci durumunu takip etmek için nesneler
let isWebSocketConnected = false;
let subscriptionCleanups = [];
const activeClients = new Set();
const dataStore = {}; // Mum verilerini hafızada tutmak için

// WebSocket bağlantı mantığı
const connectWebSocket = () => {
    console.log('[BAĞLANTI] WebSocket bağlantısı kuruluyor...');
    
    // Her sembol için ayrı bir WebSocket bağlantısı başlat
    subscriptionCleanups = SYMBOLS.map(symbol => {
        return client.ws.candles(symbol, '1m', (candle) => {
            // Her sembol için en son mum verisini sakla
            dataStore[symbol] = candle;

            // Mum verilerini bağlı tüm istemcilere yayınla
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    try {
                        client.send(JSON.stringify(candle));
                    } catch (error) {
                        console.error('[YAYIN HATASI] İstemciye veri gönderilirken hata oluştu:', error);
                    }
                }
            });
        });
    });

    // WebSocket kapanma olaylarını ele al
    client.ws.on('close', (code, reason) => {
        console.warn(`[BAĞLANTI KESİLDİ] WebSocket bağlantısı kapandı. Kod: ${code}, Sebep: ${reason}`);
        isWebSocketConnected = false;
        // Kısa bir gecikmeden sonra yeniden bağlanmayı dene
        console.log('[YENİDEN BAĞLANTI] 5 saniye içinde yeniden bağlanılıyor...');
        setTimeout(() => {
            // Önceki tüm abonelikleri temizle
            subscriptionCleanups.forEach(clean => clean());
            subscriptionCleanups = [];
            connectWebSocket();
        }, 5000);
    });

    // WebSocket hata olaylarını ele al
    client.ws.on('error', (err) => {
        console.error('[HATA] WebSocket hatası:', err.message);
        isWebSocketConnected = false;
        // 'close' olayı işleyicisi, yeniden bağlanma mantığını tetikleyecektir
    });

    client.ws.on('open', () => {
        console.log('[BAĞLANTI BAŞARILI] WebSocket bağlantısı başarıyla açıldı.');
        isWebSocketConnected = true;
    });
};

// İlk bağlantıyı başlat
connectWebSocket();

// --- HTTP Uç Noktaları ---

// Kök uç noktası (ana sayfa veya durum kontrolü için)
app.get('/', (req, res) => {
    res.send(`
        <h1>Binance WebSocket Sunucusu Çalışıyor</h1>
        <p>Sunucu durumu için <a href="/status">/status</a> adresine gidin.</p>
        <p>İlk mum verilerini almak için <a href="/candles?symbol=BTCUSDT">/candles?symbol=BTCUSDT</a> adresine gidin.</p>
        <p>WebSocket durumu: <b>${isWebSocketConnected ? 'Bağlı' : 'Bağlı Değil'}</b></p>
    `);
});

// İlk 500 mum için HTTP uç noktası
app.get('/candles', async (req, res) => {
    const symbol = req.query.symbol;
    if (!symbol) {
        return res.status(400).send('Lütfen bir sembol belirtin. Örnek: /candles?symbol=BTCUSDT');
    }

    try {
        console.log(`[HTTP İSTEK] ${symbol} için 500 mum verisi isteniyor...`);
        const candles = await client.candles({ symbol, interval: '1m', limit: 500 });
        console.log(`✅ ${symbol} için ilk 500 mum verisi yüklendi.`);
        res.json(candles);
    } catch (error) {
        console.error(`[HATA] ${symbol} için ilk mumlar alınamadı:`, error);
        res.status(500).send(`İlk mum verileri alınamadı. Hata: ${error.message}`);
    }
});

// Sunucu durumu için HTTP uç noktası
app.get('/status', (req, res) => {
    const status = {
        websocketConnection: isWebSocketConnected ? 'Bağlı' : 'Bağlı Değil',
        numberOfClients: wss.clients.size,
        subscribedSymbols: SYMBOLS,
        lastUpdatedData: Object.keys(dataStore).reduce((acc, symbol) => {
            acc[symbol] = {
                eventTime: dataStore[symbol]?.eventTime,
                isFinal: dataStore[symbol]?.isFinal,
            };
            return acc;
        }, {}),
    };
    res.json(status);
});

// --- WebSocket Sunucu Mantığı ---

wss.on('connection', ws => {
    activeClients.add(ws);
    console.log(`[YENİ İSTEMCİ] Yeni bir istemci bağlandı. Toplam istemci sayısı: ${activeClients.size}`);

    ws.on('close', (code, reason) => {
        activeClients.delete(ws);
        console.log(`[İSTEMCİ KESİLDİ] Bir istemci bağlantısı kesildi. Kod: ${code}, Sebep: ${reason}. Kalan istemci sayısı: ${activeClients.size}`);
    });

    ws.on('error', (error) => {
        console.error('[İSTEMCİ HATASI] Bir istemci WebSocket hatası:', error.message);
    });

    // İstemciye mevcut verileri gönder
    const initialData = Object.values(dataStore);
    if (initialData.length > 0) {
        ws.send(JSON.stringify(initialData));
    }
});

// Sunucuyu başlat
const port = process.env.PORT || 10000;
server.listen(port, () => {
    console.log(`[BAŞLANGIÇ] Sunucu http://localhost:${port} adresinde çalışıyor`);
    console.log(`[BAŞLANGIÇ] WebSocket sunucusu ${SYMBOLS.join(', ')} sembollerini dinliyor...`);
});
