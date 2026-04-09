import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { Navigation } from '../components/common/Navigation'
import { Card } from '../components/common/Card'
import { Badge } from '../components/common/Badge'
import { TableShell } from '../components/common/TableShell'
import { api } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { useScrollRestore } from '../hooks/useScrollRestore'

function formatMoney(value) {
  if (value == null) return '-'
  return `${(value / 10000).toFixed(2)}万`
}

function formatPct(value) {
  if (value == null) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function StatCard({ title, value, subvalue, tone = 'neutral' }) {
  const toneMap = {
    rise: 'text-rise',
    fall: 'text-fall',
    neutral: 'text-slate-100',
  }

  return (
    <Card>
      <div className="text-sm text-slate-400">{title}</div>
      <div className={`mt-2 text-3xl font-bold ${toneMap[tone]}`}>{value}</div>
      {subvalue && <div className="mt-1 text-sm text-slate-500">{subvalue}</div>}
    </Card>
  )
}

function bucketTone(bucket) {
  if (bucket === 'continuation') return 'rise'
  if (bucket === 'main') return 'sky'
  if (bucket === 'observation') return 'warn'
  return 'neutral'
}

export function PaperBoard() {
  const [portfolio, setPortfolio] = useState(null)
  const [state, setState] = useState(null)
  const [statistics, setStatistics] = useState(null)
  const [equity, setEquity] = useState([])
  const [settlement, setSettlement] = useState([])
  const [trades, setTrades] = useState([])
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('equity')
  const [sellingSymbol, setSellingSymbol] = useState(null)

  useScrollRestore('paper')

  const fetchData = async () => {
    try {
      const [portfolioData, stateData, statisticsData, equityData, settlementData, tradesData, alertsData] = await Promise.all([
        api.getPortfolio(),
        api.getState(),
        api.getStatistics(),
        api.getEquity(),
        api.getSettlement(),
        api.getTrades(),
        api.getAlerts(),
      ])
      setPortfolio(portfolioData)
      setState(stateData)
      setStatistics(statisticsData)
      setEquity(equityData)
      setSettlement(settlementData)
      setTrades(tradesData)
      setAlerts(alertsData)
    } catch (err) {
      console.error('获取模拟盘数据失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useAutoRefresh(fetchData, 30000)

  const handleSell = async (symbol) => {
    try {
      setSellingSymbol(symbol)
      const result = await api.sell(symbol)
      alert(result.message || '卖出成功')
      await fetchData()
    } catch (err) {
      alert(`卖出失败: ${err.message}`)
    } finally {
      setSellingSymbol(null)
    }
  }

  const chartData = useMemo(() => {
    return equity.slice(-100).map(item => ({
      time: item.bjTime?.slice(5, 16) || item.ts?.slice(5, 16) || '-',
      equity: Number((item.totalEquity || item.equity || 0).toFixed(2)),
      pnlPct: item.pnlPct || 0,
    }))
  }, [equity])

  if (loading) return <div className="flex min-h-screen items-center justify-center text-slate-400">加载中...</div>
  if (!portfolio) return <div className="flex min-h-screen items-center justify-center text-slate-400">模拟盘未启用</div>

  const regimeColor = state?.marketRegime?.regime === 'BULL' ? 'rise' : state?.marketRegime?.regime === 'BEAR' ? 'fall' : 'neutral'
  const regimeText = state?.marketRegime?.regime === 'BULL' ? '牛市' : state?.marketRegime?.regime === 'BEAR' ? '熊市' : state?.marketRegime?.regime === 'NEUTRAL' ? '震荡' : '未知'
  const tradeDecision = portfolio.latestTradeDiagnostics || state?.diagnostics?.tradeDecision || {}

  const positionsColumns = [
    { key: 'symbol', title: '代码' },
    { key: 'name', title: '名称' },
    { key: 'bucket', title: '建仓/实时桶' },
    { key: 'currentPrice', title: '现价' },
    { key: 'entryPrice', title: '成本' },
    { key: 'value', title: '市值' },
    { key: 'pnlPct', title: '盈亏' },
    { key: 'holdDays', title: '持有' },
    { key: 'exit', title: '退出诊断' },
    { key: 'confidence', title: '置信度' },
    { key: 'action', title: '操作' },
  ]

  const settlementColumns = [
    { key: 'symbol', title: '代码' },
    { key: 'name', title: '名称' },
    { key: 'pnlPct', title: '盈亏%' },
    { key: 'holdDays', title: '持有天数' },
    { key: 'reason', title: '卖出原因' },
    { key: 'entryMarketRegime', title: '入场环境' },
  ]

  const tradesColumns = [
    { key: 'bjTime', title: '时间' },
    { key: 'symbol', title: '代码' },
    { key: 'side', title: '方向' },
    { key: 'quantity', title: '数量' },
    { key: 'executedPrice', title: '成交价' },
    { key: 'reason', title: '原因' },
  ]

  const alertColumns = [
    { key: 'bjTime', title: '时间' },
    { key: 'type', title: '类型' },
    { key: 'symbol', title: '代码' },
    { key: 'message', title: '内容' },
  ]

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-100">模拟盘看板</h1>
            <p className="mt-2 text-sm text-slate-400">最后扫描 {state?.lastScanAt || '-'}，持仓价格与策略诊断自动刷新</p>
          </div>
          <div className="flex gap-3">
            <button onClick={fetchData} className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white">手动刷新</button>
          </div>
        </div>

        <Navigation />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard title="总权益" value={formatMoney(portfolio.totalEquity)} subvalue={`初始资金 ${formatMoney(10000000)}`} />
          <StatCard title="现金" value={formatMoney(portfolio.cash)} />
          <StatCard title="总收益率" value={formatPct(portfolio.pnlPct)} tone={portfolio.pnlPct >= 0 ? 'rise' : 'fall'} />
          <StatCard title="持仓数" value={`${portfolio.positionCount}/${portfolio.maxPositions}`} />
          <StatCard title="市场环境" value={regimeText} tone={regimeColor} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card title="市场环境与策略状态" subtitle="当前环境、自适应反馈、近期样本表现" className="xl:col-span-1">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-400">市场环境</span>
                <Badge tone={regimeColor}>{regimeText}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-slate-800/60 p-3">
                  <div className="text-slate-400">最近样本数</div>
                  <div className="mt-1 text-xl font-semibold text-slate-100">{portfolio.performanceFeedback?.tradeCount || 0}</div>
                </div>
                <div className="rounded-xl bg-slate-800/60 p-3">
                  <div className="text-slate-400">胜率</div>
                  <div className="mt-1 text-xl font-semibold text-slate-100">{portfolio.performanceFeedback?.winRate || 0}%</div>
                </div>
                <div className="rounded-xl bg-slate-800/60 p-3">
                  <div className="text-slate-400">低分段惩罚</div>
                  <div className="mt-1 text-xl font-semibold text-amber-300">{portfolio.performanceFeedback?.lowBandPenalty || 0}</div>
                </div>
                <div className="rounded-xl bg-slate-800/60 p-3">
                  <div className="text-slate-400">回撤压力</div>
                  <div className="mt-1 text-xl font-semibold text-red-300">{portfolio.performanceFeedback?.drawdownPressure || 0}%</div>
                </div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">
                历史数据更新时间：按日缓存。页面侧重看出策略是否真的有效，而不是只看收益曲线。
              </div>
            </div>
          </Card>

          <Card title="持仓区" subtitle="当前持仓、盈亏表现、手动卖出" className="xl:col-span-2">
            <TableShell
              columns={positionsColumns}
              rows={portfolio.positions || []}
              emptyText="当前无持仓"
              renderRow={(pos, idx) => (
                <tr key={idx} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 text-blue-400">{pos.symbol}</td>
                  <td className="px-4 py-3 text-slate-200">{pos.name}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <Badge tone={bucketTone(pos.entryBucket)}>{pos.entryBucket || 'main'}</Badge>
                      <div className="text-xs text-slate-500">
                        实时 {pos.liveBucketLabel || pos.liveBucket || '-'} / 日 {Number(pos.liveSelectedDayScore || pos.entrySelectedDayScore || 0).toFixed(1)}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-200">{pos.currentPrice?.toFixed(3)}</td>
                  <td className="px-4 py-3 text-slate-400">{pos.entryPrice?.toFixed(3)}</td>
                  <td className="px-4 py-3 text-slate-200">{formatMoney(pos.value)}</td>
                  <td className={`px-4 py-3 font-medium ${pos.pnlPct >= 0 ? 'text-rise' : 'text-fall'}`}>{formatPct(pos.pnlPct)}</td>
                  <td className="px-4 py-3 text-slate-400">{pos.holdDays || 0}天</td>
                  <td className="px-4 py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={pos.exitShouldExit ? 'warn' : Number(pos.exitUrgency || 0) >= 70 ? 'sky' : 'neutral'}>
                          紧迫度 {pos.exitUrgency || 0}
                        </Badge>
                        {pos.lastEvaluatedAt ? <span className="text-xs text-slate-500">{pos.lastEvaluatedAt}</span> : null}
                      </div>
                      <div className="max-w-[240px] text-xs leading-5 text-slate-400">{pos.exitSummary || '暂无诊断'}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><Badge tone={pos.confidence === 'HIGH' ? 'rise' : pos.confidence === 'LOW' ? 'warn' : 'neutral'}>{pos.confidence || 'UNKNOWN'}</Badge></td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleSell(pos.symbol)}
                      disabled={sellingSymbol === pos.symbol}
                      className="rounded-lg bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                    >
                      {sellingSymbol === pos.symbol ? '卖出中...' : '卖出'}
                    </button>
                  </td>
                </tr>
              )}
            />
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="本轮不开仓原因" subtitle={tradeDecision.skippedReason || '最近一轮交易层摘要'}>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-xl bg-slate-800/60 p-4">
                  <div className="text-sm text-slate-400">主候选</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.strategyCandidateCount || 0}</div>
                </div>
                <div className="rounded-xl bg-slate-800/60 p-4">
                  <div className="text-sm text-slate-400">买入筛后</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.buyCandidateCount || 0}</div>
                </div>
                <div className="rounded-xl bg-slate-800/60 p-4">
                  <div className="text-sm text-slate-400">通过</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.acceptedCount || 0}</div>
                </div>
                <div className="rounded-xl bg-slate-800/60 p-4">
                  <div className="text-sm text-slate-400">拒绝</div>
                  <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.rejectedCount || 0}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {(tradeDecision.rejectSummary || []).map(item => (
                  <Badge key={`${item.key}-${item.count}`} tone="warn">{item.label} {item.count}只</Badge>
                ))}
                {(!tradeDecision.rejectSummary || tradeDecision.rejectSummary.length === 0) ? <span className="text-sm text-slate-400">最近没有明显拒绝项</span> : null}
              </div>
              <div className="space-y-2">
                {(tradeDecision.rejected || []).slice(0, 6).map(item => (
                  <div key={`${item.symbol}-${item.reason}`} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                      <Badge tone="warn">{item.rejectCategory || '被拒'}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">日 {item.dayScore || 0} 分 · 历史 {item.historyScore || 0} 分</div>
                    <div className="mt-2 text-sm text-slate-300">{item.reason}</div>
                  </div>
                ))}
                {(!tradeDecision.rejected || tradeDecision.rejected.length === 0) ? <div className="text-sm text-slate-400">最近一轮没有候选被交易层拒绝</div> : null}
              </div>
            </div>
          </Card>

          <Card title="实时候选快照" subtitle="直接对照当前主候选和持仓，避免误判为系统没票。">
            <div className="space-y-2">
              {(state?.strategyPicks || []).slice(0, 6).map(item => (
                <div key={`paper-pick-${item.symbol}`} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        桶 {item.strategy?.bucketLabel || item.strategy?.bucket || '-'} · 日 {Number(item.selectedDayScore ?? item.score ?? 0).toFixed(1)} · 历史 {Number(item.historyScore || 0).toFixed(1)} · 综合 {Number(item.combinedScore || 0).toFixed(1)}
                      </div>
                    </div>
                    <Badge tone={bucketTone(item.strategy?.bucket)}>{item.strategy?.bucket || '-'}</Badge>
                  </div>
                </div>
              ))}
              {(!state?.strategyPicks || state.strategyPicks.length === 0) ? <div className="text-sm text-slate-400">当前没有主候选</div> : null}
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="策略缺陷面板" subtitle="帮助判断策略是否失效，而不只是看收益">
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="mb-2 text-sm font-medium text-slate-200">近期亏损归因</div>
                <div className="space-y-2 text-sm text-slate-400">
                  {settlement.filter(item => item.pnlPct < 0).slice(0, 5).map((item, idx) => (
                    <div key={idx} className="flex items-start justify-between gap-4 rounded-lg bg-slate-900/80 p-3">
                      <div>
                        <div className="font-medium text-slate-200">{item.symbol} {item.name}</div>
                        <div>入场环境: {item.entryMarketRegime || 'UNKNOWN'} / 原因: {item.reason || '-'}</div>
                      </div>
                      <div className="text-fall">{formatPct(item.pnlPct)}</div>
                    </div>
                  ))}
                  {settlement.filter(item => item.pnlPct < 0).length === 0 && <div>暂无亏损样本</div>}
                </div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="mb-2 text-sm font-medium text-slate-200">高分段/低分段表现</div>
                <pre className="overflow-x-auto text-xs text-slate-400">{JSON.stringify(portfolio.performanceFeedback?.scoreRangeStats || {}, null, 2)}</pre>
              </div>
            </div>
          </Card>

          <Card title="策略统计" subtitle="交易结果与质量指标">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-slate-800/60 p-4"><div className="text-sm text-slate-400">总交易</div><div className="mt-2 text-2xl font-semibold text-slate-100">{statistics?.totalTrades || 0}</div></div>
              <div className="rounded-xl bg-slate-800/60 p-4"><div className="text-sm text-slate-400">胜率</div><div className="mt-2 text-2xl font-semibold text-slate-100">{statistics?.winRate || 0}%</div></div>
              <div className="rounded-xl bg-slate-800/60 p-4"><div className="text-sm text-slate-400">平均盈利</div><div className="mt-2 text-2xl font-semibold text-rise">{statistics?.avgWin || 0}万</div></div>
              <div className="rounded-xl bg-slate-800/60 p-4"><div className="text-sm text-slate-400">平均亏损</div><div className="mt-2 text-2xl font-semibold text-fall">{statistics?.avgLoss || 0}万</div></div>
              <div className="rounded-xl bg-slate-800/60 p-4"><div className="text-sm text-slate-400">盈亏因子</div><div className="mt-2 text-2xl font-semibold text-slate-100">{statistics?.profitFactor || 0}</div></div>
              <div className="rounded-xl bg-slate-800/60 p-4"><div className="text-sm text-slate-400">平均持有</div><div className="mt-2 text-2xl font-semibold text-slate-100">{statistics?.avgHoldDays || 0}天</div></div>
            </div>
          </Card>
        </div>

        <Card title="底部明细" subtitle="权益曲线、交割单、订单流水、告警记录">
          <div className="mb-4 flex flex-wrap gap-2">
            {[
              { key: 'equity', label: '权益曲线' },
              { key: 'settlement', label: '交割单' },
              { key: 'trades', label: '订单流水' },
              { key: 'alerts', label: '告警记录' },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`rounded-full px-4 py-2 text-sm ${activeTab === tab.key ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'equity' && (
            <div className="h-96 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} />
                  <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(v) => `${(v / 10000).toFixed(0)}万`} />
                  <Tooltip formatter={(value) => formatMoney(value)} labelStyle={{ color: '#0f172a' }} />
                  <Line type="monotone" dataKey="equity" stroke="#60a5fa" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {activeTab === 'settlement' && (
            <TableShell
              columns={settlementColumns}
              rows={settlement.slice(0, 50)}
              emptyText="暂无交割单"
              renderRow={(item, idx) => (
                <tr key={idx} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 text-blue-400">{item.symbol}</td>
                  <td className="px-4 py-3 text-slate-200">{item.name}</td>
                  <td className={`px-4 py-3 font-medium ${item.pnlPct >= 0 ? 'text-rise' : 'text-fall'}`}>{formatPct(item.pnlPct)}</td>
                  <td className="px-4 py-3 text-slate-400">{item.holdDays}天</td>
                  <td className="px-4 py-3 text-slate-300">{item.reason}</td>
                  <td className="px-4 py-3 text-slate-400">{item.entryMarketRegime}</td>
                </tr>
              )}
            />
          )}

          {activeTab === 'trades' && (
            <TableShell
              columns={tradesColumns}
              rows={trades.slice(0, 100)}
              emptyText="暂无订单流水"
              renderRow={(item, idx) => (
                <tr key={idx} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 text-slate-400">{item.bjTime}</td>
                  <td className="px-4 py-3 text-blue-400">{item.symbol}</td>
                  <td className="px-4 py-3"><Badge tone={item.side === 'BUY' ? 'rise' : 'fall'}>{item.side}</Badge></td>
                  <td className="px-4 py-3 text-slate-200">{item.quantity}</td>
                  <td className="px-4 py-3 text-slate-200">{item.executedPrice?.toFixed(3)}</td>
                  <td className="px-4 py-3 text-slate-400">{item.reason}</td>
                </tr>
              )}
            />
          )}

          {activeTab === 'alerts' && (
            <TableShell
              columns={alertColumns}
              rows={alerts.slice(0, 50)}
              emptyText="暂无告警"
              renderRow={(item, idx) => (
                <tr key={idx} className="hover:bg-slate-800/40">
                  <td className="px-4 py-3 text-slate-400">{item.bjTime}</td>
                  <td className="px-4 py-3"><Badge tone="warn">{item.type}</Badge></td>
                  <td className="px-4 py-3 text-blue-400">{item.symbol}</td>
                  <td className="px-4 py-3 text-slate-300">{item.message}</td>
                </tr>
              )}
            />
          )}
        </Card>
      </div>
    </div>
  )
}
