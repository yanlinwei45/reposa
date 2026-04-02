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
    return { items: [], map: new Map(), generatedFrom: null, count: 0 };
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
      }))
      .filter(item => item.symbol);

    return {
      items,
      map: new Map(items.map(item => [item.symbol, item])),
      generatedFrom: data.generated_from || null,
      count: Number(data.count || items.length),
    };
  } catch (err) {
    return { items: [], map: new Map(), generatedFrom: null, count: 0, error: err.message };
  }
}

module.exports = {
  loadResearchWatchlist,
};
