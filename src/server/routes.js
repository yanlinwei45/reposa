const fs = require('fs');
const path = require('path');
const { readJsonLines, buildStatistics } = require('./handlers/common');
const { handleLogsApi } = require('./handlers/logs');
const { normalizeSymbol } = require('../utils/symbol');
const { canSellToday } = require('../utils/time');

function serveFrontend(req, res, frontendDistPath) {
  const filePath = req.url === '/' || req.url === '/paper' || req.url === '/logs'
    ? path.join(frontendDistPath, 'index.html')
    : path.join(frontendDistPath, req.url);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const contentTypeMap = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  res.writeHead(200, { 'Content-Type': contentTypeMap[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
}

function createApiRoutes(state, config, paperAccount, scanLogger) {
  return {
    '/api/health': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        mode: state.mode,
        startedAt: state.startedAt,
        scanRounds: state.scanRounds,
        marketCount: state.marketCount,
        lastScanAt: state.lastScanAt,
        paperTradingEnabled: !!paperAccount
      }));
    },

    '/api/state': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    },

    '/api/scan': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.market));
    },

    '/api/strategy': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.strategyPicks));
    },

    '/api/logs': (req, res) => {
      handleLogsApi(scanLogger, res);
    },

    '/api/portfolio': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(paperAccount.getPortfolio()));
    },

    '/api/orders': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(paperAccount.orders.slice(-100)));
    },

    '/api/trades': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      const trades = readJsonLines(paperAccount.tradesPath, { reverse: true, limit: 100 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(trades));
    },

    '/api/settlement': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      const settlement = readJsonLines(paperAccount.settlementPath, { reverse: true, limit: 100 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settlement));
    },

    '/api/statistics': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      const stats = buildStatistics(paperAccount);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    },

    '/api/equity': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      const equity = readJsonLines(paperAccount.equityPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(equity));
    },

    '/api/alerts': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }
      const alerts = readJsonLines(paperAccount.alertsPath, { reverse: true, limit: 50 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(alerts));
    },

    'POST /api/buy': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }

      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { symbol, name, price, amount } = JSON.parse(body);
          const normalizedSymbol = normalizeSymbol(symbol);
          const marketItem = state.market.find(item => item.symbol === normalizedSymbol);
          if (!marketItem) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `扫描池中没有 ${normalizedSymbol}` }));
            return;
          }
          if (paperAccount.positions.has(normalizedSymbol)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `${normalizedSymbol} 已在持仓中` }));
            return;
          }
          const adaptive = paperAccount.getAdaptiveConfig();
          const regimeConfig = adaptive.regimeMultipliers[state.marketRegime?.regime || 'NEUTRAL'] || adaptive.regimeMultipliers.NEUTRAL;
          const dynamicMaxPositions = Math.min(paperAccount.config.maxPositions, regimeConfig.maxPositions || paperAccount.config.maxPositions);
          if (paperAccount.positions.size >= dynamicMaxPositions) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `持仓数量已达上限 ${dynamicMaxPositions}` }));
            return;
          }
          const lastSellTs = paperAccount.sellCooldown.get(normalizedSymbol);
          if (lastSellTs) {
            const minutesSinceSell = (Date.now() - new Date(lastSellTs).getTime()) / (1000 * 60);
            const cooldownMinutes = paperAccount.config.buyCooldownMinutes || 60;
            if (minutesSinceSell < cooldownMinutes) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: `${normalizedSymbol} 仍在冷却期内` }));
              return;
            }
          }
          const orderPrice = Number(price) || Number(marketItem.price);
          if (!orderPrice || orderPrice <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `${normalizedSymbol} 当前价格无效` }));
            return;
          }

          const suggestion = paperAccount.getSuggestedPositionValue(marketItem, state.marketRegime?.regime || 'NEUTRAL');
          if (!suggestion.allowed) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `自适应系统拒绝买入: ${suggestion.reason}` }));
            return;
          }

          const requestedAmount = Number(amount);
          if (!requestedAmount || requestedAmount <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `买入金额无效` }));
            return;
          }
          const availableCash = paperAccount.cash - paperAccount.config.minCashReserve;
          if (requestedAmount > availableCash) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `可用资金不足，最多可用 ${(availableCash / 10000).toFixed(2)}万` }));
            return;
          }
          const lotSize = paperAccount.config.lotSize || 100;
          const quantity = Math.floor(requestedAmount / orderPrice / lotSize) * lotSize;
          if (quantity < lotSize) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `${normalizedSymbol} 可买数量不足一手` }));
            return;
          }
          const combinedScore = marketItem.combinedScore || marketItem.score || 0;
          paperAccount.placeOrder(normalizedSymbol, marketItem.name || name || normalizedSymbol, orderPrice, 'BUY', quantity, `手动买入(置信度${suggestion.confidence})`, {
            confidence: suggestion.confidence,
            combinedScore,
            sector: marketItem.sector || 'UNKNOWN',
            marketRegime: state.marketRegime?.regime || 'UNKNOWN',
            source: 'manual'
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `${normalizedSymbol} ${(marketItem.name || name || normalizedSymbol)} 已买入 ${quantity}股 @${orderPrice}`,
            suggestion: {
              confidence: suggestion.confidence,
              suggestedAmount: (suggestion.suggestedAmount / 10000).toFixed(2) + '万',
              actualAmount: (requestedAmount / 10000).toFixed(2) + '万',
              reason: suggestion.reason
            }
          }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    },

    'POST /api/sell': (req, res) => {
      if (!paperAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'paper trading not enabled' }));
        return;
      }

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
          const currentTime = new Date();
          const canSell = canSellToday(pos.entryTs, currentTime);
          if (!canSell) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `T+1限制：${symbol} ${pos.name} 今天买入，下个交易日才能卖出` }));
            return;
          }
          paperAccount.placeOrder(symbol, pos.name, pos.currentPrice, 'SELL', pos.quantity, '手动卖出', {
            source: 'manual'
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `${symbol} ${pos.name} 已卖出 ${pos.quantity}股 @${pos.currentPrice}` }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
    },
  };
}

module.exports = {
  createApiRoutes,
  serveFrontend,
};
