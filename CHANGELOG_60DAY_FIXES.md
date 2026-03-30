# 60日策略修复记录

## 日期: 2026-03-24

## 问题总结

系统实施60日历史数据策略后，出现以下问题：
1. 移除数量限制后，所有股票被过滤（picks=0）
2. 移除60日涨幅上限后，仍然picks=0
3. maxDrawdown计算出现>100%的不可能值
4. 放宽maxDrawdown阈值到70%后，仍然picks=0
5. 选出股票后，无法买入

## 根本原因

### 1. Eastmoney API的lmt参数失效
- **问题**: 请求60天数据（lmt=60），实际返回5124天（全部历史）
- **影响**: maxDrawdown计算包含20年前的数据，出现>100%的值
- **证据**:
  ```
  2005-07-18 changePercent: -466.67% (股票分拆/重组)
  累计收益率变为负数，导致drawdown>100%
  ```

### 2. 前复权数据的回撤计算问题
- **问题**: 使用绝对价格计算回撤，遇到分红/拆股时失真
- **原因**: 前复权数据会向下调整历史价格
- **解决**: 改用累计收益率计算回撤

## 修复方案

### 修复1: 限制K线数据长度 (src/history.js)

```javascript
// 只取最近60天的数据（API的lmt参数不可靠）
return klines.slice(-60);
```

**位置**: src/history.js line 44
**效果**: maxDrawdown从115.9%降到合理范围（9-17%）

### 修复2: 放宽maxDrawdown阈值 (src/index.js)

```javascript
// 3. 最大回撤不能太大（放宽到70%，允许波动较大的强势股）
if (h.maxDrawdown > 70) {
  filtered.push({ symbol: p.symbol, name: p.name, reason: `最大回撤${h.maxDrawdown}%过大` });
  return false;
}
```

**位置**: src/index.js line 740-744
**原因**: 7日短线策略，60日历史回撤不是关键指标

### 修复3: 修正买入逻辑的评分字段 (src/index.js)

```javascript
// 策略条件（使用p.score而不是p.strategy.score）
const dayScore = p.score || p.strategy?.score || 0;
const basicPass = dayScore >= (this.config.buyMinScore || 85) &&
       p.volumeRatio >= (this.config.buyMinVolumeRatio || 3) &&
       ...
```

**位置**: src/index.js line 1116-1118
**原因**: 60日筛选后的picks使用p.score，不是p.strategy.score

### 修复4: 降低买入阈值 (config/default.json)

```json
{
  "buyMinScore": 70,              // 保持70分
  "buyMinVolumeRatio": 1.5,       // 从2.5降到1.5
  "buyMinTurnoverRatePercent": 5, // 从8降到5
  "buyMinHistoryScore": 60        // 从65降到60
}
```

**原因**:
- 60日筛选已经很严格（8个条件）
- 买入时不需要重复严格检查
- 实时数据可能略有波动

## 测试结果

### 第一次扫描 (2026-03-24 14:12:28)
- 市场股票: 1011只
- 初筛: 5只
- 60日筛选: 2只通过
- 买入: 2只

### 买入股票
1. **sz001258 立新能源**
   - 当日评分: 74分
   - 历史评分: 68分
   - 60日涨幅: 54.01%
   - 10日涨幅: 10.01%
   - 最大回撤: 9.32%
   - 当日涨幅: 4.99%
   - 量比: 2.14

2. **sz000815 美利云**
   - 当日评分: 73分
   - 历史评分: 60分
   - 60日涨幅: 87.1%
   - 10日涨幅: 16.47%
   - 最大回撤: 16.92%
   - 当日涨幅: 6.19%
   - 量比: 1.79

### 持仓状态
- 权益: 999.88万
- 收益率: -0.01% (交易费用)
- 持仓: 2/5

## 关键经验

1. **API参数不可靠**: 不要依赖Eastmoney API的lmt参数，总是手动截取数据
2. **前复权数据处理**: 使用累计收益率计算回撤，避免绝对价格失真
3. **阈值分层设计**: 初筛宽松→历史严格→买入适中
4. **数据结构一致性**: 注意不同阶段的数据字段命名（score vs strategy.score）
5. **调试日志重要性**: 添加详细日志帮助快速定位问题

## 文件变更

- `src/history.js`: 添加klines.slice(-60)
- `src/index.js`: 修正评分字段引用，添加调试日志
- `config/default.json`: 降低买入阈值
- `STRATEGY_60DAY_FINAL.md`: 更新文档
- `MEMORY.md`: 记录关键经验
