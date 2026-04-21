const { chromium } = require('playwright');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeLiveConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    autoStart: config.autoStart === true,
    headless: config.headless === true,
    userDataDir: config.userDataDir || '/tmp/quant-live-eastmoney',
    loginUrl: config.loginUrl || 'https://jywg.18.cn/Login',
    tradeUrl: config.tradeUrl || 'https://jywg.18.cn/Trade/Buy',
    buyUrl: config.buyUrl || 'https://jywg.18.cn/Trade/Buy',
    sellUrl: config.sellUrl || 'https://jywg.18.cn/Trade/Sale',
    productName: config.productName || '东方财富网页交易',
    requireConfirmClick: config.requireConfirmClick !== false,
    requirePasswordInput: config.requirePasswordInput !== false,
    maxOrderAmount: Number(config.maxOrderAmount || 200000),
    maxOrderQuantity: Number(config.maxOrderQuantity || 20000),
    allowedSymbols: Array.isArray(config.allowedSymbols) ? config.allowedSymbols : [],
    selectors: {
      loginIndicator: config.selectors?.loginIndicator || 'text=/退出|安全退出|资产全景|普通交易/',
      codeInput: config.selectors?.codeInput || 'input[placeholder*="证券代码"], input[name*="stock"], input[id*="stock"], input[id*="zqdm"]',
      priceInput: config.selectors?.priceInput || 'input[placeholder*="价格"], input[name*="price"], input[id*="price"], input[id*="jg"]',
      quantityInput: config.selectors?.quantityInput || 'input[placeholder*="数量"], input[name*="amount"], input[id*="amount"], input[id*="sl"]',
      passwordInput: config.selectors?.passwordInput || 'input[type="password"], input[placeholder*="密码"], input[name*="password"], input[id*="password"], input[id*="jymm"]',
      submitButton: config.selectors?.submitButton || 'button:has-text("买入"), button:has-text("卖出"), input[type="button"][value*="买入"], input[type="button"][value*="卖出"]',
      confirmButton: config.selectors?.confirmButton || 'button:has-text("确认"), button:has-text("提交"), button:has-text("确定"), input[type="button"][value*="确认"], input[type="button"][value*="确定"]',
      successToast: config.selectors?.successToast || 'text=/委托成功|提交成功|下单成功/',
      errorToast: config.selectors?.errorToast || 'text=/失败|错误|不足|无效|限制/',
    },
  };
}

class EastmoneyWebTrader {
  constructor(config = {}) {
    this.config = normalizeLiveConfig(config);
    this.browserContext = null;
    this.page = null;
    this.startedAt = null;
    this.lastError = null;
    this.lastAction = null;
    this.lastActionAt = null;
    this.lastOrderDraft = null;
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      autoStart: this.config.autoStart,
      connected: !!this.page,
      startedAt: this.startedAt,
      lastError: this.lastError,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      lastOrderDraft: this.lastOrderDraft,
      headless: this.config.headless,
      userDataDir: this.config.userDataDir,
      productName: this.config.productName,
    };
  }

  validateOrder(order = {}) {
    const side = String(order.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') {
      throw new Error('实盘方向无效，仅支持 BUY/SELL');
    }

    const symbol = String(order.symbol || '').trim();
    if (!/^(sh|sz)?\d{6}$/.test(symbol)) {
      throw new Error('股票代码无效');
    }

    const price = Number(order.price);
    const quantity = Math.floor(Number(order.quantity || 0));
    if (!(price > 0)) {
      throw new Error('价格无效');
    }
    if (!(quantity > 0) || quantity % 100 !== 0) {
      throw new Error('数量必须为正整数且为100股整数倍');
    }
    if (quantity > this.config.maxOrderQuantity) {
      throw new Error(`数量超限，最大允许 ${this.config.maxOrderQuantity} 股`);
    }

    const amount = price * quantity;
    if (amount > this.config.maxOrderAmount) {
      throw new Error(`金额超限，最大允许 ${(this.config.maxOrderAmount / 10000).toFixed(2)} 万`);
    }

    if (this.config.allowedSymbols.length > 0 && !this.config.allowedSymbols.includes(symbol)) {
      throw new Error(`不在实盘白名单内: ${symbol}`);
    }

    return {
      side,
      symbol,
      price: Number(price.toFixed(3)),
      quantity,
      amount: Number(amount.toFixed(2)),
      password: order.password ? String(order.password) : '',
      submit: order.submit === true,
      confirm: order.confirm !== false,
    };
  }

  async start() {
    if (this.page) {
      return this.getStatus();
    }

    this.browserContext = await chromium.launchPersistentContext(this.config.userDataDir, {
      headless: this.config.headless,
      viewport: { width: 1440, height: 980 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const pages = this.browserContext.pages();
    this.page = pages[0] || await this.browserContext.newPage();
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    await this.page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    return this.getStatus();
  }

  async stop() {
    if (this.browserContext) {
      await this.browserContext.close().catch(() => {});
    }
    this.browserContext = null;
    this.page = null;
    this.startedAt = null;
    return this.getStatus();
  }

  async ensureStarted() {
    if (!this.page) {
      await this.start();
    }
  }

  async isLoggedIn() {
    await this.ensureStarted();
    try {
      const indicator = this.page.locator(this.config.selectors.loginIndicator).first();
      return await indicator.isVisible({ timeout: 2500 });
    } catch (_) {
      return false;
    }
  }

  async gotoTradePage(side) {
    const url = side === 'SELL' ? this.config.sellUrl : this.config.buyUrl;
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(800);
  }

  async fillFirstVisible(locatorText, value) {
    const locator = this.page.locator(locatorText).first();
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    await locator.click({ timeout: 5000 });
    await locator.fill('');
    await locator.fill(String(value));
  }

  async prepareOrder(rawOrder = {}) {
    const order = this.validateOrder(rawOrder);
    await this.ensureStarted();

    const loggedIn = await this.isLoggedIn();
    if (!loggedIn) {
      this.lastError = '尚未登录东方财富交易页';
      return {
        ok: false,
        needLogin: true,
        message: '请先在打开的东方财富窗口完成登录',
        status: this.getStatus(),
      };
    }

    await this.gotoTradePage(order.side);
    await this.fillFirstVisible(this.config.selectors.codeInput, order.symbol.replace(/^(sh|sz)/, ''));
    await this.fillFirstVisible(this.config.selectors.priceInput, order.price.toFixed(3));
    await this.fillFirstVisible(this.config.selectors.quantityInput, order.quantity);

    if (this.config.requirePasswordInput && order.password) {
      await this.fillFirstVisible(this.config.selectors.passwordInput, order.password);
    }

    this.lastAction = `${order.side} ${order.symbol}`;
    this.lastActionAt = new Date().toISOString();
    this.lastOrderDraft = {
      side: order.side,
      symbol: order.symbol,
      price: order.price,
      quantity: order.quantity,
      amount: order.amount,
      submit: order.submit,
    };
    this.lastError = null;

    if (!order.submit) {
      return {
        ok: true,
        prepared: true,
        submitted: false,
        message: '委托单已填入东方财富网页，请人工核对后提交',
        status: this.getStatus(),
      };
    }

    const submitButton = this.page.locator(this.config.selectors.submitButton).first();
    await submitButton.waitFor({ state: 'visible', timeout: 15000 });
    await submitButton.click({ timeout: 5000 });
    await sleep(800);

    if (this.config.requireConfirmClick && order.confirm) {
      const confirmButton = this.page.locator(this.config.selectors.confirmButton).first();
      if (await confirmButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmButton.click({ timeout: 5000 });
      }
    }

    let success = false;
    let message = '已点击提交，请在东方财富页面确认结果';
    const successLocator = this.page.locator(this.config.selectors.successToast).first();
    const errorLocator = this.page.locator(this.config.selectors.errorToast).first();

    if (await successLocator.isVisible({ timeout: 4000 }).catch(() => false)) {
      success = true;
      message = await successLocator.textContent().catch(() => message);
    } else if (await errorLocator.isVisible({ timeout: 1500 }).catch(() => false)) {
      message = await errorLocator.textContent().catch(() => '提交失败');
      this.lastError = message;
      return {
        ok: false,
        prepared: true,
        submitted: true,
        message,
        status: this.getStatus(),
      };
    }

    return {
      ok: true,
      prepared: true,
      submitted: true,
      success,
      message,
      status: this.getStatus(),
    };
  }
}

module.exports = {
  EastmoneyWebTrader,
  normalizeLiveConfig,
};
