import os
import time
import pandas as pd
from binance.client import Client
from binance.enums import *
from strategy import compute_signals
from dotenv import load_dotenv

# =========================================================================================
# BOT AYARLARI
# =========================================================================================
# Pine Script'teki 'Görsel Ayarlar' ve 'Diğer Ayarlar' grupları burada tanımlanır.
# Ortam değişkenlerini (environment variables) yükle
load_dotenv()

CFG = {
    "BINANCE_API_KEY": os.getenv("BINANCE_API_KEY"),
    "BINANCE_SECRET_KEY": os.getenv("BINANCE_SECRET_KEY"),
    "SYMBOL": os.getenv("SYMBOL", "ETHUSDT"),
    "INTERVAL": os.getenv("INTERVAL", "1m"),
    "TRADE_SIZE": 0.001,
    "USE_STOPLOSS_AL": os.getenv("USE_STOPLOSS_AL", 'true').lower() == 'true',
    "STOPLOSS_AL_PERCENT": float(os.getenv("STOPLOSS_AL_PERCENT", 1.4)),
    "STOPLOSS_AL_ACTIVATION_BARS": int(os.getenv("STOPLOSS_AL_ACTIVATION_BARS", 1)),
    "USE_STOPLOSS_SAT": os.getenv("USE_STOPLOSS_SAT", 'true').lower() == 'true',
    "STOPLOSS_SAT_PERCENT": float(os.getenv("STOPLOSS_SAT_PERCENT", 1.3)),
    "STOPLOSS_SAT_ACTIVATION_BARS": int(os.getenv("STOPLOSS_SAT_ACTIVATION_BARS", 1)),
    "LEN": 164,
    "ATR_LEN": 14,
    "ATR_MULT": 3.2,
    "ATR_SMOOTHING": os.getenv("ATR_SMOOTHING", 'SMA'),
    "MA_TYPE": os.getenv("MA_TYPE", 'HMA'),
    "BASELINE_SOURCE": os.getenv("BASELINE_SOURCE", 'close'),
    "KIDIV": 1,
    "ENTRY_SIGNAL_TYPE": os.getenv("ENTRY_SIGNAL_TYPE", 'BBMC+ATR Bands'),
    "M_BARS_BUY": int(os.getenv("M_BARS_BUY", 1)),
    "N_BARS_SELL": int(os.getenv("N_BARS_SELL", 3)),
}

# =========================================================================================
# DURUM TAKİBİ VE BAŞLATMA
# =========================================================================================
client = Client(CFG["BINANCE_API_KEY"], CFG["BINANCE_SECRET_KEY"])

klines = []
position = 'none'
long_entry_price = None
long_entry_bar_index = None
short_entry_price = None
short_entry_bar_index = None

def get_historical_klines():
    """Binance'dan geçmiş mum verilerini çeker."""
    print(f"Geçmiş veri çekiliyor: {CFG['SYMBOL']} {CFG['INTERVAL']}")
    try:
        raw_klines = client.get_historical_klines(
            symbol=CFG["SYMBOL"],
            interval=CFG["INTERVAL"],
            start_str="1 day ago UTC"
        )
        data = pd.DataFrame(raw_klines, columns=[
            'open_time', 'open', 'high', 'low', 'close', 'volume', 'close_time',
            'quote_asset_volume', 'number_of_trades', 'taker_buy_base_asset_volume',
            'taker_buy_quote_asset_volume', 'ignore'
        ])
        data = data[['open', 'high', 'low', 'close']].apply(pd.to_numeric)
        print(f"✅ {len(data)} adet geçmiş mum verisi başarıyla yüklendi.")
        return data.to_dict('records')
    except Exception as e:
        print(f"❌ Geçmiş veri çekilirken hata: {e}")
        return []

def process_bar(new_bar):
    """Yeni bir mum geldiğinde sinyalleri işler ve işlemleri gerçekleştirir."""
    global klines, position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index

    klines.append(new_bar)
    if len(klines) > 1000:
        klines.pop(0)

    df = pd.DataFrame(klines)
    
    signals = compute_signals(df, CFG, position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index)
    
    print(f"Anlık fiyat: {new_bar['close']:.4f}. Sinyal: {signals['type'].upper()}")
    
    if signals["type"] == "buy" and position != 'long':
        execute_trade("BUY", signals["message"], new_bar['close'])
    elif signals["type"] == "sell" and position != 'short':
        execute_trade("SELL", signals["message"], new_bar['close'])
    elif signals["type"] == "flip_long":
        execute_trade("BUY", signals["message"], new_bar['close'])
    elif signals["type"] == "flip_short":
        execute_trade("SELL", signals["message"], new_bar['close'])

def execute_trade(side, message, price):
    """Gerçek alım/satım emrini verir ve pozisyonu günceller."""
    global position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index
    
    try:
        # Piyasada işlem yapmak için quantity'yi ayarlayın
        # Örneğin, 100 USDT sermaye ile
        # quantity = 100 / price
        
        print(f"🤖 Emir veriliyor: {side} {CFG['SYMBOL']} - {message}")
        
        # Binance ile emir verme kısmı (gerçek işlem için bu satırları etkinleştirin)
        # order = client.create_order(
        #     symbol=CFG["SYMBOL"],
        #     side=SIDE_BUY if side == "BUY" else SIDE_SELL,
        #     type=ORDER_TYPE_MARKET,
        #     quantity=CFG["TRADE_SIZE"]
        # )
        # print(f"✅ Emir başarıyla verildi: {order['orderId']}")

        # Pozisyonu güncelle
        current_bar_index = len(klines) - 1
        if side == "BUY":
            position = 'long'
            long_entry_price = price
            long_entry_bar_index = current_bar_index
            short_entry_price = None
            short_entry_bar_index = None
        else: # SELL
            position = 'short'
            short_entry_price = price
            short_entry_bar_index = current_bar_index
            long_entry_price = None
            long_entry_bar_index = None
            
    except Exception as e:
        print(f"❌ Emir verilirken hata oluştu: {e}")

# =========================================================================================
# ANA ÇALIŞMA DÖNGÜSÜ
# =========================================================================================
def main():
    global klines
    klines = get_historical_klines()

    from binance import ThreadedWebsocketManager
    twm = ThreadedWebsocketManager(CFG["BINANCE_API_KEY"], CFG["BINANCE_SECRET_KEY"])
    twm.start()

    def handle_socket_message(msg):
        if msg['e'] == 'kline':
            kline = msg['k']
            if kline['x']:
                new_bar = {
                    'open': float(kline['o']),
                    'high': float(kline['h']),
                    'low': float(kline['l']),
                    'close': float(kline['c']),
                    'volume': float(kline['v'])
                }
                process_bar(new_bar)

    twm.start_kline_socket(
        callback=handle_socket_message,
        symbol=CFG["SYMBOL"],
        interval=CFG["INTERVAL"]
    )

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        twm.stop()
        print("Bot durduruldu.")

if __name__ == "__main__":
    main()
