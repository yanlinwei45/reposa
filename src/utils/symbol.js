function normalizeSymbol(symbol) {
  const raw = String(symbol).trim().toLowerCase();
  if (/^(sh|sz)\d{6}$/.test(raw)) return raw;
  const pure = raw.replace(/^(sh|sz)/, '');
  return pure.startsWith('6') || pure.startsWith('9') ? `sh${pure}` : `sz${pure}`;
}

function isMainBoardCode(code) {
  return /^(600|601|603|605|000|001)\d{3}$/.test(String(code || '').trim());
}

function isLikelyStName(name) {
  const n = String(name || '').toUpperCase().replace(/\s+/g, '');
  return n.includes('ST') || n.includes('*ST');
}

function toEastmoneyUrl(symbol) {
  return `https://quote.eastmoney.com/${normalizeSymbol(symbol)}.html`;
}

module.exports = {
  normalizeSymbol,
  isMainBoardCode,
  isLikelyStName,
  toEastmoneyUrl,
};
