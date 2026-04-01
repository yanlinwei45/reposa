function handleLogsApi(scanLogger, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(scanLogger.getRecentLogs(50)));
}

module.exports = {
  handleLogsApi,
};
