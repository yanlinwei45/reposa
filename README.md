# A股实时评测监听器（东方财富 Web）

这是一个基于 **Playwright 无头浏览器** 的 A 股实时/准实时监听服务。

它会：
- 打开东方财富个股 Web 页面
- 监听页面发出的行情接口请求
- 解析结构化行情数据
- 写入本地日志
- 提供本地 HTTP API
- 对股票池做基础评测/打分

## 当前能力
- 数据源：东方财富 Web 页面网络请求
- 标的：配置中的 A 股股票池
- 输出字段：
  - 股票代码/名称
  - 最新价
  - 涨跌额 / 涨跌幅
  - 开盘 / 最高 / 最低 / 昨收
  - 成交量 / 成交额
  - 换手率 / 振幅
  - 买一到买五 / 卖一到卖五
  - 市盈率 / 市净率 / 总市值 / 流通市值
- 本地 API：
  - `GET /health`
  - `GET /state`
  - `GET /quotes`
  - `GET /quotes/:symbol`
  - `GET /evaluation`
- 本地日志：
  - `logs/quotes.log`
  - `logs/state.json`

## 安装依赖
```bash
cd ~/Desktop/quant-paper-trading-nodejs
export PATH=/opt/homebrew/bin:$PATH
npm install
npx playwright install chromium
```

## 启动
```bash
cd ~/Desktop/quant-paper-trading-nodejs
./run.sh
```

## 停止
```bash
cd ~/Desktop/quant-paper-trading-nodejs
./stop.sh
```

## 查看日志
```bash
tail -f ~/Desktop/quant-paper-trading-nodejs/runtime.log
```

## API
```bash
curl http://localhost:3000/health
curl http://localhost:3000/state
curl http://localhost:3000/quotes
curl http://localhost:3000/quotes/sh600519
curl http://localhost:3000/evaluation
```

## 配置
配置文件：`config/default.json`

示例：
```json
{
  "marketData": {
    "source": "eastmoney-web-playwright",
    "symbols": ["sh600519", "sz300059", "sh601318"],
    "reloadIntervalMs": 15000,
    "staggerReloadMs": 1500
  }
}
```

## 注意
- 这是网页监听方案，适合内部研究与原型验证。
- 页面结构或接口参数变化时，解析逻辑可能需要更新。
- 建议控制股票池规模和刷新频率，避免过度请求。
