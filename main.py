import math

class IFTSMIStrategy:
    def __init__(self, options=None):
        options = options or {}
        self.SMIL = options.get('SMIL', 54)
        self.wmalength = options.get('wmalength', 6)
        self.IEMA = options.get('IEMA', 5)
        self.OEMA = options.get('OEMA', 5)
        self.level_buy = options.get('level_buy', -0.5)
        self.level_sell = options.get('level_sell', 0.8)
        self.use_filter = options.get('use_filter', True)
        self.atr_period = options.get('atr_period', 14)
        self.atr_ma_period = options.get('atr_ma_period', 100)
        self.atr_threshold = options.get('atr_threshold', 0.7)

        self.closes = []
        self.highs = []
        self.lows = []
        self.true_ranges = []
        self.atr_values = []
        self.atr_ma_values = []
        self.smi_values = []
        self.v1_values = []
        self.inv_values = []
        # EMA state
        self.ema_sm_inner = None
        self.ema_sm_outer = None
        self.ema_diff_inner = None
        self.ema_diff_outer = None

    # EMA calculation (Pinescript’s ta.ema)
    def calc_ema(self, value, prev_ema, length):
        if prev_ema is None:
            return value
        multiplier = 2 / (length + 1)
        return value * multiplier + prev_ema * (1 - multiplier)

    # SMA calculation
    def calc_sma(self, values, length):
        if len(values) < length:
            return None
        return sum(values[-length:]) / length

    # WMA calculation (Pinescript’s ta.wma)
    def calc_wma(self, values, length):
        if len(values) < length:
            return None
        vals = values[-length:]
        weights = [i+1 for i in range(length)]
        return sum(v*w for v, w in zip(vals, weights)) / sum(weights)

    # lowest/ highest
    def get_lowest(self, values, length):
        if len(values) < length:
            return None
        return min(values[-length:])

    def get_highest(self, values, length):
        if len(values) < length:
            return None
        return max(values[-length:])

    # ATR calculation
    def calc_true_range(self, high, low, prev_close):
        if prev_close is None:
            return high - low
        return max(high - low, abs(high - prev_close), abs(low - prev_close))

    def process_candle(self, ts, o, h, l, c, prev_close):
        self.closes.append(c)
        self.highs.append(h)
        self.lows.append(l)
        # True Range
        tr = self.calc_true_range(h, l, prev_close)
        self.true_ranges.append(tr)

        # LLow & HHigh
        LLow = self.get_lowest(self.lows, self.SMIL)
        HHigh = self.get_highest(self.highs, self.SMIL)
        if LLow is None or HHigh is None:
            return {'signal': None}

        # SM calculation
        SM = c - 0.5 * (HHigh + LLow)

        # EMA for SM (inner then outer)
        self.ema_sm_inner = self.calc_ema(SM, self.ema_sm_inner, self.IEMA)
        self.ema_sm_outer = self.calc_ema(self.ema_sm_inner, self.ema_sm_outer, self.OEMA)
        avgsm = self.ema_sm_outer

        # diff and EMA for diff
        diff = HHigh - LLow
        self.ema_diff_inner = self.calc_ema(diff, self.ema_diff_inner, self.IEMA)
        self.ema_diff_outer = self.calc_ema(self.ema_diff_inner, self.ema_diff_outer, self.OEMA)
        avgdiff = self.ema_diff_outer

        # SMI calculation
        SMI = 100 * (avgsm / (0.5 * avgdiff)) if avgdiff not in (None, 0) else 0
        self.smi_values.append(SMI)

        # v1 & v2 (wma)
        v1 = 0.1 * SMI
        self.v1_values.append(v1)
        v2 = self.calc_wma(self.v1_values, self.wmalength)
        # INV calculation
        inv = (math.exp(2 * v2) - 1) / (math.exp(2 * v2) + 1) if v2 is not None else 0
        self.inv_values.append(inv)

        # ATR & ATR MA
        atr = self.calc_sma(self.true_ranges, self.atr_period)
        if atr is not None:
            self.atr_values.append(atr)
        atr_ma = self.calc_sma(self.atr_values, self.atr_ma_period)
        if atr_ma is not None:
            self.atr_ma_values.append(atr_ma)

        # Sideways Filter
        is_sideways = self.use_filter and atr is not None and atr_ma is not None and atr < atr_ma * self.atr_threshold

        # Signal logic
        signal = None
        if len(self.inv_values) >= 2:
            prev_inv, cur_inv = self.inv_values[-2], self.inv_values[-1]
            # Pinescript crossover/crossunder mantığı:
            # Crossover: prev <= level_buy and cur > level_buy
            # Crossunder: prev >= level_sell and cur < level_sell
            if prev_inv <= self.level_buy and cur_inv > self.level_buy and not is_sideways:
                signal = {'type': 'BUY', 'message': 'AL Sinyali'}
            elif prev_inv >= self.level_sell and cur_inv < self.level_sell and not is_sideways:
                signal = {'type': 'SELL', 'message': 'SAT Sinyali'}

        return {'signal': signal}
