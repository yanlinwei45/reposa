function toBeijingTime(date = new Date()) {
  const utcDate = new Date(date);
  return new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);
}

function formatBeijingTime(date = new Date()) {
  const bjTime = toBeijingTime(date);
  return bjTime.toISOString().replace('T', ' ').substring(0, 19);
}

function isSameDay(date1, date2) {
  const d1 = toBeijingTime(date1);
  const d2 = toBeijingTime(date2);
  return d1.getUTCFullYear() === d2.getUTCFullYear() &&
         d1.getUTCMonth() === d2.getUTCMonth() &&
         d1.getUTCDate() === d2.getUTCDate();
}

function getHistoryCacheDateKey(date = new Date()) {
  const bjTime = toBeijingTime(date);
  const year = bjTime.getUTCFullYear();
  const month = String(bjTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bjTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTradingDaysBetween(startDate, endDate) {
  const start = toBeijingTime(startDate);
  const end = toBeijingTime(endDate);
  let days = 0;
  const current = new Date(start);

  while (current <= end) {
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) {
      days++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return days;
}

function canSellToday(entryTs, currentTs = new Date()) {
  return !isSameDay(entryTs, currentTs);
}

module.exports = {
  toBeijingTime,
  formatBeijingTime,
  isSameDay,
  getHistoryCacheDateKey,
  getTradingDaysBetween,
  canSellToday,
};
