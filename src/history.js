const { getRuntimeStrategyConfig } = require('./strategy/config');
const { score60DayHistory: score60DayHistoryByConfig } = require('./strategy/historyRules');

// 获取大盘指数数据（上证指数，优先使用 page.evaluate 带浏览器 Cookie/Referer）
async function fetchIndexData(context, page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cb = `jQuery${Date.now()}_${Math.random().toString().slice(2)}`;
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?cb=${cb}&secid=1.000001&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&smplmt=460&lmt=1000000&_=${Date.now()}`;

      let text;
      if (page) {
        // 使用 XMLHttpRequest 而不是 fetch
        text = await page.evaluate(async (u) => {
          return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', u, true);
            xhr.withCredentials = true;
            xhr.setRequestHeader('Accept', '*/*');
            xhr.setRequestHeader('Referer', 'https://quote.eastmoney.com/');
            xhr.timeout = 15000;

            xhr.onload = function() {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.responseText);
              } else {
                reject(new Error(`HTTP ${xhr.status}`));
              }
            };

            xhr.onerror = function() {
              reject(new Error('Network error'));
            };

            xhr.ontimeout = function() {
              reject(new Error('Timeout'));
            };

            xhr.send();
          });
        }, url);
      } else {
        const response = await context.request.get(url, { timeout: 15000 });
        text = await response.text();
      }

      const jsonText = text.replace(/^jQuery\d+_\d+\(/, '').replace(/\);?$/, '');
      const data = JSON.parse(jsonText);

      if (!data || !data.data || !data.data.klines) {
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 500 * attempt));
          continue;
        }
        return null;
      }

      const klines = data.data.klines.map(line => {
        const parts = line.split(',');
        return {
          date: parts[0],
          close: Number(parts[2]),
          changePercent: Number(parts[8])
        };
      }).slice(-60);

      return klines;
    } catch (err) {
      if (attempt < 3) {
        console.error(`[INDEX] 获取上证指数失败 (尝试${attempt}/3):`, err.message);
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
        continue;
      }
      console.error(`[INDEX] 获取上证指数最终失败:`, err.message);
      return null;
    }
  }
  return null;
}

// 判断市场环境
function analyzeMarketRegime(indexKlines) {
  if (!indexKlines || indexKlines.length < 60) {
    return { regime: 'UNKNOWN', ma20: null, ma60: null, current: null };
  }

  const prices = indexKlines.map(k => k.close);
  const current = prices[prices.length - 1];

  // 计算MA20和MA60
  const ma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const ma60 = prices.reduce((a, b) => a + b, 0) / prices.length;

  // 判断市场环境
  let regime;
  if (current > ma20 && current > ma60) {
    regime = 'BULL';  // 牛市：价格在MA20和MA60之上
  } else if (current > ma60) {
    regime = 'NEUTRAL';  // 震荡：价格在MA60之上但MA20之下
  } else {
    regime = 'BEAR';  // 熊市：价格在MA60之下
  }

  return {
    regime,
    current: Number(current.toFixed(2)),
    ma20: Number(ma20.toFixed(2)),
    ma60: Number(ma60.toFixed(2)),
    aboveMA20: current > ma20,
    aboveMA60: current > ma60
  };
}

// 计算MACD
function calculateMACD(prices) {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };

  // 计算EMA
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;

  // 计算信号线（MACD的9日EMA）
  const macdLine = [];
  for (let i = 26; i <= prices.length; i++) {
    const e12 = calculateEMA(prices.slice(0, i), 12);
    const e26 = calculateEMA(prices.slice(0, i), 26);
    macdLine.push(e12 - e26);
  }
  const signal = calculateEMA(macdLine, 9);
  const histogram = macd - signal;

  return {
    macd: Number(macd.toFixed(4)),
    signal: Number(signal.toFixed(4)),
    histogram: Number(histogram.toFixed(4))
  };
}

// 计算EMA
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// 计算RSI
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return Number(rsi.toFixed(2));
}

// 获取股票60日K线数据
async function fetch60DayKline(symbol, context, page) {
  const code = symbol.replace(/^(sh|sz)/, '');
  const market = symbol.startsWith('sh') ? 1 : 0;
  const secid = `${market}.${code}`;
  const cb = `jQuery${Date.now()}_${Math.random().toString().slice(2)}`;

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?cb=${cb}&secid=${secid}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&smplmt=460&lmt=1000000&_=${Date.now()}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let text = null;
    try {
      if (page) {
        // 使用 XMLHttpRequest 而不是 fetch，更接近真实浏览器行为
        text = await page.evaluate(async (u) => {
          return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', u, true);
            xhr.withCredentials = true;
            xhr.setRequestHeader('Accept', '*/*');
            xhr.setRequestHeader('Referer', 'https://quote.eastmoney.com/');
            xhr.timeout = 15000;

            xhr.onload = function() {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.responseText);
              } else {
                reject(new Error(`HTTP ${xhr.status}`));
              }
            };

            xhr.onerror = function() {
              reject(new Error('Network error'));
            };

            xhr.ontimeout = function() {
              reject(new Error('Timeout'));
            };

            xhr.send();
          });
        }, url);
      } else {
        const response = await context.request.get(url, { timeout: 20000 });
        text = await response.text();
      }
    } catch (err) {
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 400 * attempt));
        continue;
      }
      console.error(`[KLINE] 获取${symbol}历史数据失败:`, err.message);
      return null;
    }

    try {
      // 去掉 JSONP callback 包装
      const jsonText = text.replace(/^jQuery\d+_\d+\(/, '').replace(/\);?$/, '');
      const data = JSON.parse(jsonText);
      if (!data || !data.data || !data.data.klines) {
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 400 * attempt));
          continue;
        }
        return null;
      }

      const klines = data.data.klines.map(line => {
        const parts = line.split(',');
        return {
          date: parts[0],
          open: Number(parts[1]),
          close: Number(parts[2]),
          high: Number(parts[3]),
          low: Number(parts[4]),
          volume: Number(parts[5]),
          amount: Number(parts[6]),
          amplitude: Number(parts[7]),
          changePercent: Number(parts[8]),
          changeAmount: Number(parts[9]),
          turnoverRate: Number(parts[10])
        };
      });

      return klines.slice(-60);
    } catch (err) {
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 400 * attempt));
        continue;
      }
      console.error(`[KLINE] 解析${symbol}历史数据失败:`, err.message);
      return null;
    }
  }
  return null;
}

// 计算60日技术指标
function calculate60DayIndicators(klines) {
  if (!klines || klines.length < 10) {
    return null;
  }

  const len = klines.length;
  const latest = klines[len - 1];
  const prices = klines.map(k => k.close);
  const volumes = klines.map(k => k.volume);
  const amounts = klines.map(k => k.amount);
  const turnoverRates = klines.map(k => k.turnoverRate);

  // 涨幅计算
  const gain60d = len >= 60 ? ((latest.close - klines[0].close) / klines[0].close) * 100 : null;
  const gain30d = len >= 30 ? ((latest.close - klines[len - 30].close) / klines[len - 30].close) * 100 : null;
  const gain10d = len >= 10 ? ((latest.close - klines[len - 10].close) / klines[len - 10].close) * 100 : null;
  const gain5d = len >= 5 ? ((latest.close - klines[len - 5].close) / klines[len - 5].close) * 100 : null;

  // 过滤涨跌停板（±9.5%以上），避免一字板扭曲均值
  const normalDays = klines.filter(k => Math.abs(k.changePercent) < 9.5);
  const normalCount = normalDays.length;

  // 均值计算（排除涨跌停板）
  const avg60d = prices.reduce((a, b) => a + b, 0) / len;
  const ma5 = len >= 5 ? prices.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const ma10 = len >= 10 ? prices.slice(-10).reduce((a, b) => a + b, 0) / 10 : null;
  const ma20 = len >= 20 ? prices.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const ma30 = len >= 30 ? prices.slice(-30).reduce((a, b) => a + b, 0) / 30 : null;
  const ma60 = prices.reduce((a, b) => a + b, 0) / len;
  const avgVolume60d = normalCount > 0
    ? normalDays.reduce((a, b) => a + b.volume, 0) / normalCount
    : volumes.reduce((a, b) => a + b, 0) / len;
  const avgAmount60d = normalCount > 0
    ? normalDays.reduce((a, b) => a + b.amount, 0) / normalCount
    : amounts.reduce((a, b) => a + b, 0) / len;
  const avgTurnover60d = normalCount > 0
    ? normalDays.reduce((a, b) => a + b.turnoverRate, 0) / normalCount
    : turnoverRates.reduce((a, b) => a + b, 0) / len;

  // 近5日均值（排除涨跌停板）
  const recent5 = klines.slice(-5);
  const recent5Normal = recent5.filter(k => Math.abs(k.changePercent) < 9.5);
  const recent5NormalCount = recent5Normal.length;
  const avgVolume5d = recent5NormalCount > 0
    ? recent5Normal.reduce((a, b) => a + b.volume, 0) / recent5NormalCount
    : recent5.reduce((a, b) => a + b.volume, 0) / 5;
  const avgAmount5d = recent5NormalCount > 0
    ? recent5Normal.reduce((a, b) => a + b.amount, 0) / recent5NormalCount
    : recent5.reduce((a, b) => a + b.amount, 0) / 5;
  const avgTurnover5d = recent5NormalCount > 0
    ? recent5Normal.reduce((a, b) => a + b.turnoverRate, 0) / recent5NormalCount
    : recent5.reduce((a, b) => a + b.turnoverRate, 0) / 5;

  // 最高价和最低价
  const high60d = Math.max(...prices);
  const low60d = Math.min(...prices);
  const distanceToHigh60d = ((latest.close - high60d) / high60d) * 100;
  const deviationFromMA20 = ma20 ? ((latest.close - ma20) / ma20) * 100 : null;
  const deviationFromMA30 = ma30 ? ((latest.close - ma30) / ma30) * 100 : null;
  const deviationFromMA60 = ma60 ? ((latest.close - ma60) / ma60) * 100 : null;

  // 最大回撤（用累计收益率计算，避免复权数据失真）
  let maxDrawdown = 0;
  let cumulativeReturn = 1.0;
  let peakReturn = 1.0;

  for (const k of klines) {
    cumulativeReturn *= (1 + k.changePercent / 100);
    if (cumulativeReturn > peakReturn) {
      peakReturn = cumulativeReturn;
    }
    const drawdown = ((peakReturn - cumulativeReturn) / peakReturn) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  // 上涨天数统计
  const upDays = klines.filter(k => k.changePercent > 0).length;
  const upDaysRatio = (upDays / len) * 100;

  // 连续上涨天数
  let consecutiveUpDays = 0;
  for (let i = len - 1; i >= 0; i--) {
    if (klines[i].changePercent > 0) {
      consecutiveUpDays++;
    } else {
      break;
    }
  }

  // 连续下跌天数
  let consecutiveDownDays = 0;
  for (let i = len - 1; i >= 0; i--) {
    if (klines[i].changePercent < 0) {
      consecutiveDownDays++;
    } else {
      break;
    }
  }

  const isBreakoutHigh = latest.close >= high60d * 0.98;
  const priceVsAvg = ((latest.close - avg60d) / avg60d) * 100;

  // 波动率（标准差）
  const variance = prices.reduce((sum, price) => sum + Math.pow(price - avg60d, 2), 0) / len;
  const volatility = Math.sqrt(variance) / avg60d * 100;

  // 放量倍数
  const volumeRatio5d = avgVolume5d / avgVolume60d;
  const amountRatio5d = avgAmount5d / avgAmount60d;

  // 技术指标：MACD和RSI
  const macd = calculateMACD(prices);
  const rsi = calculateRSI(prices, 14);
  const prevMacd = len >= 35 ? calculateMACD(prices.slice(0, -1)) : null;
  const macdHistogramTrend = prevMacd ? macd.histogram - prevMacd.histogram : 0;
  const macdHistogramImproving = prevMacd ? macd.histogram > prevMacd.histogram : false;

  return {
    gain60d: gain60d != null ? Number(gain60d.toFixed(2)) : null,
    gain30d: gain30d != null ? Number(gain30d.toFixed(2)) : null,
    gain10d: gain10d != null ? Number(gain10d.toFixed(2)) : null,
    gain5d: gain5d != null ? Number(gain5d.toFixed(2)) : null,

    high60d: Number(high60d.toFixed(2)),
    low60d: Number(low60d.toFixed(2)),
    avg60d: Number(avg60d.toFixed(2)),
    ma5: ma5 != null ? Number(ma5.toFixed(2)) : null,
    ma10: ma10 != null ? Number(ma10.toFixed(2)) : null,
    ma20: ma20 != null ? Number(ma20.toFixed(2)) : null,
    ma30: ma30 != null ? Number(ma30.toFixed(2)) : null,
    ma60: Number(ma60.toFixed(2)),
    priceVsAvg: Number(priceVsAvg.toFixed(2)),
    distanceToHigh60d: Number(distanceToHigh60d.toFixed(2)),
    deviationFromMA20: deviationFromMA20 != null ? Number(deviationFromMA20.toFixed(2)) : null,
    deviationFromMA30: deviationFromMA30 != null ? Number(deviationFromMA30.toFixed(2)) : null,
    deviationFromMA60: deviationFromMA60 != null ? Number(deviationFromMA60.toFixed(2)) : null,

    avgVolume60d: Number(avgVolume60d.toFixed(0)),
    avgAmount60d: Number(avgAmount60d.toFixed(0)),
    avgTurnover60d: Number(avgTurnover60d.toFixed(2)),
    avgVolume5d: Number(avgVolume5d.toFixed(0)),
    avgAmount5d: Number(avgAmount5d.toFixed(0)),
    avgTurnover5d: Number(avgTurnover5d.toFixed(2)),
    volumeRatio5d: Number(volumeRatio5d.toFixed(2)),
    amountRatio5d: Number(amountRatio5d.toFixed(2)),

    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    volatility: Number(volatility.toFixed(2)),

    upDays,
    upDaysRatio: Number(upDaysRatio.toFixed(2)),
    consecutiveUpDays,
    consecutiveDownDays,
    isBreakoutHigh,

    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    macdBullish: macd.histogram > 0,
    macdHistogramTrend: Number(macdHistogramTrend.toFixed(4)),
    macdHistogramImproving,
    rsi,
    rsiOverbought: rsi > 70,
    rsiOversold: rsi < 30,

    limitUpCount: klines.filter(k => k.changePercent >= 9.5).length,
    lowVolumeLimitUpCount: klines.filter(k => k.changePercent >= 9.5 && k.turnoverRate < 5).length,
    recent10LimitUps: klines.slice(-10).filter(k => k.changePercent >= 9.5 && k.turnoverRate < 5).length,

    dataPoints: len,
    latestDate: latest.date
  };
}

// 基于60日数据的评分（趋势低吸策略）
function score60DayHistory(indicators) {
  const runtimeConfig = getRuntimeStrategyConfig();
  return score60DayHistoryByConfig(indicators, runtimeConfig.history?.scoring || {});
}

module.exports = {
  fetch60DayKline,
  calculate60DayIndicators,
  score60DayHistory,
  fetchIndexData,
  analyzeMarketRegime
};
