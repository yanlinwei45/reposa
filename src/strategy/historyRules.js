function score60DayHistory(indicators, scoringConfig = {}) {
  if (!indicators) return 0;

  let score = 0;

  const {
    gain60dIdealMin = 5,
    gain60dIdealMax = 25,
    gain30dIdealMin = 0,
    gain30dIdealMax = 15,
    distanceToHighIdealMin = -25,
    distanceToHighIdealMax = -5,
    gain5dIdealMin = -8,
    gain5dIdealMax = 3,
    deviationFromMA20IdealMin = -8,
    deviationFromMA20IdealMax = 4,
    rsiIdealMin = 30,
    rsiIdealMax = 55,
    macdHistogramSafe = -0.08,
    macdHistogramWeak = -0.15,
    avgAmount60dGood = 500000000,
    avgAmount60dOkay = 300000000,
    avgTurnover60dGood = 2,
    avgTurnover60dOkay = 1.5,
    maxDrawdownGood = 25,
    maxDrawdownOkay = 35,
    volatilityGood = 6,
    volatilityOkay = 8,
  } = scoringConfig;

  if (indicators.gain60d !== null) {
    if (indicators.gain60d >= gain60dIdealMin && indicators.gain60d <= gain60dIdealMax) score += 15;
    else if (indicators.gain60d > gain60dIdealMax && indicators.gain60d <= 40) score += 12;
    else if (indicators.gain60d > 40) score += 8;
    else if (indicators.gain60d >= 0 && indicators.gain60d < gain60dIdealMin) score += 5;
  }

  if (indicators.gain30d !== null) {
    if (indicators.gain30d >= gain30dIdealMin && indicators.gain30d <= gain30dIdealMax) score += 10;
    else if (indicators.gain30d > gain30dIdealMax && indicators.gain30d <= 25) score += 7;
    else if (indicators.gain30d > 25) score += 5;
  }

  if (indicators.ma20 && indicators.ma60 && indicators.ma20 > indicators.ma60) score += 5;

  if (indicators.distanceToHigh60d >= distanceToHighIdealMin && indicators.distanceToHigh60d <= distanceToHighIdealMax) score += 15;
  else if (indicators.distanceToHigh60d > distanceToHighIdealMax && indicators.distanceToHigh60d <= -3) score += 8;
  else if (indicators.distanceToHigh60d > -30 && indicators.distanceToHigh60d < distanceToHighIdealMin) score += 8;

  if (indicators.gain5d !== null) {
    if (indicators.gain5d >= gain5dIdealMin && indicators.gain5d <= gain5dIdealMax) score += 10;
    else if (indicators.gain5d > gain5dIdealMax && indicators.gain5d <= 5) score += 5;
  }

  if (indicators.deviationFromMA20 !== null) {
    const dev = indicators.deviationFromMA20;
    if (dev >= deviationFromMA20IdealMin && dev <= deviationFromMA20IdealMax) score += 5;
    else if (dev >= -12 && dev < deviationFromMA20IdealMin) score += 3;
  }

  if (indicators.consecutiveDownDays <= 3) score += 5;
  else if (indicators.consecutiveDownDays === 4) score += 3;

  if (indicators.macdHistogram > macdHistogramSafe) score += 8;
  else if (indicators.macdHistogram > macdHistogramWeak) score += 5;

  if (indicators.rsi >= rsiIdealMin && indicators.rsi <= rsiIdealMax) score += 7;
  else if (indicators.rsi > rsiIdealMax && indicators.rsi <= 60) score += 5;
  else if (indicators.rsi < 30) score -= 3;

  if (indicators.avgAmount60d >= avgAmount60dGood) score += 5;
  else if (indicators.avgAmount60d >= avgAmount60dOkay) score += 3;

  if (indicators.avgTurnover60d >= avgTurnover60dGood) score += 5;
  else if (indicators.avgTurnover60d >= avgTurnover60dOkay) score += 3;

  if (indicators.maxDrawdown <= maxDrawdownGood) score += 5;
  else if (indicators.maxDrawdown <= maxDrawdownOkay) score += 3;

  if (indicators.volatility <= volatilityGood) score += 5;
  else if (indicators.volatility <= volatilityOkay) score += 3;

  if (indicators.consecutiveDownDays >= 5) score -= 10;
  if (indicators.maxDrawdown > 40) score -= 10;
  if (indicators.distanceToHigh60d > -5) score -= 8;
  if (indicators.gain10d !== null && indicators.gain10d < -10) score -= 8;

  return Math.max(0, Math.min(100, score));
}

function evaluateHistoryFilters(item, historyConfig = {}) {
  const filters = historyConfig.filters || {};
  const degradedPolicy = historyConfig.degradedDataPolicy || {};
  const isResearchSelected = !!item.researchSelected;
  const sampleBase = {
    symbol: item.symbol,
    name: item.name,
    score: item.score || 0,
    historyScore: item.historyScore || 0,
    price: item.price || 0,
  };
  const continuationProfile = (() => {
    const h = item.history || {};
    return (
      h.gain60d != null && h.gain60d >= 10 &&
      h.gain30d != null && h.gain30d >= 0 &&
      h.gain10d != null && h.gain10d >= 0 &&
      h.gain5d != null && h.gain5d >= 1 && h.gain5d <= 6.5 &&
      h.distanceToHigh60d != null && h.distanceToHigh60d >= -22 && h.distanceToHigh60d <= 0 &&
      h.deviationFromMA20 != null && h.deviationFromMA20 >= 0 && h.deviationFromMA20 <= 16 &&
      h.rsi != null && h.rsi >= 45 && h.rsi <= 64 &&
      h.macdHistogram != null && h.macdHistogram >= 0 &&
      (item.turnover || 0) >= 500000000
    );
  })();

  if (!item.history) {
    return { passed: false, reasonKey: 'noHistory', reason: '无历史数据', detail: sampleBase };
  }

  const h = item.history;
  if (h.degraded) {
    if (degradedPolicy.allowTrading === false) {
      return { passed: false, reasonKey: 'degradedHistory', reason: '历史数据降级不可交易', detail: sampleBase };
    }
    return { passed: true };
  }

  if (h.gain60d === null || h.gain60d < (filters.minGain60d ?? 2)) {
    return { passed: false, reasonKey: 'trend60dLow', reason: `60日涨幅${h.gain60d}%不足${filters.minGain60d ?? 2}%`, detail: { ...sampleBase, gain60d: h.gain60d } };
  }

  if (!continuationProfile && h.gain30d !== null && h.gain30d < (filters.minGain30d ?? -3)) {
    return { passed: false, reasonKey: 'trend30dLow', reason: `30日涨幅${h.gain30d}%不足${filters.minGain30d ?? -3}%`, detail: { ...sampleBase, gain30d: h.gain30d } };
  }

  if (!continuationProfile && h.gain10d !== null && h.gain10d < (filters.minGain10d ?? -12)) {
    return { passed: false, reasonKey: 'gain10dTooLow', reason: `10日跌幅${h.gain10d}%过大`, detail: { ...sampleBase, gain10d: h.gain10d } };
  }

  const maxGain5d = isResearchSelected
    ? (filters.researchMaxGain5d ?? filters.maxGain5d ?? 4)
    : (filters.maxGain5d ?? 4);
  if (!continuationProfile && h.gain5d !== null && (h.gain5d > maxGain5d || h.gain5d < (filters.minGain5d ?? -10))) {
    return { passed: false, reasonKey: 'gain5dOutOfRange', reason: `5日涨幅${h.gain5d}%不在${filters.minGain5d ?? -10}%~${maxGain5d}%`, detail: { ...sampleBase, gain5d: h.gain5d } };
  }

  if (h.maxDrawdown > (filters.maxDrawdown ?? 35)) {
    return { passed: false, reasonKey: 'maxDrawdownHigh', reason: `最大回撤${h.maxDrawdown}%过深`, detail: { ...sampleBase, maxDrawdown: h.maxDrawdown } };
  }

  if (!continuationProfile && (h.distanceToHigh60d > (filters.maxDistanceToHigh60d ?? -3) || h.distanceToHigh60d < (filters.minDistanceToHigh60d ?? -30))) {
    return { passed: false, reasonKey: 'distanceToHighInvalid', reason: `距高点${h.distanceToHigh60d}%不在${filters.minDistanceToHigh60d ?? -30}%~${filters.maxDistanceToHigh60d ?? -3}%`, detail: { ...sampleBase, distanceToHigh60d: h.distanceToHigh60d } };
  }

  if (h.consecutiveDownDays > (filters.maxConsecutiveDownDays ?? 5)) {
    return { passed: false, reasonKey: 'consecutiveDown', reason: `连续下跌${h.consecutiveDownDays}天`, detail: { ...sampleBase, consecutiveDownDays: h.consecutiveDownDays } };
  }

  if (h.ma20 && h.ma60 && h.ma20 <= h.ma60 * (filters.ma20BelowMa60Ratio ?? 0.95)) {
    return { passed: false, reasonKey: 'maTrendInvalid', reason: `MA20(${h.ma20})明显弱于MA60(${h.ma60})`, detail: { ...sampleBase, ma20: h.ma20, ma60: h.ma60 } };
  }

  if (h.ma60 && item.price < h.ma60 * (filters.priceVsMa60Floor ?? 0.94)) {
    return { passed: false, reasonKey: 'belowMa60', reason: `价格${item.price}明显跌破MA60(${h.ma60})`, detail: { ...sampleBase, ma60: h.ma60 } };
  }

  const maxRsi = isResearchSelected
    ? (filters.researchMaxRsi ?? filters.maxRsi ?? 65)
    : (filters.maxRsi ?? 65);
  if (!continuationProfile && (h.rsi < (filters.minRsi ?? 28) || h.rsi > maxRsi)) {
    return { passed: false, reasonKey: 'rsiOutOfRange', reason: `RSI${h.rsi}不在${filters.minRsi ?? 28}~${maxRsi}`, detail: { ...sampleBase, rsi: h.rsi } };
  }

  const minMacdHistogram = isResearchSelected
    ? (filters.researchMinMacdHistogram ?? filters.minMacdHistogram ?? -0.2)
    : (filters.minMacdHistogram ?? -0.2);
  if (!continuationProfile && h.macdHistogram < minMacdHistogram) {
    return { passed: false, reasonKey: 'macdTooWeak', reason: `MACD柱${h.macdHistogram}过弱`, detail: { ...sampleBase, macdHistogram: h.macdHistogram } };
  }

  if (h.avgAmount60d < (filters.minAvgAmount60d ?? 200000000)) {
    return { passed: false, reasonKey: 'avgAmountLow', reason: `60日均额${(h.avgAmount60d / 1e8).toFixed(2)}亿不足${((filters.minAvgAmount60d ?? 200000000) / 1e8).toFixed(0)}亿`, detail: { ...sampleBase, avgAmount60d: h.avgAmount60d } };
  }

  const minAvgTurnover60d = isResearchSelected
    ? (filters.researchMinAvgTurnover60d ?? filters.minAvgTurnover60d ?? 1)
    : (filters.minAvgTurnover60d ?? 1);
  if (h.avgTurnover60d < minAvgTurnover60d) {
    return { passed: false, reasonKey: 'avgTurnoverLow', reason: `60日均换手${h.avgTurnover60d}%不足${minAvgTurnover60d}%`, detail: { ...sampleBase, avgTurnover60d: h.avgTurnover60d } };
  }

  if ((item.historyScore || 0) < (filters.minHistoryScore ?? 50)) {
    return { passed: false, reasonKey: 'historyScoreLow', reason: `历史评分${item.historyScore}分不足${filters.minHistoryScore ?? 50}`, detail: sampleBase };
  }

  return { passed: true };
}

module.exports = {
  score60DayHistory,
  evaluateHistoryFilters,
};
