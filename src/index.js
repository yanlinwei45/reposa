const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { fetch60DayKline, calculate60DayIndicators, score60DayHistory, fetchIndexData, analyzeMarketRegime } = require('./history');
const { getRuntimeStrategyConfig, getBacktestConfig } = require('./strategy/config');
const { loadResearchWatchlist } = require('./strategy/watchlist');
const {
  buildPositiveTags,
  buildRiskTags,
  getSelectedBucketDayScore,
  scoreIntradayStrategy,
  buildInitialCandidatePool,
  combineCandidateScores,
  classifyCandidateBuckets,
} = require('./strategy/runtimeRules');
const { evaluateHistoryFilters } = require('./strategy/historyRules');
const ScanLogger = require('./scanLogger');
const { toBeijingTime, formatBeijingTime, isSameDay, getHistoryCacheDateKey, getTradingDaysBetween, canSellToday } = require('./utils/time');
const { formatWan, formatPct } = require('./utils/format');
const { normalizeSymbol, isMainBoardCode, isLikelyStName, toEastmoneyUrl } = require('./utils/symbol');
const { createApiRoutes, serveFrontend } = require('./server/routes');
const { renderHtml, renderPaperHtml, renderLogsHtml } = require('./render/legacyPages');

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function decodeLatin1ToUtf8(text) {
  try { return Buffer.from(text, 'latin1').toString('utf8'); } catch (_) { return text; }
}

function loadResearchBestParams() {
  const bestParamsPath = path.join(__dirname, '..', 'research', 'data', 'results', 'best_params.json');
  if (!fs.existsSync(bestParamsPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(bestParamsPath, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return {
      ...data,
      params: null,
    };
  } catch (_) {
    return null;
  }
}

function loadConfig() {
  const configDir = path.join(__dirname, '..', 'config');
  const configPath = path.join(configDir, 'default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const runtimeStrategyConfig = getRuntimeStrategyConfig();
  const backtestConfig = getBacktestConfig();
  const optimizedResearch = loadResearchBestParams();
  const deriveCooldownMinutes = (cfg) => (
    cfg?.reentryCooldownDays != null ? Number(cfg.reentryCooldownDays) * 24 * 60 : null
  );
  if (!config.server) config.server = {};
  if (!config.server.port || Number(config.server.port) === 3000) config.server.port = 3088;
  if (!config.marketScan) config.marketScan = {};
  if (!config.marketScan.scanIntervalMs) config.marketScan.scanIntervalMs = 180000;
  if (!config.marketScan.scanIntervalOffHoursMs) config.marketScan.scanIntervalOffHoursMs = 600000;
  if (config.marketScan.maxPages == null) config.marketScan.maxPages = 25;
  if (config.marketScan.pageSize == null) config.marketScan.pageSize = 200;
  if (config.marketScan.pageLoadWaitMs == null) config.marketScan.pageLoadWaitMs = 3500;
  if (config.marketScan.pageTurnWaitMs == null) config.marketScan.pageTurnWaitMs = 2200;
  if (config.marketScan.headless == null) config.marketScan.headless = true;
  if (config.marketScan.listUrl == null) config.marketScan.listUrl = 'https://quote.eastmoney.com/center/gridlist.html#hs_a_board';
  if (!config.strategy) config.strategy = {};
  config.strategy = {
    ...runtimeStrategyConfig.marketFilters,
    ...config.strategy,
  };
  if (!config.paperTrading) config.paperTrading = {};
  config.paperTrading = {
    maxPositions: backtestConfig.maxPositions,
    lotSize: backtestConfig.lotSize,
    slippageBp: backtestConfig.slippageBp,
    feeBp: backtestConfig.feeBp,
    maxHoldDays: backtestConfig.maxHoldDays,
    stopLossPct: backtestConfig.stopLossPct,
    takeProfitPct: backtestConfig.takeProfitPct,
    takeProfitPartialPct: backtestConfig.takeProfitPartialPct,
    weakTakeProfitPct: backtestConfig.weakTakeProfitPct,
    exitDrawdownFromHighPct: backtestConfig.exitDrawdownFromHighPct,
    ...config.paperTrading,
  };
  if (optimizedResearch?.backtest_config && config.paperTrading.useResearchBestParams !== false) {
    config.paperTrading = {
      ...config.paperTrading,
      maxPositions: optimizedResearch.backtest_config.maxPositions ?? config.paperTrading.maxPositions,
      lotSize: optimizedResearch.backtest_config.lotSize ?? config.paperTrading.lotSize,
      slippageBp: optimizedResearch.backtest_config.slippageBp ?? config.paperTrading.slippageBp,
      feeBp: optimizedResearch.backtest_config.feeBp ?? config.paperTrading.feeBp,
      maxHoldDays: optimizedResearch.hold_days ?? config.paperTrading.maxHoldDays,
      stopLossPct: optimizedResearch.backtest_config.stopLossPct ?? config.paperTrading.stopLossPct,
      takeProfitPct: optimizedResearch.backtest_config.takeProfitPct ?? config.paperTrading.takeProfitPct,
      takeProfitPartialPct: optimizedResearch.backtest_config.takeProfitPartialPct ?? config.paperTrading.takeProfitPartialPct,
      weakTakeProfitPct: optimizedResearch.backtest_config.weakTakeProfitPct ?? config.paperTrading.weakTakeProfitPct,
      exitDrawdownFromHighPct: optimizedResearch.backtest_config.exitDrawdownFromHighPct ?? config.paperTrading.exitDrawdownFromHighPct,
    };
  }
  const targetCooldownMinutes = deriveCooldownMinutes(optimizedResearch?.backtest_config) ?? deriveCooldownMinutes(backtestConfig);
  if (targetCooldownMinutes != null && (config.paperTrading.buyCooldownMinutes == null || config.paperTrading.buyCooldownMinutes === 60)) {
    config.paperTrading.buyCooldownMinutes = targetCooldownMinutes;
  }
  const runtimeContinuation = runtimeStrategyConfig.candidateBuckets?.continuation || {};
  const currentAdaptive = config.paperTrading.adaptive || {};
  const currentContinuationBand = currentAdaptive.continuationBand || {};
  config.paperTrading.adaptive = {
    ...currentAdaptive,
    continuationBand: {
      ...currentContinuationBand,
      minDayScore: runtimeContinuation.minTradeableDayScore ?? runtimeContinuation.minIntradayScore ?? currentContinuationBand.minDayScore,
      minHistoryScore: runtimeContinuation.minTradeableHistoryScore ?? currentContinuationBand.minHistoryScore,
      minCombinedScore: runtimeContinuation.minTradeableCombinedScore ?? currentContinuationBand.minCombinedScore,
      maxGain60d: runtimeContinuation.maxTradeableGain60d ?? currentContinuationBand.maxGain60d,
      maxDrawdown: runtimeContinuation.maxTradeableMaxDrawdown ?? currentContinuationBand.maxDrawdown,
      maxDeviationFromMA20: runtimeContinuation.maxTradeableDeviationFromMA20 ?? currentContinuationBand.maxDeviationFromMA20,
      maxVolumeRatio: runtimeContinuation.maxTradeableVolumeRatio ?? currentContinuationBand.maxVolumeRatio,
      minSignalStrength: currentContinuationBand.minSignalStrength ?? 4,
    }
  };
  config.runtimeStrategy = runtimeStrategyConfig;
  config.optimizedResearch = optimizedResearch;
  return config;
}

function appendJsonLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function safeNumber(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/,/g, '').replace(/%/g, '').replace(/亿/g, '').trim();
  if (!s || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatThresholdValue(value, digits = 2) {
  if (!Number.isFinite(value)) return '-';
  const normalized = Number(value.toFixed(digits));
  return Number.isInteger(normalized) ? String(normalized) : String(normalized);
}

function formatFailedChecks(checks, actualValues = {}, labels = {}) {
  return checks.map((key) => {
    const label = labels[key] || key;
    const actual = actualValues[key];
    if (!actual || actual.value == null) return label;
    const op = actual.op || '<=';
    const thresholdText = formatThresholdValue(actual.threshold);
    const valueText = formatThresholdValue(actual.value);
    return `${label}:${valueText}${op}${thresholdText}`;
  });
}

function isProfitProtectedPosition(pos = {}) {
  const pnlPct = Number(pos.pnlPct || 0);
  const entryBucket = pos.entryBucket || 'main';
  const liveBucket = pos.liveBucket || entryBucket;
  const exitUrgency = Number(pos.exitUrgency || 0);
  const selectedDayScore = Number(pos.liveSelectedDayScore || pos.entrySelectedDayScore || pos.entryScore || 0);
  return pnlPct >= 0.5 &&
    entryBucket === 'continuation' &&
    liveBucket === 'continuation' &&
    selectedDayScore >= 84 &&
    exitUrgency < 60;
}

function parseAmountText(text) {
  const s = String(text || '').replace(/,/g, '').trim();
  if (!s || s === '-' || s === '--') return null;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (s.includes('万亿')) return n * 1000000000000;
  if (s.includes('亿')) return n * 100000000;
  if (s.includes('万')) return n * 10000;
  return n;
}

function isMarketOpen(date = new Date()) {
  const bjTime = toBeijingTime(date);
  const day = bjTime.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hours = bjTime.getUTCHours();
  const minutes = bjTime.getUTCMinutes();
  const timeInMinutes = hours * 60 + minutes;
  const morningStart = 9 * 60 + 30;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;
  return (timeInMinutes >= morningStart && timeInMinutes <= morningEnd) ||
         (timeInMinutes >= afternoonStart && timeInMinutes <= afternoonEnd);
}

function getBeijingMinutes(date = new Date()) {
  const bjTime = toBeijingTime(date);
  return bjTime.getUTCHours() * 60 + bjTime.getUTCMinutes();
}

function isLateAfternoonSession(date = new Date(), cutoffMinutes = 13 * 60 + 30) {
  const timeInMinutes = getBeijingMinutes(date);
  return timeInMinutes >= cutoffMinutes && timeInMinutes <= (15 * 60);
}

function extractScoreFromReason(reason) {
  const text = String(reason || '');
  const matched = text.match(/综合(\d+(?:\.\d+)?)分/);
  if (!matched) return null;
  const score = Number(matched[1]);
  return Number.isFinite(score) ? score : null;
}

function extractConfidenceFromReason(reason) {
  const text = String(reason || '');
  const matched = text.match(/置信度([A-Z]+)/);
  return matched?.[1] || null;
}

function extractOrderScore(order = {}) {
  const directScore = Number(order.combinedScore ?? order.entryScore ?? 0);
  if (Number.isFinite(directScore) && directScore > 0) return directScore;
  return extractScoreFromReason(order.reason) || 0;
}

function extractOrderConfidence(order = {}) {
  return order.confidence || extractConfidenceFromReason(order.reason) || 'UNKNOWN';
}

function getPullbackFromHighPct(item = {}) {
  const high = Number(item.high || 0);
  const price = Number(item.price || 0);
  if (!high || !price) return null;
  return ((high - price) / high) * 100;
}

function getOpenDrawdownPct(item = {}) {
  const open = Number(item.open || 0);
  const low = Number(item.low || 0);
  if (!open || !low) return null;
  return ((open - low) / open) * 100;
}

function mergeHistoryIntoMarketItems(items = [], historyMap = new Map()) {
  const runtimeStrategy = getRuntimeStrategyConfig();
  return items.map(item => {
    const cachedHistory = historyMap?.get(item.symbol);
    if (!cachedHistory) return item;
    return {
      ...item,
      history: cachedHistory.indicators,
      historyScore: cachedHistory.historyScore,
      combinedScore: combineCandidateScores({
        ...item,
        historyScore: cachedHistory.historyScore,
      }, runtimeStrategy),
      researchSelected: item.researchSelected || false,
    };
  });
}

function summarizeFilterStats(filterStats = {}) {
  const labels = {
    noHistory: '无历史数据',
    trend60dLow: '60日趋势不足',
    trend30dLow: '30日趋势不足',
    gain10dTooLow: '10日跌幅过大',
    gain5dOutOfRange: '5日回调不符',
    maxDrawdownHigh: '回撤过深',
    distanceToHighInvalid: '离高点位置不对',
    consecutiveDown: '连续下跌过多',
    maTrendInvalid: '均线趋势不对',
    belowMa60: '跌破MA60',
    rsiOutOfRange: 'RSI不在低吸区',
    macdTooWeak: 'MACD过弱',
    avgAmountLow: '成交额不足',
    avgTurnoverLow: '换手率过低',
    historyScoreLow: '历史评分不足',
    degradedHistory: '历史降级',
  };

  return summarizeCountMap(filterStats, labels);
}

function summarizeCountMap(countMap = {}, labels = {}, limit = Infinity) {
  return Object.entries(countMap)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, label: labels[key] || key, count }));
}

function incrementCount(countMap = {}, key, amount = 1) {
  if (!key) return;
  countMap[key] = (countMap[key] || 0) + amount;
}

function getFailedChecks(checks = {}) {
  return Object.entries(checks || {})
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
}

function createEmptyScanDiagnostics(overrides = {}) {
  return {
    initialCandidateCount: 0,
    finalPickCount: 0,
    observationCount: 0,
    researchCandidateCount: 0,
    tradeableAfterHistoryCount: 0,
    bucketDistribution: [],
    mainRejectSummary: [],
    observationRejectSummary: [],
    continuationRejectSummary: [],
    continuationDemotionSummary: [],
    bucketSamples: [],
    filterStats: {},
    filterSummary: [],
    filteredSamples: [],
    tradeDecision: createEmptyTradeDiagnostics(),
    ...overrides,
  };
}

function createEmptyTradeDiagnostics(overrides = {}) {
  return {
    ts: null,
    marketRegime: 'UNKNOWN',
    marketOpen: false,
    portfolioDrawdown: 0,
    recoveryMode: false,
    strategyCandidateCount: 0,
    buyCandidateCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    positionsBefore: 0,
    positionsAfter: 0,
    availablePositions: 0,
    skippedReason: null,
    rejectSummary: [],
    accepted: [],
    rejected: [],
    ...overrides,
  };
}

const BUCKET_LABELS = {
  main: '低吸主池',
  continuation: '趋势延续池',
  observation: '转强观察',
  rejected: '未达标',
};

const BUCKET_CHECK_LABELS = {
  intradayScore: '日内分不足',
  changePercent: '涨幅条件不符',
  turnoverRate: '换手率不符',
  volumeRatio: '量比不符',
  gain60d: '60日趋势不符',
  gain30d: '30日趋势不符',
  gain10d: '10日趋势不符',
  gain5d: '5日强弱不符',
  distanceToHigh60d: '距高点位置不符',
  deviationFromMA20: '偏离MA20不符',
  rsi: 'RSI不符',
  macdHistogram: 'MACD不符',
  consecutiveDownDays: '连跌天数不符',
  historyScore: '历史分不足',
  combinedScore: '综合分不足',
  maxDrawdown: '回撤过深',
};

const TRADE_REJECT_LABELS = {
  bucketNotTradeable: '不在可交易池',
  marketUnknown: '市场状态未知',
  alreadyHolding: '已有持仓',
  cooldown: '卖出冷却期',
  sectorLimit: '行业集中度超限',
  continuationWeak: '趋势延续确认不足',
  recoveryHighOnly: '恢复模式仅允许HIGH',
  recoveryTooHot: '恢复模式过热',
  scoreTooLow: '综合/历史分不足',
  bearRegimeBlock: '熊市限制',
  lowConfidenceBlocked: '低置信度被禁',
  lowBandPenalty: '低分段反馈过差',
  mediumBandPenalty: '中分段反馈过差',
  highBandPenalty: '高分段反馈过差',
  drawdownPressure: '回撤压力过大',
  outsidePreferredWindow: '不在首选开仓窗口',
  afternoonBlocked: '午后开仓禁止',
  mediumCutoff: '午后中置信度截止',
  latestCutoff: '最新开仓截止',
  mediumWeak: '中分段确认不足',
  overnightRisk: '隔夜风险过高',
  entryQuality: '早盘承接不足',
  insufficientLot: '建议仓位不足一手',
  other: '其他原因',
};

function buildBucketDiagnostics(classified = {}) {
  const bucketDistribution = {};
  const mainRejectStats = {};
  const observationRejectStats = {};
  const continuationRejectStats = {};
  const continuationDemotionStats = {};
  const bucketSamples = [];

  for (const item of classified.enriched || []) {
    const bucket = item.strategy?.bucket || 'rejected';
    incrementCount(bucketDistribution, bucket);

    if (bucket !== 'main' && bucket !== 'continuation') {
      for (const key of getFailedChecks(item.strategy?.pullbackChecks)) {
        incrementCount(mainRejectStats, key);
      }
    }

    if (bucket === 'rejected') {
      for (const key of getFailedChecks(item.strategy?.observationChecks)) {
        incrementCount(observationRejectStats, key);
      }
      for (const key of getFailedChecks(item.strategy?.continuationChecks)) {
        incrementCount(continuationRejectStats, key);
      }
    }

    for (const key of item.strategy?.selectedReason?.continuationRejectedChecks || []) {
      incrementCount(continuationDemotionStats, key);
    }

    if (bucketSamples.length >= 10) continue;
    if (bucket === 'main' || bucket === 'continuation') continue;
    bucketSamples.push({
      symbol: item.symbol,
      name: item.name,
      bucket,
      bucketLabel: item.strategy?.bucketLabel || BUCKET_LABELS[bucket] || bucket,
      dayScore: item.score || 0,
      historyScore: item.historyScore || 0,
      combinedScore: item.combinedScore || 0,
      failedPullback: getFailedChecks(item.strategy?.pullbackChecks).slice(0, 3),
      failedObservation: getFailedChecks(item.strategy?.observationChecks).slice(0, 3),
      failedContinuation: getFailedChecks(item.strategy?.continuationChecks).slice(0, 3),
    });
  }

  return {
    tradeableAfterHistoryCount: (classified.mainPicks || []).length,
    bucketDistribution: summarizeCountMap(bucketDistribution, BUCKET_LABELS),
    mainRejectSummary: summarizeCountMap(mainRejectStats, BUCKET_CHECK_LABELS, 8),
    observationRejectSummary: summarizeCountMap(observationRejectStats, BUCKET_CHECK_LABELS, 8),
    continuationRejectSummary: summarizeCountMap(continuationRejectStats, BUCKET_CHECK_LABELS, 8),
    continuationDemotionSummary: summarizeCountMap(continuationDemotionStats, BUCKET_CHECK_LABELS, 8),
    bucketSamples,
  };
}

function normalizeTradeRejectReason(reason = '') {
  if (reason.includes('仅低吸主池/趋势延续池允许开仓')) return 'bucketNotTradeable';
  if (reason.includes('市场状态未知')) return 'marketUnknown';
  if (reason.includes('已持仓')) return 'alreadyHolding';
  if (reason.includes('冷却期')) return 'cooldown';
  if (reason.includes('已有2只')) return 'sectorLimit';
  if (reason.startsWith('趋势延续确认不足(')) return 'continuationWeak';
  if (reason.startsWith('回撤恢复模式仅允许HIGH开仓')) return 'recoveryHighOnly';
  if (reason.startsWith('回撤恢复模式拒绝短线过热')) return 'recoveryTooHot';
  if (reason.includes('综合') && reason.includes('历史') && reason.includes('不足')) return 'scoreTooLow';
  if (reason.includes('熊市')) return 'bearRegimeBlock';
  if (reason.includes('禁止低置信度开仓')) return 'lowConfidenceBlocked';
  if (reason.startsWith('近期低分段表现差')) return 'lowBandPenalty';
  if (reason.startsWith('近期中分段表现差')) return 'mediumBandPenalty';
  if (reason.startsWith('近期高分段表现差')) return 'highBandPenalty';
  if (reason.startsWith('组合回撤压力')) return 'drawdownPressure';
  if (reason.startsWith('当前不在首选开仓窗口')) return 'outsidePreferredWindow';
  if (reason.startsWith('策略仅允许上午窗口开仓')) return 'afternoonBlocked';
  if (reason.includes('中置信度开仓')) return 'mediumCutoff';
  if (reason.includes('停止新开仓')) return 'latestCutoff';
  if (reason.startsWith('中分段确认不足(')) return 'mediumWeak';
  if (reason.startsWith('隔夜风险过高(')) return 'overnightRisk';
  if (reason.startsWith('早盘承接不足(')) return 'entryQuality';
  if (reason.startsWith('建议仓位不足')) return 'insufficientLot';
  return 'other';
}

function buildTradeDecisionDiagnostics(tradeDecisionLog = {}, overrides = {}) {
  const rejected = tradeDecisionLog.rejected || [];
  const accepted = tradeDecisionLog.accepted || [];
  const rejectStats = {};

  for (const item of rejected) {
    incrementCount(rejectStats, normalizeTradeRejectReason(item.reason));
  }

  return {
    ...createEmptyTradeDiagnostics(),
    ...overrides,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    rejectSummary: summarizeCountMap(rejectStats, TRADE_REJECT_LABELS, 8),
    accepted: accepted.slice(0, 8),
    rejected: rejected.slice(0, 12).map(item => ({
      ...item,
      rejectCategory: TRADE_REJECT_LABELS[normalizeTradeRejectReason(item.reason)] || TRADE_REJECT_LABELS.other,
    })),
  };
}

function getIntradayDataQuality(scored = [], ts = new Date()) {
  const bjTime = toBeijingTime(ts);
  const minutes = bjTime.getUTCHours() * 60 + bjTime.getUTCMinutes();
  const beforeOpen = minutes < (9 * 60 + 30);
  const sample = scored.filter(item => item && item.isMainBoard);
  const total = sample.length || 1;
  const missingTurnoverRate = sample.filter(item => !(item.turnoverRatePercent > 0)).length;
  const missingVolumeRatio = sample.filter(item => !((item.volumeBurstRatio || item.volumeRatio || 0) > 0)).length;
  const missingTurnover = sample.filter(item => !((item.turnover || 0) > 0)).length;
  const incompleteRatio = Math.max(
    missingTurnoverRate / total,
    missingVolumeRatio / total,
    missingTurnover / total
  );

  return {
    beforeOpen,
    total,
    missingTurnoverRate,
    missingVolumeRatio,
    missingTurnover,
    incompleteRatio: Number(incompleteRatio.toFixed(4)),
    insufficient: beforeOpen || incompleteRatio >= 0.35,
  };
}

function buildObservationPool(candidates = [], runtimeStrategy = {}, limit = 12) {
  const filters = runtimeStrategy.history?.filters || {};
  return candidates
    .filter(item => {
      if (item.strategy?.bucket === 'observation') return true;
      const h = item.history || {};
      if (!h || h.degraded) return !!item.researchSelected;
      if ((item.historyScore || 0) < Math.max(45, (filters.minHistoryScore ?? 50) - 5)) return false;
      if (h.gain5d != null && h.gain5d > ((filters.researchMaxGain5d ?? filters.maxGain5d ?? 4) + 4)) return false;
      if (h.rsi != null && h.rsi > ((filters.researchMaxRsi ?? filters.maxRsi ?? 65) + 4)) return false;
      return true;
    })
    .sort((a, b) => {
      if ((b.researchSelected ? 1 : 0) !== (a.researchSelected ? 1 : 0)) {
        return (b.researchSelected ? 1 : 0) - (a.researchSelected ? 1 : 0);
      }
      return (b.combinedScore || b.preHistoryScore || b.score || 0) - (a.combinedScore || a.preHistoryScore || a.score || 0);
    })
    .slice(0, limit);
}

function getEffectiveCombinedScore(item = {}, runtimeStrategy = {}) {
  const selectedDayScore = getSelectedBucketDayScore(item);
  if (item.strategy?.bucket === 'continuation' || item.strategy?.bucket === 'observation') {
    const combineWeights = runtimeStrategy.history?.combineWeights || {};
    const researchUniverse = runtimeStrategy.researchUniverse || {};
    const dayWeight = combineWeights.day ?? 0.5;
    const historyWeight = combineWeights.history ?? 0.5;
    const researchWeight = combineWeights.research ?? 0;
    const researchComponent = item.researchScore;
    const hasResearchComponent = researchComponent != null;
    const finalBonus = item.researchSelected ? (researchUniverse.finalScoreBonus ?? 0) : 0;
    const totalWeight = dayWeight + historyWeight + (hasResearchComponent ? researchWeight : 0);
    const combined = (
      selectedDayScore * dayWeight +
      (item.historyScore || 0) * historyWeight +
      ((hasResearchComponent ? researchComponent : 0) * researchWeight)
    );
    return Number(((totalWeight > 0 ? combined / totalWeight : 0) + finalBonus).toFixed(2));
  }
  return Number((item.combinedScore || item.score || 0).toFixed(2));
}

function filterMainBoardTenPercent(items) {
  return items.filter(item => item && item.isMainBoard && !item.isST && item.isTenPercentLimit);
}

async function fetchRealtimePricesForSymbols(symbols) {
  if (!symbols.length) return [];
  const https = require('https');
  const secids = symbols.map(sym => {
    const market = sym.startsWith('sh') ? 1 : 0;
    const code = sym.replace(/^(sh|sz)/, '');
    return `${market}.${code}`;
  }).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f12,f13,f14`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          const diff = obj?.data?.diff || [];
          resolve(diff.map(row => ({
            symbol: normalizeSymbol(String(row.f12 || '')),
            name: String(row.f14 || ''),
            price: row.f2 != null ? Number(row.f2) / 100 : null,
            changePercent: row.f3 != null ? Number(row.f3) / 100 : null,
          })).filter(r => r.symbol && r.price));
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

// 保留旧渲染函数供过渡使用
function renderHtmlLegacy(state, config) {
  const marketRegime = state.marketRegime || {};
  const regimeColor = marketRegime.regime === 'BULL' ? '#ef4444' : marketRegime.regime === 'BEAR' ? '#22c55e' : '#9ca3af';
  const regimeText = marketRegime.regime === 'BULL' ? '牛市' : marketRegime.regime === 'BEAR' ? '熊市' : marketRegime.regime === 'NEUTRAL' ? '震荡' : '未知';
  const adaptive = global.paperAccountRef?.getAdaptiveConfig ? global.paperAccountRef.getAdaptiveConfig() : null;
  const regimeMultipliers = adaptive?.regimeMultipliers || {};
  const latestLog = global.scanLoggerRef?.getLatestLog ? global.scanLoggerRef.getLatestLog() : null;
  const historyFilterStep = latestLog?.steps?.find(step => step.step === '60日历史数据严格筛选');
  const filterStats = historyFilterStep?.data?.filterStats || {};
  const filterReasonLabels = {
    noHistory: '无历史数据',
    trend60dLow: '60日趋势不足',
    trend30dLow: '30日趋势不足',
    gain10dTooLow: '10日跌幅过大',
    gain5dOutOfRange: '5日回调不符',
    maxDrawdownHigh: '回撤过深',
    distanceToHighInvalid: '离高点位置不对',
    consecutiveDown: '连续下跌过多',
    maTrendInvalid: '均线趋势不对',
    belowMa60: '跌破MA60',
    rsiOutOfRange: 'RSI不在低吸区',
    macdTooWeak: 'MACD过弱',
    avgAmountLow: '成交额不足',
    avgTurnoverLow: '换手率过低',
    historyScoreLow: '历史评分不足'
  };
  const topFilterReasons = Object.entries(filterStats)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `${filterReasonLabels[key] || key} ${count}只`);

  const fallbackPicks = Array.isArray(state.market)
    ? state.market
        .sort((a, b) => {
          const aHasHistory = a.historyScore != null ? 1 : 0;
          const bHasHistory = b.historyScore != null ? 1 : 0;
          if (bHasHistory !== aHasHistory) return bHasHistory - aHasHistory;
          return (b.combinedScore || b.score || 0) - (a.combinedScore || a.score || 0);
        })
        .slice(0, 30)
    : [];
  const displayPicks = state.strategyPicks.length > 0 ? state.strategyPicks : fallbackPicks;
  const usingFallback = state.strategyPicks.length === 0;
  const fallbackDiagnosis = usingFallback
    ? [
        state.marketCount === 0 ? '当前行情抓取为空，需先确认数据源是否正常' : '',
        state.marketCount > 0 && topFilterReasons.length === 0 ? '当前没有进入最终候选，可能是样本抓取偏少或筛选阈值仍偏严' : '',
        state.market?.length > 0 && !state.market.some(item => (item.score || 0) >= 60) ? '当日中高分候选偏少，说明当前盘面与低吸模型匹配度不高' : ''
      ].filter(Boolean).slice(0, 3)
    : [];
  const diagnosisItems = topFilterReasons.length ? topFilterReasons : fallbackDiagnosis;
  const picksDiagnosis = usingFallback && diagnosisItems.length
    ? `本轮 picks=0，主要原因：${diagnosisItems.join('、')}`
    : '';

  const rows = displayPicks.map((item, idx) => {
    const strategy = item.strategy || {};
    const history = item.history || {};
    const positiveTags = Array.isArray(strategy.positiveTags) ? strategy.positiveTags.join('、') : '';
    const riskTags = Array.isArray(strategy.riskTags) ? strategy.riskTags.join('、') : '';
    const grade = strategy.grade || '';
    const historyScore = item.historyScore ?? '-';
    const combinedScore = item.combinedScore ?? item.score ?? '-';
    const gain60d = history.gain60d != null ? history.gain60d.toFixed(1) + '%' : '-';
    const macd = history.macd != null ? history.macd.toFixed(3) : '-';
    const rsi = history.rsi != null ? history.rsi.toFixed(1) : '-';
    const todayKey = getHistoryCacheDateKey();
    const historyUpdated = item.historyUpdatedAt || '';
    const isToday = historyUpdated === todayKey;
    const isDegraded = history.degraded === true;
    let historyLabel = '';
    let historyUpdateStyle = 'color:#9ca3af';
    if (isDegraded) {
      historyLabel = '降级';
      historyUpdateStyle = 'color:#f59e0b;font-weight:600';
    } else if (isToday) {
      historyLabel = '今日';
      historyUpdateStyle = 'color:#22c55e;font-weight:600';
    } else if (historyUpdated) {
      historyLabel = historyUpdated;
    } else {
      historyLabel = '旧缓存';
    }
    return `<tr><td>${idx + 1}</td><td>${item.symbol || ''}</td><td>${item.name || ''}</td><td style="font-size:12px;color:#9ca3af">${item.sector || '-'}</td><td>${item.price ?? ''}</td><td class="${(item.changePercent || 0) >= 0 ? 'up' : 'down'}">${item.changePercent ?? ''}%</td><td>${item.turnoverRatePercent ?? ''}%</td><td>${item.volumeBurstRatio ?? item.volumeRatio ?? ''}</td><td>${item.turnover ? (item.turnover/1e8).toFixed(2) : ''}亿</td><td>${item.score ?? ''}</td><td>${historyScore}</td><td><strong>${combinedScore}</strong></td><td>${gain60d}</td><td>${macd}</td><td>${rsi}</td><td style="font-size:11px;${historyUpdateStyle}">${historyLabel}</td><td><span class="badge grade grade-${String(grade).toLowerCase()}">${grade || '-'}</span></td><td class="tags">${positiveTags || '-'}</td><td><div style="display:flex;gap:8px;align-items:center"><a href="${item.eastmoneyUrl}" target="_blank" rel="noreferrer">东财</a><button data-symbol="${item.symbol}" data-name="${(item.name || '').replace(/"/g, '&quot;')}" data-price="${item.price ?? ''}" onclick="manualBuy(this)" style="padding:4px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">买入</button></div></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>A股扫描</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#0b1020;color:#e5e7eb}.wrap{max-width:1800px;margin:0 auto;padding:24px}.nav{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.nav a{display:inline-block;padding:8px 14px;border:1px solid #334155;border-radius:999px;background:#111827;color:#cbd5e1;text-decoration:none}.nav a.active{background:#2563eb;color:#fff;border-color:#2563eb}h1{margin:0 0 16px;font-size:28px}.muted{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:16px 0 20px}.card{background:#111827;border:1px solid#1f2937;border-radius:14px;padding:16px}.big{font-size:24px;font-weight:700;margin-top:8px}.rule{margin:10px 0 0;line-height:1.7}.notice{margin:14px 0;padding:12px 14px;background:#111827;border:1px solid #334155;border-radius:12px;color:#cbd5e1}.diagnosis-list{margin-top:8px;line-height:1.8;color:#fcd34d;font-size:13px}table{width:100%;border-collapse:collapse;background:#111827;border-radius:14px;overflow:hidden}th,td{padding:10px 8px;border-bottom:1px solid #1f2937;font-size:13px;text-align:left;vertical-align:middle}th{background:#0f172a;color:#cbd5e1;position:sticky;top:0;font-weight:600}.up{color:#ef4444}.down{color:#22c55e}.badge{padding:4px 8px;border-radius:999px;font-size:12px;font-weight:600;display:inline-block}.badge.strong{background:rgba(239,68,68,.15);color:#fca5a5}.badge.watch{background:rgba(59,130,246,.15);color:#93c5fd}.badge.grade-a{background:rgba(34,197,94,.15);color:#86efac}.badge.grade-b{background:rgba(59,130,246,.15);color:#93c5fd}.badge.grade-c{background:rgba(250,204,21,.15);color:#fde68a}.badge.grade-drop{background:rgba(156,163,175,.15);color:#d1d5db}.tags{max-width:200px;white-space:normal;line-height:1.5}.tags.risk{color:#fca5a5}a{color:#93c5fd;text-decoration:none}@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}}@media(max-width:640px){.grid{grid-template-columns:1fr;}}</style></head><body><div class="wrap"><div class="nav"><a href="/" class="active">扫描看板</a><a href="/paper">模拟盘看板</a><a href="/logs">扫描日志</a></div><h1>趋势低吸策略看板（东方财富口径）</h1><div class="muted rule">硬过滤：仅沪深主板、非ST、10%涨跌幅标的；换手率 ${config.strategy.minTurnoverRatePercent}%~${config.strategy.maxTurnoverRatePercent}%；量比 ${config.strategy.minVolumeRatio}~${config.strategy.maxVolumeRatio}；涨幅 ${config.strategy.minChangePercent}%~${config.strategy.maxChangePercent}%；成交额 ≥ ${(config.strategy.minAmount / 1e8).toFixed(1)}亿。策略核心：寻找60日趋势向上、短线回调到均线支撑、技术指标企稳的个股。</div><div class="notice">价格、涨跌幅、换手率、量比、成交额、持仓盈亏均为实时扫描；60日K线、MACD、RSI、历史评分按天更新一次。</div>${usingFallback ? '<div class="notice">当前无最终策略候选，以下展示市场中评分靠前的股票，便于观察盘面。</div>' : ''}${picksDiagnosis ? `<div class="notice"><strong>picks=0 诊断</strong><div class="diagnosis-list">${diagnosisItems.join('<br/>')}</div></div>` : ''}<div class="grid"><div class="card"><div class="muted">市场环境</div><div class="big" style="color:${regimeColor}">${regimeText}</div><div class="muted" style="margin-top:4px;font-size:12px">上证 ${marketRegime.current || '-'}</div></div><div class="card"><div class="muted">股票池数量</div><div class="big">${state.marketCount}</div></div><div class="card"><div class="muted">命中数量</div><div class="big">${state.strategyPicks.length}</div></div><div class="card"><div class="muted">最后扫描时间</div><div class="big" style="font-size:16px">${state.lastScanAt || '-'}</div></div><div class="card"><div class="muted">扫描轮次</div><div class="big">${state.scanRounds}</div></div><div class="card"><div class="muted">自适应状态</div><div class="muted" style="margin-top:8px;font-size:13px;line-height:1.8">高置信≥${adaptive?.confidenceBands?.high?.minScore ?? 85}分<br/>中置信≥${adaptive?.confidenceBands?.medium?.minScore ?? 75}分<br/>低置信≥${adaptive?.confidenceBands?.low?.minScore ?? 70}分<br/>牛市仓位${Math.round((regimeMultipliers.BULL?.positionSize || 1) * 100)}% · 震荡${Math.round((regimeMultipliers.NEUTRAL?.positionSize || 0.7) * 100)}% · 熊市${Math.round((regimeMultipliers.BEAR?.positionSize || 0.5) * 100)}%<br/>退出紧迫度阈值≥${adaptive?.exitUrgencyThreshold ?? 100}</div></div></div><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>行业</th><th>现价</th><th>涨跌幅</th><th>换手率</th><th>量比</th><th>成交额</th><th>日评分</th><th>历史分</th><th>综合分</th><th>60日涨幅</th><th>MACD</th><th>RSI</th><th>历史更新时间</th><th>等级</th><th>标签</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="19" class="muted">等待扫描数据...</td></tr>'}</tbody></table></div><script>const AUTO_REFRESH_MS=15000;const SCROLL_KEY='scroll:'+location.pathname;const saveScroll=()=>sessionStorage.setItem(SCROLL_KEY,String(window.scrollY||0));window.addEventListener('scroll',saveScroll,{passive:true});window.addEventListener('beforeunload',saveScroll);window.addEventListener('load',()=>{const y=Number(sessionStorage.getItem(SCROLL_KEY)||0);if(y>0) window.scrollTo(0,y);setTimeout(()=>{saveScroll();location.reload();},AUTO_REFRESH_MS);});async function manualBuy(button){const symbol=button.dataset.symbol;const name=button.dataset.name;const price=Number(button.dataset.price);if(!price){alert('无法获取价格');return;}const amountInput=prompt('请输入买入金额（万元）:','20');if(!amountInput)return;const amount=parseFloat(amountInput);if(isNaN(amount)||amount<=0){alert('金额无效');return;}const amountInYuan=amount*10000;const estimatedQty=Math.floor(amountInYuan/price/100)*100;if(estimatedQty<100){alert('金额不足买入一手');return;}if(!confirm('买入 '+symbol+' '+name+'\\n价格: '+price+'\\n金额: '+amount+'万元\\n预计: '+estimatedQty+'股\\n\\n确认买入?'))return;try{const resp=await fetch('/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol,name,price,amount:amountInYuan})});const result=await resp.json();if(result.success){alert('买入成功: '+result.message);location.reload();}else{alert('买入失败: '+result.error);}}catch(err){alert('买入失败: '+err.message);}}</script></body></html>`;
}

function renderPaperHtmlLegacy(state, portfolio, config) {
  const marketRegime = state.marketRegime || {};
  const regimeColor = marketRegime.regime === 'BULL' ? '#ef4444' : marketRegime.regime === 'BEAR' ? '#22c55e' : '#9ca3af';
  const regimeText = marketRegime.regime === 'BULL' ? '牛市' : marketRegime.regime === 'BEAR' ? '熊市' : marketRegime.regime === 'NEUTRAL' ? '震荡' : '未知';
  const performanceFeedback = portfolio?.performanceFeedback || {};
  const latestLog = global.scanLoggerRef?.getLatestLog ? global.scanLoggerRef.getLatestLog() : null;
  const historyFilterStep = latestLog?.steps?.find(step => step.step === '60日历史数据严格筛选');
  const filterStats = historyFilterStep?.data?.filterStats || {};
  const filterLabels = {
    noHistory: '无历史数据',
    trend60dLow: '60日趋势不足',
    trend30dLow: '30日趋势不足',
    gain10dTooLow: '10日跌幅过大',
    gain5dOutOfRange: '5日回调不符',
    maxDrawdownHigh: '回撤过深',
    distanceToHighInvalid: '离高点位置不对',
    consecutiveDown: '连续下跌过多',
    maTrendInvalid: '均线趋势不对',
    belowMa60: '跌破MA60',
    rsiOutOfRange: 'RSI不在低吸区',
    macdTooWeak: 'MACD过弱',
    avgAmountLow: '成交额不足',
    avgTurnoverLow: '换手率过低',
    historyScoreLow: '历史评分不足'
  };
  const filterRanking = Object.entries(filterStats)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({ label: filterLabels[key] || key, count }));
  const missedSamples = Array.isArray(historyFilterStep?.data?.filtered) ? historyFilterStep.data.filtered.slice(0, 8) : [];
  const historyFilterBefore = Number(historyFilterStep?.data?.before || 0);
  const historyFilterAfter = Number(historyFilterStep?.data?.after || 0);
  const historyRejectRate = historyFilterBefore > 0 ? Number((((historyFilterBefore - historyFilterAfter) / historyFilterBefore) * 100).toFixed(1)) : 0;

  const stopLossPct = config.paperTrading?.stopLossPct || -5;
  const takeProfitPct = config.paperTrading?.takeProfitPct || 10;
  const weakTakeProfitPct = config.paperTrading?.weakTakeProfitPct || 8;
  const trailingDrawdownPct = config.paperTrading?.exitDrawdownFromHighPct || 4;

  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const positionRows = positions.map((pos, idx) => {
    const stopLossPrice = pos.entryPrice ? (pos.entryPrice * (1 + stopLossPct / 100)).toFixed(3) : '-';
    const isStrongTrend = (pos.combinedScore || pos.entryScore || 0) >= 80 || pos.confidence === 'HIGH';
    const exitGuide = isStrongTrend ? `高点回撤${trailingDrawdownPct}%` : `${weakTakeProfitPct}%目标 / 回撤${trailingDrawdownPct}%`;
    const exitSignal = isStrongTrend ? '强票：趋势没坏就拿，优先看回撤保护' : '弱票：先看目标位，转弱也走';
    const fromHigh = pos.highPrice && pos.currentPrice ? (((pos.currentPrice - pos.highPrice) / pos.highPrice) * 100).toFixed(1) : null;
    return `
    <tr>
      <td>${idx + 1}</td>
      <td>${pos.symbol || '-'}</td>
      <td>${pos.name || '-'}</td>
      <td style="font-size:12px;color:#9ca3af">${pos.sector || '-'}</td>
      <td>${pos.entryPrice != null ? pos.entryPrice.toFixed(3) : '-'}</td>
      <td>${pos.currentPrice != null ? pos.currentPrice.toFixed(3) : '-'}</td>
      <td style="font-size:12px;color:#22c55e">${stopLossPrice}</td>
      <td style="font-size:12px;color:#f59e0b">${exitGuide}</td>
      <td style="font-size:12px;color:#9ca3af">${exitSignal}</td>
      <td style="font-size:12px;color:#9ca3af">${pos.highPrice != null ? pos.highPrice.toFixed(3) : '-'}</td>
      <td style="font-size:12px;color:${fromHigh !== null && Number(fromHigh) < -3 ? '#f59e0b' : '#9ca3af'}">${fromHigh !== null ? fromHigh + '%' : '-'}</td>
      <td>${pos.quantity ?? '-'}</td>
      <td>${formatWan(pos.value)}</td>
      <td class="${(pos.pnlPct || 0) >= 0 ? 'up' : 'down'}">${formatPct(pos.pnlPct)}</td>
      <td>${pos.holdDays ?? 0}天</td>
      <td>${pos.entryDate || '-'}</td>
      <td><button onclick="manualSell('${pos.symbol}','${pos.name}')" style="padding:4px 12px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px">卖出</button></td>
    </tr>
  `;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>模拟盘看板</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#0b1020;color:#e5e7eb}.wrap{max-width:1680px;margin:0 auto;padding:24px}.nav{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.nav a{display:inline-block;padding:8px 14px;border:1px solid #334155;border-radius:999px;background:#111827;color:#cbd5e1;text-decoration:none}.nav a.active{background:#2563eb;color:#fff;border-color:#2563eb}.muted{color:#9ca3af}h1{margin:0 0 8px;font-size:28px}h3{margin:0 0 12px;font-size:18px}.sub{margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:16px 0 20px}.card{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px}.big{font-size:28px;font-weight:700;margin-top:8px}.big.up{color:#ef4444}.big.down{color:#22c55e}.panel{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px;margin-bottom:16px}.market-info{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}.market-item{background:#0f172a;padding:10px;border-radius:8px}.market-item .label{font-size:12px;color:#9ca3af;margin-bottom:4px}.market-item .value{font-size:18px;font-weight:600}table{width:100%;border-collapse:collapse;background:#111827;border-radius:14px;overflow:hidden}th,td{padding:12px 10px;border-bottom:1px solid #1f2937;font-size:14px;text-align:left;vertical-align:middle}th{background:#0f172a;color:#cbd5e1}.up{color:#ef4444}.down{color:#22c55e}.svgbox{width:100%;min-height:280px;background:#0f172a;border:1px solid #1f2937;border-radius:12px;padding:8px;box-sizing:border-box}.empty{padding:24px 0;color:#9ca3af;text-align:center}.tabs{display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid #1f2937}.tab{padding:10px 16px;cursor:pointer;border-bottom:2px solid transparent;color:#9ca3af;transition:all .2s}.tab.active{color:#60a5fa;border-bottom-color:#60a5fa}.tab-content{display:none}.tab-content.active{display:block}.diagnosis-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.mini-list{list-style:none;margin:0;padding:0}.mini-list li{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;margin-bottom:6px;background:#0f172a;border-radius:8px;font-size:13px}.mini-list .label{color:#cbd5e1}.mini-list .value{color:#f59e0b;font-weight:600}.mini-list .value.up{color:#ef4444}.mini-list .value.down{color:#22c55e}.mini-list .sub{display:block;color:#9ca3af;font-size:12px;margin-top:4px}.hint{font-size:12px;color:#9ca3af;line-height:1.7}.section-title{font-size:14px;font-weight:600;margin:0 0 10px;color:#cbd5e1}@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}.diagnosis-grid{grid-template-columns:1fr;}}</style></head><body><div class="wrap"><div class="nav"><a href="/">扫描看板</a><a href="/paper" class="active">模拟盘看板</a><a href="/logs">扫描日志</a></div><h1>模拟盘可视化看板</h1><div class="sub muted">最后扫描时间：${state.lastScanAt || '-'} · 扫描轮次：${state.scanRounds}</div><div class="panel"><h3>市场环境</h3><div style="display:flex;align-items:center;gap:16px;margin-bottom:12px"><div style="font-size:32px;font-weight:700;color:${regimeColor}">${regimeText}</div><div class="muted">上证指数 ${marketRegime.current || '-'}</div></div><div class="market-info"><div class="market-item"><div class="label">MA20</div><div class="value">${marketRegime.ma20 || '-'}</div></div><div class="market-item"><div class="label">MA60</div><div class="value">${marketRegime.ma60 || '-'}</div></div><div class="market-item"><div class="label">趋势</div><div class="value" style="font-size:14px">${marketRegime.aboveMA20 ? '✓ 站上MA20' : '✗ 跌破MA20'}<br/>${marketRegime.aboveMA60 ? '✓ 站上MA60' : '✗ 跌破MA60'}</div></div></div></div><div class="grid"><div class="card"><div class="muted">总权益</div><div class="big">${formatWan(portfolio?.totalEquity)}</div></div><div class="card"><div class="muted">账户现金</div><div class="big">${formatWan(portfolio?.cash)}</div></div><div class="card"><div class="muted">总收益率</div><div class="big ${(portfolio?.pnlPct || 0) >= 0 ? 'up' : 'down'}">${formatPct(portfolio?.pnlPct)}</div></div><div class="card"><div class="muted">持仓 / 上限</div><div class="big">${portfolio?.positionCount ?? 0} / ${portfolio?.maxPositions ?? 0}</div></div><div class="card" id="statsCard"><div class="muted">胜率</div><div class="big">-</div></div><div class="card" id="avgHoldCard"><div class="muted">平均持有</div><div class="big">-</div></div><div class="card" id="profitFactorCard"><div class="muted">盈亏比</div><div class="big">-</div></div><div class="card" id="maxGainCard"><div class="muted">最大盈利</div><div class="big">-</div></div><div class="card" id="maxLossCard"><div class="muted">最大亏损</div><div class="big">-</div></div><div class="card" id="totalTradesCard"><div class="muted">总交易数</div><div class="big">-</div></div><div class="card"><div class="muted">近期表现</div><div class="muted" style="margin-top:8px;font-size:13px;line-height:1.8">最近20笔：胜率 ${(performanceFeedback.recentWinRate || 0).toFixed(1)}% · 平均持有 ${(performanceFeedback.avgHoldDays || 0).toFixed(1)}天<br/>高分段(80+)：${performanceFeedback.highBand?.trades || 0}笔，胜率 ${(performanceFeedback.highBand?.winRate || 0).toFixed(1)}%，平均盈亏 ${(performanceFeedback.highBand?.avgPnlPct || 0).toFixed(2)}%<br/>低分段(<80)：${performanceFeedback.lowBand?.trades || 0}笔，惩罚分 ${(performanceFeedback.lowBandPenalty || 0).toFixed(1)}</div></div></div><div class="panel"><h3>策略缺陷面板</h3><div class="diagnosis-grid"><div><div class="section-title">策略健康度</div><ul class="mini-list"><li><span class="label">市场环境</span><span class="value ${marketRegime.regime === 'BEAR' ? 'down' : marketRegime.regime === 'BULL' ? 'up' : ''}">${regimeText}</span></li><li><span class="label">最近样本数</span><span class="value">${performanceFeedback.tradeCount || 0}笔</span></li><li><span class="label">60日筛选漏斗</span><span class="value">${historyFilterAfter}/${historyFilterBefore || 0}</span></li><li><span class="label">历史筛选淘汰率</span><span class="value ${historyRejectRate > 70 ? 'down' : ''}">${historyRejectRate}%</span></li><li><span class="label">高分段优势</span><span class="value ${(performanceFeedback.highBandBonus || 0) > 0 ? 'up' : ''}">+${(performanceFeedback.highBandBonus || 0).toFixed(1)}</span></li><li><span class="label">低分段惩罚</span><span class="value ${(performanceFeedback.lowBandPenalty || 0) > 0 ? 'down' : ''}">${(performanceFeedback.lowBandPenalty || 0).toFixed(1)}</span></li><li><span class="label">回撤压力</span><span class="value ${(performanceFeedback.drawdownPressure || 0) > 3 ? 'down' : ''}">${(performanceFeedback.drawdownPressure || 0).toFixed(2)}%</span></li></ul><div class="hint">如果低分段惩罚高、回撤压力大、历史筛选淘汰率长期过高，说明当前策略在弱信号阶段仍有改进空间。</div></div><div><div class="section-title">错失机会样本</div><ul class="mini-list">${missedSamples.length ? missedSamples.map(item => `<li><span class="label">${item.symbol} ${item.name}<span class="sub">日分${item.score || 0} 历史${item.historyScore || 0} 价格${item.price || '-'} · ${item.reason || '未通过60日筛选'}</span></span><span class="value">拦截</span></li>`).join('') : '<li><span class="label">暂无错失样本</span><span class="value">-</span></li>'}</ul><div class="hint">这里展示通过日内初筛、但被60日历史筛选拦截的样本，方便判断是否存在错杀。</div></div><div><div class="section-title">主要缺陷来源</div><ul class="mini-list">${filterRanking.length ? filterRanking.map(item => `<li><span class="label">${item.label}</span><span class="value">${item.count}只</span></li>`).join('') : '<li><span class="label">暂无过滤统计</span><span class="value">-</span></li>'}</ul><div id="lossDiagnosis" class="hint">最近亏损归因加载中...</div></div></div></div><div class="panel"><h3>最近亏损明细</h3><div id="lossTableWrap" class="empty">加载中...</div></div><div class="panel"><h3>持仓列表</h3><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>行业</th><th>买入价</th><th>现价</th><th>止损价</th><th>保护止盈</th><th>退出提示</th><th>最高价</th><th>距高点</th><th>数量</th><th>市值</th><th>浮盈亏</th><th>持有天数</th><th>建仓日期</th><th>操作</th></tr></thead><tbody>${positionRows || '<tr><td colspan="17" class="empty">当前没有持仓</td></tr>'}</tbody></table></div><div class="panel"><h3>权益曲线</h3><div id="equityChart" class="svgbox"></div></div><div class="panel"><div class="tabs"><div class="tab active" onclick="switchTab('settlement')">交割单</div><div class="tab" onclick="switchTab('trades')">订单流水</div><div class="tab" onclick="switchTab('alerts')">告警记录</div></div><div id="settlement" class="tab-content active"><table id="settlementTable"><thead><tr><th>日期</th><th>代码</th><th>名称</th><th>买入价</th><th>卖出价</th><th>数量</th><th>盈亏</th><th>盈亏%</th><th>持有天数</th><th>卖出原因</th></tr></thead><tbody><tr><td colspan="10" class="empty">加载中...</td></tr></tbody></table></div><div id="trades" class="tab-content"><table id="tradesTable"><thead><tr><th>时间</th><th>方向</th><th>代码</th><th>名称</th><th>价格</th><th>数量</th><th>金额</th><th>手续费</th><th>原因</th></tr></thead><tbody><tr><td colspan="9" class="empty">加载中...</td></tr></tbody></table></div><div id="alerts" class="tab-content"><table id="alertsTable"><thead><tr><th>时间</th><th>类型</th><th>代码</th><th>名称</th><th>消息</th></tr></thead><tbody><tr><td colspan="5" class="empty">加载中...</td></tr></tbody></table></div></div></div><script>
const AUTO_REFRESH_MS=15000;const SCROLL_KEY='scroll:'+location.pathname;const saveScroll=()=>sessionStorage.setItem(SCROLL_KEY,String(window.scrollY||0));window.addEventListener('scroll',saveScroll,{passive:true});window.addEventListener('beforeunload',saveScroll);window.addEventListener('load',()=>{const y=Number(sessionStorage.getItem(SCROLL_KEY)||0);if(y>0) window.scrollTo(0,y);setTimeout(()=>{saveScroll();location.reload();},AUTO_REFRESH_MS);});
function switchTab(name){const tabs=document.querySelectorAll('.tab');const contents=document.querySelectorAll('.tab-content');tabs.forEach(t=>t.classList.remove('active'));contents.forEach(c=>c.classList.remove('active'));document.querySelector('.tab[onclick*="'+name+'"]').classList.add('active');document.getElementById(name).classList.add('active');}
async function manualSell(symbol,name){if(!confirm('确认手动卖出 '+symbol+' '+name+' ?'))return;try{const resp=await fetch('/sell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol})});const result=await resp.json();if(result.success){alert('卖出成功: '+result.message);location.reload();}else{alert('卖出失败: '+result.error);}}catch(err){alert('卖出失败: '+err.message);}}
async function loadData(){
  const [equityResp, settlementResp, tradesResp, statsResp, alertsResp] = await Promise.all([
    fetch('/equity').then(r => r.json()).catch(() => []),
    fetch('/settlement').then(r => r.json()).catch(() => []),
    fetch('/trades').then(r => r.json()).catch(() => []),
    fetch('/statistics').then(r => r.json()).catch(() => ({})),
    fetch('/alerts').then(r => r.json()).catch(() => [])
  ]);
  renderEquity(equityResp || []);
  renderSettlement(settlementResp || []);
  renderTrades(tradesResp || []);
  renderStats(statsResp || {});
  renderAlerts(alertsResp || []);
  renderLossDiagnosis(settlementResp || []);
  renderLossTable(settlementResp || []);
}
function renderStats(stats){
  document.getElementById('statsCard').innerHTML='<div class="muted">胜率</div><div class="big">'+(stats.winRate||0).toFixed(1)+'%</div><div class="muted" style="margin-top:4px;font-size:12px">'+(stats.winTrades||0)+'胜/'+(stats.lossTrades||0)+'负</div>';
  document.getElementById('avgHoldCard').innerHTML='<div class="muted">平均持有</div><div class="big">'+(stats.avgHoldDays||0).toFixed(1)+'天</div>';
  document.getElementById('profitFactorCard').innerHTML='<div class="muted">盈亏比</div><div class="big">'+(stats.profitFactor||0).toFixed(2)+'</div>';
  document.getElementById('maxGainCard').innerHTML='<div class="muted">最大盈利</div><div class="big up">'+(stats.maxGain||0).toFixed(1)+'%</div>';
  document.getElementById('maxLossCard').innerHTML='<div class="muted">最大亏损</div><div class="big down">'+(stats.maxLoss||0).toFixed(1)+'%</div>';
  document.getElementById('totalTradesCard').innerHTML='<div class="muted">总交易数</div><div class="big">'+(stats.totalTrades||0)+'</div>';
}
function renderEquity(points){
  const box = document.getElementById('equityChart');
  if(!Array.isArray(points) || !points.length){ box.innerHTML = '<div class="empty">暂无权益曲线数据</div>'; return; }
  const tradingHours = points.filter(p => {
    const d = new Date(p.ts);
    const h = d.getHours();
    const m = d.getMinutes();
    const time = h * 60 + m;
    return time >= 540 && time <= 900;
  });
  const data = tradingHours.length > 0 ? tradingHours.slice(-80) : points.slice(-80);
  const values = data.map(x => Number(x.totalEquity || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = Math.max((box.clientWidth || 640) - 16, 320);
  const h = 260;
  const pad = 24;
  const range = Math.max(max - min, 1);
  const coords = values.map((v, i) => {
    const x = pad + (i * (w - pad * 2) / Math.max(values.length - 1, 1));
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const linePath = coords.map(function(p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  const last = values[values.length - 1];
  const first = values[0];
  const change = ((last - first) / first * 100).toFixed(2);
  const timeLabel = tradingHours.length > 0 ? '交易时间' : '全时段';
  const initialCapital = 10000000;
  const baselineY = h - pad - ((initialCapital - min) / range) * (h - pad * 2);
  box.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="260" xmlns="http://www.w3.org/2000/svg">'
    + '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="12" fill="#0f172a"/>'
    + '<line x1="' + pad + '" y1="' + baselineY.toFixed(1) + '" x2="' + (w - pad) + '" y2="' + baselineY.toFixed(1) + '" stroke="#475569" stroke-width="1" stroke-dasharray="4,4"/>'
    + '<path d="' + linePath + '" fill="none" stroke="#60a5fa" stroke-width="3"/>'
    + '<text x="16" y="22" fill="#94a3b8" font-size="12">最低 ' + (min/10000).toFixed(2) + '万</text>'
    + '<text x="' + (w-130) + '" y="22" fill="#94a3b8" font-size="12">最高 ' + (max/10000).toFixed(2) + '万</text>'
    + '<text x="16" y="' + (h-12) + '" fill="#e5e7eb" font-size="12">最新 ' + (last/10000).toFixed(2) + '万 (' + (change>=0?'+':'') + change + '%) ' + timeLabel + '</text>'
    + '</svg>';
}
function renderSettlement(records){
  const tbody = document.querySelector('#settlementTable tbody');
  if(!records.length){ tbody.innerHTML = '<tr><td colspan="10" class="empty">暂无交割记录</td></tr>'; return; }
  tbody.innerHTML = records.map(r =>
    '<tr><td>'+r.sellDate+'</td><td>'+r.symbol+'</td><td>'+r.name+'</td><td>'+r.buyPrice.toFixed(3)+'</td><td>'+r.sellPrice.toFixed(3)+'</td><td>'+r.quantity+'</td><td class="'+(r.pnl>=0?'up':'down')+'">'+(r.pnl/10000).toFixed(2)+'万</td><td class="'+(r.pnlPct>=0?'up':'down')+'">'+(r.pnlPct>=0?'+':'')+r.pnlPct.toFixed(2)+'%</td><td>'+r.holdDays+'天</td><td>'+r.reason+'</td></tr>'
  ).join('');
}
function renderTrades(records){
  const tbody = document.querySelector('#tradesTable tbody');
  if(!records.length){ tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无订单记录</td></tr>'; return; }
  tbody.innerHTML = records.map(r =>
    '<tr><td>'+r.bjTime+'</td><td><strong>'+(r.side=='BUY'?'买入':'卖出')+'</strong></td><td>'+r.symbol+'</td><td>'+r.name+'</td><td>'+r.executedPrice.toFixed(3)+'</td><td>'+r.quantity+'</td><td>'+(r.amount/10000).toFixed(2)+'万</td><td>'+(r.fee/100).toFixed(2)+'元</td><td>'+r.reason+'</td></tr>'
  ).join('');
}
function renderAlerts(records){
  const tbody = document.querySelector('#alertsTable tbody');
  if(!records.length){ tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无告警记录</td></tr>'; return; }
  const typeColor = {'BUY':'#60a5fa','SELL_PROFIT':'#ef4444','SELL_LOSS':'#22c55e','PORTFOLIO_RISK':'#f59e0b','MARKET_REGIME':'#a78bfa'};
  tbody.innerHTML = records.map(r =>
    '<tr><td>'+r.bjTime+'</td><td><span style="color:'+(typeColor[r.type]||'#9ca3af')+';font-weight:600">'+r.type+'</span></td><td>'+(r.symbol||'-')+'</td><td>'+(r.name||'-')+'</td><td>'+r.message+'</td></tr>'
  ).join('');
}
function renderLossDiagnosis(settlements){
  const losses = settlements.filter(r => r.pnlPct < 0).slice(0, 5);
  const el = document.getElementById('lossDiagnosis');
  if(!losses.length){ el.textContent = '最近无亏损交易，策略表现良好。'; return; }
  const commonReasons = {};
  const confidenceStats = {};
  const regimeStats = {};
  losses.forEach(r => {
    const key = r.reason || '未知原因';
    commonReasons[key] = (commonReasons[key] || 0) + 1;
    const confidence = r.confidence || '未知置信度';
    confidenceStats[confidence] = (confidenceStats[confidence] || 0) + 1;
    const regime = r.entryMarketRegime || '未知环境';
    regimeStats[regime] = (regimeStats[regime] || 0) + 1;
  });
  const topReason = Object.entries(commonReasons).sort((a,b) => b[1] - a[1])[0];
  const topConfidence = Object.entries(confidenceStats).sort((a,b) => b[1] - a[1])[0];
  const topRegime = Object.entries(regimeStats).sort((a,b) => b[1] - a[1])[0];
  const avgLoss = (losses.reduce((sum, r) => sum + r.pnlPct, 0) / losses.length).toFixed(2);
  const avgHold = (losses.reduce((sum, r) => sum + r.holdDays, 0) / losses.length).toFixed(1);
  el.innerHTML = '最近'+losses.length+'笔亏损：平均亏'+Math.abs(avgLoss)+'%，平均持有'+avgHold+'天。主要原因：'+topReason[0]+'('+topReason[1]+'笔)；集中在'+topConfidence[0]+'、'+topRegime[0]+'环境。';
}
function renderLossTable(settlements){
  const losses = settlements.filter(r => r.pnlPct < 0).slice(0, 10);
  const el = document.getElementById('lossTableWrap');
  if(!losses.length){ el.innerHTML = '<div class="empty">暂无亏损交易明细</div>'; return; }
  el.innerHTML = '<table><thead><tr><th>卖出日期</th><th>代码</th><th>盈亏%</th><th>持有</th><th>入场环境</th><th>置信度</th><th>入场分</th><th>卖出原因</th></tr></thead><tbody>' + losses.map(r =>
    '<tr><td>'+(r.sellDate||'-')+'</td><td>'+(r.symbol||'-')+' '+(r.name||'')+'</td><td class="down">'+(r.pnlPct||0).toFixed(2)+'%</td><td>'+(r.holdDays||0)+'天</td><td>'+(r.entryMarketRegime||'-')+'</td><td>'+(r.confidence||'-')+'</td><td>'+((r.combinedScore||r.entryScore||0).toFixed ? (r.combinedScore||r.entryScore||0).toFixed(1) : (r.combinedScore||r.entryScore||0))+'</td><td>'+(r.reason||'-')+'</td></tr>'
  ).join('') + '</tbody></table>';
}
loadData();
</script></body></html>`;
}

function renderLogsHtmlLegacy(scanLogger) {
  function renderDecisionList(title, items, colorClass, formatter) {
    if (!Array.isArray(items) || items.length === 0) return '';
    return `<div class="decision-block ${colorClass}"><div class="decision-title">${title}</div><ul class="decision-list">${items.map(formatter).join('')}</ul></div>`;
  }

  function renderFilterStats(stepData) {
    const labels = {
      noHistory: '无历史数据',
      bearMarketVolume: '熊市量比不足',
      gain60dNegative: '60日涨幅为负',
      gain10dNegative: '10日涨幅为负',
      maxDrawdownHigh: '最大回撤过大',
      consecutiveDown: '连续下跌过多',
      avgTurnoverLow: '60日平均换手过低',
      volumeRatio5dLow: '近5日放量不足',
      upDaysRatioLow: '上涨天数占比过低',
      historyScoreLow: '历史评分不足'
    };
    const stats = Object.entries(stepData?.filterStats || {})
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => b[1] - a[1]);
    const summary = `<div class="filter-summary"><span>筛选前 ${stepData?.before || 0} 只</span><span>筛选后 ${stepData?.after || 0} 只</span><span>剔除 ${(stepData?.before || 0) - (stepData?.after || 0)} 只</span></div>`;
    const ranking = stats.length ? `<div class="decision-block filter-list"><div class="decision-title">主要过滤原因</div><ul class="decision-list">${stats.map(([key, count]) => `<li><span class="symbol">${labels[key] || key}</span> <span class="urgency">${count}只</span></li>`).join('')}</ul></div>` : '<div class="empty-decision">本轮无过滤统计</div>';
    const samples = Array.isArray(stepData?.filtered) && stepData.filtered.length > 0
      ? `<div class="decision-block sample-list"><div class="decision-title">过滤样本</div><ul class="decision-list">${stepData.filtered.map(item => `<li><span class="symbol">${item.symbol || '-'} ${item.name || ''}</span> <span class="reason">${item.reason || '未通过筛选'}</span></li>`).join('')}</ul></div>`
      : '';
    return summary + ranking + samples;
  }

  const logs = scanLogger.getRecentLogs(20);
  const logsHtml = logs.map((log, idx) => {
    const steps = log.steps.map(step => {
      let decisionClass = '';
      let formattedData = '';

      if (step.step === '买入决策') {
        decisionClass = 'decision-accept';
        const data = step.data || {};
        const rejected = renderDecisionList('拒绝买入', data.rejected, 'reject-list', item =>
          `<li><span class="symbol">${item.symbol} ${item.name}</span> <span class="reason">${item.reason}</span> <span class="score">日${item.dayScore}分 历史${item.historyScore}分</span></li>`
        );
        const accepted = renderDecisionList('接受买入', data.accepted, 'accept-list', item =>
          `<li><span class="symbol">${item.symbol} ${item.name}</span> <span class="confidence">${item.confidence}</span> <span class="reason">${item.reason}</span> <span class="value">仓位${(item.positionValue/10000).toFixed(1)}万</span></li>`
        );
        formattedData = rejected + accepted || '<div class="empty-decision">本轮无买入决策</div>';
      } else if (step.step === '持有观察') {
        decisionClass = 'decision-hold';
        const data = step.data || {};
        formattedData = renderDecisionList('持有中', data.positions, 'hold-list', item =>
          `<li><span class="symbol">${item.symbol} ${item.name}</span> <span class="hold-info">持有${item.holdDays}天 浮盈${item.pnlPct.toFixed(2)}%</span> <span class="urgency">紧迫度${item.urgency}</span> <span class="reasons">${item.reasons?.map(r => r.type).join(',') || ''}</span></li>`
        ) || '<div class="empty-decision">本轮无持有观察</div>';
      } else if (step.step === '卖出决策') {
        decisionClass = 'decision-sell';
        const data = step.data || {};
        formattedData = renderDecisionList('卖出', data.sold, 'sell-list', item =>
          `<li><span class="symbol">${item.symbol} ${item.name}</span> <span class="pnl ${item.pnlPct >= 0 ? 'up' : 'down'}">${item.pnlPct.toFixed(2)}%</span> <span class="urgency">紧迫度${item.urgency}</span> <span class="reasons">${item.reasons?.map(r => r.type).join(',') || ''}</span></li>`
        ) || '<div class="empty-decision">本轮无卖出</div>';
      } else if (step.step === '60日历史数据严格筛选') {
        decisionClass = 'decision-filter';
        formattedData = renderFilterStats(step.data);
      } else {
        formattedData = `<pre class="step-data">${JSON.stringify(step.data, null, 2)}</pre>`;
      }

      return `<div class="step ${decisionClass}"><div class="step-header"><span class="step-name">${step.step}</span><span class="step-time">${step.time}ms</span></div>${formattedData}</div>`;
    }).join('');

    const summaryStr = JSON.stringify(log.summary, null, 2);

    return `
      <div class="log-item">
        <div class="log-header">
          <div>
            <strong>扫描 #${logs.length - idx}</strong>
            <span class="muted">${log.bjTime}</span>
          </div>
          <div class="muted">耗时: ${log.duration}ms</div>
        </div>
        <div class="log-summary">
          <div class="summary-item"><span>总股票数</span><strong>${log.summary.totalStocks || 0}</strong></div>
          <div class="summary-item"><span>主板股票</span><strong>${log.summary.mainBoardStocks || 0}</strong></div>
          <div class="summary-item"><span>评分通过</span><strong>${log.summary.scoredStocks || 0}</strong></div>
          <div class="summary-item"><span>策略匹配</span><strong>${log.summary.matchedStocks || 0}</strong></div>
          <div class="summary-item"><span>最终选出</span><strong class="highlight">${log.summary.finalPicks || 0}</strong></div>
        </div>
        <details class="log-details">
          <summary>查看详细步骤</summary>
          <div class="steps">${steps}</div>
        </details>
      </div>
    `;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>扫描日志</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#0b1020;color:#e5e7eb}.wrap{max-width:1400px;margin:0 auto;padding:24px}.nav{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.nav a{display:inline-block;padding:8px 14px;border:1px solid #334155;border-radius:999px;background:#111827;color:#cbd5e1;text-decoration:none}.nav a.active{background:#2563eb;color:#fff;border-color:#2563eb}h1{margin:0 0 16px;font-size:28px}.muted{color:#9ca3af;font-size:14px}.log-item{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:20px;margin-bottom:16px}.log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1f2937}.log-header strong{font-size:18px;margin-right:12px}.log-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}.summary-item{background:#0f172a;padding:12px;border-radius:8px;text-align:center}.summary-item span{display:block;font-size:12px;color:#9ca3af;margin-bottom:4px}.summary-item strong{display:block;font-size:20px;font-weight:700}.summary-item .highlight{color:#60a5fa}.log-details{margin-top:16px}.log-details summary{cursor:pointer;padding:8px 12px;background:#0f172a;border-radius:8px;user-select:none}.log-details summary:hover{background:#1e293b}.steps{margin-top:12px;padding:12px;background:#0f172a;border-radius:8px}.step{margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #1f2937}.step:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}.step-header{display:flex;justify-content:space-between;margin-bottom:8px}.step-name{font-weight:600;color:#93c5fd}.step-time{font-size:12px;color:#9ca3af}.step-data{background:#000;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.6;margin:0}.decision-reject .step-name{color:#f59e0b}.decision-accept .step-name{color:#22c55e}.decision-hold .step-name{color:#60a5fa}.decision-sell .step-name{color:#ef4444}.decision-filter .step-name{color:#a78bfa}.decision-block{margin-top:8px}.decision-title{font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:6px;padding-left:4px}.decision-list{list-style:none;margin:0;padding:0}.decision-list li{padding:8px 12px;margin-bottom:4px;background:#1e293b;border-radius:6px;font-size:13px;line-height:1.6;display:flex;flex-wrap:wrap;gap:8px;align-items:center}.reject-list li{border-left:3px solid #f59e0b}.accept-list li{border-left:3px solid #22c55e}.hold-list li{border-left:3px solid #60a5fa}.sell-list li{border-left:3px solid #ef4444}.filter-list li{border-left:3px solid #a78bfa}.sample-list li{border-left:3px solid #64748b}.filter-summary{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 10px}.filter-summary span{background:#1e293b;border:1px solid #334155;border-radius:999px;padding:4px 10px;color:#cbd5e1;font-size:12px}.decision-list .symbol{font-weight:600;color:#e5e7eb}.decision-list .reason{color:#9ca3af;font-size:12px}.decision-list .score{color:#64748b;font-size:12px}.decision-list .confidence{color:#22c55e;font-weight:600;font-size:12px}.decision-list .value{color:#60a5fa;font-size:12px}.decision-list .hold-info{color:#cbd5e1;font-size:12px}.decision-list .urgency{color:#f59e0b;font-weight:600;font-size:12px}.decision-list .reasons{color:#9ca3af;font-size:11px}.decision-list .pnl{font-weight:600;font-size:13px}.decision-list .pnl.up{color:#ef4444}.decision-list .pnl.down{color:#22c55e}.empty-decision{color:#64748b;font-size:13px;padding:8px 12px;font-style:italic}@media(max-width:900px){.log-summary{grid-template-columns:repeat(3,1fr);}}</style></head><body><div class="wrap"><div class="nav"><a href="/">扫描看板</a><a href="/paper">模拟盘看板</a><a href="/logs" class="active">扫描日志</a></div><h1>扫描日志</h1><div class="muted" style="margin-bottom:20px">最近20次扫描的详细过程</div>${logsHtml || '<div class="muted">暂无日志数据</div>'}</div><script>const AUTO_REFRESH_MS=30000;const SCROLL_KEY='scroll:'+location.pathname;const saveScroll=()=>sessionStorage.setItem(SCROLL_KEY,String(window.scrollY||0));window.addEventListener('scroll',saveScroll,{passive:true});window.addEventListener('beforeunload',saveScroll);window.addEventListener('load',()=>{const y=Number(sessionStorage.getItem(SCROLL_KEY)||0);if(y>0) window.scrollTo(0,y);setTimeout(()=>{saveScroll();location.reload();},AUTO_REFRESH_MS);});</script></body></html>`;
}

async function openEastmoneyListPage(config) {
  const browser = await chromium.launch({
    headless: !!config.marketScan.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  });
  const page = await context.newPage();

  // 隐藏 webdriver 特征
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  });

  await page.goto(config.marketScan.listUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(config.marketScan.pageLoadWaitMs || 3500);
  return { browser, context, page };
}

function buildEastmoneyClistUrl(config, pn) {
  const pz = config.marketScan.pageSize || 200;
  const cb = `jQuery${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  const fsParam = [
    'm:0+t:6+f:!2',
    'm:0+t:80+f:!2',
    'm:1+t:2+f:!2',
    'm:1+t:23+f:!2',
    'm:0+t:81+s:262144+f:!2'
  ].join(',');
  const fields = [
    'f2','f3','f4','f5','f6','f7','f8','f9','f10','f12','f13','f14','f15','f16','f17','f18','f23','f100'
  ].join(',');
  const params = new URLSearchParams({
    np: '1',
    fltt: '1',
    invt: '2',
    cb,
    fs: fsParam,
    fields,
    fid: 'f3',
    pn: String(pn),
    pz: String(pz),
    po: '1',
    dect: '1',
    ut: 'fa5fd1943c7b386f172d6893dbfba10b',
    wbp2u: '|0|0|0|web',
    _: String(Date.now())
  });
  return `https://push2.eastmoney.com/api/qt/clist/get?${params.toString()}`;
}

function parseEastmoneyJsonp(text) {
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new Error('invalid jsonp response');
  return JSON.parse(text.slice(start + 1, end));
}

function normalizeClistItem(row) {
  const code = String(row.f12 || '').trim();
  const market = Number(row.f13);
  const name = String(row.f14 || '').trim();
  if (!/^\d{6}$/.test(code)) return null;
  if (!isMainBoardCode(code)) return null;
  if (isLikelyStName(name)) return null;
  const price = row.f2 != null ? Number(row.f2) / 100 : null;
  const changePercent = row.f3 != null ? Number(row.f3) / 100 : null;
  const changeAmount = row.f4 != null ? Number(row.f4) / 100 : null;
  const volumeLots = row.f5 != null ? Number(row.f5) : null;
  const amount = row.f6 != null ? Number(row.f6) : null;
  const amplitudePercent = row.f7 != null ? Number(row.f7) / 100 : null;
  const turnoverRatePercent = row.f8 != null ? Number(row.f8) / 100 : null;
  const peDynamic = row.f9 != null ? Number(row.f9) / 100 : null;
  const volumeRatio = row.f10 != null ? Number(row.f10) / 100 : null;
  const high = row.f15 != null ? Number(row.f15) / 100 : null;
  const low = row.f16 != null ? Number(row.f16) / 100 : null;
  const open = row.f17 != null ? Number(row.f17) / 100 : null;
  const prevClose = row.f18 != null ? Number(row.f18) / 100 : null;
  const pb = row.f23 != null ? Number(row.f23) / 100 : null;
  const sector = String(row.f100 || '').trim() || 'UNKNOWN';
  const intradayReturnPct = open && price ? Number((((price - open) / open) * 100).toFixed(4)) : null;
  return {
    symbol: normalizeSymbol(code),
    code,
    market,
    name,
    sector,
    eastmoneyUrl: toEastmoneyUrl(code),
    price,
    prevClose,
    open,
    high,
    low,
    changeAmount,
    changePercent,
    volumeLots,
    bid1Price: null,
    ask1Price: null,
    turnoverRatePercent,
    peDynamic,
    pb,
    amplitudePercent,
    volumeRatio,
    volumeBurstRatio: volumeRatio,
    turnover: amount,
    totalMarketCap: null,
    circulatingMarketCap: null,
    speedPercent: null,
    intradayReturnPct,
    limitUp: null,
    limitDown: null,
    limitPercent: 10,
    isMainBoard: true,
    isST: false,
    isTenPercentLimit: true,
    ts: new Date().toISOString(),
    raw: row
  };
}

async function scrapeEastmoneyDomMarketWithPage(config, page, context) {
  const dedup = new Map();
  const maxPages = config.marketScan.maxPages || 25;
  let total = null;
  let failedPages = 0;

  for (let pn = 1; pn <= maxPages; pn += 1) {
    const url = buildEastmoneyClistUrl(config, pn);
    let text = null;
    let success = false;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const resp = await context.request.get(url, { timeout: 15000 });
        text = await resp.text();
        success = true;
        break;
      } catch (err) {
        console.log(`[EMAPI] page=${pn} attempt=${attempt} context.request失败: ${err.message}`);
        try {
          text = await page.evaluate(async (u) => {
            const resp = await fetch(u, {
              method: 'GET',
              credentials: 'include',
              headers: { 'Accept': '*/*' }
            });
            return await resp.text();
          }, url);
          success = true;
          break;
        } catch (err2) {
          console.error(`[EMAPI] page=${pn} attempt=${attempt} page.evaluate失败: ${err2.message}`);
          await page.waitForTimeout(300 * attempt);
        }
      }
    }

    if (!success || !text) {
      failedPages++;
      console.error(`[EMAPI] page=${pn} 最终失败，跳过该页`);
      if (failedPages >= 5 && dedup.size < 100) {
        console.error(`[EMAPI] 连续失败过多且样本严重不足(<100)，提前结束，本轮仅保留${dedup.size}只`);
        break;
      }
      continue;
    }

    let obj;
    try {
      obj = parseEastmoneyJsonp(text);
    } catch (err) {
      failedPages++;
      console.error(`[EMAPI] page=${pn} 解析失败: ${err.message}`);
      continue;
    }

    const diff = obj && obj.data && Array.isArray(obj.data.diff) ? obj.data.diff : [];
    if (total == null && obj && obj.data) total = Number(obj.data.total || 0);
    let kept = 0;
    for (const row of diff) {
      const item = normalizeClistItem(row);
      if (!item) continue;
      dedup.set(item.code, item);
      kept += 1;
    }
    console.log(`[EMAPI] page=${pn} rows=${diff.length} kept=${kept} total=${dedup.size}`);
    if (!diff.length) break;
    if (total && pn * (config.marketScan.pageSize || 200) >= total) break;
    await page.waitForTimeout(250);
  }

  const items = Array.from(dedup.values());
  if (!items.length) {
    throw new Error('eastmoney clist api returned 0 items');
  }
  return items;
}

async function scrapeEastmoneyDomMarket(config) {
  const { browser, page } = await openEastmoneyListPage(config);
  try {
    return await scrapeEastmoneyDomMarketWithPage(config, page, browser.contexts()[0] || page.context());
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

class MarketScanner {
  constructor(config, onScan, logsDir) {
    this.config = config;
    this.runtimeStrategy = config.runtimeStrategy || getRuntimeStrategyConfig();
    this.onScan = onScan;
    this.timer = null;
    this.historyCache = new Map(); // 缓存历史数据
    this.lastHistoryUpdate = null;
    this.scanLogger = new ScanLogger(logsDir);
    this.historyCachePath = path.join(logsDir, 'history-cache.json');
    this.marketRegimeCachePath = path.join(logsDir, 'market-regime-cache.json');
    this.researchWatchlist = loadResearchWatchlist();
    this.marketRegimeCache = this.loadMarketRegimeCache();
    this.loadHistoryCache();
  }

  loadMarketRegimeCache() {
    if (!fs.existsSync(this.marketRegimeCachePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.marketRegimeCachePath, 'utf8'));
    } catch (err) {
      console.error('[INDEX] 加载市场环境缓存失败:', err.message);
      return null;
    }
  }

  saveMarketRegimeCache(payload) {
    this.marketRegimeCache = payload;
    try {
      fs.writeFileSync(this.marketRegimeCachePath, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error('[INDEX] 保存市场环境缓存失败:', err.message);
    }
  }

  getCachedMarketRegime(ts = Date.now()) {
    if (!this.marketRegimeCache?.marketRegime) return null;
    const cacheTs = this.marketRegimeCache.ts ? new Date(this.marketRegimeCache.ts).getTime() : 0;
    if (!cacheTs) return null;
    const ageMs = ts - cacheTs;
    const sameDay = getHistoryCacheDateKey(ts) === getHistoryCacheDateKey(cacheTs);
    if (!sameDay || ageMs > 6 * 60 * 60 * 1000) return null;
    return {
      ...this.marketRegimeCache.marketRegime,
      source: 'cache',
      cachedAt: this.marketRegimeCache.bjTime || null,
      staleMinutes: Math.round(ageMs / 60000),
    };
  }

  loadHistoryCache() {
    if (fs.existsSync(this.historyCachePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.historyCachePath, 'utf8'));
        const now = Date.now();
        const dayMs = 86400000; // 1天
        const historyCfg = this.runtimeStrategy?.history?.degradedDataPolicy || {};
        const preferStaleCache = historyCfg.preferStaleCache !== false;
        const staleMaxAgeMs = historyCfg.staleCacheMaxAgeMs ?? (7 * dayMs);
        let loaded = 0;
        for (const [symbol, history] of Object.entries(data)) {
          const ageMs = history?.fetchedAt ? (now - Number(history.fetchedAt)) : Number.POSITIVE_INFINITY;
          const usableFresh = history.fetchedAt && ageMs < dayMs;
          const usableStale = preferStaleCache &&
            history?.indicators &&
            history.indicators.degraded !== true &&
            ageMs < staleMaxAgeMs;
          if (usableFresh || usableStale) {
            this.historyCache.set(symbol, history);
            loaded++;
          }
        }
        console.log(`[HISTORY] 从磁盘加载${loaded}只股票的历史缓存`);
      } catch (err) {
        console.error('[HISTORY] 加载历史缓存失败:', err.message);
      }
    }
  }

  saveHistoryCache() {
    try {
      const data = Object.fromEntries(this.historyCache);
      fs.writeFileSync(this.historyCachePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[HISTORY] 保存历史缓存失败:', err.message);
    }
  }

  async enrichWithHistory(picks, context) {
    const now = Date.now();
    const todayKey = getHistoryCacheDateKey(now);
    const degradedPolicy = this.runtimeStrategy.history?.degradedDataPolicy || {};
    const retryIntervalMs = degradedPolicy.retryIntervalMs ?? 900000;
    const preferStaleCache = degradedPolicy.preferStaleCache !== false;

    const enriched = [];
    let fetchCount = 0;
    const historyFetched = [];

    console.log(`[HISTORY] 开始获取${picks.length}只股票的历史数据 (今日: ${todayKey})`);

    // 先让页面访问一次东财首页，建立会话
    if (this.page && picks.length > 0) {
      try {
        await this.page.evaluate(() => {
          // 在页面上下文中预热，确保 Cookie 和会话状态正常
          return fetch('https://quote.eastmoney.com/', { credentials: 'include' }).catch(() => {});
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        // 忽略预热失败
      }
    }

    // 分批处理，每批5只，避免并发过高触发限流
    const batchSize = 5;
    for (let i = 0; i < picks.length; i += batchSize) {
      const batch = picks.slice(i, i + batchSize);

      for (const pick of batch) {
        let history = this.historyCache.get(pick.symbol);
        const previousHistory = history;

        // 判断是否需要更新：没有缓存 或 缓存不是今天的
        const fetchedAt = history?.fetchedAt ? Number(history.fetchedAt) : 0;
        const isToday = !!history?.fetchedAt && getHistoryCacheDateKey(history.fetchedAt) === todayKey;
        const hasUsableHistory = !!history?.indicators && history.indicators.degraded !== true;
        const shouldRetryDegraded = !!history?.indicators?.degraded && (!fetchedAt || now - fetchedAt >= retryIntervalMs);
        const needUpdate = !history || !isToday || shouldRetryDegraded;

        if (needUpdate) {
          console.log(`[HISTORY] 获取${pick.symbol} ${pick.name}的60日数据 (${fetchCount + 1}/${picks.length}) ${history ? '更新' : '新增'}`);
          const klines = await fetch60DayKline(pick.symbol, context, this.page);
          if (klines && klines.length >= 30) {
            const indicators = calculate60DayIndicators(klines);
            const historyScore = score60DayHistory(indicators);
            history = { indicators, historyScore, fetchedAt: now, dateKey: todayKey };
            this.historyCache.set(pick.symbol, history);
            historyFetched.push({
              symbol: pick.symbol,
              name: pick.name,
              historyScore,
              gain60d: indicators.gain60d,
              gain10d: indicators.gain10d,
              maxDrawdown: indicators.maxDrawdown,
              avgTurnover60d: indicators.avgTurnover60d
            });
            fetchCount++;
          } else {
            if (preferStaleCache && hasUsableHistory) {
              console.log(`[HISTORY] ${pick.symbol} ${pick.name} 拉取失败，保留旧历史缓存 (${previousHistory.dateKey || 'unknown'})`);
              history = {
                ...previousHistory,
                lastAttemptAt: now,
                lastAttemptDateKey: todayKey,
              };
              this.historyCache.set(pick.symbol, history);
            } else {
              console.log(`[HISTORY] ${pick.symbol} ${pick.name} 历史数据不足，标记为降级`);
              history = {
                indicators: { degraded: true },
                historyScore: this.runtimeStrategy.history?.degradedDataPolicy?.fallbackScore ?? 35,
                fetchedAt: now,
                dateKey: todayKey,
              };
              this.historyCache.set(pick.symbol, history);
            }
          }
          // 每次请求后延迟600ms，避免触发限流
          await new Promise(resolve => setTimeout(resolve, 600));
        } else {
          console.log(`[HISTORY] ${pick.symbol} ${pick.name} 使用今日缓存 (${history.dateKey})`);
        }

        if (history) {
          const enrichedItem = {
            ...pick,
            history: history.indicators,
            historyScore: history.historyScore,
            historyUpdatedAt: history.dateKey || (history.fetchedAt ? getHistoryCacheDateKey(history.fetchedAt) : null),
            combinedScore: combineCandidateScores({
              ...pick,
              historyScore: history.historyScore,
            }, this.runtimeStrategy)
          };
          // 重新生成标签（基于历史数据）
          if (enrichedItem.strategy) {
            enrichedItem.strategy.positiveTags = buildPositiveTags(enrichedItem);
            enrichedItem.strategy.riskTags = buildRiskTags(enrichedItem);
          }
          enriched.push(enrichedItem);
        } else {
          // 历史数据获取失败时给降级分数，避免完全丢失候选
          // 降级候选的综合分以当日分为主，避免因历史分过低被排除
          enriched.push({
            ...pick,
            history: { degraded: true },
            historyScore: this.runtimeStrategy.history?.degradedDataPolicy?.fallbackScore ?? 35,
            combinedScore: combineCandidateScores({
              ...pick,
              historyScore: this.runtimeStrategy.history?.degradedDataPolicy?.fallbackScore ?? 35,
            }, this.runtimeStrategy)
          });
        }
      }

      // 每批之间额外延迟
      if (i + batchSize < picks.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`[HISTORY] 完成！共获取${fetchCount}只新数据，使用缓存${picks.length - fetchCount}只`);
    if (fetchCount > 0) this.saveHistoryCache();

    this.scanLogger.log('获取历史数据', {
      total: picks.length,
      fetched: fetchCount,
      cached: picks.length - fetchCount,
      withHistory: enriched.filter(p => p.history).length,
      details: historyFetched.slice(0, 10) // 只记录前10个
    });

    this.lastHistoryUpdate = now;
    return enriched;
  }

  async scanOnce() {
    const ts = new Date().toISOString();
    const bjTime = formatBeijingTime(ts);
    this.scanLogger.startScan(ts, bjTime);
    this.researchWatchlist = loadResearchWatchlist();

    const { browser, context, page } = await openEastmoneyListPage(this.config);
    this.page = page;
    try {
      // 获取大盘环境
      const indexKlines = await fetchIndexData(context, page);
      let marketRegime = analyzeMarketRegime(indexKlines);
      let marketRegimeSource = 'live';
      if (marketRegime.regime !== 'UNKNOWN' && indexKlines?.length >= 20) {
        this.saveMarketRegimeCache({
          ts,
          bjTime,
          marketRegime,
          sampleSize: indexKlines.length,
        });
      } else {
        const cachedRegime = this.getCachedMarketRegime(new Date(ts).getTime());
        if (cachedRegime) {
          marketRegime = cachedRegime;
          marketRegimeSource = 'cache';
          console.warn(`[INDEX] 实时指数获取失败，回退到缓存环境 ${cachedRegime.regime} (${cachedRegime.cachedAt || '-'})`);
        }
      }
      console.log(`[MARKET] 上证指数: ${marketRegime.current} MA20: ${marketRegime.ma20} MA60: ${marketRegime.ma60} 环境: ${marketRegime.regime} 来源: ${marketRegimeSource}`);
      this.scanLogger.log('市场环境', {
        regime: marketRegime.regime,
        current: marketRegime.current,
        ma20: marketRegime.ma20,
        ma60: marketRegime.ma60,
        source: marketRegimeSource,
        cachedAt: marketRegime.cachedAt || null,
      });

      this.scanLogger.log('开始获取行情数据', {});

      const marketOpen = isMarketOpen(toBeijingTime(ts));
      const portfolioFull = !!(global.paperAccountRef && global.paperAccountRef.positions.size >= global.paperAccountRef.config.maxPositions);

      const rawQuotes = await scrapeEastmoneyDomMarketWithPage(this.config, page, context);
      this.scanLogger.log('获取原始数据', { total: rawQuotes.length });

      const quotes = filterMainBoardTenPercent(rawQuotes);
      this.scanLogger.log('主板过滤', {
        before: rawQuotes.length,
        after: quotes.length,
        filtered: rawQuotes.length - quotes.length
      });

      const scored = quotes.map(item => scoreIntradayStrategy(item, this.runtimeStrategy, this.researchWatchlist.map));
      const dataQuality = getIntradayDataQuality(scored, ts);
      this.scanLogger.log('当日评分', {
        total: scored.length,
        dataQuality,
      });

      // 非交易时间也执行完整候选筛选，方便随时查看策略效果
      if (dataQuality.insufficient) {
        const reason = dataQuality.beforeOpen
          ? '09:30前成交字段未稳定，跳过日内候选'
          : `行情字段缺失过多(${Math.round(dataQuality.incompleteRatio * 100)}%)，跳过日内候选`;
        this.scanLogger.log('行情数据完整性不足', {
          reason,
          dataQuality,
          sample: scored.slice(0, 10).map(item => ({
            symbol: item.symbol,
            name: item.name,
            score: item.score,
            changePercent: item.changePercent,
            turnoverRatePercent: item.turnoverRatePercent,
            volumeRatio: item.volumeBurstRatio || item.volumeRatio || null,
            turnover: item.turnover || null,
          })),
        });
        this.scanLogger.endScan({
          totalStocks: rawQuotes.length,
          mainBoardStocks: quotes.length,
          scoredStocks: scored.length,
          researchUniverseCount: this.researchWatchlist.count,
          initialCandidates: 0,
          finalPicks: 0,
          skipped: reason,
        });
        await this.onScan({
          all: scored,
          picks: [],
          observationPicks: [],
          ts,
          marketRegime,
          researchWatchlist: {
            count: this.researchWatchlist.count,
            generatedFrom: this.researchWatchlist.generatedFrom,
          },
          diagnostics: {
            ...createEmptyScanDiagnostics(),
            dataQuality,
            skippedReason: reason,
          },
        });
        return;
      }

      const pool = buildInitialCandidatePool(scored, marketOpen, portfolioFull, this.runtimeStrategy);
      const initialPool = pool.candidates;
      let candidates = initialPool;
      let observationPicks = [];
      let bucketDiagnostics = createEmptyScanDiagnostics();
      let filterStats = {
        noHistory: 0,
        trend60dLow: 0,
        trend30dLow: 0,
        gain10dTooLow: 0,
        gain5dOutOfRange: 0,
        maxDrawdownHigh: 0,
        distanceToHighInvalid: 0,
        consecutiveDown: 0,
        maTrendInvalid: 0,
        belowMa60: 0,
        rsiOutOfRange: 0,
        macdTooWeak: 0,
        avgAmountLow: 0,
        avgTurnoverLow: 0,
        historyScoreLow: 0,
        degradedHistory: 0,
      };
      let filteredOut = [];

      this.scanLogger.log('初步筛选（降低标准）', {
        threshold: pool.initialThreshold,
        poolThreshold: pool.poolThreshold ?? pool.initialThreshold,
        before: scored.length,
        after: candidates.length,
        researchWatchlistCount: this.researchWatchlist.count,
        researchCandidates: pool.researchCandidateCount,
        topScores: candidates.slice(0, 5).map(p => ({
          symbol: p.symbol,
          name: p.name,
          score: p.score,
          researchSelected: p.researchSelected,
          researchScore: p.researchScore,
        }))
      });

      // 获取历史数据
      if (this.runtimeStrategy.marketFilters.enableHistoryScore !== false) {
        candidates = await this.enrichWithHistory(candidates, context);

        // 基于60日历史数据进行严格筛选（趋势低吸策略）
        const beforeHistoryFilter = candidates.length;
        filteredOut = [];

        candidates = candidates.filter(p => {
          const decision = evaluateHistoryFilters(p, this.runtimeStrategy.history);
          if (decision.passed) return true;
          filteredOut.push({ ...decision.detail, reason: decision.reason });
          if (filterStats[decision.reasonKey] == null) filterStats[decision.reasonKey] = 0;
          filterStats[decision.reasonKey] += 1;
          return false;
        });

        this.scanLogger.log('60日历史数据严格筛选', {
          before: beforeHistoryFilter,
          after: candidates.length,
          filtered: filteredOut.slice(0, 10), // 只记录前10个被过滤的
          filterStats
        });

        // 重新计算综合评分，并按低吸主池/转强观察分桶
        const historyQualifiedCandidates = candidates
          .map(p => ({
            ...p,
            combinedScore: combineCandidateScores(p, this.runtimeStrategy)
          }));
        const classified = classifyCandidateBuckets(historyQualifiedCandidates, this.runtimeStrategy);
        const normalizedMainPicks = classified.mainPicks.map(item => ({
          ...item,
          selectedDayScore: getSelectedBucketDayScore(item),
          combinedScore: getEffectiveCombinedScore(item, this.runtimeStrategy),
        }));
        bucketDiagnostics = buildBucketDiagnostics(classified);
        candidates = normalizedMainPicks
          .slice(0, this.config.strategy.topN);

        const observationSourceMap = new Map();
        for (const item of classified.enriched.filter(candidate => candidate.strategy?.bucket !== 'main')) {
          observationSourceMap.set(item.symbol, {
            ...item,
            selectedDayScore: getSelectedBucketDayScore(item),
            combinedScore: getEffectiveCombinedScore(item, this.runtimeStrategy),
          });
        }
        for (const item of filteredOut
          .map(sample => initialPool.find(candidate => candidate.symbol === sample.symbol))
          .filter(Boolean)) {
          if (!observationSourceMap.has(item.symbol)) {
            observationSourceMap.set(item.symbol, item);
          }
        }
        const observationSource = Array.from(observationSourceMap.values()).map(item => (item.combinedScore != null ? item : {
          ...item,
          combinedScore: combineCandidateScores(item, this.runtimeStrategy),
        }));

        observationPicks = buildObservationPool(
          observationSource,
          this.runtimeStrategy,
          Math.min(12, this.config.strategy.topN || 30)
        ).filter(item => !candidates.some(candidate => candidate.symbol === item.symbol));

        this.scanLogger.log('综合评分排序（当日/历史 50/50）', {
          total: candidates.length,
          observationCount: observationPicks.length,
          topPicks: candidates.slice(0, 10).map(p => ({
            symbol: p.symbol,
            name: p.name,
            dayScore: p.score,
            historyScore: p.historyScore,
            combinedScore: p.combinedScore,
            bucket: p.strategy?.bucket || 'unknown',
            gain60d: p.history?.gain60d || null,
            gain10d: p.history?.gain10d || null,
            maxDrawdown: p.history?.maxDrawdown || null
          })),
          observationPicks: observationPicks.slice(0, 10).map(p => ({
            symbol: p.symbol,
            name: p.name,
            dayScore: p.score,
            historyScore: p.historyScore,
            combinedScore: p.combinedScore,
            bucket: p.strategy?.bucket || 'unknown',
            reason: p.strategy?.bucketLabel || '',
            changePercent: p.changePercent || 0
          }))
        });
      }

      if (this.runtimeStrategy.marketFilters.enableHistoryScore !== false && candidates.length === 0) {
        const fallbackForDashboard = scored
          .filter(item => item.score >= (pool.poolThreshold ?? pool.initialThreshold))
          .sort((a, b) => (b.preHistoryScore || b.score || 0) - (a.preHistoryScore || a.score || 0))
          .slice(0, 30);
        const fallbackMissingHistory = fallbackForDashboard.filter(item => !this.historyCache.get(item.symbol));
        if (fallbackMissingHistory.length > 0) {
          console.log(`[HISTORY] picks=0，补充首页候选历史数据: ${fallbackMissingHistory.length}只`);
          await this.enrichWithHistory(fallbackMissingHistory, context);
        }
        if (observationPicks.length === 0) {
          const enrichedFallback = mergeHistoryIntoMarketItems(fallbackForDashboard, this.historyCache);
          const classifiedFallback = classifyCandidateBuckets(
            enrichedFallback.map(item => ({
              ...item,
              combinedScore: item.combinedScore != null ? item.combinedScore : combineCandidateScores(item, this.runtimeStrategy),
            })),
            this.runtimeStrategy
          );
          observationPicks = buildObservationPool(
            classifiedFallback.observationPicks,
            this.runtimeStrategy,
            12
          );
          if (observationPicks.length === 0) {
            observationPicks = buildObservationPool(
              classifiedFallback.enriched.filter(item => item.strategy?.bucket !== 'main'),
              this.runtimeStrategy,
              12
            );
          }
          if (observationPicks.length === 0) {
            observationPicks = enrichedFallback
              .sort((a, b) => (b.combinedScore || b.preHistoryScore || b.score || 0) - (a.combinedScore || a.preHistoryScore || a.score || 0))
              .slice(0, 12)
              .map(item => ({
                ...item,
                strategy: {
                  ...(item.strategy || {}),
                  bucket: item.strategy?.bucket || 'rejected',
                  bucketLabel: item.strategy?.bucketLabel || '高分样本',
                },
              }));
          }
        }
      }

      const filterSummary = summarizeFilterStats(filterStats);

      const summary = {
        totalStocks: rawQuotes.length,
        mainBoardStocks: quotes.length,
        scoredStocks: scored.length,
        researchUniverseCount: this.researchWatchlist.count,
        initialCandidates: initialPool.length,
        finalPicks: candidates.length
      };

      this.scanLogger.endScan(summary);
      await this.onScan({
        all: scored,
        picks: candidates,
        observationPicks,
        ts,
        marketRegime,
        researchWatchlist: {
          count: this.researchWatchlist.count,
          generatedFrom: this.researchWatchlist.generatedFrom,
        }
        ,
        diagnostics: {
          ...createEmptyScanDiagnostics(),
          ...bucketDiagnostics,
          initialCandidateCount: initialPool.length,
          finalPickCount: candidates.length,
          observationCount: observationPicks.length,
          researchCandidateCount: pool.researchCandidateCount,
          filterStats,
          filterSummary,
          filteredSamples: filteredOut.slice(0, 10),
        }
      });
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  getNextScanInterval() {
    const marketOpen = isMarketOpen();
    const interval = marketOpen
      ? this.config.marketScan.scanIntervalMs
      : this.config.marketScan.scanIntervalOffHoursMs;
    const status = marketOpen ? '交易时间' : '非交易时间';
    console.log(`[SCAN] 下次扫描间隔: ${interval/1000}秒 (${status})`);
    return interval;
  }

  async start() {
    try {
      await this.scanOnce();
    } catch (err) {
      console.error('[SCAN] initial scan error', err.message);
    }

    const scheduleNext = () => {
      const interval = this.getNextScanInterval();
      this.timer = setTimeout(async () => {
        try {
          await this.scanOnce();
        } catch (err) {
          console.error('[SCAN] interval error', err.message);
        }
        scheduleNext();
      }, interval);
    };

    scheduleNext();
  }

  async stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

class PaperAccount {
  constructor(config, logsDir) {
    this.config = config.paperTrading;
    this.runtimeStrategy = config.runtimeStrategy || getRuntimeStrategyConfig();
    this.logsDir = logsDir;
    this.cash = this.config.initialCash;
    this.positions = new Map(); // symbol => { symbol, name, entryPrice, currentPrice, quantity, value, pnlPct, entryTs, entryDate, holdRounds, holdDays, highPrice, lowPrice, sector, confidence }
    this.orders = [];
    this.trades = []; // 完整交割单（买入+卖出配对）
    this.equityHistory = [];
    this.sellCooldown = new Map(); // symbol => lastSellTs (交易冷却期)
    this.peakEquity = this.config.initialCash; // 峰值权益（用于组合风险控制）
    this.lastAlertRegime = null; // 上次告警的市场环境
    this.lastAlertDrawdown = 0; // 上次告警的回撤水平
    this.statistics = {
      totalTrades: 0,
      winTrades: 0,
      lossTrades: 0,
      totalPnl: 0,
      totalWinPnl: 0,
      totalLossPnl: 0,
      maxGain: 0,
      maxLoss: 0,
      totalHoldDays: 0
    };
    // 近期表现追踪器
    this.recentPerformance = {
      closedTrades: [], // 最近N笔已平仓交易
      scoreRangeStats: new Map() // 分数区间统计
    };
    this.ordersPath = path.join(logsDir, 'orders.json');
    this.tradesPath = path.join(logsDir, 'trades.log');
    this.settlementPath = path.join(logsDir, 'settlement.log');
    this.equityPath = path.join(logsDir, 'equity.log');
    this.statisticsPath = path.join(logsDir, 'statistics.json');
    this.alertsPath = path.join(logsDir, 'alerts.log');
    this.latestTradeDiagnostics = createEmptyTradeDiagnostics();
    this.loadState();

    // 如果是首次启动，保存初始状态
    if (!fs.existsSync(this.ordersPath)) {
      this.saveState();
      console.log('[PAPER] 初始化账户状态');
    }
  }

  loadState() {
    if (fs.existsSync(this.ordersPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.ordersPath, 'utf8'));
        this.orders = data.orders || [];
        this.positions = new Map(data.positions || []);
        this.cash = data.cash ?? this.config.initialCash;
        this.sellCooldown = new Map(data.sellCooldown || []);
        this.statistics = data.statistics || this.statistics;
        this.peakEquity = data.peakEquity || this.getTotalEquity();
        for (const [, pos] of this.positions.entries()) {
          if (!pos.source) {
            pos.source = 'strategy';
          }
        }
        this.rebuildRecentPerformance();
        this.latestTradeDiagnostics = data.latestTradeDiagnostics || this.latestTradeDiagnostics;
        this.saveState();
        const posCount = this.positions.size;
        const orderCount = this.orders.length;
        if (posCount > 0 || orderCount > 0) {
          console.log(`[PAPER] 恢复状态: 持仓${posCount}只, 历史订单${orderCount}条, 现金${(this.cash/10000).toFixed(2)}万, 峰值权益${(this.peakEquity/10000).toFixed(2)}万`);
        }
      } catch (_) {}
    }
  }

  saveState() {
    const state = {
      cash: this.cash,
      positions: Array.from(this.positions.entries()),
      orders: this.orders.slice(-1000),
      sellCooldown: Array.from(this.sellCooldown.entries()),
      statistics: this.statistics,
      peakEquity: this.peakEquity,
      recentPerformance: {
        closedTrades: this.recentPerformance.closedTrades,
        scoreRangeStats: Array.from(this.recentPerformance.scoreRangeStats.entries())
      },
      latestTradeDiagnostics: this.latestTradeDiagnostics,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.ordersPath, JSON.stringify(state, null, 2));
  }

  getAdaptiveConfig() {
    const adaptive = this.config.adaptive || {};
    const continuationBand = adaptive.continuationBand || {};
    const tradeWindows = adaptive.tradeWindows || {};
    return {
      enabled: adaptive.enabled !== false,
      performanceWindow: adaptive.performanceWindow || 20,
      confidenceBands: adaptive.confidenceBands || {
        high: { minScore: 85, minHistoryScore: 70, positionMultiplier: 1.25 },
        medium: { minScore: 75, minHistoryScore: 60, positionMultiplier: 1.0 },
        low: { minScore: 70, minHistoryScore: 50, positionMultiplier: 0.5 }
      },
      continuationBand: {
        minDayScore: continuationBand.minDayScore ?? 82,
        minHistoryScore: continuationBand.minHistoryScore ?? 60,
        minCombinedScore: continuationBand.minCombinedScore ?? 58,
        minSignalStrength: continuationBand.minSignalStrength ?? 4,
        maxVolumeRatio: continuationBand.maxVolumeRatio ?? 4.8,
        maxGain60d: continuationBand.maxGain60d ?? 80,
        maxDrawdown: continuationBand.maxDrawdown ?? 22,
        maxDeviationFromMA20: continuationBand.maxDeviationFromMA20 ?? 14,
      },
      tradeWindows: {
        mediumConfidenceCutoffMinutes: tradeWindows.mediumConfidenceCutoffMinutes ?? (13 * 60 + 30),
        latestEntryCutoffMinutes: tradeWindows.latestEntryCutoffMinutes ?? (13 * 60 + 40),
        preferredEntryStartMinutes: tradeWindows.preferredEntryStartMinutes ?? (9 * 60 + 35),
        preferredEntryEndMinutes: tradeWindows.preferredEntryEndMinutes ?? (10 * 60 + 45),
        allowAfternoonEntries: tradeWindows.allowAfternoonEntries ?? false,
      },
      overnightRisk: {
        enabled: adaptive.overnightRisk?.enabled !== false,
        minScoreToCheck: adaptive.overnightRisk?.minScoreToCheck ?? 80,
        maxGain10d: adaptive.overnightRisk?.maxGain10d ?? 18,
        maxGain5d: adaptive.overnightRisk?.maxGain5d ?? 4,
        maxDeviationFromMA20: adaptive.overnightRisk?.maxDeviationFromMA20 ?? 8,
        maxVolatility: adaptive.overnightRisk?.maxVolatility ?? 20,
        maxRecent10LimitUps: adaptive.overnightRisk?.maxRecent10LimitUps ?? 0,
      },
      entryQuality: {
        enabled: adaptive.entryQuality?.enabled !== false,
        requireAboveOpen: adaptive.entryQuality?.requireAboveOpen !== false,
        maxPullbackFromHighPct: adaptive.entryQuality?.maxPullbackFromHighPct ?? 1.2,
        maxIntradayReturnPct: adaptive.entryQuality?.maxIntradayReturnPct ?? 4.5,
        maxOpenDrawdownPct: adaptive.entryQuality?.maxOpenDrawdownPct ?? 1.8,
        maxVolumeRatio: adaptive.entryQuality?.maxVolumeRatio ?? 1.6,
      },
      exitUrgencyWeights: adaptive.exitUrgencyWeights || {
        stopLoss: 100,
        trailingStop: 80,
        scoreDrop: 40,
        holdTooLong: 50,
        weakStock: 60
      },
      exitUrgencyThreshold: adaptive.exitUrgencyThreshold || 100,
      regimeMultipliers: adaptive.regimeMultipliers || {
        BULL: { positionSize: 1.0, maxPositions: this.config.maxPositions, allowLowConfidence: true },
        NEUTRAL: { positionSize: 1.0, maxPositions: this.config.maxPositions, allowLowConfidence: true },
        BEAR: { positionSize: 1.0, maxPositions: this.config.maxPositions, allowLowConfidence: true }
      }
    };
  }

  getScoreRangeKey(score) {
    if (score >= 90) return '90+';
    if (score >= 80) return '80-89';
    if (score >= 70) return '70-79';
    return '<70';
  }

  resolveTradeSource(trade = {}) {
    if (trade.source === 'manual' || trade.source === 'strategy') {
      return trade.source;
    }
    const reason = String(trade.reason || '');
    return reason.includes('手动') ? 'manual' : 'strategy';
  }

  rebuildRecentPerformance(seedTrades = null) {
    const adaptive = this.getAdaptiveConfig();
    const entryOrderMeta = new Map(
      this.orders
        .filter(order => order.side === 'BUY')
        .map(order => {
          const key = `${order.symbol}:${order.ts}`;
          return [
            key,
            {
              score: extractOrderScore(order),
              confidence: extractOrderConfidence(order),
              source: this.resolveTradeSource(order),
              marketRegime: order.marketRegime || order.entryMarketRegime || 'UNKNOWN',
            }
          ];
        })
    );
    const closedTrades = Array.isArray(seedTrades)
      ? seedTrades
      : this.orders
          .filter(order => order.side === 'SELL')
          .map(order => {
            const entryKey = order.entryTs ? `${order.symbol}:${order.entryTs}` : null;
            const entryMeta = entryKey ? entryOrderMeta.get(entryKey) : null;
            return {
              symbol: order.symbol,
              pnlPct: order.pnlPct || 0,
              holdDays: order.holdDays || 0,
              combinedScore: extractOrderScore(order) || entryMeta?.score || 0,
              confidence: extractOrderConfidence(order) !== 'UNKNOWN'
                ? extractOrderConfidence(order)
                : (entryMeta?.confidence || 'UNKNOWN'),
              marketRegime: order.marketRegime || order.entryMarketRegime || entryMeta?.marketRegime || 'UNKNOWN',
              soldAt: order.ts || new Date().toISOString(),
              reason: order.reason || '',
              source: this.resolveTradeSource(order) !== 'strategy'
                ? this.resolveTradeSource(order)
                : (entryMeta?.source || 'strategy')
            };
          });

    const filteredTrades = closedTrades
      .filter(trade => this.resolveTradeSource(trade) !== 'manual')
      .filter(trade => trade.confidence && trade.confidence !== 'UNKNOWN')
      .slice(-adaptive.performanceWindow)
      .map(trade => {
        const score = trade.combinedScore || trade.entryScore || trade.score || 0;
        return {
          symbol: trade.symbol,
          pnlPct: trade.pnlPct || 0,
          holdDays: trade.holdDays || 0,
          score,
          scoreRangeKey: this.getScoreRangeKey(score),
          confidence: trade.confidence || 'UNKNOWN',
          marketRegime: trade.marketRegime || 'UNKNOWN',
          soldAt: trade.soldAt || trade.ts || new Date().toISOString(),
          source: this.resolveTradeSource(trade)
        };
      });

    const scoreRangeStats = new Map();
    for (const trade of filteredTrades) {
      const rangeStats = scoreRangeStats.get(trade.scoreRangeKey) || {
        trades: 0,
        wins: 0,
        totalPnlPct: 0,
        totalHoldDays: 0
      };
      rangeStats.trades += 1;
      rangeStats.totalPnlPct += trade.pnlPct;
      rangeStats.totalHoldDays += trade.holdDays;
      if (trade.pnlPct > 0) rangeStats.wins += 1;
      scoreRangeStats.set(trade.scoreRangeKey, rangeStats);
    }

    this.recentPerformance = {
      closedTrades: filteredTrades,
      scoreRangeStats
    };
  }

  recordClosedTradePerformance(trade) {
    if (this.resolveTradeSource(trade) === 'manual') {
      return;
    }

    const adaptive = this.getAdaptiveConfig();
    const score = trade.combinedScore || trade.entryScore || extractScoreFromReason(trade.reason) || 0;
    const scoreRangeKey = this.getScoreRangeKey(score);
    const closedTrade = {
      symbol: trade.symbol,
      pnlPct: trade.pnlPct || 0,
      holdDays: trade.holdDays || 0,
      score,
      scoreRangeKey,
      confidence: trade.confidence || extractConfidenceFromReason(trade.reason) || 'UNKNOWN',
      marketRegime: trade.marketRegime || trade.entryMarketRegime || 'UNKNOWN',
      soldAt: trade.ts || new Date().toISOString(),
      source: this.resolveTradeSource(trade)
    };

    this.recentPerformance.closedTrades.push(closedTrade);
    if (this.recentPerformance.closedTrades.length > adaptive.performanceWindow) {
      this.recentPerformance.closedTrades = this.recentPerformance.closedTrades.slice(-adaptive.performanceWindow);
    }
    this.rebuildRecentPerformance(this.recentPerformance.closedTrades);
  }

  getPerformanceFeedback(context = {}) {
    const totalEquity = this.getTotalEquity();
    const drawdownPressure = this.peakEquity > 0 ? Math.max(0, ((this.peakEquity - totalEquity) / this.peakEquity) * 100) : 0;
    const marketRegime = context.marketRegime || 'UNKNOWN';
    const closedTrades = this.recentPerformance.closedTrades || [];
    const sameRegimeTrades = marketRegime !== 'UNKNOWN'
      ? closedTrades.filter(t => !t.marketRegime || t.marketRegime === marketRegime)
      : [];
    const trades = sameRegimeTrades.length >= 3 ? sameRegimeTrades : closedTrades;
    if (!trades.length) {
      return {
        tradeCount: 0,
        winRate: 50,
        avgHoldDays: 0,
        avgPnlPct: 0,
        avgWinPct: 0,
        avgLossPct: 0,
        lowBandPenalty: 0,
        mediumBandPenalty: 0,
        highBandPenalty: 0,
        highBandBonus: 0,
        drawdownPressure: Number(drawdownPressure.toFixed(2)),
        scoreRangeStats: {},
        feedbackTradeCount: 0,
        feedbackScopedToRegime: false,
      };
    }

    const wins = trades.filter(t => t.pnlPct > 0);
    const losses = trades.filter(t => t.pnlPct <= 0);
    const scoreRangeStats = {};
    for (const [key, value] of this.recentPerformance.scoreRangeStats.entries()) {
      scoreRangeStats[key] = {
        trades: value.trades,
        winRate: value.trades > 0 ? Number(((value.wins / value.trades) * 100).toFixed(2)) : 0,
        avgPnlPct: value.trades > 0 ? Number((value.totalPnlPct / value.trades).toFixed(2)) : 0,
        avgHoldDays: value.trades > 0 ? Number((value.totalHoldDays / value.trades).toFixed(1)) : 0
      };
    }

    const lowBand = scoreRangeStats['<70'] || { avgPnlPct: 0, winRate: 50, trades: 0 };
    const mediumBand = scoreRangeStats['70-79'] || { avgPnlPct: 0, winRate: 50, trades: 0 };
    const highBandTradeStats = ['90+', '80-89']
      .map(key => scoreRangeStats[key])
      .filter(Boolean);
    const highBand = highBandTradeStats.length
      ? highBandTradeStats.reduce((acc, item) => ({
          trades: acc.trades + item.trades,
          totalPnl: acc.totalPnl + (item.avgPnlPct * item.trades),
        }), { trades: 0, totalPnl: 0 })
      : { trades: 0, totalPnl: 0 };
    const highBandAvgPnl = highBand.trades > 0 ? (highBand.totalPnl / highBand.trades) : 0;

    return {
      tradeCount: trades.length,
      winRate: Number(((wins.length / trades.length) * 100).toFixed(2)),
      avgHoldDays: Number((trades.reduce((sum, t) => sum + t.holdDays, 0) / trades.length).toFixed(1)),
      avgPnlPct: Number((trades.reduce((sum, t) => sum + t.pnlPct, 0) / trades.length).toFixed(2)),
      avgWinPct: wins.length ? Number((wins.reduce((sum, t) => sum + t.pnlPct, 0) / wins.length).toFixed(2)) : 0,
      avgLossPct: losses.length ? Number((losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length).toFixed(2)) : 0,
      lowBandPenalty: lowBand.trades >= 3 && lowBand.avgPnlPct < 0 ? Math.min(8, Math.abs(lowBand.avgPnlPct)) : 0,
      mediumBandPenalty: mediumBand.trades >= 3 && mediumBand.avgPnlPct < 0 ? Math.min(8, Math.abs(mediumBand.avgPnlPct)) : 0,
      highBandPenalty: highBand.trades >= 3 && highBandAvgPnl < 0 ? Math.min(8, Math.abs(highBandAvgPnl)) : 0,
      highBandBonus: highBand.trades >= 3 && highBandAvgPnl > 0 ? Math.min(8, highBandAvgPnl / 2) : 0,
      drawdownPressure: Number(drawdownPressure.toFixed(2)),
      scoreRangeStats,
      feedbackTradeCount: trades.length,
      feedbackScopedToRegime: sameRegimeTrades.length >= 3 && trades === sameRegimeTrades,
    };
  }

  getTotalEquity() {
    const positionValue = Array.from(this.positions.values()).reduce((sum, pos) => sum + pos.value, 0);
    return this.cash + positionValue;
  }

  buildPositionSignalMap(allMarketData = []) {
    if (!this.positions.size || !Array.isArray(allMarketData) || allMarketData.length === 0) {
      return new Map();
    }

    const trackedSymbols = new Set(this.positions.keys());
    const candidates = allMarketData
      .filter(item => trackedSymbols.has(item.symbol))
      .map(item => ({
        ...item,
        combinedScore: item.combinedScore != null
          ? item.combinedScore
          : combineCandidateScores(item, this.runtimeStrategy),
      }));

    if (!candidates.length) {
      return new Map();
    }

    const classified = classifyCandidateBuckets(candidates, this.runtimeStrategy);
    return new Map((classified.enriched || []).map(item => [item.symbol, item]));
  }

  updatePositionExitSnapshot(pos, exitDecision = {}, pick = null, ts = new Date()) {
    const reasons = Array.isArray(exitDecision.reasons) ? exitDecision.reasons : [];
    const liveBucket = pick?.strategy?.bucket || pos.entryBucket || 'main';
    const liveBucketLabel = pick?.strategy?.bucketLabel || BUCKET_LABELS[liveBucket] || liveBucket;
    const liveSelectedDayScore = pick
      ? getSelectedBucketDayScore(pick)
      : (pos.entrySelectedDayScore || pos.entryScore || 0);
    const liveCombinedScore = pick
      ? getEffectiveCombinedScore(pick, this.runtimeStrategy)
      : (pos.combinedScore || pos.entryScore || 0);

    pos.liveBucket = liveBucket;
    pos.liveBucketLabel = liveBucketLabel;
    pos.liveSelectedDayScore = Number((Number(liveSelectedDayScore || 0)).toFixed(2));
    pos.liveCombinedScore = Number((Number(liveCombinedScore || 0)).toFixed(2));
    pos.exitUrgency = Number(exitDecision.urgency || 0);
    pos.exitShouldExit = !!exitDecision.shouldExit;
    pos.exitReasons = reasons.slice(0, 5).map(reason => ({ ...reason }));
    pos.exitSummary = reasons.length > 0
      ? reasons.map(reason => `${reason.type}${reason.detail ? `(${reason.detail})` : ''}`).join('，')
      : '暂无强退出信号';
    pos.lastEvaluatedAt = formatBeijingTime(ts);
  }

  assessBuyConfidence(pick, marketRegime, performanceFeedback, options = {}) {
    const adaptive = this.getAdaptiveConfig();
    if (!adaptive.enabled) {
      return { confidence: 'MEDIUM', reason: '自适应未启用' };
    }

    const regimeConfig = adaptive.regimeMultipliers[marketRegime] || adaptive.regimeMultipliers.NEUTRAL;
    if (marketRegime === 'UNKNOWN') {
      return { confidence: 'REJECT', reason: '市场状态未知，禁止开仓' };
    }
    if (marketRegime === 'BEAR' && !pick.researchSelected) {
      return { confidence: 'REJECT', reason: '熊市仅允许研究白名单标的' };
    }

    let combinedScore = pick.combinedScore || pick.score || 0;
    const historyScore = pick.historyScore || 0;
    const volumeRatio = pick.volumeBurstRatio || pick.volumeRatio || 0;
    const bands = adaptive.confidenceBands;
    const continuationBand = adaptive.continuationBand || {};
    const currentTime = options.currentTime || new Date();
    const h = pick.history || {};
    const signalStrength = [];
    const nowMinutes = getBeijingMinutes(currentTime);

    if (h.distanceToHigh60d >= -20 && h.distanceToHigh60d <= -8) signalStrength.push('回撤到位');
    if (h.deviationFromMA20 >= -6 && h.deviationFromMA20 <= 3) signalStrength.push('接近MA20');
    if (h.rsi >= 35 && h.rsi <= 50) signalStrength.push('RSI低位');
    if (h.macdHistogram > -0.05) signalStrength.push('MACD修复');
    if (volumeRatio >= 0.9 && volumeRatio <= 1.6) signalStrength.push('温和承接');
      if (pick.strategy?.bucket === 'continuation') {
        if (h.gain5d != null && h.gain5d >= 1 && h.gain5d <= 6.5) signalStrength.push('延续不过热');
        if (h.distanceToHigh60d != null && h.distanceToHigh60d >= -22 && h.distanceToHigh60d <= 0) signalStrength.push('趋势贴近前高');
        if (h.gain10d != null && h.gain10d >= 0) signalStrength.push('10日仍在抬升');
        if (h.macdHistogramImproving === true) signalStrength.push('MACD修复中');
        if (volumeRatio >= 1.2 && volumeRatio <= 4.6) signalStrength.push('强势放量');
      }

    // 基础置信度判断
    let baseConfidence = 'LOW';
    let baseReason = [];

    if (pick.strategy?.bucket === 'continuation') {
      const selectedDayScore = getSelectedBucketDayScore(pick);
      const effectiveCombinedScore = getEffectiveCombinedScore(pick, this.runtimeStrategy);
      const continuationMaxVolumeRatio = continuationBand.maxVolumeRatio ?? 4.8;
      const continuationMaxGain60d = continuationBand.maxGain60d ?? 80;
      const continuationMaxDrawdown = continuationBand.maxDrawdown ?? 22;
      const continuationMaxDeviationFromMA20 = continuationBand.maxDeviationFromMA20 ?? 14;
      const continuationChecks = {
        dayScore: selectedDayScore >= (continuationBand.minDayScore ?? 82),
        historyScore: historyScore >= (continuationBand.minHistoryScore ?? 60),
        combinedScore: effectiveCombinedScore >= (continuationBand.minCombinedScore ?? 58),
        signalStrength: signalStrength.length >= (continuationBand.minSignalStrength ?? 4),
        volumeRatio: volumeRatio <= continuationMaxVolumeRatio,
        gain5d: h.gain5d != null && h.gain5d >= -2 && h.gain5d <= 12,
        distanceToHigh60d: h.distanceToHigh60d != null && h.distanceToHigh60d >= -24 && h.distanceToHigh60d <= 2,
        macdHistogram: h.macdHistogram != null && (h.macdHistogram >= -0.12 || h.macdHistogramImproving === true),
        gain60d: h.gain60d == null || h.gain60d <= continuationMaxGain60d,
        maxDrawdown: h.maxDrawdown == null || h.maxDrawdown <= continuationMaxDrawdown,
        deviationFromMA20: h.deviationFromMA20 == null || h.deviationFromMA20 <= continuationMaxDeviationFromMA20,
      };
      const failedContinuationChecks = Object.entries(continuationChecks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key);
      if (failedContinuationChecks.length > 0) {
        const detailedChecks = formatFailedChecks(failedContinuationChecks, {
          volumeRatio: { value: volumeRatio, threshold: continuationMaxVolumeRatio, op: '>' },
          gain60d: { value: h.gain60d, threshold: continuationMaxGain60d, op: '>' },
          maxDrawdown: { value: h.maxDrawdown, threshold: continuationMaxDrawdown, op: '>' },
          deviationFromMA20: { value: h.deviationFromMA20, threshold: continuationMaxDeviationFromMA20, op: '>' },
          signalStrength: { value: signalStrength.length, threshold: continuationBand.minSignalStrength ?? 4, op: '<' },
          dayScore: { value: selectedDayScore, threshold: continuationBand.minDayScore ?? 82, op: '<' },
          historyScore: { value: historyScore, threshold: continuationBand.minHistoryScore ?? 60, op: '<' },
          combinedScore: { value: effectiveCombinedScore, threshold: continuationBand.minCombinedScore ?? 58, op: '<' },
        }, {
          volumeRatio: '量比',
          gain60d: '60日涨幅',
          maxDrawdown: '历史回撤',
          deviationFromMA20: '偏离MA20',
          signalStrength: '信号强度',
          dayScore: '延续日分',
          historyScore: '历史分',
          combinedScore: '综合分',
        });
        return { confidence: 'REJECT', reason: `趋势延续确认不足(${detailedChecks.join('/')})` };
      }
      baseConfidence = 'HIGH';
      baseReason.push(`延续日分${selectedDayScore}分≥${continuationBand.minDayScore ?? 82}`);
      baseReason.push(`历史${historyScore}分≥${continuationBand.minHistoryScore ?? 60}`);
      baseReason.push(`综合${effectiveCombinedScore}分≥${continuationBand.minCombinedScore ?? 58}`);
      combinedScore = effectiveCombinedScore;
    } else if (combinedScore >= bands.high.minScore && historyScore >= bands.high.minHistoryScore) {
      baseConfidence = 'HIGH';
      baseReason.push(`综合${combinedScore}分≥${bands.high.minScore}`);
      baseReason.push(`历史${historyScore}分≥${bands.high.minHistoryScore}`);
    } else if (combinedScore >= bands.medium.minScore && historyScore >= bands.medium.minHistoryScore) {
      baseConfidence = 'MEDIUM';
      baseReason.push(`综合${combinedScore}分≥${bands.medium.minScore}`);
      baseReason.push(`历史${historyScore}分≥${bands.medium.minHistoryScore}`);
    } else if (combinedScore >= bands.low.minScore && historyScore >= bands.low.minHistoryScore) {
      baseConfidence = 'LOW';
      baseReason.push(`综合${combinedScore}分≥${bands.low.minScore}`);
      baseReason.push(`历史${historyScore}分≥${bands.low.minHistoryScore}`);
    } else {
      return { confidence: 'REJECT', reason: `综合${combinedScore}分或历史${historyScore}分不足` };
    }

    if (marketRegime === 'BEAR' && baseConfidence !== 'HIGH') {
      return { confidence: 'REJECT', reason: `熊市仅允许高置信度标的，当前${baseConfidence}` };
    }
    if (!regimeConfig.allowLowConfidence && baseConfidence === 'LOW') {
      return { confidence: 'REJECT', reason: `${marketRegime}环境禁止低置信度开仓` };
    }

    // 近期表现反馈调整
    if (performanceFeedback.tradeCount >= 10) {
      if (performanceFeedback.lowBandPenalty > 5 && baseConfidence === 'LOW') {
        return { confidence: 'REJECT', reason: `近期低分段表现差(${performanceFeedback.lowBandPenalty.toFixed(1)}分惩罚)` };
      }
      if (performanceFeedback.drawdownPressure > 3 && baseConfidence === 'LOW') {
        return { confidence: 'REJECT', reason: `组合回撤压力${performanceFeedback.drawdownPressure.toFixed(1)}%` };
      }
    }
    if (performanceFeedback.tradeCount >= 3) {
      if (performanceFeedback.mediumBandPenalty > 3.5 && baseConfidence === 'MEDIUM') {
        return { confidence: 'REJECT', reason: `近期中分段表现差(${performanceFeedback.mediumBandPenalty.toFixed(1)}%均亏)` };
      }
      if (performanceFeedback.highBandPenalty > 4.5 && baseConfidence === 'HIGH') {
        return { confidence: 'REJECT', reason: `近期高分段表现差(${performanceFeedback.highBandPenalty.toFixed(1)}%均亏)` };
      }
    }

    if (isMarketOpen(currentTime)) {
      const preferredEndMinutes = pick.strategy?.bucket === 'continuation'
        ? Math.max(adaptive.tradeWindows.preferredEntryEndMinutes, 11 * 60)
        : adaptive.tradeWindows.preferredEntryEndMinutes;
      const outsidePreferredWindow =
        nowMinutes < adaptive.tradeWindows.preferredEntryStartMinutes ||
        nowMinutes > preferredEndMinutes;
      const inAfternoonWindow = nowMinutes >= (13 * 60) && nowMinutes <= (15 * 60);

      if (!adaptive.tradeWindows.allowAfternoonEntries && inAfternoonWindow) {
        return {
          confidence: 'REJECT',
          reason: `策略仅允许上午窗口开仓(${adaptive.tradeWindows.preferredEntryStartMinutes}-${preferredEndMinutes})`,
        };
      }
      if (outsidePreferredWindow && !inAfternoonWindow) {
        return {
          confidence: 'REJECT',
          reason: `当前不在首选开仓窗口(${adaptive.tradeWindows.preferredEntryStartMinutes}-${preferredEndMinutes})`,
        };
      }
    }

    if (baseConfidence === 'MEDIUM') {
      const stricterMediumChecks = {
        signalStrength: signalStrength.length >= 3,
        macdHistogram: h.macdHistogram != null && h.macdHistogram >= 0,
        gain5d: h.gain5d != null && h.gain5d >= -5 && h.gain5d <= 2.5,
        deviationFromMA20: h.deviationFromMA20 != null && h.deviationFromMA20 >= -4 && h.deviationFromMA20 <= 2.5,
        volumeRatio: volumeRatio >= 0.9 && volumeRatio <= 1.45,
      };
      const failedMediumChecks = Object.entries(stricterMediumChecks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key);
      if (failedMediumChecks.length > 0) {
        return { confidence: 'REJECT', reason: `中分段确认不足(${failedMediumChecks.join('/')})` };
      }
    }
    if (baseConfidence === 'MEDIUM' && isMarketOpen(currentTime) && isLateAfternoonSession(currentTime, adaptive.tradeWindows.mediumConfidenceCutoffMinutes)) {
      return {
        confidence: 'REJECT',
        reason: `午后${adaptive.tradeWindows.mediumConfidenceCutoffMinutes}分钟后禁止中置信度开仓`,
      };
    }
    if (isMarketOpen(currentTime) && isLateAfternoonSession(currentTime, adaptive.tradeWindows.latestEntryCutoffMinutes)) {
      return {
        confidence: 'REJECT',
        reason: `午后${adaptive.tradeWindows.latestEntryCutoffMinutes}分钟后停止新开仓`,
      };
    }
    if (adaptive.overnightRisk?.enabled && combinedScore >= (adaptive.overnightRisk.minScoreToCheck ?? 80)) {
      const overnightRiskCfg = pick.strategy?.bucket === 'continuation'
        ? {
            ...adaptive.overnightRisk,
            maxGain10d: Math.max(adaptive.overnightRisk.maxGain10d ?? 18, 24),
            maxGain5d: Math.max(adaptive.overnightRisk.maxGain5d ?? 4, 8),
            maxDeviationFromMA20: Math.max(adaptive.overnightRisk.maxDeviationFromMA20 ?? 8, 12),
            maxVolatility: Math.max(adaptive.overnightRisk.maxVolatility ?? 20, 24),
            maxRecent10LimitUps: Math.max(adaptive.overnightRisk.maxRecent10LimitUps ?? 0, 1),
          }
        : adaptive.overnightRisk;
      const overnightRiskChecks = {
        gain10d: h.gain10d == null || h.gain10d <= (overnightRiskCfg.maxGain10d ?? 18),
        gain5d: h.gain5d == null || h.gain5d <= (overnightRiskCfg.maxGain5d ?? 4),
        deviationFromMA20: h.deviationFromMA20 == null || h.deviationFromMA20 <= (overnightRiskCfg.maxDeviationFromMA20 ?? 8),
        volatility: h.volatility == null || h.volatility <= (overnightRiskCfg.maxVolatility ?? 20),
        recent10LimitUps: h.recent10LimitUps == null || h.recent10LimitUps <= (overnightRiskCfg.maxRecent10LimitUps ?? 0),
      };
      const failedOvernightRiskChecks = Object.entries(overnightRiskChecks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key);
      if (failedOvernightRiskChecks.length > 0) {
        return {
          confidence: 'REJECT',
          reason: `隔夜风险过高(${failedOvernightRiskChecks.join('/')})`,
        };
      }
    }
    if (adaptive.entryQuality?.enabled) {
      const pullbackFromHighPct = getPullbackFromHighPct(pick);
      const openDrawdownPct = getOpenDrawdownPct(pick);
      const entryQualityCfg = pick.strategy?.bucket === 'continuation'
        ? {
            ...adaptive.entryQuality,
            maxIntradayReturnPct: Math.max(adaptive.entryQuality.maxIntradayReturnPct ?? 4.5, 8.5),
            maxVolumeRatio: Math.max(adaptive.entryQuality.maxVolumeRatio ?? 1.6, 4.8),
            maxPullbackFromHighPct: Math.max(adaptive.entryQuality.maxPullbackFromHighPct ?? 1.2, 2.2),
            maxOpenDrawdownPct: Math.max(adaptive.entryQuality.maxOpenDrawdownPct ?? 1.8, 2.6),
          }
        : adaptive.entryQuality;
      const entryQualityChecks = {
        aboveOpen: !entryQualityCfg.requireAboveOpen || !pick.open || !pick.price || pick.price >= pick.open * 0.998,
        pullbackFromHigh: pullbackFromHighPct == null || pullbackFromHighPct <= (entryQualityCfg.maxPullbackFromHighPct ?? 1.2),
        intradayReturn: pick.intradayReturnPct == null || pick.intradayReturnPct <= (entryQualityCfg.maxIntradayReturnPct ?? 4.5),
        openDrawdown: openDrawdownPct == null || openDrawdownPct <= (entryQualityCfg.maxOpenDrawdownPct ?? 1.8),
        volumeRatio: volumeRatio <= (entryQualityCfg.maxVolumeRatio ?? 1.6),
      };
      const failedEntryQualityChecks = Object.entries(entryQualityChecks)
        .filter(([, passed]) => !passed)
        .map(([key]) => key);
      if (failedEntryQualityChecks.length > 0) {
        return {
          confidence: 'REJECT',
          reason: `早盘承接不足(${failedEntryQualityChecks.join('/')})`,
        };
      }
    }

    return {
      confidence: baseConfidence,
      reason: [...baseReason, ...signalStrength].join(','),
      signalStrength: signalStrength.length
    };
  }

  calculateExitUrgency(pos, pick, marketRegime) {
    const adaptive = this.getAdaptiveConfig();
    if (!adaptive.enabled) {
      return { urgency: 0, reasons: [] };
    }

    const weights = adaptive.exitUrgencyWeights;
    let totalUrgency = 0;
    const reasons = [];
    const entryBucket = pos.entryBucket || 'main';
    const isContinuationPosition = entryBucket === 'continuation';
    const effectiveDayScore = pick ? getSelectedBucketDayScore(pick) : (pos.entrySelectedDayScore || pos.entryScore || 0);
    const entrySelectedDayScore = pos.entrySelectedDayScore || pos.entryScore || 0;
    const highestPnlPct = pos.highPrice ? (((pos.highPrice - pos.entryPrice) / pos.entryPrice) * 100) : (pos.pnlPct || 0);

    // 1. 止损触发
    const stopLoss = pos.pnlPct <= (this.config.stopLossPct || -5);
    if (stopLoss) {
      totalUrgency += weights.stopLoss;
      reasons.push({ type: '止损', weight: weights.stopLoss, detail: `${pos.pnlPct.toFixed(2)}%` });
    }

    // 2. 移动止盈（盈利后启动保护）
    const trailingStopThreshold = this.config.takeProfitPartialPct || 6;
    const drawdownFromHigh = pos.highPrice ? (((pos.highPrice - pos.currentPrice) / pos.highPrice) * 100) : 0;
    const trailingStop = pos.pnlPct > trailingStopThreshold && drawdownFromHigh >= (this.config.exitDrawdownFromHighPct || 4);
    if (trailingStop) {
      totalUrgency += weights.trailingStop;
      reasons.push({ type: '移动止盈', weight: weights.trailingStop, detail: `最高${((pos.highPrice/pos.entryPrice-1)*100).toFixed(2)}%,回撤${drawdownFromHigh.toFixed(2)}%` });
    }

    // 3. 趋势失效止损
    if (pick) {
      const h = pick.history || {};
      const liveBucket = pick.strategy?.bucket || entryBucket;

      if (isContinuationPosition && liveBucket !== 'continuation') {
        totalUrgency += 75;
        reasons.push({ type: '强势失效', weight: 75, detail: `由${entryBucket}降为${liveBucket}` });
      }

      // 跌破MA60
      if (h.ma60 && pos.currentPrice < h.ma60) {
        totalUrgency += 80;
        reasons.push({ type: '跌破MA60', weight: 80, detail: `价格${pos.currentPrice.toFixed(2)}<MA60(${h.ma60})` });
      }

      // MACD明显转负
      if (h.macdHistogram < -0.1) {
        totalUrgency += 60;
        reasons.push({ type: 'MACD转负', weight: 60, detail: `MACD柱${h.macdHistogram.toFixed(3)}` });
      }

      // 10日跌幅过大
      if (h.gain10d !== null && h.gain10d < -8) {
        totalUrgency += 70;
        reasons.push({ type: '10日跌幅过大', weight: 70, detail: `${h.gain10d.toFixed(2)}%` });
      }

      // 评分下跌
      const exitScoreThreshold = isContinuationPosition
        ? Math.max(this.config.exitStrongScoreThreshold || 80, entrySelectedDayScore - 18)
        : (this.config.exitScoreThreshold || 55);
      const scoreDrop = effectiveDayScore < exitScoreThreshold;
      if (scoreDrop) {
        totalUrgency += weights.scoreDrop;
        reasons.push({ type: '评分下跌', weight: weights.scoreDrop, detail: `${effectiveDayScore}分<${exitScoreThreshold}` });
      }

      if (isContinuationPosition) {
        const prevClose = Number(pick.prevClose || 0);
        const continuationFailFast = (
          pick.open &&
          pos.currentPrice < pick.open * 0.997 &&
          (pos.pnlPct || 0) < 0
        );
        if (continuationFailFast) {
          totalUrgency += 70;
          reasons.push({ type: '强势承接失效', weight: 70, detail: `价格${pos.currentPrice.toFixed(2)}弱于开盘${pick.open}` });
        }

        if (highestPnlPct >= 1.8 && drawdownFromHigh >= 1.6) {
          totalUrgency += 70;
          reasons.push({ type: '强势回撤过快', weight: 70, detail: `最高${highestPnlPct.toFixed(2)}%回撤${drawdownFromHigh.toFixed(2)}%` });
        }

        if (pos.holdDays >= 1 && pick.open && prevClose > 0) {
          const weakVsOpen = pos.currentPrice < pick.open * 0.995;
          const weakVsPrevClose = pos.currentPrice < prevClose * 0.998;
          if (weakVsOpen && weakVsPrevClose) {
            totalUrgency += 85;
            reasons.push({ type: '次日承接失效', weight: 85, detail: `现价${pos.currentPrice.toFixed(2)}低于开盘${pick.open}和昨收${prevClose}` });
          }

          if (pick.open >= prevClose * 1.015 && pos.currentPrice <= prevClose * 0.998) {
            totalUrgency += 90;
            reasons.push({ type: '高开低走失效', weight: 90, detail: `高开${(((pick.open / prevClose) - 1) * 100).toFixed(2)}%后跌回昨收下` });
          }

          if (pick.high && pick.high >= pick.open * 1.02 && pos.currentPrice <= pick.open * 0.997) {
            totalUrgency += 55;
            reasons.push({ type: '冲高回落', weight: 55, detail: `高点${pick.high.toFixed(2)}后回落至${pos.currentPrice.toFixed(2)}` });
          }
        }

        if (highestPnlPct >= 2 && (pos.pnlPct || 0) <= 0.3) {
          totalUrgency += 80;
          reasons.push({ type: '利润回吐过大', weight: 80, detail: `最高${highestPnlPct.toFixed(2)}%回落至${(pos.pnlPct || 0).toFixed(2)}%` });
        }

        if (pos.holdDays >= 2 && (pos.pnlPct || 0) < 0.8) {
          totalUrgency += 45;
          reasons.push({ type: '强势停滞', weight: 45, detail: `${pos.holdDays}天仅${(pos.pnlPct || 0).toFixed(2)}%` });
        }
      }
    }

    // 4. 弱票固定止盈（到目标就走）
    const isWeakStock = !isContinuationPosition && (pos.combinedScore || pos.entryScore || 0) < 80 && pos.confidence !== 'HIGH';
    const weakTakeProfitPct = this.config.weakTakeProfitPct || 8;
    if (isWeakStock && pos.pnlPct >= weakTakeProfitPct) {
      totalUrgency += 70;
      reasons.push({ type: '弱票到目标', weight: 70, detail: `${pos.pnlPct.toFixed(2)}%≥${weakTakeProfitPct}%` });
    }

    // 5. 时间止损
    const maxHoldDays = isContinuationPosition
      ? Math.min(this.config.maxHoldDays || 10, 3)
      : (this.config.maxHoldDays || 10);
    const holdTooLong = pos.holdDays >= maxHoldDays;
    if (holdTooLong) {
      totalUrgency += weights.holdTooLong;
      reasons.push({ type: '持有超时', weight: weights.holdTooLong, detail: `${pos.holdDays}天` });
    }

    // 6. 弱势股（持有几天没起色）
    const weakStockDays = isContinuationPosition
      ? Math.max(2, (this.config.weakStockHoldDays || 4) - 1)
      : (this.config.weakStockHoldDays || 4);
    const weakStockProfit = this.config.weakStockMinProfit || 2;
    const weakStock = !holdTooLong && pos.holdDays >= weakStockDays && pos.pnlPct < weakStockProfit;
    if (weakStock) {
      totalUrgency += weights.weakStock;
      reasons.push({ type: '弱势股', weight: weights.weakStock, detail: `${pos.holdDays}天仅${pos.pnlPct.toFixed(2)}%` });
    }

    return {
      urgency: totalUrgency,
      reasons,
      shouldExit: totalUrgency >= adaptive.exitUrgencyThreshold
    };
  }

  logEquity(ts) {
    const equity = this.getTotalEquity();
    const entry = { ts, cash: this.cash, positionValue: equity - this.cash, totalEquity: equity };
    this.equityHistory.push(entry);
    appendJsonLine(this.equityPath, entry);
  }

  logAlert(type, symbol, name, message) {
    const ts = new Date().toISOString();
    const bjTime = formatBeijingTime(ts);
    const alert = { ts, bjTime, type, symbol, name, message };
    appendJsonLine(this.alertsPath, alert);
    console.log(`[ALERT] ${type} ${symbol} ${name}: ${message}`);
  }

  placeOrder(symbol, name, price, side, quantity, reason = '', metadata = {}) {
    const orderId = `ORD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = new Date().toISOString();
    const bjTime = formatBeijingTime(ts);
    const slippage = side === 'BUY' ? price * (this.config.slippageBp / 10000) : price * (-this.config.slippageBp / 10000);
    const executedPrice = price + slippage;
    const fee = (executedPrice * quantity) * (this.config.feeBp / 10000);
    const order = {
      orderId,
      symbol,
      name,
      side,
      price,
      executedPrice,
      quantity,
      amount: executedPrice * quantity,
      fee,
      status: 'FILLED',
      reason,
      ts,
      bjTime,
      ...metadata
    };
    this.orders.push(order);
    appendJsonLine(this.tradesPath, order);

    if (side === 'BUY') {
      this.cash -= (order.amount + fee);
      this.positions.set(symbol, {
        symbol,
        name,
        entryPrice: executedPrice,
        currentPrice: executedPrice,
        quantity,
        value: executedPrice * quantity,
        pnlPct: 0,
        entryTs: ts,
        entryDate: new Date(ts).toISOString().split('T')[0],
        holdRounds: 0,
        holdDays: 0,
        highPrice: executedPrice,
        lowPrice: executedPrice,
        confidence: metadata.confidence || 'UNKNOWN',
        entryScore: metadata.entryScore || 0,
        entrySelectedDayScore: metadata.entrySelectedDayScore || metadata.entryScore || 0,
        combinedScore: metadata.combinedScore || 0,
        marketRegime: metadata.marketRegime || 'UNKNOWN',
        sector: metadata.sector || 'UNKNOWN',
        entryBucket: metadata.entryBucket || 'main',
        liveBucket: metadata.entryBucket || 'main',
        liveBucketLabel: BUCKET_LABELS[metadata.entryBucket || 'main'] || (metadata.entryBucket || 'main'),
        liveSelectedDayScore: metadata.entrySelectedDayScore || metadata.entryScore || 0,
        liveCombinedScore: metadata.combinedScore || 0,
        exitUrgency: 0,
        exitShouldExit: false,
        exitReasons: [],
        exitSummary: '新开仓，等待下一轮评估',
        lastEvaluatedAt: bjTime,
        source: metadata.source || 'strategy'
      });
      this.logAlert('BUY', symbol, name, `买入 ${quantity}股 @${executedPrice.toFixed(3)} (${reason})`);
    } else {
      const pos = this.positions.get(symbol);
      if (pos) {
        const pnl = (executedPrice - pos.entryPrice) * quantity - fee;
        const holdDays = getTradingDaysBetween(pos.entryTs, ts);
        order.pnl = pnl;
        order.pnlPct = ((executedPrice - pos.entryPrice) / pos.entryPrice) * 100;
        order.holdDays = holdDays;
        order.holdRounds = pos.holdRounds;
        order.entryPrice = pos.entryPrice;
        order.entryTs = pos.entryTs;
        order.entryBjTime = formatBeijingTime(pos.entryTs);
        order.combinedScore = pos.combinedScore || 0;
        order.confidence = pos.confidence || 'UNKNOWN';
        order.entryBucket = pos.entryBucket || 'main';
        order.source = pos.source || metadata.source || 'strategy';
        this.cash += (order.amount - fee);
        this.positions.delete(symbol);
        this.sellCooldown.set(symbol, ts);

        // 写入交割单
        const settlement = {
          symbol,
          name,
          buyDate: formatBeijingTime(pos.entryTs).split(' ')[0],
          sellDate: bjTime.split(' ')[0],
          buyPrice: Number(pos.entryPrice.toFixed(3)),
          sellPrice: Number(executedPrice.toFixed(3)),
          quantity,
          pnl: Number(pnl.toFixed(2)),
          pnlPct: Number(order.pnlPct.toFixed(2)),
          holdDays,
          fee: Number(fee.toFixed(2)),
          reason,
          confidence: pos.confidence || 'UNKNOWN',
          entryScore: Number(pos.entryScore || 0),
          entrySelectedDayScore: Number(pos.entrySelectedDayScore || pos.entryScore || 0),
          combinedScore: Number(pos.combinedScore || pos.entryScore || 0),
          entryBucket: pos.entryBucket || 'main',
          entryMarketRegime: pos.marketRegime || 'UNKNOWN',
          source: pos.source || 'strategy',
          bjTime
        };
        appendJsonLine(this.settlementPath, settlement);

        // 更新统计
        this.statistics.totalTrades += 1;
        this.statistics.totalPnl += pnl;
        this.statistics.totalHoldDays += holdDays;
        if (pnl > 0) {
          this.statistics.winTrades += 1;
          this.statistics.totalWinPnl = (this.statistics.totalWinPnl || 0) + pnl;
          if (order.pnlPct > this.statistics.maxGain) this.statistics.maxGain = order.pnlPct;
        } else {
          this.statistics.lossTrades += 1;
          this.statistics.totalLossPnl = (this.statistics.totalLossPnl || 0) + Math.abs(pnl);
          if (order.pnlPct < this.statistics.maxLoss) this.statistics.maxLoss = order.pnlPct;
        }

        // 记录近期表现
        this.recordClosedTradePerformance({
          symbol,
          pnlPct: order.pnlPct,
          holdDays,
          combinedScore: pos.combinedScore,
          confidence: pos.confidence,
          source: pos.source || 'strategy',
          ts
        });

        const alertType = order.pnlPct >= 0 ? 'SELL_PROFIT' : 'SELL_LOSS';
        this.logAlert(alertType, symbol, name, `卖出 ${quantity}股 @${executedPrice.toFixed(3)} 盈亏${order.pnlPct.toFixed(2)}% (${reason})`);
        fs.writeFileSync(this.statisticsPath, JSON.stringify(this.statistics, null, 2));
      }
    }
    this.saveState();
    return order;
  }

  runTradeCycle(strategyPicks, ts, marketRegime = 'UNKNOWN', allMarketData = []) {
    const currentTime = new Date(ts);
    const marketOpen = isMarketOpen(currentTime);
    const adaptive = this.getAdaptiveConfig();
    const performanceFeedback = this.getPerformanceFeedback({ marketRegime });
    const positionsBefore = this.positions.size;

    // 先更新持仓价格（无论是否交易时间，都要更新持仓价格）
    const symbolToPick = new Map(strategyPicks.map(p => [p.symbol, p]));
    const symbolToMarket = new Map(allMarketData.map(p => [p.symbol, p]));
    const positionSignalMap = this.buildPositionSignalMap(allMarketData);

    for (const [symbol, pos] of this.positions.entries()) {
      const pick = symbolToPick.get(symbol) || positionSignalMap.get(symbol);
      const marketData = symbolToMarket.get(symbol);

      if (pick) {
        if (!pos.entryBucket && pick.strategy?.bucket) {
          pos.entryBucket = pick.strategy.bucket;
        }
        if (!pos.entrySelectedDayScore) {
          pos.entrySelectedDayScore = getSelectedBucketDayScore(pick);
        }
      }

      if (marketData && marketData.price) {
        pos.currentPrice = marketData.price;
      } else if (pick && pick.price) {
        pos.currentPrice = pick.price;
      }

      if (pos.currentPrice > (pos.highPrice || 0)) {
        pos.highPrice = pos.currentPrice;
      }
      if (!pos.lowPrice || pos.currentPrice < pos.lowPrice) {
        pos.lowPrice = pos.currentPrice;
      }

      pos.value = pos.currentPrice * pos.quantity;
      pos.pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    }

    const currentEquity = this.getTotalEquity();
    const portfolioDrawdown = ((this.peakEquity - currentEquity) / this.peakEquity) * 100;
    const recoveryMode = portfolioDrawdown > 5 && this.positions.size === 0;
    const regimeConfig = adaptive.regimeMultipliers[marketRegime] || adaptive.regimeMultipliers.NEUTRAL;
    const dynamicMaxPositions = Math.min(this.config.maxPositions, regimeConfig.maxPositions || this.config.maxPositions);
    const availablePositions = dynamicMaxPositions - this.positions.size;

    if (!marketOpen) {
      console.log(`[PAPER] 非交易时间，跳过交易 ts=${formatBeijingTime(ts)}`);
      this.latestTradeDiagnostics = buildTradeDecisionDiagnostics({}, {
        ts: formatBeijingTime(ts),
        marketRegime,
        marketOpen,
        portfolioDrawdown: Number(portfolioDrawdown.toFixed(2)),
        recoveryMode,
        strategyCandidateCount: strategyPicks.length,
        buyCandidateCount: 0,
        positionsBefore,
        positionsAfter: this.positions.size,
        availablePositions,
        skippedReason: '非交易时间',
      });
      this.saveState();
      this.logEquity(ts);
      return;
    }
    const holdObservations = [];
    const sellDecisions = [];
    const buyDecisionLog = { rejected: [], accepted: [] };
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
    }

    const protectedRecoveryPositions = Array.from(this.positions.values()).filter(isProfitProtectedPosition);
    const guardedRecoveryMode = portfolioDrawdown > 5 &&
      this.positions.size > 0 &&
      this.positions.size < 2 &&
      protectedRecoveryPositions.length > 0;
    if (portfolioDrawdown > 8) {
      if (this.lastAlertDrawdown < 8) {
        this.logAlert('PORTFOLIO_RISK', '', '', `组合回撤${portfolioDrawdown.toFixed(2)}%超过8%，清仓所有持仓`);
        this.lastAlertDrawdown = 8;
      }
      console.log(`[RISK] 组合回撤${portfolioDrawdown.toFixed(2)}%超过8%，清仓所有持仓`);
      for (const [symbol, pos] of this.positions.entries()) {
        this.placeOrder(symbol, pos.name, pos.currentPrice, 'SELL', pos.quantity, `组合风险控制(回撤${portfolioDrawdown.toFixed(2)}%)`);
      }
      this.latestTradeDiagnostics = buildTradeDecisionDiagnostics({}, {
        ts: formatBeijingTime(ts),
        marketRegime,
        marketOpen,
        portfolioDrawdown: Number(portfolioDrawdown.toFixed(2)),
        recoveryMode,
        strategyCandidateCount: strategyPicks.length,
        positionsBefore,
        positionsAfter: this.positions.size,
        skippedReason: '组合回撤超过8%，触发清仓',
      });
      this.saveState();
      this.logEquity(ts);
      return;
    }

    if (portfolioDrawdown > 5) {
      if (this.lastAlertDrawdown < 5) {
        const riskModeLabel = recoveryMode
          ? '进入空仓恢复模式'
          : guardedRecoveryMode
            ? '进入防守恢复模式'
            : '停止新开仓';
        this.logAlert('PORTFOLIO_RISK', '', '', `组合回撤${portfolioDrawdown.toFixed(2)}%超过5%，${riskModeLabel}`);
        this.lastAlertDrawdown = 5;
      }
      const riskModeText = recoveryMode
        ? '空仓恢复模式：仅允许小仓高确认信号'
        : guardedRecoveryMode
          ? `防守恢复模式：已有${protectedRecoveryPositions.length}只盈利延续仓，允许极小仓试错`
          : '停止新开仓';
      console.log(`[RISK] 组合回撤${portfolioDrawdown.toFixed(2)}%超过5%，${riskModeText}`);
    } else if (portfolioDrawdown < 3 && this.lastAlertDrawdown > 0) {
      this.lastAlertDrawdown = 0;
    }

    const toSell = [];
    for (const [symbol, pos] of this.positions.entries()) {
      const pick = symbolToPick.get(symbol) || positionSignalMap.get(symbol);
      pos.holdRounds += 1;
      pos.holdDays = getTradingDaysBetween(pos.entryTs, currentTime);

      const canSell = canSellToday(pos.entryTs, currentTime);
      if (!canSell) {
        this.updatePositionExitSnapshot(pos, {
          urgency: 0,
          shouldExit: false,
          reasons: [{ type: 'T+1限制', weight: 0, detail: '当日买入不可卖出' }],
        }, pick, currentTime);
        console.log(`[PAPER] T+1限制: ${symbol} 当天买入不能卖出`);
        continue;
      }

      if (pick && pick.changePercent <= -9.5) {
        this.updatePositionExitSnapshot(pos, {
          urgency: 0,
          shouldExit: false,
          reasons: [{ type: '跌停受限', weight: 0, detail: `${pick.changePercent}%` }],
        }, pick, currentTime);
        console.log(`[PAPER] 跌停限制: ${symbol} ${pos.name} 跌停${pick.changePercent}%无法卖出`);
        continue;
      }

      const exitDecision = this.calculateExitUrgency(pos, pick, marketRegime);
      this.updatePositionExitSnapshot(pos, exitDecision, pick, currentTime);
      if (exitDecision.shouldExit) {
        const reasonText = exitDecision.reasons.map(r => `${r.type}${r.detail ? `(${r.detail})` : ''}`).join(',');
        const sellItem = { ...pos, reason: `卖出紧迫度${exitDecision.urgency}: ${reasonText}`, urgency: exitDecision.urgency, reasons: exitDecision.reasons };
        toSell.push(sellItem);
        sellDecisions.push({ symbol, name: pos.name, urgency: exitDecision.urgency, reasons: exitDecision.reasons, pnlPct: Number((pos.pnlPct || 0).toFixed(2)) });
        console.log(`[PAPER] 卖出决策: ${symbol} ${pos.name} 紧迫度${exitDecision.urgency}/${adaptive.exitUrgencyThreshold} ${reasonText}`);
      } else if (exitDecision.reasons.length > 0) {
        const holdText = exitDecision.reasons.map(r => `${r.type}(${r.detail})`).join(',');
        holdObservations.push({ symbol, name: pos.name, holdDays: pos.holdDays, pnlPct: Number((pos.pnlPct || 0).toFixed(2)), urgency: exitDecision.urgency, reasons: exitDecision.reasons });
        console.log(`[PAPER] 持有观察: ${symbol} ${pos.name} 紧迫度${exitDecision.urgency}/${adaptive.exitUrgencyThreshold} ${holdText}`);
      }
    }

    for (const pos of toSell) {
      this.placeOrder(pos.symbol, pos.name, pos.currentPrice, 'SELL', pos.quantity, pos.reason);
    }
    if (holdObservations.length > 0 && global.scanLoggerRef) {
      global.scanLoggerRef.log('持有观察', { positions: holdObservations });
    }
    if (sellDecisions.length > 0 && global.scanLoggerRef) {
      global.scanLoggerRef.log('卖出决策', { sold: sellDecisions });
    }

    const cooldownMinutes = this.config.buyCooldownMinutes || 60;
    const profitableContinuationPositions = Array.from(this.positions.values()).filter(isProfitProtectedPosition);
    const allowAddOnRecovery = portfolioDrawdown > 5 &&
      this.positions.size > 0 &&
      profitableContinuationPositions.length > 0 &&
      this.positions.size < 2;
    const allowGuardedRecovery = guardedRecoveryMode || allowAddOnRecovery;

    const sectorCount = new Map();
    for (const pos of this.positions.values()) {
      const sector = pos.sector || 'UNKNOWN';
      sectorCount.set(sector, (sectorCount.get(sector) || 0) + 1);
    }

    let buyCandidates = [];
    if (availablePositions > 0 && this.cash > this.config.minCashReserve && (portfolioDrawdown <= 5 || recoveryMode || allowGuardedRecovery)) {
      buyCandidates = strategyPicks
        .filter(p => {
          const selectedDayScore = p.selectedDayScore || getSelectedBucketDayScore(p);
          const allowedBuckets = new Set(['main', 'continuation']);
          if (p.strategy?.bucket && !allowedBuckets.has(p.strategy.bucket)) {
            buyDecisionLog.rejected.push({
              symbol: p.symbol,
              name: p.name,
              reason: `仅低吸主池/趋势延续池允许开仓，当前为${p.strategy?.bucketLabel || p.strategy.bucket}`,
              dayScore: selectedDayScore,
              historyScore: p.historyScore || 0,
            });
            return false;
          }

          if (marketRegime === 'UNKNOWN') {
            buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason: '市场状态未知，禁止开仓', dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
            return false;
          }

          if (this.positions.has(p.symbol)) {
            buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason: '已持仓', dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
            return false;
          }

          const lastSellTs = this.sellCooldown.get(p.symbol);
          if (lastSellTs) {
            const minutesSinceSell = (currentTime - new Date(lastSellTs)) / (1000 * 60);
            if (minutesSinceSell < cooldownMinutes) {
              console.log(`[PAPER] ${p.symbol} ${p.name} 在冷却期内，跳过`);
              buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason: `冷却期${minutesSinceSell.toFixed(0)}分钟`, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
              return false;
            }
          }

          const sector = p.sector || 'UNKNOWN';
          if ((sectorCount.get(sector) || 0) >= 2) {
            console.log(`[PAPER] ${p.symbol} ${p.name} 行业${sector}已有2只，跳过`);
            buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason: `行业${sector}已有2只`, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
            return false;
          }

          const confidenceDecision = this.assessBuyConfidence(p, marketRegime, performanceFeedback, { currentTime });
          p.tradeDecision = confidenceDecision;
          if (confidenceDecision.confidence === 'REJECT') {
            console.log(`[PAPER] ${p.symbol} ${p.name} 拒绝买入: ${confidenceDecision.reason}`);
            buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason: confidenceDecision.reason, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
            return false;
          }
          if (recoveryMode) {
            const h = p.history || {};
            const signalStrength = confidenceDecision.signalStrength || 0;
            if (confidenceDecision.confidence !== 'HIGH') {
              const reason = `回撤恢复模式仅允许HIGH开仓(${confidenceDecision.confidence},强度${signalStrength})`;
              buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
              return false;
            }
            if (h.gain5d != null && h.gain5d > 6) {
              const reason = `回撤恢复模式拒绝短线过热(gain5d=${h.gain5d}%)`;
              buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
              return false;
            }
          }
          if (allowGuardedRecovery) {
            if (p.strategy?.bucket !== 'continuation' || confidenceDecision.confidence !== 'HIGH') {
              const reason = guardedRecoveryMode ? '防守恢复模式仅允许HIGH延续池' : '回撤加仓仅允许HIGH延续池';
              buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
              return false;
            }
            const selectedCombinedScore = getEffectiveCombinedScore(p, this.runtimeStrategy);
            if (selectedCombinedScore < 76) {
              const reason = `防守恢复模式要求综合分≥76(当前${selectedCombinedScore.toFixed(2)})`;
              buyDecisionLog.rejected.push({ symbol: p.symbol, name: p.name, reason, dayScore: selectedDayScore, historyScore: p.historyScore || 0 });
              return false;
            }
          }
          return true;
        })
        .sort((a, b) => {
          const confidenceRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
          const aRank = confidenceRank[a.tradeDecision?.confidence] || 0;
          const bRank = confidenceRank[b.tradeDecision?.confidence] || 0;
          if (bRank !== aRank) return bRank - aRank;
          return (b.combinedScore || b.score || 0) - (a.combinedScore || a.score || 0);
        })
        .slice(0, availablePositions);

      for (const pick of buyCandidates) {
        const confidence = pick.tradeDecision?.confidence || 'LOW';
        const confidenceBand = adaptive.confidenceBands[confidence.toLowerCase()] || adaptive.confidenceBands.low;
        const combinedScore = pick.combinedScore || pick.score || 70;
        const maxDrawdown = pick.history?.maxDrawdown || 20;

        let basePositionValue = this.config.maxPositionValue * (confidenceBand.positionMultiplier || 1);
        basePositionValue = basePositionValue * (regimeConfig.positionSize || 1);
        if (pick.strategy?.bucket === 'continuation') {
          basePositionValue *= 0.45;
        }
        if (recoveryMode) {
          basePositionValue *= 0.35;
        } else if (allowGuardedRecovery) {
          basePositionValue *= 0.25;
        }

        if (performanceFeedback.highBandBonus > 0 && confidence === 'HIGH') {
          basePositionValue *= 1 + Math.min(0.2, performanceFeedback.highBandBonus / 100);
        }
        if (performanceFeedback.drawdownPressure > 3) {
          basePositionValue *= 0.8;
        }
        if (maxDrawdown > 20) {
          basePositionValue *= 0.7;
        }

        const maxBuyValue = Math.min(basePositionValue, this.cash - this.config.minCashReserve);
        if (maxBuyValue <= 0) break;
        const selectedDayScore = pick.selectedDayScore || getSelectedBucketDayScore(pick);
        const quantity = Math.floor(maxBuyValue / (pick.price * this.config.lotSize)) * this.config.lotSize;
        if (quantity < this.config.lotSize) {
          buyDecisionLog.rejected.push({
            symbol: pick.symbol,
            name: pick.name,
            reason: `建议仓位不足一手(可用${maxBuyValue.toFixed(0)}元)`,
            dayScore: selectedDayScore,
            historyScore: pick.historyScore || 0,
          });
          continue;
        }

        const positionPct = (maxBuyValue / currentEquity * 100).toFixed(1);
        const buyReason = `置信度${confidence}(综合${combinedScore.toFixed(1)}分,${pick.tradeDecision.reason})`;
        console.log(`[PAPER] 买入: ${pick.symbol} ${pick.name} ${buyReason} 仓位${positionPct}% 市场${marketRegime}`);
        buyDecisionLog.accepted.push({ symbol: pick.symbol, name: pick.name, confidence, reason: pick.tradeDecision.reason, positionValue: maxBuyValue, dayScore: selectedDayScore, historyScore: pick.historyScore || 0 });
        this.placeOrder(pick.symbol, pick.name, pick.price, 'BUY', quantity, buyReason, {
          confidence,
          entryScore: pick.score || 0,
          entrySelectedDayScore: selectedDayScore,
          combinedScore,
          marketRegime,
          sector: pick.sector || 'UNKNOWN',
          entryBucket: pick.strategy?.bucket || 'main',
          source: 'strategy'
        });

        const sector = pick.sector || 'UNKNOWN';
        sectorCount.set(sector, (sectorCount.get(sector) || 0) + 1);
      }
    }

    if ((buyDecisionLog.rejected.length > 0 || buyDecisionLog.accepted.length > 0) && global.scanLoggerRef) {
      global.scanLoggerRef.log('买入决策', buyDecisionLog);
    }

    let skippedReason = null;
    if (availablePositions <= 0) {
      skippedReason = '持仓已满';
    } else if (this.cash <= this.config.minCashReserve) {
      skippedReason = '可用现金低于保留阈值';
    } else if (portfolioDrawdown > 5 && !recoveryMode && !allowGuardedRecovery) {
      skippedReason = '组合回撤超过5%，暂停开仓';
    } else if (strategyPicks.length === 0) {
      skippedReason = '无主候选';
    } else if (buyCandidates.length === 0 && buyDecisionLog.rejected.length === 0) {
      skippedReason = '主候选在排序前已被仓位约束过滤';
    } else if (buyCandidates.length === 0) {
      skippedReason = '候选均未通过交易层';
    } else if (buyDecisionLog.accepted.length === 0) {
      skippedReason = '通过过滤但仓位不足或被交易约束拒绝';
    }

    this.latestTradeDiagnostics = buildTradeDecisionDiagnostics(buyDecisionLog, {
      ts: formatBeijingTime(ts),
      marketRegime,
      marketOpen,
      portfolioDrawdown: Number(portfolioDrawdown.toFixed(2)),
      recoveryMode,
      strategyCandidateCount: strategyPicks.length,
      buyCandidateCount: buyCandidates.length,
      positionsBefore,
      positionsAfter: this.positions.size,
      availablePositions,
      skippedReason,
    });
    this.saveState();

    this.logEquity(ts);
  }

  getSuggestedPositionValue(pick, marketRegime = 'NEUTRAL') {
    const adaptive = this.getAdaptiveConfig();
    const performanceFeedback = this.getPerformanceFeedback();
    const confidenceDecision = this.assessBuyConfidence(pick, marketRegime, performanceFeedback);
    if (confidenceDecision.confidence === 'REJECT') {
      return {
        allowed: false,
        confidence: 'REJECT',
        suggestedAmount: 0,
        reason: confidenceDecision.reason
      };
    }

    const confidence = confidenceDecision.confidence;
    const confidenceBand = adaptive.confidenceBands[confidence.toLowerCase()] || adaptive.confidenceBands.low;
    const regimeConfig = adaptive.regimeMultipliers[marketRegime] || adaptive.regimeMultipliers.NEUTRAL;
    const maxDrawdown = pick.history?.maxDrawdown || 20;

    let basePositionValue = this.config.maxPositionValue * (confidenceBand.positionMultiplier || 1);
    basePositionValue = basePositionValue * (regimeConfig.positionSize || 1);
    if (pick.strategy?.bucket === 'continuation') {
      basePositionValue *= 0.45;
    }

    if (performanceFeedback.highBandBonus > 0 && confidence === 'HIGH') {
      basePositionValue *= 1 + Math.min(0.2, performanceFeedback.highBandBonus / 100);
    }
    if (performanceFeedback.drawdownPressure > 3) {
      basePositionValue *= 0.8;
    }
    if (maxDrawdown > 20) {
      basePositionValue *= 0.7;
    }

    const suggestedAmount = Math.min(basePositionValue, this.cash - this.config.minCashReserve);
    return {
      allowed: suggestedAmount > 0,
      confidence,
      suggestedAmount: Math.max(0, suggestedAmount),
      reason: confidenceDecision.reason
    };
  }

  getPortfolio() {
    const regime = global.latestMarketRegimeRef || 'UNKNOWN';
    const adaptive = this.getAdaptiveConfig();
    const regimeConfig = adaptive.regimeMultipliers[regime] || adaptive.regimeMultipliers.NEUTRAL;
    const dynamicMaxPositions = Math.min(this.config.maxPositions, regimeConfig.maxPositions || this.config.maxPositions);
    return {
      cash: this.cash,
      totalEquity: this.getTotalEquity(),
      pnlPct: ((this.getTotalEquity() / this.config.initialCash) - 1) * 100,
      positions: Array.from(this.positions.values()).sort((a, b) => b.value - a.value),
      positionCount: this.positions.size,
      maxPositions: dynamicMaxPositions,
      marketRegime: regime,
      performanceFeedback: this.getPerformanceFeedback(),
      latestTradeDiagnostics: this.latestTradeDiagnostics
    };
  }
}

async function main() {
  const config = loadConfig();
  const logsDir = path.join(__dirname, '..', 'logs');
  ensureDir(logsDir);
  const scanLogPath = path.join(logsDir, 'scan.log');
  const statePath = path.join(logsDir, 'state.json');
  const state = {
    startedAt: new Date().toISOString(),
    mode: 'eastmoney-dom-scanner',
    market: [],
    strategyPicks: [],
    observationPicks: [],
    marketCount: 0,
    scanRounds: 0,
    lastScanAt: null,
    researchWatchlist: { count: 0, generatedFrom: null },
    diagnostics: createEmptyScanDiagnostics(),
  };
  
  // 初始化模拟盘账户
  const paperAccount = config.paperTrading?.enabled ? new PaperAccount(config, logsDir) : null;
  if (paperAccount) {
    console.log(`[PAPER] 模拟盘已启用，初始资金: ${(paperAccount.config.initialCash / 10000).toFixed(0)}万`);
    global.paperAccountRef = paperAccount;
  }

  const scanner = new MarketScanner(config, async (payload) => {
    state.scanRounds += 1;
    state.lastScanAt = formatBeijingTime(payload.ts);
    state.market = mergeHistoryIntoMarketItems(payload.all, scanner.historyCache);
    state.strategyPicks = payload.picks;
    state.observationPicks = payload.observationPicks || [];
    state.marketCount = payload.all.length;
    state.marketRegime = payload.marketRegime;
    global.latestMarketRegimeRef = payload.marketRegime?.regime || 'UNKNOWN';
    state.researchWatchlist = payload.researchWatchlist || state.researchWatchlist;
    state.diagnostics = {
      ...createEmptyScanDiagnostics(),
      ...(payload.diagnostics || {}),
      tradeDecision: state.diagnostics?.tradeDecision || createEmptyTradeDiagnostics(),
    };
    appendJsonLine(scanLogPath, { ts: payload.ts, bjTime: formatBeijingTime(payload.ts), marketCount: payload.all.length, picks: payload.picks.slice(0, 20) });
    console.log(`[SCAN] round=${state.scanRounds} market=${state.marketCount} picks=${state.strategyPicks.length} ts=${formatBeijingTime(payload.ts)}`);

    // 补充持仓股票的实时价格（如果不在扫描结果中）
    if (paperAccount && paperAccount.positions.size > 0) {
      const marketSymbols = new Set(payload.all.map(p => p.symbol));
      const missingSymbols = [...paperAccount.positions.keys()].filter(s => !marketSymbols.has(s));
      if (missingSymbols.length > 0) {
        console.log(`[PAPER] 补充持仓实时价格: ${missingSymbols.join(', ')}`);
        const freshPrices = await fetchRealtimePricesForSymbols(missingSymbols);
        if (freshPrices.length > 0) {
          console.log(`[PAPER] 获取到${freshPrices.length}只股票实时价格: ${freshPrices.map(p => `${p.symbol}@${p.price}`).join(', ')}`);
          payload.all = [...payload.all, ...freshPrices];
        }
      }
    }

    // 执行模拟盘交易轮次
    if (paperAccount) {
      paperAccount.runTradeCycle(payload.picks, payload.ts, payload.marketRegime?.regime, payload.all);
      const portfolio = paperAccount.getPortfolio();
      state.diagnostics = {
        ...state.diagnostics,
        tradeDecision: portfolio.latestTradeDiagnostics || createEmptyTradeDiagnostics(),
      };
      console.log(`[PAPER] 权益: ${(portfolio.totalEquity / 10000).toFixed(2)}万 收益率: ${portfolio.pnlPct.toFixed(2)}% 持仓: ${portfolio.positionCount}/${portfolio.maxPositions}`);
    }

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }, logsDir);
  global.scanLoggerRef = scanner.scanLogger;

  // 暴露旧渲染函数供 legacyPages 使用
  global.__legacyRenderPaperHtml = renderPaperHtmlLegacy;
  global.__legacyRenderLogsHtml = renderLogsHtmlLegacy;

  // 创建统一 API 路由
  const apiRoutes = createApiRoutes(state, config, paperAccount, scanner.scanLogger);
  const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
  const useFrontend = fs.existsSync(frontendDistPath);

  const server = http.createServer((req, res) => {
    // 优先匹配 API 路由
    const routeKey = req.method === 'POST' ? `POST ${req.url}` : req.url;
    if (apiRoutes[routeKey]) {
      apiRoutes[routeKey](req, res);
      return;
    }

    // 新前端页面路由（如果已构建）
    if (useFrontend && (req.url === '/' || req.url === '/paper' || req.url === '/logs' || req.url.startsWith('/assets/'))) {
      serveFrontend(req, res, frontendDistPath);
      return;
    }

    // 旧页面路由（过渡期保留）
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderHtml(state, config, paperAccount, scanner.scanLogger)); return; }
    if (paperAccount && req.url === '/paper') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderPaperHtml(state, paperAccount.getPortfolio(), config)); return; }
    if (req.url === '/logs') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderLogsHtml(scanner.scanLogger)); return; }

    // 兼容旧接口（无 /api 前缀）
    if (req.url === '/health') { apiRoutes['/api/health'](req, res); return; }
    if (req.url === '/state') { apiRoutes['/api/state'](req, res); return; }
    if (req.url === '/scan') { apiRoutes['/api/scan'](req, res); return; }
    if (req.url === '/strategy') { apiRoutes['/api/strategy'](req, res); return; }
    if (paperAccount && req.url === '/portfolio') { apiRoutes['/api/portfolio'](req, res); return; }
    if (paperAccount && req.url === '/orders') { apiRoutes['/api/orders'](req, res); return; }
    if (paperAccount && req.url === '/trades') { apiRoutes['/api/trades'](req, res); return; }
    if (paperAccount && req.url === '/settlement') { apiRoutes['/api/settlement'](req, res); return; }
    if (paperAccount && req.url === '/statistics') { apiRoutes['/api/statistics'](req, res); return; }
    if (paperAccount && req.url === '/equity') { apiRoutes['/api/equity'](req, res); return; }
    if (paperAccount && req.url === '/alerts') { apiRoutes['/api/alerts'](req, res); return; }
    if (paperAccount && req.method === 'POST' && req.url === '/buy') { apiRoutes['POST /api/buy'](req, res); return; }
    if (paperAccount && req.method === 'POST' && req.url === '/sell') { apiRoutes['POST /api/sell'](req, res); return; }

    // 单个股票查询
    const match = req.url.match(/^\/scan\/(sh\d{6}|sz\d{6}|\d{6})$/);
    if (match) { const raw = req.url.split('/').pop(); const symbol = normalizeSymbol(raw); const item = state.market.find((x) => x.symbol === symbol) || null; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(item)); return; }

    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(config.server.port, async () => { console.log(`[HTTP] server listening on http://localhost:${config.server.port}`); console.log('[APP] Eastmoney DOM market scanner started'); await scanner.start(); });
  const shutdown = async () => { console.log('[APP] shutting down'); await scanner.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error('[FATAL]', err); process.exit(1); });
