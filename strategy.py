import pandas as pd
import ta as talib

# =========================================================================================
# GÖSTERGELER VE YARDIMCI FONKSİYONLAR (Pine Script'teki `function`lara karşılık gelir)
# =========================================================================================
def get_moving_average(series, length, ma_type):
    """
    Belirtilen tipte hareketli ortalama hesaplar.
    Bu fonksiyon, Pine Script'teki 'Moving Average Tipleri' bölümünü çevirir.
    """
    if ma_type == "SMA":
        return series.rolling(window=length).mean()
    elif ma_type == "EMA":
        return talib.trend.ema_indicator(series, window=length)
    # DEMA, TEMA, LSMA, TMA, HMA gibi diğer MA türlerini ekleyin
    elif ma_type == "HMA":
        # HMA için gerekli hesaplamalar
        wma1 = series.ewm(alpha=2/(length/2+1), adjust=False).mean()
        wma2 = series.ewm(alpha=2/(length+1), adjust=False).mean()
        hma_series = 2 * wma1 - wma2
        return hma_series.ewm(alpha=2/(int(length**0.5)+1), adjust=False).mean()
    else:
        return series.rolling(window=length).mean()

def get_atr(df, length, smoothing):
    """
    ATR (Average True Range) hesaplar.
    Pine Script'teki 'ta.atr' fonksiyonuna ve 'smoothing' seçeneklerine karşılık gelir.
    """
    atr_series = talib.volatility.average_true_range(df['high'], df['low'], df['close'], window=length)
    if smoothing == "RMA":
        return atr_series.ewm(alpha=1/length, adjust=False).mean()
    elif smoothing == "SMA":
        return atr_series.rolling(window=length).mean()
    elif smoothing == "EMA":
        return talib.trend.ema_indicator(atr_series, window=length)
    elif smoothing == "WMA":
        return atr_series.ewm(alpha=1/length, adjust=False).mean()
    else:
        return atr_series.rolling(window=length).mean()

def get_ssl1_line(df, length, ma_type, kidiv):
    """
    Pine Script'teki SSL1 göstergesini hesaplar.
    Bu kısım, Pine Script'in 'H/L' değişkenini taklit eder ve 'ta.rma' yerine
    benzer bir hareketli ortalama kullanır.
    """
    high = df['high']
    low = df['low']
    close = df['close']
    
    ma_high = get_moving_average(high, length, ma_type)
    ma_low = get_moving_average(low, length, ma_type)

    # hlv değişkeninin Pine Script mantığı
    hlv = []
    for i in range(len(close)):
        if close[i] > ma_high.iloc[i]:
            hlv.append(1)
        elif close[i] < ma_low.iloc[i]:
            hlv.append(-1)
        else:
            if i > 0:
                hlv.append(hlv[-1])
            else:
                hlv.append(0)
    hlv = pd.Series(hlv, index=df.index)
    
    ssl1_line = [ma_high.iloc[i] if hlv.iloc[i] == -1 else ma_low.iloc[i] for i in range(len(hlv))]
    return pd.Series(ssl1_line, index=df.index)

def cross(series1, series2):
    """
    Pine Script'teki `ta.crossover` fonksiyonunun Python versiyonu.
    Seri1'in Seri2'yi yukarı kestiğini kontrol eder.
    """
    if len(series1) < 2 or len(series2) < 2:
        return False
    return (series1.iloc[-2] < series2.iloc[-2]) and (series1.iloc[-1] > series2.iloc[-1])

def crossunder(series1, series2):
    """
    Pine Script'teki `ta.crossunder` fonksiyonunun Python versiyonu.
    Seri1'in Seri2'yi aşağı kestiğini kontrol eder.
    """
    if len(series1) < 2 or len(series2) < 2:
        return False
    return (series1.iloc[-2] > series2.iloc[-2]) and (series1.iloc[-1] < series2.iloc[-1])

# =========================================================================================
# ANA SİNYAL HESAPLAMA FONKSİYONU
# =========================================================================================
def compute_signals(df, CFG, position, long_entry_price, long_entry_bar_index, short_entry_price, short_entry_bar_index):
    """
    Pine Script'teki ana strateji bloğunu (if/else) Python'a çevirir.
    """
    if len(df) < max(CFG["LEN"], CFG["ATR_LEN"]) + 1:
        return {"type": "none", "message": "Yetersiz veri"}
    
    last_close = df['close'].iloc[-1]
    
    # --- STOP LOSS KONTROLÜ (Pine Script'teki `alert()` mantığı) ---
    if position == 'long' and CFG["USE_STOPLOSS_AL"] and long_entry_price is not None:
        stop_loss_level = long_entry_price * (1 - CFG["STOPLOSS_AL_PERCENT"] / 100)
        bars_since_entry = len(df) - 1 - long_entry_bar_index
        if bars_since_entry >= CFG["STOPLOSS_AL_ACTIVATION_BARS"] and last_close <= stop_loss_level:
            return {"type": "flip_short", "message": "UZUN POZISYON SL VURDU. SAT"}
    
    if position == 'short' and CFG["USE_STOPLOSS_SAT"] and short_entry_price is not None:
        stop_loss_level = short_entry_price * (1 + CFG["STOPLOSS_SAT_PERCENT"] / 100)
        bars_since_entry = len(df) - 1 - short_entry_bar_index
        if bars_since_entry >= CFG["STOPLOSS_SAT_ACTIVATION_BARS"] and last_close >= stop_loss_level:
            return {"type": "flip_long", "message": "KISA POZISYON SL VURDU. AL"}

    # --- GİRİŞ SİNYALİ KONTROLÜ (Pine Script'teki `if (entrySignalType == "...")` bloğu) ---
    source = df[CFG["BASELINE_SOURCE"]]
    baseline = get_moving_average(source, CFG["LEN"], CFG["MA_TYPE"])
    atr_value = get_atr(df, CFG["ATR_LEN"], CFG["ATR_SMOOTHING"])

    bbmc_upper = baseline + atr_value * CFG["ATR_MULT"]
    bbmc_lower = baseline - atr_value * CFG["ATR_MULT"]
    
    ssl1_line = get_ssl1_line(df, CFG["LEN"], CFG["MA_TYPE"], CFG["KIDIV"])

    if CFG["ENTRY_SIGNAL_TYPE"] == "BBMC+ATR Bands":
        # Pine Script'teki 'consecutive_closes_above_entry_target' mantığı
        consecutive_above = all(df['close'].iloc[-CFG["M_BARS_BUY"]:] > bbmc_upper.iloc[-CFG["M_BARS_BUY"]:])
        consecutive_below = all(df['close'].iloc[-CFG["N_BARS_SELL"]:] < bbmc_lower.iloc[-CFG["N_BARS_SELL"]:])
        
        if consecutive_above and CFG["M_BARS_BUY"] > 0 and position != 'long':
            return {"type": "buy", "message": "AL sinyali: BBMC+ATR bands üzeri"}
        if consecutive_below and CFG["N_BARS_SELL"] > 0 and position != 'short':
            return {"type": "sell", "message": "SAT sinyali: BBMC+ATR bands altı"}
            
    elif CFG["ENTRY_SIGNAL_TYPE"] == "SSL1 Kesişimi":
        if cross(df['close'], ssl1_line) and position != 'long':
            return {"type": "buy", "message": "AL sinyali: SSL1 Kesişimi"}
        if crossunder(df['close'], ssl1_line) and position != 'short':
            return {"type": "sell", "message": "SAT sinyali: SSL1 Kesişimi"}
            
    return {"type": "none", "message": "Sinyal yok"}
