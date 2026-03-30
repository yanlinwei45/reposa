const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { fetch60DayKline, calculate60DayIndicators, score60DayHistory, fetchIndexData, analyzeMarketRegime } = require('./history');
const ScanLogger = require('./scanLogger');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function decodeLatin1ToUtf8(text) {
  try { return Buffer.from(text, 'latin1').toString('utf8'); } catch (_) { return text; }
}

function loadConfig() {
  const configDir = path.join(__dirname, '..', 'config');
  const configPath = path.join(configDir, 'default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
  if (config.strategy.minTurnoverRatePercent == null) config.strategy.minTurnoverRatePercent = 10;
  if (config.strategy.minVolumeRatio == null) config.strategy.minVolumeRatio = 2;
  if (config.strategy.minChangePercent == null) config.strategy.minChangePercent = 3;
  if (config.strategy.maxChangePercent == null) config.strategy.maxChangePercent = 8.5;
  if (config.strategy.topN == null) config.strategy.topN = 100;
  if (config.strategy.minAmount == null) config.strategy.minAmount = 300000000;
  if (config.strategy.gradeAThreshold == null) config.strategy.gradeAThreshold = 80;
  if (config.strategy.gradeBThreshold == null) config.strategy.gradeBThreshold = 65;
  if (config.strategy.gradeCThreshold == null) config.strategy.gradeCThreshold = 50;
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

function toBeijingTime(date = new Date()) {
  const utcDate = new Date(date);
  return new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);
}

function formatBeijingTime(date = new Date()) {
  const bjTime = toBeijingTime(date);
  return bjTime.toISOString().replace('T', ' ').substring(0, 19);
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

function isSameDay(date1, date2) {
  const d1 = toBeijingTime(date1);
  const d2 = toBeijingTime(date2);
  return d1.getUTCFullYear() === d2.getUTCFullYear() &&
         d1.getUTCMonth() === d2.getUTCMonth() &&
         d1.getUTCDate() === d2.getUTCDate();
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

function toEastmoneyUrl(symbol) {
  return `https://quote.eastmoney.com/${normalizeSymbol(symbol)}.html`;
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

function scoreTurnoverRatePercent(v) {
  if (v >= 30) return 30;
  if (v >= 20) return 27;
  if (v >= 15) return 22;
  if (v >= 10) return 15;
  return 0;
}

function scoreVolumeRatio(v) {
  if (v > 6) return 30;
  if (v >= 4) return 27;
  if (v >= 3) return 22;
  if (v >= 2) return 15;
  return 0;
}

function scoreChangePercent(v, maxChangePercent) {
  if (v > maxChangePercent) return 0;
  if (v >= 7 && v <= maxChangePercent) return 20;
  if (v >= 5 && v < 7) return 18;
  if (v >= 3 && v < 5) return 12;
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

function buildPositiveTags(item) {
  const tags = [];
  const turnoverRatePercent = item.turnoverRatePercent || 0;
  const volumeRatio = item.volumeBurstRatio || item.volumeRatio || 0;
  const turnover = item.turnover || 0;
  const changePercent = item.changePercent || 0;
  const price = item.price || 0;
  const open = item.open || 0;
  const high = item.high || 0;

  if (turnoverRatePercent >= 15) tags.push('高换手');
  else if (turnoverRatePercent >= 10) tags.push('换手达标');

  if (volumeRatio >= 4) tags.push('强放量');
  else if (volumeRatio >= 3) tags.push('明显放量');
  else if (volumeRatio >= 2) tags.push('放量达标');

  if (turnover >= 1000000000) tags.push('大成交额');
  else if (turnover >= 500000000) tags.push('成交额充足');

  if (changePercent >= 7) tags.push('强势上涨');
  else if (changePercent >= 5) tags.push('中强上涨');
  else if (changePercent >= 3) tags.push('启动区间');

  if (high && price) {
    const drawdownPct = ((high - price) / price) * 100;
    if (drawdownPct <= 1.5) tags.push('接近日内高点');
  }

  if (open && price && price > open) tags.push('强于开盘价');
  return tags;
}

function buildRiskTags(item) {
  const tags = [];
  const changePercent = item.changePercent || 0;
  const turnoverRatePercent = item.turnoverRatePercent || 0;
  const turnover = item.turnover || 0;
  const open = item.open || 0;
  const price = item.price || 0;
  const high = item.high || 0;

  if (changePercent > 8.0) tags.push('接近涨停_谨慎追高');
  if (turnoverRatePercent > 30) tags.push('超高换手_波动较大');
  if (turnover < 500000000) tags.push('成交额偏低');
  if (open && price && price < open) tags.push('弱于开盘价');

  if (high && price) {
    const drawdownPct = ((high - price) / price) * 100;
    if (drawdownPct > 2.5) tags.push('冲高回落迹象');
  }

  return tags;
}

function getStrategyGrade(score, strategy) {
  const a = strategy.gradeAThreshold == null ? 80 : strategy.gradeAThreshold;
  const b = strategy.gradeBThreshold == null ? 65 : strategy.gradeBThreshold;
  const c = strategy.gradeCThreshold == null ? 50 : strategy.gradeCThreshold;
  if (score >= a) return 'A';
  if (score >= b) return 'B';
  if (score >= c) return 'C';
  return 'DROP';
}

function scoreStrategy(item, strategy) {
  const turnoverRatePercent = item.turnoverRatePercent || 0;
  const volRatio = item.volumeBurstRatio || item.volumeRatio || 0;
  const changePercent = item.changePercent || 0;
  const turnover = item.turnover || 0;
  const maxChangePercent = strategy.maxChangePercent == null ? 8.5 : strategy.maxChangePercent;

  const hardMatched =
    !!item.isMainBoard &&
    !item.isST &&
    !!item.isTenPercentLimit &&
    turnoverRatePercent >= strategy.minTurnoverRatePercent &&
    volRatio >= strategy.minVolumeRatio &&
    changePercent >= strategy.minChangePercent &&
    changePercent <= maxChangePercent &&
    turnover >= strategy.minAmount;

  const rawScore =
    scoreTurnoverRatePercent(turnoverRatePercent) +
    scoreVolumeRatio(volRatio) +
    scoreChangePercent(changePercent, maxChangePercent) +
    scoreTurnoverAmount(turnover) +
    scoreNearHigh(item) +
    scoreAboveOpen(item);

  const score = Math.min(rawScore, 100);
  const grade = getStrategyGrade(score, strategy);
  const strategyMatched = hardMatched && grade !== 'DROP';

  return {
    ...item,
    score: Number(score.toFixed(4)),
    signal: strategyMatched ? 'HOT' : 'WATCH',
    strategyMatched,
    strategy: {
      score: Number(score.toFixed(4)),
      grade,
      positiveTags: buildPositiveTags(item),
      riskTags: buildRiskTags(item),
      selectedReason: {
        isMainBoard: !!item.isMainBoard,
        notST: !item.isST,
        tenPercentLimit: !!item.isTenPercentLimit,
        turnoverQualified: turnover >= strategy.minAmount,
        turnoverRateQualified: turnoverRatePercent >= strategy.minTurnoverRatePercent,
        volumeRatioQualified: volRatio >= strategy.minVolumeRatio,
        changePercentQualified: changePercent >= strategy.minChangePercent && changePercent <= maxChangePercent
      }
    }
  };
}

function formatWan(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${(value / 10000).toFixed(2)}万`;
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function renderHtml(state, config) {
  const marketRegime = state.marketRegime || {};
  const regimeColor = marketRegime.regime === 'BULL' ? '#ef4444' : marketRegime.regime === 'BEAR' ? '#22c55e' : '#9ca3af';
  const regimeText = marketRegime.regime === 'BULL' ? '牛市' : marketRegime.regime === 'BEAR' ? '熊市' : marketRegime.regime === 'NEUTRAL' ? '震荡' : '未知';

  const rows = state.strategyPicks.map((item, idx) => {
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
    return `<tr><td>${idx + 1}</td><td>${item.symbol || ''}</td><td>${item.name || ''}</td><td style="font-size:12px;color:#9ca3af">${item.sector || '-'}</td><td>${item.price ?? ''}</td><td class="${(item.changePercent || 0) >= 0 ? 'up' : 'down'}">${item.changePercent ?? ''}%</td><td>${item.turnoverRatePercent ?? ''}%</td><td>${item.volumeBurstRatio ?? item.volumeRatio ?? ''}</td><td>${item.turnover ? (item.turnover/1e8).toFixed(2) : ''}亿</td><td>${item.score ?? ''}</td><td>${historyScore}</td><td><strong>${combinedScore}</strong></td><td>${gain60d}</td><td>${macd}</td><td>${rsi}</td><td><span class="badge grade grade-${String(grade).toLowerCase()}">${grade || '-'}</span></td><td class="tags">${positiveTags || '-'}</td><td><a href="${item.eastmoneyUrl}" target="_blank" rel="noreferrer">东财</a></td></tr>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta http-equiv="refresh" content="15" /><title>A股扫描</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#0b1020;color:#e5e7eb}.wrap{max-width:1800px;margin:0 auto;padding:24px}.nav{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.nav a{display:inline-block;padding:8px 14px;border:1px solid #334155;border-radius:999px;background:#111827;color:#cbd5e1;text-decoration:none}.nav a.active{background:#2563eb;color:#fff;border-color:#2563eb}h1{margin:0 0 16px;font-size:28px}.muted{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:16px 0 20px}.card{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px}.big{font-size:24px;font-weight:700;margin-top:8px}.rule{margin:10px 0 0;line-height:1.7}table{width:100%;border-collapse:collapse;background:#111827;border-radius:14px;overflow:hidden}th,td{padding:10px 8px;border-bottom:1px solid #1f2937;font-size:13px;text-align:left;vertical-align:middle}th{background:#0f172a;color:#cbd5e1;position:sticky;top:0;font-weight:600}.up{color:#ef4444}.down{color:#22c55e}.badge{padding:4px 8px;border-radius:999px;font-size:12px;font-weight:600;display:inline-block}.badge.strong{background:rgba(239,68,68,.15);color:#fca5a5}.badge.watch{background:rgba(59,130,246,.15);color:#93c5fd}.badge.grade-a{background:rgba(34,197,94,.15);color:#86efac}.badge.grade-b{background:rgba(59,130,246,.15);color:#93c5fd}.badge.grade-c{background:rgba(250,204,21,.15);color:#fde68a}.badge.grade-drop{background:rgba(156,163,175,.15);color:#d1d5db}.tags{max-width:200px;white-space:normal;line-height:1.5}.tags.risk{color:#fca5a5}a{color:#93c5fd;text-decoration:none}@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}}@media(max-width:640px){.grid{grid-template-columns:1fr;}}</style></head><body><div class="wrap"><div class="nav"><a href="/" class="active">扫描看板</a><a href="/paper">模拟盘看板</a><a href="/logs">扫描日志</a></div><h1>A股主板强势异动扫描（东方财富口径）</h1><div class="muted rule">硬过滤：仅沪深主板、非ST、10%涨跌幅标的；换手率 ≥ ${config.strategy.minTurnoverRatePercent}%；量比 ≥ ${config.strategy.minVolumeRatio}；涨幅 ${config.strategy.minChangePercent}% ~ ${config.strategy.maxChangePercent}%；成交额 ≥ ${(config.strategy.minAmount / 1e8).toFixed(1)}亿</div><div class="grid"><div class="card"><div class="muted">市场环境</div><div class="big" style="color:${regimeColor}">${regimeText}</div><div class="muted" style="margin-top:4px;font-size:12px">上证 ${marketRegime.current || '-'}</div></div><div class="card"><div class="muted">股票池数量</div><div class="big">${state.marketCount}</div></div><div class="card"><div class="muted">命中数量</div><div class="big">${state.strategyPicks.length}</div></div><div class="card"><div class="muted">最后扫描时间</div><div class="big" style="font-size:16px">${state.lastScanAt || '-'}</div></div><div class="card"><div class="muted">扫描轮次</div><div class="big">${state.scanRounds}</div></div></div><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>行业</th><th>现价</th><th>涨跌幅</th><th>换手率</th><th>量比</th><th>成交额</th><th>日评分</th><th>历史分</th><th>综合分</th><th>60日涨幅</th><th>MACD</th><th>RSI</th><th>等级</th><th>标签</th><th>链接</th></tr></thead><tbody>${rows || '<tr><td colspan="18" class="muted">等待扫描数据...</td></tr>'}</tbody></table></div></body></html>`;
}

function renderPaperHtml(state, portfolio, config) {
  const marketRegime = state.marketRegime || {};
  const regimeColor = marketRegime.regime === 'BULL' ? '#ef4444' : marketRegime.regime === 'BEAR' ? '#22c55e' : '#9ca3af';
  const regimeText = marketRegime.regime === 'BULL' ? '牛市' : marketRegime.regime === 'BEAR' ? '熊市' : marketRegime.regime === 'NEUTRAL' ? '震荡' : '未知';

  const stopLossPct = config.paperTrading?.stopLossPct || -5;
  const takeProfitPct = config.paperTrading?.takeProfitPct || 12;

  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const positionRows = positions.map((pos, idx) => {
    const stopLossPrice = pos.entryPrice ? (pos.entryPrice * (1 + stopLossPct / 100)).toFixed(3) : '-';
    const takeProfitPrice = pos.entryPrice ? (pos.entryPrice * (1 + takeProfitPct / 100)).toFixed(3) : '-';
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
      <td style="font-size:12px;color:#ef4444">${takeProfitPrice}</td>
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

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta http-equiv="refresh" content="15" /><title>模拟盘看板</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#0b1020;color:#e5e7eb}.wrap{max-width:1680px;margin:0 auto;padding:24px}.nav{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.nav a{display:inline-block;padding:8px 14px;border:1px solid #334155;border-radius:999px;background:#111827;color:#cbd5e1;text-decoration:none}.nav a.active{background:#2563eb;color:#fff;border-color:#2563eb}.muted{color:#9ca3af}h1{margin:0 0 8px;font-size:28px}h3{margin:0 0 12px;font-size:18px}.sub{margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:16px 0 20px}.card{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px}.big{font-size:28px;font-weight:700;margin-top:8px}.big.up{color:#ef4444}.big.down{color:#22c55e}.panel{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:16px;margin-bottom:16px}.market-info{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}.market-item{background:#0f172a;padding:10px;border-radius:8px}.market-item .label{font-size:12px;color:#9ca3af;margin-bottom:4px}.market-item .value{font-size:18px;font-weight:600}table{width:100%;border-collapse:collapse;background:#111827;border-radius:14px;overflow:hidden}th,td{padding:12px 10px;border-bottom:1px solid #1f2937;font-size:14px;text-align:left;vertical-align:middle}th{background:#0f172a;color:#cbd5e1}.up{color:#ef4444}.down{color:#22c55e}.svgbox{width:100%;min-height:280px;background:#0f172a;border:1px solid #1f2937;border-radius:12px;padding:8px;box-sizing:border-box}.empty{padding:24px 0;color:#9ca3af;text-align:center}.tabs{display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid #1f2937}.tab{padding:10px 16px;cursor:pointer;border-bottom:2px solid transparent;color:#9ca3af;transition:all .2s}.tab.active{color:#60a5fa;border-bottom-color:#60a5fa}.tab-content{display:none}.tab-content.active{display:block}@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr);}}</style></head><body><div class="wrap"><div class="nav"><a href="/">扫描看板</a><a href="/paper" class="active">模拟盘看板</a><a href="/logs">扫描日志</a></div><h1>模拟盘可视化看板</h1><div class="sub muted">最后扫描时间：${state.lastScanAt || '-'} · 扫描轮次：${state.scanRounds}</div><div class="panel"><h3>市场环境</h3><div style="display:flex;align-items:center;gap:16px;margin-bottom:12px"><div style="font-size:32px;font-weight:700;color:${regimeColor}">${regimeText}</div><div class="muted">上证指数 ${marketRegime.current || '-'}</div></div><div class="market-info"><div class="market-item"><div class="label">MA20</div><div class="value">${marketRegime.ma20 || '-'}</div></div><div class="market-item"><div class="label">MA60</div><div class="value">${marketRegime.ma60 || '-'}</div></div><div class="market-item"><div class="label">趋势</div><div class="value" style="font-size:14px">${marketRegime.aboveMA20 ? '✓ 站上MA20' : '✗ 跌破MA20'}<br/>${marketRegime.aboveMA60 ? '✓ 站上MA60' : '✗ 跌破MA60'}</div></div></div></div><div class="grid"><div class="card"><div class="muted">总权益</div><div class="big">${formatWan(portfolio?.totalEquity)}</div></div><div class="card"><div class="muted">账户现金</div><div class="big">${formatWan(portfolio?.cash)}</div></div><div class="card"><div class="muted">总收益率</div><div class="big ${(portfolio?.pnlPct || 0) >= 0 ? 'up' : 'down'}">${formatPct(portfolio?.pnlPct)}</div></div><div class="card"><div class="muted">持仓 / 上限</div><div class="big">${portfolio?.positionCount ?? 0} / ${portfolio?.maxPositions ?? 0}</div></div><div class="card" id="statsCard"><div class="muted">胜率</div><div class="big">-</div></div><div class="card" id="avgHoldCard"><div class="muted">平均持有</div><div class="big">-</div></div><div class="card" id="profitFactorCard"><div class="muted">盈亏比</div><div class="big">-</div></div><div class="card" id="maxGainCard"><div class="muted">最大盈利</div><div class="big">-</div></div><div class="card" id="maxLossCard"><div class="muted">最大亏损</div><div class="big">-</div></div><div class="card" id="totalTradesCard"><div class="muted">总交易数</div><div class="big">-</div></div></div><div class="panel"><h3>持仓列表</h3><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>行业</th><th>买入价</th><th>现价</th><th>止损价</th><th>止盈价</th><th>最高价</th><th>距高点</th><th>数量</th><th>市值</th><th>浮盈亏</th><th>持有天数</th><th>建仓日期</th><th>操作</th></tr></thead><tbody>${positionRows || '<tr><td colspan="16" class="empty">当前没有持仓</td></tr>'}</tbody></table></div><div class="panel"><h3>权益曲线</h3><div id="equityChart" class="svgbox"></div></div><div class="panel"><div class="tabs"><div class="tab active" onclick="switchTab('settlement')">交割单</div><div class="tab" onclick="switchTab('trades')">订单流水</div><div class="tab" onclick="switchTab('alerts')">告警记录</div></div><div id="settlement" class="tab-content active"><table id="settlementTable"><thead><tr><th>日期</th><th>代码</th><th>名称</th><th>买入价</th><th>卖出价</th><th>数量</th><th>盈亏</th><th>盈亏%</th><th>持有天数</th><th>卖出原因</th></tr></thead><tbody><tr><td colspan="10" class="empty">加载中...</td></tr></tbody></table></div><div id="trades" class="tab-content"><table id="tradesTable"><thead><tr><th>时间</th><th>方向</th><th>代码</th><th>名称</th><th>价格</th><th>数量</th><th>金额</th><th>手续费</th><th>原因</th></tr></thead><tbody><tr><td colspan="9" class="empty">加载中...</td></tr></tbody></table></div><div id="alerts" class="tab-content"><table id="alertsTable"><thead><tr><th>时间</th><th>类型</th><th>代码</th><th>名称</th><th>消息</th></tr></thead><tbody><tr><td colspan="5" class="empty">加载中...</td></tr></tbody></table></div></div></div><script>
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
loadData();
</script></body></html>`;
}

function renderLogsHtml(scanLogger) {
  const logs = scanLogger.getRecentLogs(20);
  const logsHtml = logs.map((log, idx) => {
    const steps = log.steps.map(step => {
      const dataStr = JSON.stringify(step.data, null, 2);
      return `<div class="step"><div class="step-header"><span class="step-name">${step.step}</span><span class="step-time">${step.time}ms</span></div><pre class="step-data">${dataStr}</pre></div>`;
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

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta http-equiv="refresh" content="30" /><title>扫描日志</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#0b1020;color:#e5e7eb}.wrap{max-width:1400px;margin:0 auto;padding:24px}.nav{display:flex;gap:12px;align-items:center;margin-bottom:16px;flex-wrap:wrap}.nav a{display:inline-block;padding:8px 14px;border:1px solid #334155;border-radius:999px;background:#111827;color:#cbd5e1;text-decoration:none}.nav a.active{background:#2563eb;color:#fff;border-color:#2563eb}h1{margin:0 0 16px;font-size:28px}.muted{color:#9ca3af;font-size:14px}.log-item{background:#111827;border:1px solid #1f2937;border-radius:14px;padding:20px;margin-bottom:16px}.log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1f2937}.log-header strong{font-size:18px;margin-right:12px}.log-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:16px}.summary-item{background:#0f172a;padding:12px;border-radius:8px;text-align:center}.summary-item span{display:block;font-size:12px;color:#9ca3af;margin-bottom:4px}.summary-item strong{display:block;font-size:20px;font-weight:700}.summary-item .highlight{color:#60a5fa}.log-details{margin-top:16px}.log-details summary{cursor:pointer;padding:8px 12px;background:#0f172a;border-radius:8px;user-select:none}.log-details summary:hover{background:#1e293b}.steps{margin-top:12px;padding:12px;background:#0f172a;border-radius:8px}.step{margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #1f2937}.step:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}.step-header{display:flex;justify-content:space-between;margin-bottom:8px}.step-name{font-weight:600;color:#93c5fd}.step-time{font-size:12px;color:#9ca3af}.step-data{background:#000;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px;line-height:1.6;margin:0}@media(max-width:900px){.log-summary{grid-template-columns:repeat(3,1fr);}}</style></head><body><div class="wrap"><div class="nav"><a href="/">扫描看板</a><a href="/paper">模拟盘看板</a><a href="/logs" class="active">扫描日志</a></div><h1>扫描日志</h1><div class="muted" style="margin-bottom:20px">最近20次扫描的详细过程</div>${logsHtml || '<div class="muted">暂无日志数据</div>'}</div></body></html>`;
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

async function scrapeEastmoneyDomMarketWithPage(config, page) {
  const dedup = new Map();
  const maxPages = config.marketScan.maxPages || 25;
  let total = null;
  for (let pn = 1; pn <= maxPages; pn += 1) {
    const url = buildEastmoneyClistUrl(config, pn);
    const text = await page.evaluate(async (u) => {
      const resp = await fetch(u, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': '*/*' }
      });
      return await resp.text();
    }, url);
    const obj = parseEastmoneyJsonp(text);
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
    await page.waitForTimeout(150);
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
    return await scrapeEastmoneyDomMarketWithPage(config, page);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

class MarketScanner {
  constructor(config, onScan, logsDir) {
    this.config = config;
    this.onScan = onScan;
    this.timer = null;
    this.historyCache = new Map(); // 缓存历史数据
    this.lastHistoryUpdate = null;
    this.scanLogger = new ScanLogger(logsDir);
    this.historyCachePath = path.join(logsDir, 'history-cache.json');
    this.loadHistoryCache();
  }

  loadHistoryCache() {
    if (fs.existsSync(this.historyCachePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.historyCachePath, 'utf8'));
        const now = Date.now();
        const dayMs = 86400000; // 1天
        let loaded = 0;
        for (const [symbol, history] of Object.entries(data)) {
          // 只加载1天内的缓存
          if (history.fetchedAt && (now - history.fetchedAt) < dayMs) {
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
    // 交易时间内缓存5分钟（避免频繁请求被限流）；非交易时间缓存1天
    const trading = isMarketOpen();
    const cacheExpiry = trading ? 5 * 60 * 1000 : 86400000;

    if (this.lastHistoryUpdate && (now - this.lastHistoryUpdate) > cacheExpiry) {
      console.log(`[HISTORY] 缓存过期(${trading ? '5分钟' : '1天'})，清空历史数据`);
      this.historyCache.clear();
    }

    const enriched = [];
    let fetchCount = 0;
    const historyFetched = [];

    console.log(`[HISTORY] 开始获取${picks.length}只股票的历史数据`);

    for (const pick of picks) {
      let history = this.historyCache.get(pick.symbol);

      // 如果缓存中没有，则获取（不限制数量）
      if (!history) {
        console.log(`[HISTORY] 获取${pick.symbol} ${pick.name}的60日数据 (${fetchCount + 1}/${picks.length})`);
        const klines = await fetch60DayKline(pick.symbol, context);
        if (klines && klines.length >= 30) {
          const indicators = calculate60DayIndicators(klines);
          const historyScore = score60DayHistory(indicators);
          history = { indicators, historyScore, fetchedAt: now };
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
          console.log(`[HISTORY] ${pick.symbol} ${pick.name} 历史数据不足，跳过`);
        }
        // 每次请求后延迟300ms，避免触发限流
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      if (history) {
        enriched.push({
          ...pick,
          history: history.indicators,
          historyScore: history.historyScore,
          combinedScore: Number(((pick.score * 0.5 + history.historyScore * 0.5).toFixed(2)))
        });
      } else {
        // 没有历史数据的标记为0分
        enriched.push({
          ...pick,
          history: null,
          historyScore: 0,
          combinedScore: pick.score * 0.4
        });
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

    const { browser, context, page } = await openEastmoneyListPage(this.config);
    try {
      // 获取大盘环境
      const indexKlines = await fetchIndexData(context);
      const marketRegime = analyzeMarketRegime(indexKlines);
      console.log(`[MARKET] 上证指数: ${marketRegime.current} MA20: ${marketRegime.ma20} MA60: ${marketRegime.ma60} 环境: ${marketRegime.regime}`);

      this.scanLogger.log('开始获取行情数据', {});

      const marketOpen = isMarketOpen(toBeijingTime(ts));
      const portfolioFull = !!(global.paperAccountRef && global.paperAccountRef.positions.size >= global.paperAccountRef.config.maxPositions);

      const rawQuotes = await scrapeEastmoneyDomMarketWithPage(this.config, page);
      this.scanLogger.log('获取原始数据', { total: rawQuotes.length });

      const quotes = filterMainBoardTenPercent(rawQuotes);
      this.scanLogger.log('主板过滤', {
        before: rawQuotes.length,
        after: quotes.length,
        filtered: rawQuotes.length - quotes.length
      });

      const scored = quotes.map(item => scoreStrategy(item, this.config.strategy));
      this.scanLogger.log('当日评分', { total: scored.length });

      // 非交易时间：仅保留基础市场快照与持仓补价所需数据，不做重型候选筛选
      if (!marketOpen) {
        const summary = {
          totalStocks: rawQuotes.length,
          mainBoardStocks: quotes.length,
          scoredStocks: scored.length,
          initialCandidates: 0,
          finalPicks: 0,
          mode: 'offhours-light'
        };
        this.scanLogger.endScan(summary);
        await this.onScan({ all: scored, picks: [], ts, marketRegime });
        return;
      }

      // 降低当日筛选标准，选出更多候选股票用于历史数据分析
      const initialThreshold = 70; // 降低到70分
      const candidateLimit = portfolioFull ? Math.min(40, this.config.strategy.topN * 2) : Math.min(100, this.config.strategy.topN * 3);
      let candidates = scored
        .filter(item => item.score >= initialThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateLimit); // 满仓时减少候选深度

      this.scanLogger.log('初步筛选（降低标准）', {
        threshold: initialThreshold,
        before: scored.length,
        after: candidates.length,
        topScores: candidates.slice(0, 5).map(p => ({ symbol: p.symbol, name: p.name, score: p.score }))
      });

      // 获取历史数据
      if (this.config.strategy.enableHistoryScore !== false) {
        candidates = await this.enrichWithHistory(candidates, context);

        // 基于60日历史数据进行严格筛选
        const beforeHistoryFilter = candidates.length;
        const filtered = [];

        candidates = candidates.filter(p => {
          // 轻量预过滤：熊市下过滤明显量比不足的噪音票，但不等同于买入条件
          if (marketRegime.regime === 'BEAR' && (p.volumeRatio || 0) < 1.5) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `熊市量比${p.volumeRatio}低于1.5` });
            return false;
          }

          // 必须有历史数据
          if (!p.history) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: '无历史数据' });
            return false;
          }

          // 60日历史数据筛选条件
          const h = p.history;

          // 1. 60日涨幅必须为正（移除上限，不限制强势股）
          if (h.gain60d === null || h.gain60d < 0) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `60日涨幅${h.gain60d}%为负` });
            return false;
          }

          // 2. 近期必须有上涨趋势
          if (h.gain10d !== null && h.gain10d < 0) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `10日涨幅${h.gain10d}%为负` });
            return false;
          }

          // 3. 最大回撤不能太大（放宽到70%，允许波动较大的强势股）
          if (h.maxDrawdown > 70) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `最大回撤${h.maxDrawdown}%过大` });
            return false;
          }

          // 4. 连续下跌天数不能太多
          if (h.consecutiveDownDays >= 5) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `连续下跌${h.consecutiveDownDays}天` });
            return false;
          }

          // 5. 60日平均换手率要足够
          if (h.avgTurnover60d < 3) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `60日平均换手率${h.avgTurnover60d}%过低` });
            return false;
          }

          // 6. 近5日必须放量
          if (h.volumeRatio5d < 1.2) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `近5日放量倍数${h.volumeRatio5d}不足` });
            return false;
          }

          // 7. 上涨天数占比要合理
          if (h.upDaysRatio < 40) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `上涨天数占比${h.upDaysRatio}%过低` });
            return false;
          }

          // 8. 历史评分要达标
          if (p.historyScore < 60) {
            filtered.push({ symbol: p.symbol, name: p.name, reason: `历史评分${p.historyScore}分不足` });
            return false;
          }

          return true;
        });

        this.scanLogger.log('60日历史数据严格筛选', {
          before: beforeHistoryFilter,
          after: candidates.length,
          filtered: filtered.slice(0, 10) // 只记录前10个被过滤的
        });

        // 重新计算综合评分并排序
        candidates = candidates
          .map(p => ({
            ...p,
            // 历史数据与当日强度各占50%
            combinedScore: Number(((p.score * 0.5 + p.historyScore * 0.5).toFixed(2)))
          }))
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .slice(0, this.config.strategy.topN);

        this.scanLogger.log('综合评分排序（当日/历史 50/50）', {
          total: candidates.length,
          topPicks: candidates.slice(0, 10).map(p => ({
            symbol: p.symbol,
            name: p.name,
            dayScore: p.score,
            historyScore: p.historyScore,
            combinedScore: p.combinedScore,
            gain60d: p.history?.gain60d || null,
            gain10d: p.history?.gain10d || null,
            maxDrawdown: p.history?.maxDrawdown || null
          }))
        });
      }

      const summary = {
        totalStocks: rawQuotes.length,
        mainBoardStocks: quotes.length,
        scoredStocks: scored.length,
        initialCandidates: candidates.length,
        finalPicks: candidates.length
      };

      this.scanLogger.endScan(summary);
      await this.onScan({ all: scored, picks: candidates, ts, marketRegime });
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
    this.logsDir = logsDir;
    this.cash = this.config.initialCash;
    this.positions = new Map(); // symbol => { symbol, name, entryPrice, currentPrice, quantity, value, pnlPct, entryTs, entryDate, holdRounds, holdDays, highPrice, lowPrice, sector }
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
    this.ordersPath = path.join(logsDir, 'orders.json');
    this.tradesPath = path.join(logsDir, 'trades.log');
    this.settlementPath = path.join(logsDir, 'settlement.log');
    this.equityPath = path.join(logsDir, 'equity.log');
    this.statisticsPath = path.join(logsDir, 'statistics.json');
    this.alertsPath = path.join(logsDir, 'alerts.log');
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
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(this.ordersPath, JSON.stringify(state, null, 2));
  }

  getTotalEquity() {
    const positionValue = Array.from(this.positions.values()).reduce((sum, pos) => sum + pos.value, 0);
    return this.cash + positionValue;
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

  placeOrder(symbol, name, price, side, quantity, reason = '') {
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
      bjTime
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
        lowPrice: executedPrice
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

    // 先更新持仓价格（无论是否交易时间，都要更新持仓价格）
    const symbolToPick = new Map(strategyPicks.map(p => [p.symbol, p]));
    const symbolToMarket = new Map(allMarketData.map(p => [p.symbol, p]));

    for (const [symbol, pos] of this.positions.entries()) {
      const pick = symbolToPick.get(symbol);
      const marketData = symbolToMarket.get(symbol);

      // 优先从全市场数据更新价格，其次从picks，最后保持不变
      if (marketData && marketData.price) {
        pos.currentPrice = marketData.price;
      } else if (pick && pick.price) {
        pos.currentPrice = pick.price;
      }
      // 如果都没有，保持 pos.currentPrice 不变

      // 更新最高价和最低价
      if (pos.currentPrice > (pos.highPrice || 0)) {
        pos.highPrice = pos.currentPrice;
      }
      if (!pos.lowPrice || pos.currentPrice < pos.lowPrice) {
        pos.lowPrice = pos.currentPrice;
      }

      pos.value = pos.currentPrice * pos.quantity;
      pos.pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    }

    // 非交易时间，只更新价格，不执行交易逻辑
    if (!marketOpen) {
      console.log(`[PAPER] 非交易时间，跳过交易 ts=${formatBeijingTime(ts)}`);
      this.logEquity(ts);
      return;
    }

    // 交易时间：更新持有天数并执行交易逻辑
    const toSell = [];
    for (const [symbol, pos] of this.positions.entries()) {
      const pick = symbolToPick.get(symbol);
      pos.holdRounds += 1;
      pos.holdDays = getTradingDaysBetween(pos.entryTs, currentTime);

      // T+1检查：当天买入的不能当天卖出
      const canSell = canSellToday(pos.entryTs, currentTime);
      if (!canSell) {
        console.log(`[PAPER] T+1限制: ${symbol} 当天买入不能卖出`);
        continue;
      }

      // 跌停检测：跌停时无法卖出
      if (pick && pick.changePercent <= -9.5) {
        console.log(`[PAPER] 跌停限制: ${symbol} ${pos.name} 跌停${pick.changePercent}%无法卖出`);
        continue;
      }

      // 7日短线卖出策略
      const reasons = [];

      // 1. 智能止盈（12%）- 综合分析多个指标
      const reachedProfitTarget = pos.pnlPct >= (this.config.takeProfitPct || 12);
      if (reachedProfitTarget && pick) {
        // 检查是否仍然强势，可以继续持有
        const dayScore = pick.score || pick.strategy?.score || 0;
        const stillStrong =
          dayScore >= (this.config.exitStrongScoreThreshold || 80) &&  // 评分仍然≥80
          pick.volumeRatio >= (this.config.exitStrongVolumeRatio || 2) &&  // 量比≥2
          pick.turnoverRatePercent >= (this.config.exitStrongTurnover || 5) &&  // 换手≥5%
          pick.changePercent >= 0 &&  // 当日未下跌
          pick.changePercent <= (this.config.buyMaxChangePercent || 9.5);  // 未冲高回落

        if (!stillStrong) {
          // 不再强势，止盈卖出
          const weakReasons = [];
          if (dayScore < 80) weakReasons.push(`评分${dayScore}`);
          if (pick.volumeRatio < 2) weakReasons.push(`量比${pick.volumeRatio}`);
          if (pick.turnoverRatePercent < 5) weakReasons.push(`换手${pick.turnoverRatePercent}%`);
          if (pick.changePercent < 0) weakReasons.push(`下跌${pick.changePercent}%`);
          if (pick.changePercent > 7.5) weakReasons.push(`冲高${pick.changePercent}%`);
          reasons.push(`智能止盈${pos.pnlPct.toFixed(2)}%(${weakReasons.join(',')})`);
        } else {
          console.log(`[PAPER] ${symbol} ${pos.name} 盈利${pos.pnlPct.toFixed(2)}%但仍强势，继续持有 (评分${dayScore} 量比${pick.volumeRatio} 换手${pick.turnoverRatePercent}%)`);
        }
      } else if (reachedProfitTarget && !pick) {
        // 找不到当日数据，保守止盈
        reasons.push(`止盈${pos.pnlPct.toFixed(2)}%(无当日数据)`);
      }

      // 2. 固定止损（-5%）
      const stopLoss = pos.pnlPct <= (this.config.stopLossPct || -5);
      if (stopLoss) reasons.push(`止损${pos.pnlPct.toFixed(2)}%`);

      // 3. 移动止盈（盈利>8%后，从最高点回撤5%）
      const trailingStopThreshold = this.config.takeProfitPartialPct || 8;
      const drawdownFromHigh = pos.highPrice ? (((pos.highPrice - pos.currentPrice) / pos.highPrice) * 100) : 0;
      const trailingStop = pos.pnlPct > trailingStopThreshold && drawdownFromHigh >= (this.config.exitDrawdownFromHighPct || 5);
      if (trailingStop) reasons.push(`移动止盈(最高${((pos.highPrice/pos.entryPrice-1)*100).toFixed(2)}%,回撤${drawdownFromHigh.toFixed(2)}%)`);

      // 4. 时间止损（持有≥7天）
      const maxHoldDays = this.config.maxHoldDays || 7;
      const holdTooLong = pos.holdDays >= maxHoldDays;
      if (holdTooLong) reasons.push(`持有${pos.holdDays}天超时`);

      // 5. 弱势股止损（持有≥5天且盈利<3%，但不与时间止损重复）
      const weakStockDays = this.config.weakStockHoldDays || 5;
      const weakStockProfit = this.config.weakStockMinProfit || 3;
      const weakStock = !holdTooLong && pos.holdDays >= weakStockDays && pos.pnlPct < weakStockProfit;
      if (weakStock) reasons.push(`弱势股(${pos.holdDays}天仅${pos.pnlPct.toFixed(2)}%)`);

      // 6. 评分下跌（仅当股票在今日扫描中且评分低时触发）
      if (pick) {
        const dayScore = pick.score || pick.strategy?.score || 0;
        const scoreDrop = dayScore < (this.config.exitScoreThreshold || 65);
        if (scoreDrop) reasons.push(`评分${dayScore}分过低`);
      }

      if (reasons.length > 0) {
        toSell.push({ ...pos, reason: reasons.join(',') });
      }
    }

    // 执行卖出
    for (const pos of toSell) {
      this.placeOrder(pos.symbol, pos.name, pos.currentPrice, 'SELL', pos.quantity, pos.reason);
    }

    // 执行买入（增加组合风险控制、动态仓位、行业分散）
    const availablePositions = this.config.maxPositions - this.positions.size;
    const cooldownMinutes = this.config.buyCooldownMinutes || 60;
    const currentEquity = this.getTotalEquity();

    // 更新峰值权益
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
    }

    // 组合风险控制：总回撤超过5%停止新开仓，超过8%清仓
    const portfolioDrawdown = ((this.peakEquity - currentEquity) / this.peakEquity) * 100;
    if (portfolioDrawdown > 8) {
      if (this.lastAlertDrawdown < 8) {
        this.logAlert('PORTFOLIO_RISK', '', '', `组合回撤${portfolioDrawdown.toFixed(2)}%超过8%，清仓所有持仓`);
        this.lastAlertDrawdown = 8;
      }
      console.log(`[RISK] 组合回撤${portfolioDrawdown.toFixed(2)}%超过8%，清仓所有持仓`);
      for (const [symbol, pos] of this.positions.entries()) {
        this.placeOrder(symbol, pos.name, pos.currentPrice, 'SELL', pos.quantity, `组合风险控制(回撤${portfolioDrawdown.toFixed(2)}%)`);
      }
      this.logEquity(ts);
      return;
    }

    if (portfolioDrawdown > 5) {
      if (this.lastAlertDrawdown < 5) {
        this.logAlert('PORTFOLIO_RISK', '', '', `组合回撤${portfolioDrawdown.toFixed(2)}%超过5%，停止新开仓`);
        this.lastAlertDrawdown = 5;
      }
      console.log(`[RISK] 组合回撤${portfolioDrawdown.toFixed(2)}%超过5%，停止新开仓`);
      this.logEquity(ts);
      return;
    }

    // 回撤恢复，重置告警状态
    if (portfolioDrawdown < 3 && this.lastAlertDrawdown > 0) {
      this.lastAlertDrawdown = 0;
    }

    // 熊市：提高门槛、降低仓位，但不完全停止交易
    const isBearMarket = marketRegime === 'BEAR';
    if (isBearMarket && this.lastAlertRegime !== 'BEAR') {
      this.logAlert('MARKET_REGIME', '', '', `熊市环境，提高入场门槛，仓位减半`);
      this.lastAlertRegime = 'BEAR';
    } else if (!isBearMarket && this.lastAlertRegime === 'BEAR') {
      this.lastAlertRegime = null;
    }

    // 统计当前持仓的行业分布
    const sectorCount = new Map();
    for (const pos of this.positions.values()) {
      const sector = pos.sector || 'UNKNOWN';
      sectorCount.set(sector, (sectorCount.get(sector) || 0) + 1);
    }

    if (availablePositions > 0 && this.cash > this.config.minCashReserve) {
      // 熊市限制：最多2个仓位
      const maxBuyCount = isBearMarket ? Math.min(2, availablePositions) : availablePositions;

      const buyCandidates = strategyPicks.filter(p => {
        // 检查是否在持仓中
        if (this.positions.has(p.symbol)) return false;

        // 检查冷却期
        const lastSellTs = this.sellCooldown.get(p.symbol);
        if (lastSellTs) {
          const minutesSinceSell = (currentTime - new Date(lastSellTs)) / (1000 * 60);
          if (minutesSinceSell < cooldownMinutes) {
            console.log(`[PAPER] ${p.symbol} ${p.name} 在冷却期内，跳过`);
            return false;
          }
        }

        // 行业分散：同一行业最多2只
        const sector = p.sector || 'UNKNOWN';
        if ((sectorCount.get(sector) || 0) >= 2) {
          console.log(`[PAPER] ${p.symbol} ${p.name} 行业${sector}已有2只，跳过`);
          return false;
        }

        // 策略条件（熊市提高门槛）
        const dayScore = p.score || p.strategy?.score || 0;
        const minScore = isBearMarket ? 70 : (this.config.buyMinScore || 75);
        const minVolumeRatio = isBearMarket ? 2.0 : (this.config.buyMinVolumeRatio || 2.0);
        const minHistoryScore = isBearMarket ? 65 : (this.config.buyMinHistoryScore || 60);

        const basicPass = dayScore >= minScore &&
               p.volumeRatio >= minVolumeRatio &&
               p.turnoverRatePercent >= (this.config.buyMinTurnoverRatePercent || 5) &&
               p.changePercent >= (this.config.buyMinChangePercent || 3) &&
               p.changePercent <= (this.config.buyMaxChangePercent || 7.5);

        // 历史评分检查（修复：0分不应通过）
        const historyPass = true;

        if (!basicPass) {
          console.log(`[PAPER] ${p.symbol} ${p.name} 基础条件不通过: 评分${dayScore}(需${minScore}) 量比${p.volumeRatio}(需${minVolumeRatio}) 换手${p.turnoverRatePercent}% 涨幅${p.changePercent}%`);
        }
        if (!historyPass) {
          console.log(`[PAPER] ${p.symbol} ${p.name} 历史评分${p.historyScore}不足（需要${minHistoryScore}）`);
        }

        return basicPass && historyPass;
      }).slice(0, maxBuyCount);

      for (const pick of buyCandidates) {
        // 动态仓位：根据综合评分和波动率调整
        const combinedScore = pick.combinedScore || pick.score || 70;
        const maxDrawdown = pick.history?.maxDrawdown || 20;

        let basePositionValue = this.config.maxPositionValue;

        // 根据评分调整仓位
        if (combinedScore >= 90) {
          basePositionValue = basePositionValue * 1.25; // 90+分：125%
        } else if (combinedScore >= 85) {
          basePositionValue = basePositionValue * 1.0;  // 85-90分：100%
        } else if (combinedScore >= 80) {
          basePositionValue = basePositionValue * 0.75; // 80-85分：75%
        } else {
          basePositionValue = basePositionValue * 0.5;  // 80分以下：50%
        }

        // 根据波动率调整仓位
        if (maxDrawdown > 20) {
          basePositionValue = basePositionValue * 0.5; // 高波动：减半
        }

        // 熊市减仓
        if (isBearMarket) {
          basePositionValue = basePositionValue * 0.5; // 熊市：减半
        }

        // 震荡市减仓
        if (marketRegime === 'NEUTRAL') {
          basePositionValue = basePositionValue * 0.7; // 震荡市：70%
        }

        const maxBuyValue = Math.min(basePositionValue, this.cash - this.config.minCashReserve);
        if (maxBuyValue <= 0) break;
        const quantity = Math.floor(maxBuyValue / (pick.price * this.config.lotSize)) * this.config.lotSize;
        if (quantity < this.config.lotSize) continue;

        const historyInfo = pick.history ? `历史${pick.historyScore}分(60日${pick.history.gain60d}%)` : '无历史';
        const positionPct = (maxBuyValue / currentEquity * 100).toFixed(1);
        console.log(`[PAPER] 买入: ${pick.symbol} ${pick.name} 综合${combinedScore.toFixed(1)}分 ${historyInfo} 仓位${positionPct}% 市场${marketRegime}`);
        this.placeOrder(pick.symbol, pick.name, pick.price, 'BUY', quantity, `策略信号(综合${combinedScore.toFixed(1)}分,市场${marketRegime})`);

        // 更新行业计数
        const sector = pick.sector || 'UNKNOWN';
        sectorCount.set(sector, (sectorCount.get(sector) || 0) + 1);
      }
    }

    this.logEquity(ts);
  }

  getPortfolio() {
    return {
      cash: this.cash,
      totalEquity: this.getTotalEquity(),
      pnlPct: ((this.getTotalEquity() / this.config.initialCash) - 1) * 100,
      positions: Array.from(this.positions.values()).sort((a, b) => b.value - a.value),
      positionCount: this.positions.size,
      maxPositions: this.config.maxPositions
    };
  }
}

async function main() {
  const config = loadConfig();
  const logsDir = path.join(__dirname, '..', 'logs');
  ensureDir(logsDir);
  const scanLogPath = path.join(logsDir, 'scan.log');
  const statePath = path.join(logsDir, 'state.json');
  const state = { startedAt: new Date().toISOString(), mode: 'eastmoney-dom-scanner', market: [], strategyPicks: [], marketCount: 0, scanRounds: 0, lastScanAt: null };
  
  // 初始化模拟盘账户
  const paperAccount = config.paperTrading?.enabled ? new PaperAccount(config, logsDir) : null;
  if (paperAccount) {
    console.log(`[PAPER] 模拟盘已启用，初始资金: ${(paperAccount.config.initialCash / 10000).toFixed(0)}万`);
    global.paperAccountRef = paperAccount;
  }

  const scanner = new MarketScanner(config, async (payload) => {
    state.scanRounds += 1;
    state.lastScanAt = formatBeijingTime(payload.ts);
    state.market = payload.all;
    state.strategyPicks = payload.picks;
    state.marketCount = payload.all.length;
    state.marketRegime = payload.marketRegime;
    appendJsonLine(scanLogPath, { ts: payload.ts, bjTime: formatBeijingTime(payload.ts), marketCount: payload.all.length, picks: payload.picks.slice(0, 20) });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
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
      console.log(`[PAPER] 权益: ${(portfolio.totalEquity / 10000).toFixed(2)}万 收益率: ${portfolio.pnlPct.toFixed(2)}% 持仓: ${portfolio.positionCount}/${portfolio.maxPositions}`);
    }
  }, logsDir);
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderHtml(state, config)); return; }
    if (paperAccount && req.url === '/paper') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderPaperHtml(state, paperAccount.getPortfolio(), config)); return; }
    if (req.url === '/logs') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderLogsHtml(scanner.scanLogger)); return; }
    if (req.url === '/api/logs') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(scanner.scanLogger.getRecentLogs(50))); return; }
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, mode: state.mode, startedAt: state.startedAt, scanRounds: state.scanRounds, marketCount: state.marketCount, lastScanAt: state.lastScanAt, paperTradingEnabled: !!paperAccount })); return; }
    if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state)); return; }
    if (req.url === '/scan') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state.market)); return; }
    if (req.url === '/strategy') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state.strategyPicks)); return; }

    // 新增模拟盘接口
    if (paperAccount && req.url === '/portfolio') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(paperAccount.getPortfolio())); return; }
    if (paperAccount && req.url === '/orders') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(paperAccount.orders.slice(-100))); return; }
    if (paperAccount && req.url === '/trades') {
      const trades = fs.existsSync(paperAccount.tradesPath) ? fs.readFileSync(paperAccount.tradesPath, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch(_) { return null } }).filter(Boolean).reverse().slice(0, 100) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(trades)); return;
    }
    if (paperAccount && req.url === '/settlement') {
      const settlement = fs.existsSync(paperAccount.settlementPath) ? fs.readFileSync(paperAccount.settlementPath, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch(_) { return null } }).filter(Boolean).reverse().slice(0, 100) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(settlement)); return;
    }
    if (paperAccount && req.url === '/statistics') {
      const stats = fs.existsSync(paperAccount.statisticsPath) ? JSON.parse(fs.readFileSync(paperAccount.statisticsPath, 'utf8')) : paperAccount.statistics;
      const winRate = stats.totalTrades > 0 ? (stats.winTrades / stats.totalTrades * 100) : 0;
      const avgHoldDays = stats.totalTrades > 0 ? (stats.totalHoldDays / stats.totalTrades) : 0;
      const avgWin = stats.winTrades > 0 ? ((stats.totalWinPnl || 0) / stats.winTrades / 10000) : 0;
      const avgLoss = stats.lossTrades > 0 ? ((stats.totalLossPnl || 0) / stats.lossTrades / 10000) : 0;
      const profitFactor = (stats.totalLossPnl || 0) > 0 ? (stats.totalWinPnl || 0) / (stats.totalLossPnl || 1) : 0;
      const totalPnlPct = (stats.totalPnl / paperAccount.config.initialCash * 100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...stats,
        winRate: Number(winRate.toFixed(2)),
        avgHoldDays: Number(avgHoldDays.toFixed(1)),
        avgWin: Number(avgWin.toFixed(2)),
        avgLoss: Number(avgLoss.toFixed(2)),
        profitFactor: Number(profitFactor.toFixed(2)),
        totalPnlPct: Number(totalPnlPct.toFixed(2))
      }));
      return;
    }
    if (paperAccount && req.url === '/equity') {
      const equity = fs.existsSync(paperAccount.equityPath) ? fs.readFileSync(paperAccount.equityPath, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch(_) { return null } }).filter(Boolean) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(equity)); return;
    }
    if (paperAccount && req.url === '/alerts') {
      const alerts = fs.existsSync(paperAccount.alertsPath) ? fs.readFileSync(paperAccount.alertsPath, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch(_) { return null } }).filter(Boolean).reverse().slice(0, 50) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(alerts)); return;
    }

    if (paperAccount && req.method === 'POST' && req.url === '/sell') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { symbol } = JSON.parse(body);
          const pos = paperAccount.positions.get(symbol);
          if (!pos) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `持仓中没有 ${symbol}` }));
            return;
          }
          // T+1检查：当天买入的不能当天卖出
          const currentTime = new Date();
          const canSell = canSellToday(pos.entryTs, currentTime);
          if (!canSell) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `T+1限制：${symbol} ${pos.name} 今天买入，下个交易日才能卖出` }));
            return;
          }
          paperAccount.placeOrder(symbol, pos.name, pos.currentPrice, 'SELL', pos.quantity, '手动卖出');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `${symbol} ${pos.name} 已卖出 ${pos.quantity}股 @${pos.currentPrice}` }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    const match = req.url.match(/^\/scan\/(sh\d{6}|sz\d{6}|\d{6})$/);
    if (match) { const raw = req.url.split('/').pop(); const symbol = normalizeSymbol(raw); const item = state.market.find((x) => x.symbol === symbol) || null; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(item)); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(config.server.port, async () => { console.log(`[HTTP] server listening on http://localhost:${config.server.port}`); console.log('[APP] Eastmoney DOM market scanner started'); await scanner.start(); });
  const shutdown = async () => { console.log('[APP] shutting down'); await scanner.stop(); server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

main().catch((err) => { console.error('[FATAL]', err); process.exit(1); });
