import os
import time
import pandas as pd
from binance.client import Client
from binance.enums import *
from strategy import compute_signals
from dotenv import load_dotenv
import telegram
from telegram import constants
from datetime import datetime

# =========================================================================================
# BOT AYARLARI
# =========================================================================================
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
    "BOT_NAME": "SSHL Strategy Python",
    "MODE": "Simülasyon",
}

client = Client(CFG["BINANCE_API_KEY"], CFG["BINANCE_SECRET_KEY"])

klines = []
position = 'none'
long_entry_price = None
long_entry_bar_index = None
short_entry_price = None
short_entry_bar_index = None
total_net_profit = 0.0

telegram_bot = None
if os.getenv("TG_TOKEN") and os.getenv("TG_CHAT_ID"):
    telegram_bot = telegram.Bot(token=os.getenv("TG_TOKEN"))

# =========================================================================================
# TELEGRAM MESAJ FONKSİYONU
# =========================================================================================
async def send_telegram_message(text):
    if not telegram_bot or not os.getenv("TG_CHAT_ID"):
        print("Telegram ayarlı değil.")
        return
    try:
        await telegram_bot.send_message(
            chat_id=os.getenv("TG_CHAT_ID"),
            text=text,
            parse_mode=constants.ParseMode.MARKDOWN
        )
    except Exception as e:
        print(f"Telegram mesajı gönderilemedi: {e}")

# =========================================================================================
# GEÇMİŞ VERİ ÇEKME
# =========================================================================================
def get_historical_klines():
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

# =========================================================================================
# BAR İŞLEME
# =========================================================================================
def process_bar(new_bar):
    global klines, position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index

    klines.append(new_bar)
    if len(klines) > 1000:
        klines.pop(0)

    df = pd.DataFrame(klines)
    signals = compute_signals(df, CFG, position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index)

    print(f"🕒 Yeni bar alındı | Anlık fiyat: {new_bar['close']:.4f}. Sinyal: {signals['type'].upper()}")

    if signals["type"] == "buy" and position != 'long':
        execute_trade("BUY", signals["message"], new_bar['close'])
    elif signals["type"] == "sell" and position != 'short':
        execute_trade("SELL", signals["message"], new_bar['close'])
    elif signals["type"] == "flip_long":
        execute_trade("BUY", signals["message"], new_bar['close'])
    elif signals["type"] == "flip_short":
        execute_trade("SELL", signals["message"], new_bar['close'])

# =========================================================================================
# TRADE İŞLEMLERİ
# =========================================================================================
def execute_trade(side, message, price):
    global position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index, total_net_profit

    try:
        current_bar_index = len(klines) - 1
        pnl = 0.0

        if position != 'none':
            if position == 'long':
                pnl = price - long_entry_price
            elif position == 'short':
                pnl = short_entry_price - price
            total_net_profit += pnl

        if side == "BUY":
            position = 'long'
            long_entry_price = price
            long_entry_bar_index = current_bar_index
            short_entry_price = None
            short_entry_bar_index = None
        else:  # SELL
            position = 'short'
            short_entry_price = price
            short_entry_bar_index = current_bar_index
            long_entry_price = None
            long_entry_bar_index = None

        now_str = datetime.now().strftime("%d.%m.%Y - %H:%M")
        profit_pct = (pnl / price * 100) if price else 0
        net_pct = (total_net_profit / price * 100) if price else 0

        msg = (
            f"{side} Emri Gerçekleşti!\n\n"
            f"Bot Adı: {CFG['BOT_NAME']}\n"
            f"Sembol: {CFG['SYMBOL'].replace('USDT','/USDT')}\n"
            f"Zaman Aralığı: {CFG['INTERVAL']}\n"
            f"Sinyal:{message}\n"
            f"Fiyat:{price}\n"
            f"Zaman : {now_str}\n"
            f"Bu İşlemden Kar/Zarar : % {profit_pct:.2f} ({pnl:.2f} USDT)\n"
            f"Toplam Net Kar/Zarar : % {net_pct:.2f} ({total_net_profit:.2f} USDT)"
        )
        import asyncio
        asyncio.run(send_telegram_message(msg))

    except Exception as e:
        print(f"❌ Emir verilirken hata oluştu: {e}")

# =========================================================================================
# ANA DÖNGÜ
# =========================================================================================
def main():
    global klines
    klines = get_historical_klines()

    from binance import ThreadedWebsocketManager
    twm = ThreadedWebsocketManager(CFG["BINANCE_API_KEY"], CFG["BINANCE_SECRET_KEY"])
    twm.start()

    # Bot başlatıldı mesajı
    start_msg = (
        f"Bot Başlatıldı!\n"
        f"Mod:{CFG['MODE']}\n"
        f"Sembol: {CFG['SYMBOL']}\n"
        f"Zaman Aralığı: {CFG['INTERVAL']}\n"
    )
    import asyncio
    asyncio.run(send_telegram_message(start_msg))

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
