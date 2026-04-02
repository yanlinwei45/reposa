function scoreTurnoverRatePercent(v) {
  if (v >= 2 && v <= 4) return 20;
  if (v > 4 && v <= 6) return 18;
  if (v > 6 && v <= 8) return 15;
  if (v > 8) return 10;
  return 0;
}

function scoreVolumeRatio(v) {
  if (v >= 0.9 && v <= 1.3) return 25;
  if (v > 1.3 && v <= 1.6) return 22;
  if (v >= 0.8 && v < 0.9) return 18;
  if (v > 1.6 && v <= 1.8) return 15;
  if (v > 1.8) return 10;
  return 0;
}

function scoreChangePercent(v, maxChangePercent) {
  if (v < -3 || v > maxChangePercent) return 0;
  if (v >= -1 && v <= 1) return 25;
  if (v > 1 && v <= 2) return 22;
  if (v >= -2 && v < -1) return 20;
  if (v > 2 && v <= 2.5) return 18;
  if (v >= -3 && v < -2) return 15;
  return 0;
}

function scoreTurnoverAmount(v) {
  if (v >= 1000000000) return 20;
  if (v >= 500000000) return 15;
  if (v >= 300000000) return 10;
  return 0;
}

function scoreNearHigh(item) {
  const high = item.high || 0;
  const price = item.price || 0;
  if (!high || !price) return 0;
  const drawdownPct = ((high - price) / price) * 100;
  return drawdownPct <= 1.5 ? 5 : 0;
}

function scoreAboveOpen(item) {
  const open = item.open || 0;
  const price = item.price || 0;
  if (!open || !price) return 0;
  return price > open ? 5 : 0;
}

function getStrategyGrade(score, marketFilters = {}) {
  const a = marketFilters.gradeAThreshold == null ? 80 : marketFilters.gradeAThreshold;
  const b = marketFilters.gradeBThreshold == null ? 65 : marketFilters.gradeBThreshold;
  const c = marketFilters.gradeCThreshold == null ? 50 : marketFilters.gradeCThreshold;
  if (score >= a) return 'A';
  if (score >= b) return 'B';
  if (score >= c) return 'C';
  return 'DROP';
}

function buildPositiveTags(item) {
  const tags = [];
  const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;

  if (item.history?.distanceToHigh60d >= -20 && item.history?.distanceToHigh60d <= -8) tags.push('回撤到位');
  if (item.history?.deviationFromMA20 >= -3 && item.history?.deviationFromMA20 <= 3) tags.push('接近MA20');
  if (item.history?.rsi >= 35 && item.history?.rsi <= 50) tags.push('RSI低位');
  if (item.history?.macdHistogram > -0.05 && item.history?.macdHistogram < 0.1) tags.push('MACD修复');
  if (volumeRatio >= 0.9 && volumeRatio <= 1.6) tags.push('温和承接');
  if (item.history?.gain60d > 8) tags.push('趋势向上');
  if ((item.turnover || 0) >= 500000000) tags.push('成交额充足');
  if (item.researchSelected) tags.push('研究层入选');

  return tags;
}

function buildRiskTags(item) {
  const tags = [];
  const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;

  if (item.history?.distanceToHigh60d > -5) tags.push('离高点过近');
  if (item.history?.maxDrawdown > 25) tags.push('回撤过深');
  if (item.history?.consecutiveDownDays >= 4) tags.push('连续下跌');
  if (volumeRatio < 0.8) tags.push('缩量过度');
  if ((item.turnover || 0) < 500000000) tags.push('成交额偏低');
  if (item.history?.degraded) tags.push('历史降级');

  return tags;
}

function scoreIntradayStrategy(item, runtimeConfig, researchWatchlistMap = new Map()) {
  const marketFilters = runtimeConfig.marketFilters || {};
  const intradayScoring = runtimeConfig.intradayScoring || {};
  const componentWeights = intradayScoring.componentWeights || {};

  const turnoverRatePercent = item.turnoverRatePercent || 0;
  const volRatio = item.volumeBurstRatio || item.volumeRatio || 0;
  const changePercent = item.changePercent || 0;
  const turnover = item.turnover || 0;
  const maxChangePercent = marketFilters.maxChangePercent == null ? 2.5 : marketFilters.maxChangePercent;
  const maxTurnoverRatePercent = marketFilters.maxTurnoverRatePercent == null ? 8 : marketFilters.maxTurnoverRatePercent;
  const maxVolumeRatio = marketFilters.maxVolumeRatio == null ? 1.8 : marketFilters.maxVolumeRatio;

  const hardMatched =
    !!item.isMainBoard &&
    !item.isST &&
    !!item.isTenPercentLimit &&
    turnoverRatePercent >= marketFilters.minTurnoverRatePercent &&
    turnoverRatePercent <= maxTurnoverRatePercent &&
    volRatio >= marketFilters.minVolumeRatio &&
    volRatio <= maxVolumeRatio &&
    changePercent >= marketFilters.minChangePercent &&
    changePercent <= maxChangePercent &&
    turnover >= marketFilters.minAmount;

  const scoreBreakdown = {
    turnoverRate: Math.min(componentWeights.turnoverRate || 20, scoreTurnoverRatePercent(turnoverRatePercent)),
    volumeRatio: Math.min(componentWeights.volumeRatio || 25, scoreVolumeRatio(volRatio)),
    changePercent: Math.min(componentWeights.changePercent || 25, scoreChangePercent(changePercent, maxChangePercent)),
    turnoverAmount: Math.min(componentWeights.turnoverAmount || 20, scoreTurnoverAmount(turnover)),
    nearHigh: Math.min(componentWeights.nearHigh || 5, scoreNearHigh(item)),
    aboveOpen: Math.min(componentWeights.aboveOpen || 5, scoreAboveOpen(item)),
  };

  const rawScore = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  const score = Math.min(rawScore, 100);
  const grade = getStrategyGrade(score, marketFilters);
  const strategyMatched = hardMatched && grade !== 'DROP';

  const researchEntry = researchWatchlistMap.get(item.symbol) || null;
  const researchScore = researchEntry?.researchScore != null
    ? Number((researchEntry.researchScore * 100).toFixed(2))
    : null;
  const researchFloor = intradayScoring.researchUniverseMinScoreFloor ?? 55;
  const researchBonus = researchEntry && score >= researchFloor
    ? intradayScoring.researchUniverseCandidateBonus ?? 0
    : 0;

  return {
    ...item,
    score: Number(score.toFixed(4)),
    scoreBreakdown,
    preHistoryScore: Number((score + researchBonus).toFixed(4)),
    signal: strategyMatched ? 'HOT' : 'WATCH',
    strategyMatched,
    researchSelected: !!researchEntry,
    researchScore,
    researchRank: researchEntry?.researchRank || null,
    strategy: {
      score: Number(score.toFixed(4)),
      grade,
      positiveTags: buildPositiveTags(item),
      riskTags: buildRiskTags(item),
      selectedReason: {
        isMainBoard: !!item.isMainBoard,
        notST: !item.isST,
        tenPercentLimit: !!item.isTenPercentLimit,
        turnoverQualified: turnover >= marketFilters.minAmount,
        turnoverRateQualified: turnoverRatePercent >= marketFilters.minTurnoverRatePercent && turnoverRatePercent <= maxTurnoverRatePercent,
        volumeRatioQualified: volRatio >= marketFilters.minVolumeRatio && volRatio <= maxVolumeRatio,
        changePercentQualified: changePercent >= marketFilters.minChangePercent && changePercent <= maxChangePercent,
        researchSelected: !!researchEntry,
      }
    }
  };
}

function buildInitialCandidatePool(scored, marketOpen, portfolioFull, runtimeConfig) {
  const intradayScoring = runtimeConfig.intradayScoring || {};
  const researchUniverse = runtimeConfig.researchUniverse || {};
  const marketFilters = runtimeConfig.marketFilters || {};

  const initialThreshold = marketOpen
    ? (intradayScoring.initialScoreThresholdOpen ?? 65)
    : (intradayScoring.initialScoreThresholdClosed ?? 55);
  const candidateLimit = portfolioFull
    ? Math.min(intradayScoring.candidateLimitFullPortfolioCap ?? 60, (marketFilters.topN || 30) * (intradayScoring.candidateLimitFullPortfolioMultiplier ?? 3))
    : Math.min(intradayScoring.candidateLimitCap ?? 150, (marketFilters.topN || 30) * (intradayScoring.candidateLimitMultiplier ?? 5));

  const baseCandidates = scored.filter(item => item.score >= initialThreshold);
  const researchCandidates = researchUniverse.enabled
    ? scored.filter(item => item.researchSelected && item.score >= (intradayScoring.researchUniverseMinScoreFloor ?? 55))
    : [];

  let candidates;
  if (researchUniverse.enabled && researchUniverse.mode === 'strict') {
    candidates = researchCandidates;
  } else {
    const merged = new Map();
    for (const item of [...baseCandidates, ...researchCandidates]) {
      merged.set(item.symbol, item);
    }
    candidates = Array.from(merged.values());
  }

  candidates = candidates
    .sort((a, b) => {
      if ((b.researchSelected ? 1 : 0) !== (a.researchSelected ? 1 : 0)) {
        return (b.researchSelected ? 1 : 0) - (a.researchSelected ? 1 : 0);
      }
      return (b.preHistoryScore || b.score || 0) - (a.preHistoryScore || a.score || 0);
    })
    .slice(0, candidateLimit);

  return {
    initialThreshold,
    candidateLimit,
    candidates,
    researchCandidateCount: researchCandidates.length,
    baseCandidateCount: baseCandidates.length,
  };
}

function combineCandidateScores(item, runtimeConfig) {
  const combineWeights = runtimeConfig.history?.combineWeights || {};
  const researchUniverse = runtimeConfig.researchUniverse || {};
  const dayWeight = combineWeights.day ?? 0.5;
  const historyWeight = combineWeights.history ?? 0.5;
  const researchWeight = combineWeights.research ?? 0;
  const researchComponent = item.researchScore || 0;
  const finalBonus = item.researchSelected ? (researchUniverse.finalScoreBonus ?? 0) : 0;

  const combined = (
    (item.score || 0) * dayWeight +
    (item.historyScore || 0) * historyWeight +
    researchComponent * researchWeight +
    finalBonus
  );

  return Number(combined.toFixed(2));
}

module.exports = {
  getStrategyGrade,
  buildPositiveTags,
  buildRiskTags,
  scoreIntradayStrategy,
  buildInitialCandidatePool,
  combineCandidateScores,
};
