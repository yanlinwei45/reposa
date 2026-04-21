const fs = require('fs');
const path = require('path');
const { readJsonLines, buildStatistics } = require('./handlers/common');
const { handleLogsApi } = require('./handlers/logs');
const { normalizeSymbol } = require('../utils/symbol');
const { canSellToday } = require('../utils/time');

function writeJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(JSON.stringify(payload));
}

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

function createApiRoutes(state, config, paperAccount, scanLogger, fetchRealtimePricesForSymbols) {
  return {
    '/api/health': (req, res) => {
      writeJson(res, {
        ok: true,
        mode: state.mode,
        startedAt: state.startedAt,
        scanRounds: state.scanRounds,
        marketCount: state.marketCount,
        lastScanAt: state.lastScanAt,
        paperTradingEnabled: !!paperAccount
      });
    },

    '/api/state': (req, res) => {
      writeJson(res, state);
    },

    '/api/scan': (req, res) => {
      writeJson(res, state.market);
    },

    '/api/strategy': (req, res) => {
      writeJson(res, state.strategyPicks);
    },

    '/api/logs': (req, res) => {
      handleLogsApi(scanLogger, res);
    },

    '/api/portfolio': async (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      try {
        if (paperAccount.positions.size > 0 && typeof fetchRealtimePricesForSymbols === 'function') {
          const quotes = await fetchRealtimePricesForSymbols([...paperAccount.positions.keys()]);
          paperAccount.applyRealtimePositionQuotes(quotes);
        }
      } catch (err) {
        console.error('[API] 刷新持仓实时价格失败:', err.message);
      }
      writeJson(res, paperAccount.getPortfolio());
    },

    '/api/orders': (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      writeJson(res, paperAccount.orders.slice(-100));
    },

    '/api/trades': (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      const trades = readJsonLines(paperAccount.tradesPath, { reverse: true, limit: 100 });
      writeJson(res, trades);
    },

    '/api/settlement': (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      const settlement = readJsonLines(paperAccount.settlementPath, { reverse: true, limit: 100 });
      writeJson(res, settlement);
    },

    '/api/statistics': (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      const stats = buildStatistics(paperAccount);
      writeJson(res, stats);
    },

    '/api/equity': (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      const equity = readJsonLines(paperAccount.equityPath);
      writeJson(res, equity);
    },

    '/api/alerts': (req, res) => {
      if (!paperAccount) {
        writeJson(res, { error: 'paper trading not enabled' }, 404);
        return;
      }
      const alerts = readJsonLines(paperAccount.alertsPath, { reverse: true, limit: 50 });
      writeJson(res, alerts);
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
          const { symbol, name, price, amount, force } = JSON.parse(body);
          const normalizedSymbol = normalizeSymbol(symbol);
          const manualOverride = force === true || force === 'true';
          const marketItem = state.market.find(item => item.symbol === normalizedSymbol);
          if (!marketItem) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `扫描池中没有 ${normalizedSymbol}` }));
            return;
          }
          const adaptive = paperAccount.getAdaptiveConfig();
          const regimeConfig = adaptive.regimeMultipliers[state.marketRegime?.regime || 'NEUTRAL'] || adaptive.regimeMultipliers.NEUTRAL;
          const dynamicMaxPositions = Math.min(paperAccount.config.maxPositions, regimeConfig.maxPositions || paperAccount.config.maxPositions);
          if (!paperAccount.positions.has(normalizedSymbol) && paperAccount.positions.size >= dynamicMaxPositions) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `持仓数量已达上限 ${dynamicMaxPositions}` }));
            return;
          }
          const lastSellTs = paperAccount.sellCooldown.get(normalizedSymbol);
          if (lastSellTs && !manualOverride) {
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
          if (!suggestion.allowed && !manualOverride) {
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
          const existingPos = paperAccount.positions.get(normalizedSymbol);
          const orderConfidence = suggestion.confidence === 'REJECT' ? 'MANUAL' : suggestion.confidence;
          const orderReason = manualOverride && !suggestion.allowed
            ? `手动${existingPos ? '加仓' : '买入'}(覆盖策略:${suggestion.reason})`
            : `手动${existingPos ? '加仓' : '买入'}(置信度${orderConfidence})`;
          paperAccount.placeOrder(normalizedSymbol, marketItem.name || name || normalizedSymbol, orderPrice, 'BUY', quantity, orderReason, {
            confidence: orderConfidence,
            combinedScore,
            sector: marketItem.sector || 'UNKNOWN',
            marketRegime: state.marketRegime?.regime || 'UNKNOWN',
            source: 'manual',
            positionAction: existingPos ? 'ADD_ON' : 'INITIAL',
            targetPositionValue: requestedAmount,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `${normalizedSymbol} ${(marketItem.name || name || normalizedSymbol)} 已${existingPos ? '加仓' : '买入'} ${quantity}股 @${orderPrice}`,
            suggestion: {
              confidence: orderConfidence,
              suggestedAmount: (suggestion.suggestedAmount / 10000).toFixed(2) + '万',
              actualAmount: (requestedAmount / 10000).toFixed(2) + '万',
              reason: suggestion.reason,
              overridden: manualOverride && !suggestion.allowed
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
          const { symbol, quantity } = JSON.parse(body);
          const pos = paperAccount.positions.get(symbol);
          if (!pos) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `持仓中没有 ${symbol}` }));
            return;
          }
          const currentTime = new Date();
          const sellableQuantity = paperAccount.getSellablePositionQuantity(pos, currentTime);
          if (sellableQuantity < (paperAccount.config.lotSize || 100)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `T+1限制：${symbol} ${pos.name} 当前无可卖仓位` }));
            return;
          }
          const lotSize = paperAccount.config.lotSize || 100;
          const requestedQuantity = quantity ? Math.floor(Number(quantity) / lotSize) * lotSize : sellableQuantity;
          const finalQuantity = Math.min(sellableQuantity, requestedQuantity || sellableQuantity);
          if (finalQuantity < lotSize) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `卖出数量不足一手` }));
            return;
          }
          const positionAction = finalQuantity < pos.quantity ? 'TRIM' : 'FULL_EXIT';
          paperAccount.placeOrder(symbol, pos.name, pos.currentPrice, 'SELL', finalQuantity, `手动${positionAction === 'TRIM' ? '减仓' : '卖出'}`, {
            source: 'manual',
            positionAction,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `${symbol} ${pos.name} 已${positionAction === 'TRIM' ? '减仓' : '卖出'} ${finalQuantity}股 @${pos.currentPrice}` }));
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
