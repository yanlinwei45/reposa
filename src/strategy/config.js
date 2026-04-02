const fs = require('fs');
const path = require('path');

let cachedStrategyConfig = null;

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function loadStrategyConfig() {
  if (cachedStrategyConfig) {
    return clone(cachedStrategyConfig);
  }

  const strategyPath = path.join(__dirname, '..', '..', 'config', 'strategy.json');
  const config = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
  cachedStrategyConfig = config;
  return clone(config);
}

function getRuntimeStrategyConfig() {
  return loadStrategyConfig().runtime;
}

function getResearchStrategyConfig() {
  return loadStrategyConfig().research;
}

function getBacktestConfig() {
  return loadStrategyConfig().backtest;
}

module.exports = {
  loadStrategyConfig,
  getRuntimeStrategyConfig,
  getResearchStrategyConfig,
  getBacktestConfig,
};
