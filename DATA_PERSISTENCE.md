# 数据持久化方案

## 概述

所有交易数据持久化存储在 `logs/` 目录，系统重启后自动恢复。

## 持久化文件

### 1. orders.json - 账户状态（主文件）
**内容**：
- `cash`: 当前现金余额
- `positions`: 当前持仓（Map转数组）
- `orders`: 最近1000条订单
- `sellCooldown`: 卖出冷却期
- `statistics`: 统计数据
- `savedAt`: 保存时间

**更新时机**：每次买入/卖出后立即保存

**示例**：
```json
{
  "cash": 9998800,
  "positions": [
    ["sz001258", {
      "symbol": "sz001258",
      "name": "立新能源",
      "entryPrice": 10.52,
      "currentPrice": 11.05,
      "quantity": 1900,
      "value": 20995,
      "pnlPct": 5.04,
      "entryTs": "2026-03-24T06:12:28.000Z",
      "holdDays": 0,
      "highPrice": 11.05,
      "lowPrice": 10.52
    }]
  ],
  "orders": [...],
  "sellCooldown": [],
  "statistics": {
    "totalTrades": 5,
    "winTrades": 3,
    "lossTrades": 2,
    "totalPnl": 12500,
    "maxGain": 15.2,
    "maxLoss": -4.8,
    "totalHoldDays": 25
  },
  "savedAt": "2026-03-24T08:53:21.000Z"
}
```

### 2. settlement.log - 交割单（每笔完整交易）
**内容**：每笔卖出交易的完整记录（买入+卖出配对）

**格式**：每行一条JSON记录

**字段**：
- `symbol`: 股票代码
- `name`: 股票名称
- `buyDate`: 买入日期
- `sellDate`: 卖出日期
- `buyPrice`: 买入价格
- `sellPrice`: 卖出价格
- `quantity`: 数量
- `pnl`: 盈亏金额
- `pnlPct`: 盈亏百分比
- `holdDays`: 持有天数
- `fee`: 手续费
- `reason`: 卖出原因
- `bjTime`: 卖出时间

**示例**：
```json
{"symbol":"sz001258","name":"立新能源","buyDate":"2026-03-24","sellDate":"2026-03-25","buyPrice":10.52,"sellPrice":11.79,"quantity":1900,"pnl":2313,"pnlPct":12.07,"holdDays":1,"fee":22.4,"reason":"智能止盈12.07%(评分78)","bjTime":"2026-03-25 14:30:15"}
{"symbol":"sz000815","name":"美利云","buyDate":"2026-03-24","sellDate":"2026-03-26","buyPrice":8.35,"sellPrice":7.93,"quantity":2300,"pnl":-1026,"pnlPct":-5.03,"holdDays":2,"fee":18.2,"reason":"止损-5.03%","bjTime":"2026-03-26 10:15:32"}
```

### 3. statistics.json - 统计汇总
**内容**：交易统计数据

**字段**：
- `totalTrades`: 总交易次数
- `winTrades`: 盈利次数
- `lossTrades`: 亏损次数
- `totalPnl`: 总盈亏金额
- `maxGain`: 最大单笔盈利%
- `maxLoss`: 最大单笔亏损%
- `totalHoldDays`: 总持有天数

**计算字段**（API返回）：
- `winRate`: 胜率 = winTrades / totalTrades * 100
- `avgHoldDays`: 平均持有天数 = totalHoldDays / totalTrades

**示例**：
```json
{
  "totalTrades": 15,
  "winTrades": 10,
  "lossTrades": 5,
  "totalPnl": 45230,
  "maxGain": 18.5,
  "maxLoss": -5.2,
  "totalHoldDays": 52
}
```

### 4. trades.log - 订单流水
**内容**：所有买入/卖出订单（包括未配对的）

**格式**：每行一条JSON记录

**用途**：完整的订单历史，用于审计和回溯

### 5. equity.log - 权益曲线
**内容**：每次扫描后的账户权益

**格式**：每行一条JSON记录

**字段**：
- `ts`: 时间戳
- `cash`: 现金
- `positionValue`: 持仓市值
- `totalEquity`: 总权益

**用途**：绘制权益曲线图

## API接口

### GET /portfolio
当前持仓和账户信息
```json
{
  "cash": 9998800,
  "totalEquity": 10041795,
  "pnlPct": 0.42,
  "positions": [...],
  "positionCount": 2,
  "maxPositions": 5
}
```

### GET /settlement
交割单（最近100条）
```bash
curl http://localhost:3088/settlement | jq '.'
```

### GET /statistics
统计数据
```bash
curl http://localhost:3088/statistics | jq '.'
```
返回：
```json
{
  "totalTrades": 15,
  "winTrades": 10,
  "lossTrades": 5,
  "totalPnl": 45230,
  "maxGain": 18.5,
  "maxLoss": -5.2,
  "totalHoldDays": 52,
  "winRate": 66.67,
  "avgHoldDays": 3.5
}
```

### GET /orders
订单流水（最近100条）

### GET /trades
交易流水（最近100条）

### GET /equity
权益曲线（全部）

## 数据恢复

系统启动时自动从 `orders.json` 恢复：
- 现金余额
- 持仓信息
- 卖出冷却期
- 统计数据

**启动日志示例**：
```
[PAPER] 恢复状态: 持仓2只, 历史订单15条, 现金999.88万
```

## 数据安全

1. **原子写入**：每次交易后立即保存，不会丢失数据
2. **JSON格式**：人类可读，易于备份和迁移
3. **追加写入**：settlement.log、trades.log、equity.log 使用追加模式，不会覆盖历史
4. **限制大小**：orders.json 只保留最近1000条订单，避免文件过大

## 备份建议

定期备份 `logs/` 目录：
```bash
tar -czf backup_$(date +%Y%m%d).tar.gz logs/
```

## 数据迁移

迁移到新机器：
1. 复制整个 `logs/` 目录
2. 启动系统，自动恢复所有状态

## 注意事项

1. **不要手动编辑** orders.json，可能导致数据损坏
2. **settlement.log** 是最重要的文件，记录了所有完整交易
3. **statistics.json** 可以从 settlement.log 重新计算生成
4. 系统重启不会丢失任何数据
