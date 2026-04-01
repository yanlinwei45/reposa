function formatWan(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${(value / 10000).toFixed(2)}万`;
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

module.exports = {
  formatWan,
  formatPct,
};
