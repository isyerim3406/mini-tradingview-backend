import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Ana endpoint (sunucu çalışıyor mu testi)
app.get("/", (req, res) => {
  res.send("🚀 Webhook Sunucusu Çalışıyor!");
});

// TradingView Webhook Endpoint
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("📩 Webhook alındı:", data);

    // TradingView'den gelen sinyal örneği:
    // { signal: "buy", pair: "BTCUSDT", exchange: "binance", timeframe: "1h" }

    // Eğer sinyal buy/sell ise 3Commas API’ye gönderebilirsin
    if (data.signal === "buy" || data.signal === "sell") {
      console.log(`📊 İşlem sinyali: ${data.signal} - ${data.pair}`);

      // 3Commas API entegrasyonu örnek (dummy, sen API_KEY ekleyeceksin)
      const apiResponse = await fetch("https://api.3commas.io/public/api/v2/smart_trades", {
        method: "POST",
        headers: {
          "APIKEY": process.env.THREECOMMAS_API_KEY || "xxx",
          "Signature": process.env.THREECOMMAS_SIGNATURE || "xxx",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          pair: data.pair,
          action: data.signal
        })
      });

      const result = await apiResponse.json();
      console.log("📤 3Commas cevabı:", result);
    }

    res.json({ status: "ok", received: data });
  } catch (err) {
    console.error("❌ Webhook hatası:", err.message);
    res.status(500).json({ error: "Webhook işlenemedi" });
  }
});

// Sunucuyu başlat
app.listen(PORT, () => {
  console.log(`✅ Sunucu http://localhost:${PORT} adresinde dinliyor`);
});
