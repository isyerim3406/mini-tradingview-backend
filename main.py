import asyncio
import os
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
# IFTSMI STRATEJİSİ
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

        self.closes, self.highs, self.lows = [], [], []
        self.true_ranges, self.v1_values, self.smi_values = [], [], []
        self.inv_values, self.atr_values, self.atr_ma_values = [], [], []
        self.ema_states = {}

        self.initial_capital = options.get('initial_capital', 100.0)
        self.qty_percent = options.get('qty_percent', 100.0)
        self.capital = float(self.initial_capital)
        self.position_size = 0.0
        self.trades = []

    def calculate_ema(self, value, period, key):
        if key not in self.ema_states:
            self.ema_states[key] = {'ema': None}
        state = self.ema_states[key]
        if state['ema'] is None:
            state['ema'] = value
        else:
            multiplier = 2 / (period + 1)
            state['ema'] = (value * multiplier) + (state['ema'] * (1 - multiplier))
        return state['ema']

    def calculate_sma(self, values, period):
        return sum(values[-period:]) / period if len(values) >= period else None

    def calculate_wma(self, values, period):
        if len(values) < period:
            return None
        s = values[-period:]
        weighted_sum = sum(s[i] * (i + 1) for i in range(period))
        return weighted_sum / (period * (period + 1) / 2)

    def get_lowest(self, values, period):
        return min(values[-period:]) if len(values) >= period else (min(values) if values else None)

    def get_highest(self, values, period):
        return max(values[-period:]) if len(values) >= period else (max(values) if values else None)

    def calculate_true_range(self, high, low, prev_close):
        if prev_close is None:
            return high - low
        return max(high - low, abs(high - prev_close), abs(low - prev_close))

    def process_candle(self, ts, o, h, l, c, prev_close):
        self.closes.append(c)
        self.highs.append(h)
        self.lows.append(l)
        self.true_ranges.append(self.calculate_true_range(h, l, prev_close))

        LLow, HHigh = self.get_lowest(self.lows, self.SMIL), self.get_highest(self.highs, self.SMIL)
        if LLow is None or HHigh is None:
            return {'signal': None}

        SM = c - 0.5 * (HHigh + LLow)
        avgsm = self.calculate_ema(self.calculate_ema(SM, self.IEMA, 'sm_inner'), self.OEMA, 'sm_outer')
        diff = HHigh - LLow
        avgdiff = self.calculate_ema(self.calculate_ema(diff, self.IEMA, 'diff_inner'), self.OEMA, 'diff_outer')
        SMI = 100 * (avgsm / (0.5 * avgdiff)) if avgdiff not in (None, 0) else 0
        self.smi_values.append(SMI)

        v1 = 0.1 * SMI
        self.v1_values.append(v1)
        v2 = self.calculate_wma(self.v1_values, self.wmalength)
        inv = (math.exp(2 * v2) - 1) / (math.exp(2 * v2) + 1) if v2 else 0
        self.inv_values.append(inv)

        atr = self.calculate_sma(self.true_ranges, self.atr_period)
        if atr: self.atr_values.append(atr)
        atr_ma = self.calculate_sma(self.atr_values, self.atr_ma_period)
        if atr_ma: self.atr_ma_values.append(atr_ma)

        is_sideways = self.use_filter and atr and atr_ma and atr < atr_ma * self.atr_threshold

        signal = None
        if len(self.inv_values) >= 2:
            prev, cur = self.inv_values[-2], self.inv_values[-1]
            if prev <= self.level_buy and cur > self.level_buy and not is_sideways:
                signal = {'type': 'BUY', 'message': 'AL Sinyali'}
            elif prev >= self.level_sell and cur < self.level_sell and not is_sideways:
                signal = {'type': 'SELL', 'message': 'SAT Sinyali'}

        return {'signal': signal}

    def get_avg_entry_price(self):
        entries = [t for t in self.trades if t['action'] == 'entry']
        return entries[-1]['price'] if entries else 0.0

    def open_position(self, side, price):
        qty = (self.capital * (self.qty_percent / 100)) / price
        self.position_size = qty if side == 'BUY' else -qty
        self.trades.append({'action': 'entry', 'type': side, 'price': price, 'quantity': qty})

    def close_position(self, price):
        if self.position_size == 0:
            return 0.0
        pnl = self.position_size * (price - self.get_avg_entry_price())
        self.capital += pnl
        self.trades.append({'action': 'exit', 'pnl': pnl, 'price': price})
        self.position_size = 0.0
        return pnl

# =========================================================================================
# BOT AYARLARI
# =========================================================================================
CFG = {
    'SYMBOL': os.getenv('SYMBOL', 'ETHUSDT'),
    'INTERVAL': os.getenv('INTERVAL', '1h'),
    'INITIAL_CAPITAL': float(os.getenv('INITIAL_CAPITAL', 100)),
    'TRADE_SIZE_PERCENT': float(os.getenv('TRADE_SIZE_PERCENT', 100)),
    'COOLDOWN_SECONDS': int(os.getenv('COOLDOWN_SECONDS', 3600)),
    'BOT_NAME': os.getenv('BOT_NAME', 'IFTSMI Python'),
    'MODE': os.getenv('MODE', 'Simülasyon')
}

bot_current_position = 'none'
total_net_profit = 0.0
last_signal_time = 0.0

telegram_bot = telegram.Bot(token=os.getenv('TG_TOKEN')) if os.getenv('TG_TOKEN') else None

strategy = IFTSMIStrategy({'initial_capital': CFG['INITIAL_CAPITAL'], 'qty_percent': CFG['TRADE_SIZE_PERCENT']})

async def send_telegram_message(text):
    if not telegram_bot or not os.getenv('TG_CHAT_ID'):
        return
    await telegram_bot.send_message(chat_id=os.getenv('TG_CHAT_ID'), text=text, parse_mode=constants.ParseMode.MARKDOWN)

# =========================================================================================
# BOT ANA DÖNGÜSÜ
# =========================================================================================
async def run_bot():
    global bot_current_position, total_net_profit, last_signal_time

    client = await AsyncClient.create()
    bm = BinanceSocketManager(client)

    # İlk 500 mum
    candles = await client.get_klines(symbol=CFG['SYMBOL'], interval=CFG['INTERVAL'], limit=500)
    last_signal = None
    prev_close = None
    for c in candles:
        ts, o, h, l, cl = c[0], float(c[1]), float(c[2]), float(c[3]), float(c[4])
        result = strategy.process_candle(ts, o, h, l, cl, prev_close)
        if result['signal']:
            last_signal = result['signal']
        prev_close = cl

    await send_telegram_message(
        f"Bot Başlatıldı!\n"
        f"Mod:{CFG['MODE']}\n"
        f"Sembol: {CFG['SYMBOL']}\n"
        f"Zaman Aralığı: {CFG['INTERVAL']}\n"
        f"Son Oluşan Sinyal: {last_signal['message'] if last_signal else 'Yok'}"
    )

    ts = bm.kline_socket(symbol=CFG['SYMBOL'], interval=CFG['INTERVAL'])
    async with ts as stream:
        while True:
            msg = await stream.recv()
            if msg.get('e') != 'kline':
                continue
            k = msg['k']
            if k['x']:
                close_price = float(k['c'])
                print(f"📊 Yeni bar alındı. Kapanış: {close_price}")

                result = strategy.process_candle(k['t'], float(k['o']), float(k['h']), float(k['l']), close_price, strategy.closes[-1] if strategy.closes else None)

                if result['signal']:
                    now = time.time()
                    if last_signal_time and (now - last_signal_time) < CFG['COOLDOWN_SECONDS']:
                        continue
                    signal = result['signal']

                    pnl = strategy.close_position(close_price)
                    total_net_profit += pnl
                    strategy.open_position(signal['type'], close_price)
                    bot_current_position = 'long' if signal['type'] == 'BUY' else 'short'
                    last_signal_time = now

                    ts_str = datetime.utcfromtimestamp(k['t']/1000).strftime("%d.%m.%Y - %H:%M")
                    pnl_pct = (pnl / CFG['INITIAL_CAPITAL']) * 100
                    net_pct = (total_net_profit / CFG['INITIAL_CAPITAL']) * 100

                    await send_telegram_message(
                        f"{signal['type']} Emri Gerçekleşti!\n\n"
                        f"Bot Adı: {CFG['BOT_NAME']}\n"
                        f"Sembol: {CFG['SYMBOL']}\n"
                        f"Zaman Aralığı: {CFG['INTERVAL']}\n"
                        f"Sinyal:{signal['message']}\n"
                        f"Fiyat:{close_price}\n"
                        f"Zaman : {ts_str}\n"
                        f"Bu İşlemden Kar/Zarar : % {pnl_pct:.2f} ({pnl:.2f} USDT)\n"
                        f"Toplam Net Kar/Zarar : % {net_pct:.2f} ({total_net_profit:.2f} USDT)"
                    )

    await client.close_connection()

# =========================================================================================
# HTTP SERVER
# =========================================================================================
async def start_http_server():
    async def handle_root(request):
        return web.Response(text="Bot çalışıyor 🚀")
    app = web.Application()
    app.router.add_get("/", handle_root)
    app.router.add_get("/healthz", lambda r: web.Response(text="ok"))
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", int(os.getenv("PORT", 8000)))
    await site.start()

# =========================================================================================
# MAIN
# =========================================================================================
async def main():
    await asyncio.gather(start_http_server(), run_bot())

if __name__ == "__main__":
    asyncio.run(main())
