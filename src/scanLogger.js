const fs = require('fs');
const path = require('path');

class ScanLogger {
  constructor(logsDir) {
    this.logsDir = logsDir;
    this.scanLogsPath = path.join(logsDir, 'scan_details.log');
    this.currentScanLog = null;
  }

  startScan(ts, bjTime) {
    this.currentScanLog = {
      ts,
      bjTime,
      startTime: Date.now(),
      steps: [],
      summary: {}
    };
    this.log('开始扫描', { ts: bjTime });
  }

  log(step, data) {
    if (!this.currentScanLog) return;
    this.currentScanLog.steps.push({
      step,
      data,
      time: Date.now() - this.currentScanLog.startTime
    });
  }

  endScan(summary) {
    if (!this.currentScanLog) return;
    this.currentScanLog.summary = summary;
    this.currentScanLog.duration = Date.now() - this.currentScanLog.startTime;

    // 追加到日志文件
    const logLine = JSON.stringify(this.currentScanLog) + '\n';
    fs.appendFileSync(this.scanLogsPath, logLine);

    const result = this.currentScanLog;
    this.currentScanLog = null;
    return result;
  }

  getRecentLogs(limit = 50) {
    if (!fs.existsSync(this.scanLogsPath)) {
      return [];
    }

    const content = fs.readFileSync(this.scanLogsPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const logs = lines.slice(-limit).map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    return logs.reverse(); // 最新的在前面
  }

  getLatestLog() {
    const logs = this.getRecentLogs(1);
    return logs.length > 0 ? logs[0] : null;
  }
}

module.exports = ScanLogger;
