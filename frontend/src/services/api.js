const API_BASE = '';

export const api = {
  async get(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      throw new Error(payload?.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      throw new Error(payload?.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // 扫描相关
  getHealth: () => api.get('/api/health'),
  getState: () => api.get('/api/state'),
  getScan: () => api.get('/api/scan'),
  getStrategy: () => api.get('/api/strategy'),
  getLogs: () => api.get('/api/logs'),

  // 模拟盘相关
  getPortfolio: () => api.get('/api/portfolio'),
  getOrders: () => api.get('/api/orders'),
  getTrades: () => api.get('/api/trades'),
  getSettlement: () => api.get('/api/settlement'),
  getStatistics: () => api.get('/api/statistics'),
  getEquity: () => api.get('/api/equity'),
  getAlerts: () => api.get('/api/alerts'),
  lookupStock: (symbol) => api.get(`/scan/${encodeURIComponent(symbol)}`),

  // 交易操作
  buy: (symbol, name, price, amount, force = false) => api.post('/api/buy', { symbol, name, price, amount, force }),
  sell: (symbol, quantity) => api.post('/api/sell', { symbol, quantity }),
};
