const fs = require('fs');
const path = require('path');

// 获取大盘指数数据（上证指数，使用 context.request 绕过 CORS）
async function fetchIndexData(context) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&lmt=60&_=${Date.now()}`;

  try {
    const response = await context.request.get(url);
    const text = await response.text();
    const data = JSON.parse(text);

    if (!data || !data.data || !data.data.klines) {
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
    console.error(`[INDEX] 获取上证指数失败:`, err.message);
    return null;
  }
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
async function fetch60DayKline(symbol, context) {
  const code = symbol.replace(/^(sh|sz)/, '');
  const market = symbol.startsWith('sh') ? 1 : 0;
  const secid = `${market}.${code}`;

  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=20500101&lmt=60&_=${Date.now()}`;

  try {
    const response = await context.request.get(url);
    const text = await response.text();
    const data = JSON.parse(text);
    if (!data || !data.data || !data.data.klines) {
      return null;
    }

    const klines = data.data.klines.map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],           // 日期
        open: Number(parts[1]),   // 开盘价
        close: Number(parts[2]),  // 收盘价
        high: Number(parts[3]),   // 最高价
        low: Number(parts[4]),    // 最低价
        volume: Number(parts[5]), // 成交量
        amount: Number(parts[6]), // 成交额
        amplitude: Number(parts[7]), // 振幅
        changePercent: Number(parts[8]), // 涨跌幅
        changeAmount: Number(parts[9]),  // 涨跌额
        turnoverRate: Number(parts[10])  // 换手率
      };
    });

    // 只取最近60天的数据（API的lmt参数不可靠）
    return klines.slice(-60);
  } catch (err) {
    console.error(`[KLINE] 获取${symbol}历史数据失败:`, err.message);
    return null;
  }
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

  // 缩量涨停统计（强势信号）
  // 涨停：涨幅≥9.5%，缩量：换手率<5%
  const limitUpDays = klines.filter(k => k.changePercent >= 9.5);
  const lowVolumeLimitUps = limitUpDays.filter(k => k.turnoverRate < 5);
  const recent10LimitUps = klines.slice(-10).filter(k => k.changePercent >= 9.5 && k.turnoverRate < 5).length;

  // 最高价和最低价
  const high60d = Math.max(...prices);
  const low60d = Math.min(...prices);

  // 最大回撤（用累计收益率计算，避免复权数据失真）
  let maxDrawdown = 0;
  let cumulativeReturn = 1.0; // 累计收益率
  let peakReturn = 1.0; // 峰值收益率

  for (const k of klines) {
    // 累计收益率 = 前一天累计收益率 × (1 + 当日涨跌幅%)
    cumulativeReturn *= (1 + k.changePercent / 100);

    // 更新峰值
    if (cumulativeReturn > peakReturn) {
      peakReturn = cumulativeReturn;
    }

    // 计算从峰值的回撤
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

  // 是否突破60日新高
  const isBreakoutHigh = latest.close >= high60d * 0.98;

  // 价格相对60日均线位置
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

  return {
    // 涨幅指标
    gain60d: gain60d ? Number(gain60d.toFixed(2)) : null,
    gain30d: gain30d ? Number(gain30d.toFixed(2)) : null,
    gain10d: gain10d ? Number(gain10d.toFixed(2)) : null,
    gain5d: gain5d ? Number(gain5d.toFixed(2)) : null,

    // 价格指标
    high60d: Number(high60d.toFixed(2)),
    low60d: Number(low60d.toFixed(2)),
    avg60d: Number(avg60d.toFixed(2)),
    priceVsAvg: Number(priceVsAvg.toFixed(2)),

    // 量能指标
    avgVolume60d: Number(avgVolume60d.toFixed(0)),
    avgAmount60d: Number(avgAmount60d.toFixed(0)),
    avgTurnover60d: Number(avgTurnover60d.toFixed(2)),
    avgVolume5d: Number(avgVolume5d.toFixed(0)),
    avgAmount5d: Number(avgAmount5d.toFixed(0)),
    avgTurnover5d: Number(avgTurnover5d.toFixed(2)),
    volumeRatio5d: Number(volumeRatio5d.toFixed(2)),
    amountRatio5d: Number(amountRatio5d.toFixed(2)),

    // 风险指标
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    volatility: Number(volatility.toFixed(2)),

    // 趋势指标
    upDays,
    upDaysRatio: Number(upDaysRatio.toFixed(2)),
    consecutiveUpDays,
    consecutiveDownDays,
    isBreakoutHigh,

    // 技术指标
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    macdBullish: macd.histogram > 0,  // MACD柱状图为正（多头）
    rsi,
    rsiOverbought: rsi > 70,   // 超买
    rsiOversold: rsi < 30,     // 超卖

    // 涨停统计（强势信号）
    limitUpCount: limitUpDays.length,           // 60日涨停次数
    lowVolumeLimitUpCount: lowVolumeLimitUps.length, // 60日缩量涨停次数
    recent10LimitUps,                           // 近10日缩量涨停次数

    // 元数据
    dataPoints: len,
    latestDate: latest.date
  };
}

// 基于60日数据的评分
function score60DayHistory(indicators) {
  if (!indicators) return 0;

  let score = 0;

  // 趋势得分（30分）
  if (indicators.gain60d !== null) {
    if (indicators.gain60d >= 20 && indicators.gain60d <= 40) score += 10;
    else if (indicators.gain60d >= 40 && indicators.gain60d <= 60) score += 8;
    else if (indicators.gain60d >= 0 && indicators.gain60d < 20) score += 5;
  }

  if (indicators.isBreakoutHigh) score += 10;
  if (indicators.priceVsAvg > 0) score += 5;
  if (indicators.consecutiveUpDays >= 3) score += 5;

  // 量能得分（25分）
  if (indicators.volumeRatio5d >= 2) score += 10;
  else if (indicators.volumeRatio5d >= 1.5) score += 7;

  if (indicators.avgAmount60d >= 1000000000) score += 5;
  else if (indicators.avgAmount60d >= 500000000) score += 3;

  if (indicators.avgTurnover5d > indicators.avgTurnover60d * 1.5) score += 10;
  else if (indicators.avgTurnover5d > indicators.avgTurnover60d * 1.2) score += 5;

  // 稳定性得分（20分）
  if (indicators.volatility < 3) score += 10;
  else if (indicators.volatility < 5) score += 7;
  else if (indicators.volatility < 7) score += 3;

  if (indicators.maxDrawdown < 15) score += 10;
  else if (indicators.maxDrawdown < 25) score += 5;

  // 强度得分（15分）
  if (indicators.upDaysRatio >= 55) score += 10;
  else if (indicators.upDaysRatio >= 50) score += 7;
  else if (indicators.upDaysRatio >= 45) score += 5;

  if (indicators.gain5d !== null && indicators.gain5d > 0) score += 5;

  // 缩量涨停加分（10分）- 强势信号
  if (indicators.recent10LimitUps >= 2) score += 10;  // 近10日有2次以上缩量涨停
  else if (indicators.recent10LimitUps >= 1) score += 5;  // 近10日有1次缩量涨停

  // 技术指标得分（15分）
  if (indicators.macdBullish && indicators.macdHistogram > 0.1) score += 8;  // MACD多头强势
  else if (indicators.macdBullish) score += 5;  // MACD多头

  if (indicators.rsi >= 50 && indicators.rsi <= 70) score += 7;  // RSI健康区间
  else if (indicators.rsi > 70) score -= 5;  // RSI超买，扣分
  else if (indicators.rsi < 30) score -= 3;  // RSI超卖，扣分

  // 风险扣分
  if (indicators.consecutiveDownDays >= 5) score -= 10; // 连续下跌
  if (indicators.maxDrawdown > 30) score -= 10; // 回撤过大

  return Math.max(0, Math.min(100, score));
}

module.exports = {
  fetch60DayKline,
  calculate60DayIndicators,
  score60DayHistory,
  fetchIndexData,
  analyzeMarketRegime
};
