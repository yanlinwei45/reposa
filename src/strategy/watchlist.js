const fs = require('fs');
const path = require('path');
const { normalizeSymbol } = require('../utils/symbol');

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function loadResearchWatchlist() {
  const watchlistPath = path.join(__dirname, '..', '..', 'config', 'watchlist.json');
  if (!fs.existsSync(watchlistPath)) {
    return { items: [], map: new Map(), generatedFrom: null, count: 0, activeCount: 0, mode: null };
  }

  try {
    const data = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const items = rawItems
      .map((item, index) => ({
        symbol: normalizeSymbol(item.symbol || ''),
        rawSymbol: String(item.symbol || ''),
        name: item.name || String(item.symbol || ''),
        researchScore: toNumber(item.score),
        researchRank: index + 1,
        rankingMode: String(item.ranking_mode || data.mode || 'strict'),
      }))
      .filter(item => item.symbol);
    const activeItems = items.filter(item => item.rankingMode !== 'fallback');

    return {
      items,
      map: new Map(items.map(item => [item.symbol, item])),
      generatedFrom: data.generated_from || null,
      count: Number(data.count || items.length),
      activeCount: activeItems.length,
      mode: data.mode || null,
    };
  } catch (err) {
    return { items: [], map: new Map(), generatedFrom: null, count: 0, activeCount: 0, mode: null, error: err.message };
  }
}

module.exports = {
  loadResearchWatchlist,
};
