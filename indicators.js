// Basit indikatörler: ATR (RMA/SMA/EMA/WMA), MA tipleri, SSL1
export function sma(arr, len) {
  const out = []
  let sum = 0
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i]
    if (i >= len) sum -= arr[i - len]
    out.push(i >= len - 1 ? sum / len : arr[i])
  }
  return out
}

export function ema(arr, len) {
  const k = 2 / (len + 1)
  const out = []
  let prev = arr[0]
  for (let i = 0; i < arr.length; i++) {
    const v = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k)
    out.push(v)
    prev = v
  }
  return out
}

export function wma(arr, len) {
  const out = []
  let denom = (len * (len + 1)) / 2
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1) { out.push(arr[i]); continue }
    let num = 0
    for (let j = 0; j < len; j++) num += arr[i - j] * (len - j)
    out.push(num / denom)
  }
  return out
}

export function dema(arr, len) {
  const e = ema(arr, len)
  const ee = ema(e, len)
  return e.map((v, i) => 2 * v - ee[i])
}

export function tema(arr, len) {
  const e = ema(arr, len)
  const ee = ema(e, len)
  const eee = ema(ee, len)
  return e.map((v, i) => 3 * (v - ee[i]) + eee[i])
}

export function tma(arr, len) {
  return sma(sma(arr, Math.ceil(len / 2)), Math.floor(len / 2) + 1)
}

// LSMA ~ linreg(series, len, 0) — son noktadaki regresyon değeri
export function lsma(arr, len) {
  const out = []
  for (let i = 0; i < arr.length; i++) {
    if (i < len - 1) { out.push(arr[i]); continue }
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
    for (let j = 0; j < len; j++) {
      const x = j + 1
      const y = arr[i - len + 1 + j]
      sumX += x; sumY += y; sumXY += x * y; sumXX += x * x
    }
    const n = len
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
    const intercept = (sumY - slope * sumX) / n
    const lastX = len
    out.push(intercept + slope * lastX)
  }
  return out
}

export function hma(arr, len) {
  const half = Math.round(len / 2)
  const sqrt = Math.round(Math.sqrt(len))
  const wma1 = wma(arr, half)
  const wma2 = wma(arr, len)
  const diff = arr.map((_, i) => 2 * (wma1[i] ?? arr[i]) - (wma2[i] ?? arr[i]))
  return wma(diff, sqrt)
}

export function kijun2(arrHigh, arrLow, len, kidiv = 1) {
  // Pine: kijun = avg(lowest(len), highest(len)); conversion len/ kidiv
  const out = []
  for (let i = 0; i < arrHigh.length; i++) {
    const l1 = i < len - 1 ? 0 : Math.min(...arrLow.slice(i - len + 1, i + 1))
    const h1 = i < len - 1 ? 0 : Math.max(...arrHigh.slice(i - len + 1, i + 1))
    const kijun = i < len - 1 ? arrHigh[i] : (l1 + h1) / 2
    const len2 = Math.max(1, Math.floor(len / kidiv))
    const l2 = i < len2 - 1 ? 0 : Math.min(...arrLow.slice(i - len2 + 1, i + 1))
    const h2 = i < len2 - 1 ? 0 : Math.max(...arrHigh.slice(i - len2 + 1, i + 1))
    const conv = i < len2 - 1 ? arrHigh[i] : (l2 + h2) / 2
    out.push((kijun + conv) / 2)
  }
  return out
}

export function mcginley(arr, len) {
  const out = []
  let mg = arr[0]
  out.push(mg)
  for (let i = 1; i < arr.length; i++) {
    const p = arr[i]
    mg = mg + (p - mg) / (len * Math.pow(p / mg, 4))
    out.push(mg)
  }
  return out
}

export function moving(type, src, len, opts = {}) {
  switch ((type || '').toUpperCase()) {
    case 'SMA': return sma(src, len)
    case 'EMA': return ema(src, len)
    case 'DEMA': return dema(src, len)
    case 'TEMA': return tema(src, len)
    case 'WMA': return wma(src, len)
    case 'TMA': return tma(src, len)
    case 'HMA': return hma(src, len)
    case 'LSMA': return lsma(src, len)
    case 'KIJUN V2':
    case 'KIJUN2': return kijun2(opts.high, opts.low, len, opts.kidiv || 1)
    case 'MCGINLEY': return mcginley(src, len)
    default: return ema(src, len)
  }
}

export function trueRange(h, l, c) {
  const out = [h[0] - l[0]]
  for (let i = 1; i < h.length; i++) {
    const tr = Math.max(
      h[i] - l[i],
      Math.abs(h[i] - c[i - 1]),
      Math.abs(l[i] - c[i - 1])
    )
    out.push(tr)
  }
  return out
}

export function smooth(arr, len, mode) {
  const m = (mode || 'WMA').toUpperCase()
  if (m === 'RMA') { // Wilder
    const out = []
    let prev = arr[0]
    out.push(prev)
    for (let i = 1; i < arr.length; i++) {
      prev = (prev * (len - 1) + arr[i]) / len
      out.push(prev)
    }
    return out
  }
  if (m === 'SMA') return sma(arr, len)
  if (m === 'EMA') return ema(arr, len)
  return wma(arr, len)
}

export function atr(h, l, c, len, mode) {
  const tr = trueRange(h, l, c)
  return smooth(tr, len, mode)
}

export function ssl1Line(high, low, close, len, type, opts) {
  const emaHigh = moving(type, high, len, opts)
  const emaLow = moving(type, low, len, opts)
  const out = []
  let Hlv1 = 0
  for (let i = 0; i < close.length; i++) {
    if (close[i] > emaHigh[i]) Hlv1 = 1
    else if (close[i] < emaLow[i]) Hlv1 = -1
    // else Hlv1 previous
    out.push(Hlv1 < 0 ? emaHigh[i] : emaLow[i])
  }
  return out
}
