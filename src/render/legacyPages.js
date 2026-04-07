function renderHtml(state, config, paperAccount, scanLogger) {
  const marketRegime = state.marketRegime || {};
  const regimeColor = marketRegime.regime === 'BULL' ? '#ef4444' : marketRegime.regime === 'BEAR' ? '#22c55e' : '#9ca3af';
  const regimeText = marketRegime.regime === 'BULL' ? '牛市' : marketRegime.regime === 'BEAR' ? '熊市' : marketRegime.regime === 'NEUTRAL' ? '震荡' : '未知';
  const adaptive = paperAccount?.getAdaptiveConfig ? paperAccount.getAdaptiveConfig() : null;
  const regimeMultipliers = adaptive?.regimeMultipliers || {};
  const latestLog = scanLogger?.getLatestLog ? scanLogger.getLatestLog() : null;
  const historyFilterStep = latestLog?.steps?.find(step => step.step === '60日历史数据严格筛选');
  const dataQualityStep = latestLog?.steps?.find(step => step.step === '行情数据完整性不足');
  const filterStats = historyFilterStep?.data?.filterStats || {};
  const filterReasonLabels = {
    noHistory: '无历史数据',
    trend60dLow: '60日趋势不足',
    trend30dLow: '30日趋势不足',
    gain10dTooLow: '10日跌幅过大',
    gain5dOutOfRange: '5日回调不符',
    maxDrawdownHigh: '回撤过深',
    distanceToHighInvalid: '离高点位置不对',
    consecutiveDown: '连续下跌过多',
    maTrendInvalid: '均线趋势不对',
    belowMa60: '跌破MA60',
    rsiOutOfRange: 'RSI不在低吸区',
    macdTooWeak: 'MACD过弱',
    avgAmountLow: '成交额不足',
    avgTurnoverLow: '换手率过低',
    historyScoreLow: '历史评分不足'
  };
  const topFilterReasons = Object.entries(filterStats)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, count]) => `${filterReasonLabels[key] || key} ${count}只`)
    .join('、');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>A股实时观察</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:20px;background:#0f172a;color:#e5e7eb;margin:0}
a{color:#93c5fd} table{width:100%;border-collapse:collapse;background:#111827} th,td{padding:8px 10px;border-bottom:1px solid #1f2937;font-size:12px;text-align:left;vertical-align:top} th{background:#0b1220;position:sticky;top:0}.muted{color:#94a3b8}.hot{color:#ef4444;font-weight:700}.watch{color:#f59e0b;font-weight:700}.tag{display:inline-block;padding:2px 6px;border-radius:999px;background:#1f2937;color:#cbd5e1;font-size:11px;margin-right:4px;margin-bottom:4px}.good{background:#0f3d2e;color:#86efac}.bad{background:#3f1d1d;color:#fca5a5}.panel{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.stat{font-size:24px;font-weight:700}.small{font-size:12px}.regime{display:inline-block;padding:4px 10px;border-radius:999px;color:#fff;font-weight:700}.section-title{font-size:18px;font-weight:700;margin:0 0 12px}.table-wrap{overflow:auto}.diag{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.kpi{display:flex;justify-content:space-between;align-items:flex-end}.refresh-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
</style></head><body>
<h1>A股实时观察</h1>
<div class="refresh-bar"><a href="/">扫描看板</a><a href="/paper">模拟盘</a><a href="/logs">日志</a><span class="muted">最后扫描 ${state.lastScanAt || '-'}</span></div>
<div class="grid">
  <div class="panel"><div class="small muted">扫描轮次</div><div class="stat">${state.scanRounds}</div></div>
  <div class="panel"><div class="small muted">市场股票数</div><div class="stat">${state.marketCount}</div></div>
  <div class="panel"><div class="small muted">策略候选</div><div class="stat">${state.strategyPicks.length}</div></div>
  <div class="panel"><div class="small muted">市场环境</div><div class="stat"><span class="regime" style="background:${regimeColor}">${regimeText}</span></div></div>
</div>
<div class="diag">
  <div class="panel"><div class="section-title">策略环境</div><div class="small muted">当前市场环境与自适应仓位控制</div><div style="margin-top:8px">${Object.entries(regimeMultipliers).map(([key, value]) => `<div class="small" style="margin-bottom:6px">${key}: 仓位x${value.positionSize ?? 1} / 最多${value.maxPositions ?? '-'}只</div>`).join('') || '<div class="muted small">暂无</div>'}</div></div>
  <div class="panel"><div class="section-title">历史筛选漏斗</div><div class="small muted">60日严格筛选主要淘汰原因</div><div style="margin-top:8px">${topFilterReasons || '暂无数据'}</div></div>
</div>
${dataQualityStep ? `<div class="panel"><div class="section-title">数据状态</div><div class="small muted">本轮跳过候选筛选</div><div style="margin-top:8px">${dataQualityStep.data?.reason || '行情字段不完整'}</div></div>` : ''}
<div class="panel"><div class="section-title">候选股票</div><div class="table-wrap"><table><thead><tr><th>代码</th><th>名称</th><th>价格</th><th>涨跌幅</th><th>评分</th><th>历史分</th><th>综合分</th><th>标签</th></tr></thead><tbody>
${state.strategyPicks.map(item => `<tr><td><a href="${item.symbol ? `https://quote.eastmoney.com/${item.symbol}.html` : '#'}" target="_blank" rel="noreferrer">${item.symbol || '-'}</a></td><td>${item.name || '-'}</td><td>${item.price ?? '-'}</td><td class="${(item.changePercent || 0) >= 0 ? 'hot' : 'watch'}">${item.changePercent == null ? '-' : item.changePercent.toFixed(2) + '%'}</td><td>${item.score ?? '-'}</td><td>${item.historyScore ?? '-'}</td><td>${item.combinedScore ?? '-'}</td><td>${[...(item.strategy?.positiveTags || []).map(t => `<span class="tag good">${t}</span>`), ...(item.strategy?.riskTags || []).map(t => `<span class="tag bad">${t}</span>`)].join('')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">暂无候选</td></tr>'}
</tbody></table></div></div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body></html>`;
}

function renderPaperHtml(state, portfolio, config) {
  return global.__legacyRenderPaperHtml(state, portfolio, config);
}

function renderLogsHtml(scanLogger) {
  return global.__legacyRenderLogsHtml(scanLogger);
}

module.exports = {
  renderHtml,
  renderPaperHtml,
  renderLogsHtml,
};
