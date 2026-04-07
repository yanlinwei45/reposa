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

function getBucketConfig(runtimeConfig, key) {
  return runtimeConfig.candidateBuckets?.[key] || {};
}

function isWithinRange(value, min, max) {
  if (value == null) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

function getObservationBias(item, observationBucket = {}) {
  const changePercent = item.changePercent || 0;
  const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;
  const h = item.history || {};

  return (
    isWithinRange(changePercent, observationBucket.minChangePercent ?? 1, observationBucket.maxChangePercent ?? 6.5) &&
    isWithinRange(volumeRatio, observationBucket.minVolumeRatio ?? 1, observationBucket.maxVolumeRatio ?? 3) &&
    isWithinRange(h.distanceToHigh60d, observationBucket.minDistanceToHigh60d ?? -12, observationBucket.maxDistanceToHigh60d ?? 0) &&
    isWithinRange(h.deviationFromMA20, observationBucket.minDeviationFromMA20 ?? -2, observationBucket.maxDeviationFromMA20 ?? 8)
  );
}

function evaluateBucketQualification(item, runtimeConfig) {
  const mainBucket = getBucketConfig(runtimeConfig, 'main');
  const observationBucket = getBucketConfig(runtimeConfig, 'observation');
  const continuationBucket = getBucketConfig(runtimeConfig, 'continuation');
  const h = item.history || {};
  const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;
  const intradayScore = item.score || 0;
  const changePercent = item.changePercent || 0;
  const turnoverRatePercent = item.turnoverRatePercent || 0;

  const pullbackChecks = {
    intradayScore: intradayScore >= (mainBucket.minIntradayScore ?? 63),
    changePercent: isWithinRange(changePercent, mainBucket.minChangePercent ?? -2.8, mainBucket.maxChangePercent ?? 1.8),
    turnoverRate: isWithinRange(turnoverRatePercent, mainBucket.minTurnoverRatePercent ?? 2, mainBucket.maxTurnoverRatePercent ?? 7),
    volumeRatio: isWithinRange(volumeRatio, mainBucket.minVolumeRatio ?? 0.85, mainBucket.maxVolumeRatio ?? 1.7),
    gain60d: h.gain60d == null || h.gain60d >= (mainBucket.minGain60d ?? 2),
    gain10d: isWithinRange(h.gain10d, mainBucket.minGain10d ?? -12, mainBucket.maxGain10d ?? 8),
    gain5d: isWithinRange(h.gain5d, mainBucket.minGain5d ?? -8, mainBucket.maxGain5d ?? 2.5),
    distanceToHigh60d: isWithinRange(h.distanceToHigh60d, mainBucket.minDistanceToHigh60d ?? -18, mainBucket.maxDistanceToHigh60d ?? -5),
    deviationFromMA20: isWithinRange(h.deviationFromMA20, mainBucket.minDeviationFromMA20 ?? -6, mainBucket.maxDeviationFromMA20 ?? 2.5),
    rsi: isWithinRange(h.rsi, mainBucket.minRsi ?? 32, mainBucket.maxRsi ?? 56),
    macdHistogram: h.macdHistogram != null && h.macdHistogram >= (mainBucket.minMacdHistogram ?? -0.08),
    consecutiveDownDays: h.consecutiveDownDays == null || h.consecutiveDownDays <= (mainBucket.maxConsecutiveDownDays ?? 3),
  };

  const pullbackQualified = Object.values(pullbackChecks).every(Boolean);
  const observationChecks = {
    intradayScore: intradayScore >= (observationBucket.minIntradayScore ?? 58),
    changePercent: isWithinRange(changePercent, observationBucket.minChangePercent ?? 1, observationBucket.maxChangePercent ?? 6.5),
    turnoverRate: isWithinRange(turnoverRatePercent, observationBucket.minTurnoverRatePercent ?? 2, observationBucket.maxTurnoverRatePercent ?? 10),
    volumeRatio: isWithinRange(volumeRatio, observationBucket.minVolumeRatio ?? 1, observationBucket.maxVolumeRatio ?? 3),
    gain60d: h.gain60d == null || h.gain60d >= (observationBucket.minGain60d ?? 5),
    gain5d: h.gain5d == null || h.gain5d <= (observationBucket.maxGain5d ?? 12),
    distanceToHigh60d: isWithinRange(h.distanceToHigh60d, observationBucket.minDistanceToHigh60d ?? -12, observationBucket.maxDistanceToHigh60d ?? 0),
    deviationFromMA20: isWithinRange(h.deviationFromMA20, observationBucket.minDeviationFromMA20 ?? -2, observationBucket.maxDeviationFromMA20 ?? 8),
    rsi: isWithinRange(h.rsi, observationBucket.minRsi ?? 40, observationBucket.maxRsi ?? 72),
    macdHistogram: h.macdHistogram == null || h.macdHistogram >= (observationBucket.minMacdHistogram ?? -0.05),
  };
  const observationQualified = Object.values(observationChecks).every(Boolean);

  const continuationChecks = {
    intradayScore: intradayScore >= (continuationBucket.minIntradayScore ?? 72),
    changePercent: isWithinRange(changePercent, continuationBucket.minChangePercent ?? 0.5, continuationBucket.maxChangePercent ?? 4.5),
    turnoverRate: isWithinRange(turnoverRatePercent, continuationBucket.minTurnoverRatePercent ?? 2, continuationBucket.maxTurnoverRatePercent ?? 10),
    volumeRatio: isWithinRange(volumeRatio, continuationBucket.minVolumeRatio ?? 0.9, continuationBucket.maxVolumeRatio ?? 2.2),
    gain60d: h.gain60d == null || h.gain60d >= (continuationBucket.minGain60d ?? 5),
    gain30d: h.gain30d == null || h.gain30d >= (continuationBucket.minGain30d ?? -2),
    gain10d: h.gain10d == null || h.gain10d >= (continuationBucket.minGain10d ?? 0),
    gain5d: isWithinRange(h.gain5d, continuationBucket.minGain5d ?? 1, continuationBucket.maxGain5d ?? 10),
    distanceToHigh60d: isWithinRange(h.distanceToHigh60d, continuationBucket.minDistanceToHigh60d ?? -15, continuationBucket.maxDistanceToHigh60d ?? 1),
    deviationFromMA20: isWithinRange(h.deviationFromMA20, continuationBucket.minDeviationFromMA20 ?? -1, continuationBucket.maxDeviationFromMA20 ?? 8),
    rsi: isWithinRange(h.rsi, continuationBucket.minRsi ?? 45, continuationBucket.maxRsi ?? 68),
    macdHistogram: h.macdHistogram != null && h.macdHistogram >= (continuationBucket.minMacdHistogram ?? -0.02),
    consecutiveDownDays: h.consecutiveDownDays == null || h.consecutiveDownDays <= (continuationBucket.maxConsecutiveDownDays ?? 2),
  };
  const continuationQualified = Object.values(continuationChecks).every(Boolean);

  return {
    pullbackChecks,
    observationChecks,
    continuationChecks,
    pullbackQualified,
    observationQualified,
    continuationQualified,
    bucket: pullbackQualified
      ? 'main'
      : continuationQualified
        ? 'continuation'
        : (observationQualified ? 'observation' : 'rejected'),
    observationBias: getObservationBias(item, observationBucket),
  };
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
  if (item.strategy?.bucket === 'observation') tags.push('盘中转强');

  return tags;
}

function buildRiskTags(item) {
  const tags = [];
  const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;

  if (item.history?.distanceToHigh60d > -5) tags.push('离高点过近');
  if (item.history?.gain10d != null && item.history.gain10d < 0) tags.push('10日转弱');
  if (item.history?.maxDrawdown > 25) tags.push('回撤过深');
  if (item.history?.consecutiveDownDays >= 4) tags.push('连续下跌');
  if (volumeRatio < 0.8) tags.push('缩量过度');
  if ((item.turnover || 0) < 500000000) tags.push('成交额偏低');
  if (item.history?.degraded) tags.push('历史降级');
  if (item.strategy?.observationBias) tags.push('更像转强不是低吸');

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
  const researchIsActive = !!researchEntry && researchEntry.rankingMode !== 'fallback';
  const researchScore = researchEntry?.researchScore != null
    ? Number((researchEntry.researchScore * 100).toFixed(2))
    : null;
  const researchFloor = intradayScoring.researchUniverseMinScoreFloor ?? 55;
  const researchBonus = researchIsActive && score >= researchFloor
    ? intradayScoring.researchUniverseCandidateBonus ?? 0
    : 0;
  const preHistoryScore = Number((score + researchBonus).toFixed(4));

  return {
    ...item,
    score: Number(score.toFixed(4)),
    scoreBreakdown,
    preHistoryScore,
    signal: strategyMatched ? 'HOT' : 'WATCH',
    strategyMatched,
    researchSelected: researchIsActive,
    researchFallback: !!researchEntry && !researchIsActive,
    researchScore,
    researchRank: researchEntry?.researchRank || null,
    strategy: {
      score: Number(score.toFixed(4)),
      grade,
      positiveTags: buildPositiveTags(item),
      riskTags: buildRiskTags(item),
      bucket: 'unclassified',
      bucketLabel: '待历史确认',
      observationBias: false,
      selectedReason: {
        isMainBoard: !!item.isMainBoard,
        notST: !item.isST,
        tenPercentLimit: !!item.isTenPercentLimit,
        turnoverQualified: turnover >= marketFilters.minAmount,
        turnoverRateQualified: turnoverRatePercent >= marketFilters.minTurnoverRatePercent && turnoverRatePercent <= maxTurnoverRatePercent,
        volumeRatioQualified: volRatio >= marketFilters.minVolumeRatio && volRatio <= maxVolumeRatio,
        changePercentQualified: changePercent >= marketFilters.minChangePercent && changePercent <= maxChangePercent,
        researchSelected: researchIsActive,
        researchFallback: !!researchEntry && !researchIsActive,
      }
    }
  };
}

function buildInitialCandidatePool(scored, marketOpen, portfolioFull, runtimeConfig) {
  const intradayScoring = runtimeConfig.intradayScoring || {};
  const researchUniverse = runtimeConfig.researchUniverse || {};
  const marketFilters = runtimeConfig.marketFilters || {};
  const observationBucket = getBucketConfig(runtimeConfig, 'observation');

  const initialThreshold = marketOpen
    ? (intradayScoring.initialScoreThresholdOpen ?? 65)
    : (intradayScoring.initialScoreThresholdClosed ?? 55);
  const poolThreshold = Math.min(initialThreshold, observationBucket.minIntradayScore ?? initialThreshold);
  const candidateLimit = portfolioFull
    ? Math.min(intradayScoring.candidateLimitFullPortfolioCap ?? 60, (marketFilters.topN || 30) * (intradayScoring.candidateLimitFullPortfolioMultiplier ?? 3))
    : Math.min(intradayScoring.candidateLimitCap ?? 150, (marketFilters.topN || 30) * (intradayScoring.candidateLimitMultiplier ?? 5));

  const baseCandidates = scored.filter(item => item.score >= poolThreshold);
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
    poolThreshold,
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

function classifyCandidateBuckets(candidates, runtimeConfig) {
  const researchUniverse = runtimeConfig.researchUniverse || {};
  const enriched = candidates.map(item => {
    const qualification = evaluateBucketQualification(item, runtimeConfig);
    const bucketLabel = qualification.bucket === 'main'
      ? (getBucketConfig(runtimeConfig, 'main').label || '低吸主池')
      : qualification.bucket === 'continuation'
        ? (getBucketConfig(runtimeConfig, 'continuation').label || '趋势延续池')
      : qualification.bucket === 'observation'
        ? (getBucketConfig(runtimeConfig, 'observation').label || '转强观察')
        : '未达标';
    const strategy = {
      ...(item.strategy || {}),
      bucket: qualification.bucket,
      bucketLabel,
      observationBias: qualification.observationBias,
      pullbackChecks: qualification.pullbackChecks,
      observationChecks: qualification.observationChecks,
      continuationChecks: qualification.continuationChecks,
      selectedReason: {
        ...(item.strategy?.selectedReason || {}),
        pullbackQualified: qualification.pullbackQualified,
        observationQualified: qualification.observationQualified,
        continuationQualified: qualification.continuationQualified,
      },
    };
    const nextItem = {
      ...item,
      strategy,
    };
    nextItem.strategy.positiveTags = buildPositiveTags(nextItem);
    nextItem.strategy.riskTags = buildRiskTags(nextItem);
    return nextItem;
  });

  const mainBucket = getBucketConfig(runtimeConfig, 'main');
  const mainMaxVolumeRatio = mainBucket.maxVolumeRatio ?? 1.7;
  const recoverableCheckKeys = new Set([
    'volumeRatio',
    'gain5d',
    'distanceToHigh60d',
    'deviationFromMA20',
    'rsi',
    'macdHistogram',
  ]);

  for (const item of enriched) {
    if (item.strategy?.bucket === 'main') continue;

    const failedPullbackChecks = Object.entries(item.strategy?.pullbackChecks || {})
      .filter(([, passed]) => !passed)
      .map(([key]) => key);
    if (failedPullbackChecks.length === 0 || failedPullbackChecks.length > 2) continue;
    if (!failedPullbackChecks.every(key => recoverableCheckKeys.has(key))) continue;

    const h = item.history || {};
    const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;
    const recoverable =
      (failedPullbackChecks.includes('volumeRatio') ? volumeRatio >= 0.8 && volumeRatio <= Math.max(2, mainMaxVolumeRatio) : true) &&
      (failedPullbackChecks.includes('gain5d') ? h.gain5d != null && h.gain5d >= -8 && h.gain5d <= 4 : true) &&
      (failedPullbackChecks.includes('distanceToHigh60d') ? h.distanceToHigh60d != null && h.distanceToHigh60d >= -24 && h.distanceToHigh60d <= -4 : true) &&
      (failedPullbackChecks.includes('deviationFromMA20') ? h.deviationFromMA20 != null && h.deviationFromMA20 >= -3.5 && h.deviationFromMA20 <= 4 : true) &&
      (failedPullbackChecks.includes('rsi') ? h.rsi != null && h.rsi >= 36 && h.rsi <= 61 : true) &&
      (failedPullbackChecks.includes('macdHistogram') ? h.macdHistogram != null && h.macdHistogram >= -0.08 : true);

    if (!recoverable) continue;

    const recoveryTags = Array.isArray(item.strategy?.positiveTags) ? [...item.strategy.positiveTags] : [];
    recoveryTags.push(`接近主池:${failedPullbackChecks.join('/')}`);
    item.strategy = {
      ...(item.strategy || {}),
      bucket: 'main',
      bucketLabel: `${mainBucket.label || '趋势回踩主池'}(放宽)`,
      positiveTags: recoveryTags,
      selectedReason: {
        ...(item.strategy?.selectedReason || {}),
        pullbackQualified: true,
        recoveryPromoted: true,
        recoveryFailedChecks: failedPullbackChecks,
      },
    };
  }

  const mainPicks = enriched
    .filter(item => item.strategy?.bucket === 'main' || item.strategy?.bucket === 'continuation')
    .sort((a, b) => {
      if ((b.researchSelected ? 1 : 0) !== (a.researchSelected ? 1 : 0)) {
        return (b.researchSelected ? 1 : 0) - (a.researchSelected ? 1 : 0);
      }
      if ((a.strategy?.bucket === 'main' ? 1 : 0) !== (b.strategy?.bucket === 'main' ? 1 : 0)) {
        return (b.strategy?.bucket === 'main' ? 1 : 0) - (a.strategy?.bucket === 'main' ? 1 : 0);
      }
      return (b.combinedScore || b.preHistoryScore || b.score || 0) - (a.combinedScore || a.preHistoryScore || a.score || 0);
    });

  const observationPicks = enriched
    .filter(item => item.strategy?.bucket === 'observation' || (item.researchSelected && item.strategy?.bucket !== 'main' && item.strategy?.bucket !== 'continuation'))
    .map(item => ({ ...item }))
    .sort((a, b) => (b.combinedScore || b.preHistoryScore || b.score || 0) - (a.combinedScore || a.preHistoryScore || a.score || 0));

  return {
    enriched,
    mainPicks,
    observationPicks,
  };
}

module.exports = {
  getStrategyGrade,
  buildPositiveTags,
  buildRiskTags,
  scoreIntradayStrategy,
  buildInitialCandidatePool,
  combineCandidateScores,
  classifyCandidateBuckets,
};
