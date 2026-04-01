const fs = require('fs');

function readJsonLines(filePath, { reverse = false, limit = null } = {}) {
  if (!fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);

  const result = reverse ? rows.reverse() : rows;
  return limit ? result.slice(0, limit) : result;
}

function buildStatistics(paperAccount) {
  const stats = fs.existsSync(paperAccount.statisticsPath)
    ? JSON.parse(fs.readFileSync(paperAccount.statisticsPath, 'utf8'))
    : paperAccount.statistics;
  const winRate = stats.totalTrades > 0 ? (stats.winTrades / stats.totalTrades * 100) : 0;
  const avgHoldDays = stats.totalTrades > 0 ? (stats.totalHoldDays / stats.totalTrades) : 0;
  const avgWin = stats.winTrades > 0 ? ((stats.totalWinPnl || 0) / stats.winTrades / 10000) : 0;
  const avgLoss = stats.lossTrades > 0 ? ((stats.totalLossPnl || 0) / stats.lossTrades / 10000) : 0;
  const profitFactor = (stats.totalLossPnl || 0) > 0 ? (stats.totalWinPnl || 0) / (stats.totalLossPnl || 1) : 0;
  const totalPnlPct = (stats.totalPnl / paperAccount.config.initialCash * 100);

  return {
    ...stats,
    winRate: Number(winRate.toFixed(2)),
    avgHoldDays: Number(avgHoldDays.toFixed(1)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    totalPnlPct: Number(totalPnlPct.toFixed(2))
  };
}

module.exports = {
  readJsonLines,
  buildStatistics,
};
