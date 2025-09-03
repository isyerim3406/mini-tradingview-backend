import asyncio
import os
import json
import time
from datetime import datetime
from binance import AsyncClient, BinanceSocketManager
from dotenv import load_dotenv
import telegram
from telegram import constants
from aiohttp import web
import math

# .env dosyasını yükle
load_dotenv()

# =========================================================================================
# IFTSMI STRATEJİSİ (UTBot yerine adapte edildi) + PnL yönetimi
# =========================================================================================
class IFTSMIStrategy:
    def __init__(self, options=None):
        options = options or {}
        self.SMIL = options.get('SMIL', 40)
        self.wmalength = options.get('wmalength', 9)
        self.IEMA = options.get('IEMA', 5)
        self.OEMA = options.get('OEMA', 5)
        self.level_buy = options.get('level_buy', -0.57)
        self.level_sell = options.get('level_sell', 0.90)
        self.use_filter = options.get('use_filter', True)
        self.atr_period = options.get('atr_period', 14)
        self.atr_ma_period = options.get('atr_ma_period', 53)
        self.atr_threshold = options.get('atr_threshold', 1)

        self.closes = []
        self.highs = []
        self.lows = []
        self.true_ranges = []
        self.v1_values = []
        self.smi_values = []
        self.inv_values = []
        self.atr_values = []
        self.atr_ma_values = []
        self.ema_states = {}

        self.initial_capital = options.get('initial_capital', 100.0)
        self.qty_percent = options.get('qty_percent', 100.0)
        self.capital = float(self.initial_capital)
        self.position_size = 0.0
        self.trades = []

    # === Hesaplama metodları (EMA, SMA, WMA vs) ===
    def calculate_ema(self, value, period, key):
        if key not in self.ema_states:
            self.ema_states[key] = {'values': [], 'ema': None}
        state = self.ema_states[key]
        state['values'].append(value)
        if len(state['values']) == 1:
            state['ema'] = value
        else:
            multiplier = 2 / (period + 1)
            state['ema'] = (value * multiplier) + (state['ema'] * (1 - multiplier))
        return state['ema']

    def calculate_sma(self, values, period):
        if len(values) < period:
            return None
        return sum(values[-period:]) / period

    def calculate_wma(self, values, period):
        if len(values) < period:
            return None
        s = values[-period:]
        weighted_sum = sum(s[i] * (i + 1) for i in range(period))
        weight_sum = period * (period + 1) / 2
        return weighted_sum / weight_sum

    def get_lowest(self, values, period):
        if not values:
            return None
        if len(values) < period:
            return min(values)
        return min(values[-period:])

    def get_highest(self, values, period):
        if not values:
            return None
        if len(values) < period:
            return max(values)
        return max(values[-period:])

    def calculate_true_range(self, high, low, prev_close):
        if prev_close is None:
            return high - low
        tr1 = high - low
        tr2 = abs(high - prev_close)
        tr3 = abs(low - prev_close)
        return max(tr1, tr2, tr3)

    # === Sinyal üretimi ===
    def process_candle(self, ts, open_p, high, low, close_p, prev_close):
        self.closes.append(close_p)
        self.highs.append(high)
        self.lows.append(low)

        tr = self.calculate_true_range(high, low, prev_close)
        self.true_ranges.append(tr)

        LLow = self.get_lowest(self.lows, self.SMIL)
        HHigh = self.get_highest(self.highs, self.SMIL)
        if LLow is None or HHigh is None:
            return {'signal': None}

        SM = close_p - 0.5 * (HHigh + LLow)
        avgsm = self.calculate_ema(self.calculate_ema(SM, self.IEMA, 'sm_inner'), self.OEMA, 'sm_outer')
        diff = (HHigh - LLow) if (HHigh is not None and LLow is not None) else 0
        avgdiff = self.calculate_ema(self.calculate_ema(diff, self.IEMA, 'diff_inner'), self.OEMA, 'diff_outer')
        SMI = 100 * (avgsm / (0.5 * avgdiff)) if avgdiff not in (None, 0) else 0
        self.smi_values.append(SMI)

        v1 = 0.1 * SMI
        self.v1_values.append(v1)
        v2 = self.calculate_wma(self.v1_values, self.wmalength)
        inv = (math.exp(2 * v2) - 1) / (math.exp(2 * v2) + 1) if v2 is not None else 0
        self.inv_values.append(inv)

        atr = self.calculate_sma(self.true_ranges, self.atr_period)
        if atr is not None:
            self.atr_values.append(atr)
        atr_ma = self.calculate_sma(self.atr_values, self.atr_ma_period)
        if atr_ma is not None:
            self.atr_ma_values.append(atr_ma)

        is_sideways = self.use_filter and atr is not None and atr_ma is not None and (atr < atr_ma * self.atr_threshold)

        signal = None
        if len(self.inv_values) >= 2:
            cur_inv = self.inv_values[-1]
            prev_inv = self.inv_values[-2]
            if prev_inv <= self.level_buy and cur_inv > self.level_buy and not is_sideways:
                signal = {'type': 'BUY', 'message': 'AL Sinyali'}
            elif prev_inv >= self.level_sell and cur_inv < self.level_sell and not is_sideways:
                signal = {'type': 'SELL', 'message': 'SAT Sinyali'}

        return {
            'signal': signal,
            'inv': inv,
            'smi': SMI,
            'atr': atr,
            'atr_ma': atr_ma,
            'is_sideways': is_sideways,
        }

    def get_avg_entry_price(self):
        entries = [t for t in self.trades if t['action'] == 'entry']
        return entries[-1]['price'] if entries else 0.0

    def open_position(self, side, price):
        qty = (self.capital * (self.qty_percent / 100.0)) / max(price, 1e-9)
        self.position_size = qty if side == 'BUY' else -qty
        self.trades.append({
            'type': side, 'price': price, 'quantity': abs(self.position_size), 'action': 'entry'
        })

    def close_position(self, price):
        if self.position_size == 0:
            return 0.0
        side = 'SELL' if self.position_size > 0 else 'BUY'
        pnl = self.position_size * (price - self.get_avg_entry_price())
        self.capital += pnl
        self.trades.append({
            'type': side, 'price': price, 'quantity': abs(self.position_size),
            'action': 'exit', 'pnl': pnl
        })
        self.position_size = 0.0
        return pnl

# =========================================================================================
# BOT AYARLARI
# =========================================================================================
CFG = {
    'SMIL': int(os.getenv('SMIL', 40)),
    'wmalength': int(os.getenv('WMALENGTH', 9)),
    'IEMA': int(os.getenv('IEMA', 5)),
    'OEMA': int(os.getenv('OEMA', 5)),
    'level_buy': float(os.getenv('LEVEL_BUY', -0.57)),
    'level_sell': float(os.getenv('LEVEL_SELL', 0.90)),
    'use_filter': os.getenv('USE_FILTER', 'true').lower() == 'true',
    'atr_period': int(os.getenv('ATR_PERIOD', 14)),
    'atr_ma_period': int(os.getenv('ATR_MA_PERIOD', 53)),
    'atr_threshold': float(os.getenv('ATR_THRESHOLD', 1)),
    'TRADE_SIZE_PERCENT': float(os.getenv('TRADE_SIZE_PERCENT', 100)),
    'SYMBOL': os.getenv('SYMBOL', 'ETHUSDT'),
    'INTERVAL': os.getenv('INTERVAL', '1h'),
    'INITIAL_CAPITAL': float(os.getenv('INITIAL_CAPITAL', 100)),
    'COOLDOWN_SECONDS': int(os.getenv('COOLDOWN_SECONDS', 60*60)),
    'BOT_NAME': os.getenv('BOT_NAME', 'UT BOT Python'),
    'MODE': os.getenv('MODE', 'Simülasyon'),
}

bot_current_position = 'none'
total_net_profit = 0.0
last_signal_time = 0.0

telegram_bot = None
if os.getenv('TG_TOKEN') and os.getenv('TG_CHAT_ID'):
    telegram_bot = telegram.Bot(token=os.getenv('TG_TOKEN'))

strategy = IFTSMIStrategy(options={
    'SMIL': CFG['SMIL'], 'wmalength': CFG['wmalength'],
    'IEMA': CFG['IEMA'], 'OEMA': CFG['OEMA'],
    'level_buy': CFG['level_buy'], 'level_sell': CFG['level_sell'],
    'use_filter': CFG['use_filter'],
    'atr_period': CFG['atr_period'], 'atr_ma_period': CFG['atr_ma_period'],
    'atr_threshold': CFG['atr_threshold'],
    'initial_capital': CFG['INITIAL_CAPITAL'], 'qty_percent': CFG['TRADE_SIZE_PERCENT']
})

async def send_telegram_message(text):
    if not telegram_bot or not os.getenv('TG_CHAT_ID'):
        print("Telegram API token veya chat ID ayarlanmadı. Mesaj atlanıyor.")
        return
    try:
        await telegram_bot.send_message(chat_id=os.getenv('TG_CHAT_ID'),
                                        text=text,
                                        parse_mode=constants.ParseMode.MARKDOWN)
    except Exception as e:
        print(f"Telegram mesajı gönderilirken hata oluştu: {e}")

# =========================================================================================
# BOT ANA DÖNGÜSÜ
# =========================================================================================
async def run_bot():
    global bot_current_position, total_net_profit, last_signal_time

    print("🤖 Bot başlatılıyor...")

    client = await AsyncClient.create()
    bm = BinanceSocketManager(client)

    candles = await client.get_klines(symbol=CFG['SYMBOL'], interval=CFG['INTERVAL'], limit=500)
    last_signal = None
    prev_close = None
    for c in candles:
        ts, o, h, l, cl = c[0], float(c[1]), float(c[2]), float(c[3]), float(c[4])
        result = strategy.process_candle(ts, o, h, l, cl, prev_close)
        if result['signal']:
            last_signal = result['signal']
        prev_close = cl

    if last_signal:
        msg = (
            f"Bot Başlatıldı!\n"
            f"Mod:{CFG['MODE']}\n"
            f"Sembol: {CFG['SYMBOL']}\n"
            f"Zaman Aralığı: {CFG['INTERVAL']}\n"
            f"Son Oluşan Sinyal: {last_signal['message']}"
        )
        await send_telegram_message(msg)

    ts = bm.kline_socket(symbol=CFG['SYMBOL'], interval=CFG['INTERVAL'])
    async with ts as stream:
        while True:
            msg = await stream.recv()
            if msg.get('e') != 'kline':
                continue
            k = msg['k']
            if k['x']:
                timestamp = k['t']
                open_price = float(k['o'])
                high = float(k['h'])
                low = float(k['l'])
                close_price = float(k['c'])

                prev_close_ws = strategy.closes[-1] if strategy.closes else None
                result = strategy.process_candle(timestamp, open_price, high, low, close_price, prev_close_ws)

                unrealized = 0.0
                if strategy.position_size != 0:
                    unrealized = strategy.position_size * (close_price - strategy.get_avg_entry_price())

                if result['signal']:
                    now = time.time()
                    if last_signal_time != 0 and (now - last_signal_time) < CFG['COOLDOWN_SECONDS']:
                        continue
                    signal = result['signal']
                    closed_pnl = strategy.close_position(close_price)
                    total_net_profit = sum(t['pnl'] for t in strategy.trades if t.get('action') == 'exit')

                    side = 'BUY' if signal['type'] == 'BUY' else 'SELL'
                    strategy.open_position(side, close_price)
                    bot_current_position = 'long' if side == 'BUY' else 'short'
                    last_signal_time = now

                    ts_str = datetime.utcfromtimestamp(timestamp/1000).strftime("%d.%m.%Y - %H:%M")

                    msg = (
                        f"{side} Emri Gerçekleşti!\n\n"
                        f"Bot Adı: {CFG['BOT_NAME']}\n"
                        f"Sembol: {CFG['SYMBOL']}\n"
                        f"Zaman Aralığı: {CFG['INTERVAL']}\n"
                        f"Sinyal:{signal['message']}\n"
                        f"Fiyat:{close_price}\n"
                        f"Zaman : {ts_str}\n"
                        f"Bu İşlemden Kar/Zarar : {closed_pnl:.2f} USDT\n"
                        f"Toplam Net Kar/Zarar : {total_net_profit:.2f} USDT"
                    )
                    await send_telegram_message(msg)

    await client.close_connection()

# =========================================================================================
# HTTP SERVER
# =========================================================================================
async def start_http_server():
    async def handle_root(request):
        last_price = strategy.closes[-1] if strategy.closes else 0
        unrealized = 0.0
        if strategy.position_size != 0 and last_price:
            unrealized = strategy.position_size * (last_price - strategy.get_avg_entry_price())
        body = (
            "Bot çalışıyor 🚀\n"
            f"Sembol: {CFG['SYMBOL']} | Interval: {CFG['INTERVAL']}\n"
            f"Capital: {strategy.capital:.2f} | OpenQty: {strategy.position_size:.6f} | Unrealized: {unrealized:.2f}\n"
            f"Toplam Kapanan PnL: {sum(t['pnl'] for t in strategy.trades if t.get('action')=='exit'):.2f}\n"
            f"Toplam İşlem: {len(strategy.trades)}"
        )
        return web.Response(text=body)

    async def handle_health(request):
        return web.Response(text="ok")

    app = web.Application()
    app.router.add_get("/", handle_root)
    app.router.add_get("/healthz", handle_health)

    port = int(os.environ.get("PORT", 8000))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    print(f"🌐 HTTP server ayakta: 0.0.0.0:{port}")

# =========================================================================================
# MAIN
# =========================================================================================
async def main():
    await asyncio.gather(
        start_http_server(),
        run_bot()
    )

if __name__ == "__main__":
    asyncio.run(main())
