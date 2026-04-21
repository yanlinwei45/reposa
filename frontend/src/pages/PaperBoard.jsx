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
  const [sellQuantities, setSellQuantities] = useState({})
  const [lookupInput, setLookupInput] = useState('')
  const [manualAmount, setManualAmount] = useState('')
  const [lookupResult, setLookupResult] = useState(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [manualBuying, setManualBuying] = useState(false)
  const [manualStatus, setManualStatus] = useState({
    tone: 'neutral',
    text: '输入股票代码后可查询当前扫描行情，并直接手动买入。',
  })

  useScrollRestore('paper')

  const fetchPortfolioOnly = async () => {
    try {
      const portfolioData = await api.getPortfolio()
      setPortfolio(portfolioData)
    } catch (err) {
      console.error('获取持仓数据失败:', err)
    } finally {
      setLoading(false)
    }
  }

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

  useAutoRefresh(fetchData, 15000)
  useAutoRefresh(fetchPortfolioOnly, 3000)

  const handleSell = async (position) => {
    const symbol = position.symbol
    const rawQuantity = sellQuantities[symbol]
    const quantity = rawQuantity ? Number(rawQuantity) : undefined

    if (rawQuantity && (!Number.isFinite(quantity) || quantity <= 0)) {
      alert('减仓数量无效')
      return
    }

    try {
      setSellingSymbol(symbol)
      const result = await api.sell(symbol, quantity)
      alert(result.message || '卖出成功')
      setSellQuantities(prev => ({ ...prev, [symbol]: '' }))
      await fetchData()
    } catch (err) {
      alert(`卖出失败: ${err.message}`)
    } finally {
      setSellingSymbol(null)
    }
  }

  const handleLookup = async () => {
    const symbol = lookupInput.trim()
    if (!symbol) {
      setLookupResult(null)
      setManualStatus({ tone: 'fall', text: '请输入股票代码。' })
      return
    }

    try {
      setLookupLoading(true)
      const result = await api.lookupStock(symbol)
      setLookupResult(result)
      setManualStatus({ tone: 'rise', text: `已查询 ${result.symbol} ${result.name}，可直接手动买入。` })
    } catch (err) {
      setLookupResult(null)
      setManualStatus({ tone: 'fall', text: `查询失败: ${err.message}` })
    } finally {
      setLookupLoading(false)
    }
  }

  const handleManualBuy = async () => {
    if (!lookupResult) {
      setManualStatus({ tone: 'fall', text: '请先查询股票。' })
      return
    }

    const amountWan = Number(manualAmount)
    if (!Number.isFinite(amountWan) || amountWan <= 0) {
      setManualStatus({ tone: 'fall', text: '请输入有效的买入金额（万元）。' })
      return
    }

    const price = Number(lookupResult.price || 0)
    const amount = amountWan * 10000
    const estimatedQuantity = Math.floor(amount / price / 100) * 100

    if (!(price > 0)) {
      setManualStatus({ tone: 'fall', text: '当前价格无效，无法下单。' })
      return
    }

    if (estimatedQuantity < 100) {
      setManualStatus({ tone: 'fall', text: '金额不足买入一手。' })
      return
    }

    const confirmed = window.confirm(
      `手动买入 ${lookupResult.symbol} ${lookupResult.name}\n价格: ${price.toFixed(3)}\n金额: ${amountWan.toFixed(2)}万\n预计数量: ${estimatedQuantity}股\n\n确认提交？`
    )
    if (!confirmed) return

    try {
      setManualBuying(true)
      const result = await api.buy(lookupResult.symbol, lookupResult.name, price, amount, true)
      setManualStatus({ tone: 'rise', text: result.message || '买入成功。' })
      setManualAmount('')
      await fetchData()
    } catch (err) {
      setManualStatus({ tone: 'fall', text: `买入失败: ${err.message}` })
    } finally {
      setManualBuying(false)
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
    { key: 'bucket', title: '建仓/实时桶/阶段' },
    { key: 'currentPrice', title: '现价' },
    { key: 'entryPrice', title: '成本' },
    { key: 'value', title: '市值' },
    { key: 'pnlPct', title: '盈亏' },
    { key: 'holdDays', title: '持有/可卖' },
    { key: 'exit', title: '管理诊断' },
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

          <Card title="手动交易" subtitle="输入股票代码查询当前扫描行情，并直接手动买入" className="xl:col-span-1">
            <div className="space-y-4">
              <div className="flex flex-col gap-3">
                <input
                  value={lookupInput}
                  onChange={(event) => setLookupInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleLookup()
                  }}
                  placeholder="输入 603936 或 sh603936"
                  className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-400"
                />
                <div className="flex gap-3">
                  <button
                    onClick={handleLookup}
                    disabled={lookupLoading}
                    className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-50"
                  >
                    {lookupLoading ? '查询中...' : '查询'}
                  </button>
                  <button
                    onClick={() => {
                      setLookupInput('')
                      setManualAmount('')
                      setLookupResult(null)
                      setManualStatus({ tone: 'neutral', text: '输入股票代码后可查询当前扫描行情，并直接手动买入。' })
                    }}
                    className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700"
                  >
                    清空
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                {!lookupResult && <div className="text-sm text-slate-500">暂无查询结果</div>}
                {lookupResult && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-base font-semibold text-slate-100">{lookupResult.symbol} {lookupResult.name}</div>
                        <div className="mt-1 text-sm text-slate-500">{lookupResult.sector || '未知行业'}</div>
                      </div>
                      <Badge tone={bucketTone(lookupResult.strategy?.bucket)}>{lookupResult.strategy?.bucketLabel || lookupResult.strategy?.bucket || '未分类'}</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl bg-slate-900/80 p-3">
                        <div className="text-slate-500">现价</div>
                        <div className="mt-1 font-medium text-slate-100">{lookupResult.price != null ? Number(lookupResult.price).toFixed(3) : '-'}</div>
                      </div>
                      <div className="rounded-xl bg-slate-900/80 p-3">
                        <div className="text-slate-500">涨跌幅</div>
                        <div className={`mt-1 font-medium ${Number(lookupResult.changePercent || 0) >= 0 ? 'text-rise' : 'text-fall'}`}>
                          {formatPct(Number(lookupResult.changePercent || 0))}
                        </div>
                      </div>
                      <div className="rounded-xl bg-slate-900/80 p-3">
                        <div className="text-slate-500">综合分</div>
                        <div className="mt-1 font-medium text-slate-100">
                          {lookupResult.combinedScore != null ? Number(lookupResult.combinedScore).toFixed(2) : lookupResult.score ?? '-'}
                        </div>
                      </div>
                      <div className="rounded-xl bg-slate-900/80 p-3">
                        <div className="text-slate-500">建议</div>
                        <div className="mt-1 font-medium text-slate-100">
                          {lookupResult.manualSuggestion?.confidence || '-'} / {formatMoney(lookupResult.manualSuggestion?.suggestedAmount || 0)}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs leading-6 text-slate-400">{lookupResult.manualSuggestion?.reason || '无策略说明'}</div>
                    <div className="flex items-center gap-3">
                      <input
                        value={manualAmount}
                        onChange={(event) => setManualAmount(event.target.value)}
                        placeholder="买入金额（万元）"
                        className="w-44 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
                      />
                      <button
                        onClick={handleManualBuy}
                        disabled={manualBuying || !(Number(lookupResult.price) > 0)}
                        className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {manualBuying ? '买入中...' : '手动买入'}
                      </button>
                      <a
                        href={lookupResult.eastmoneyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm text-sky-300 hover:text-sky-200"
                      >
                        东财
                      </a>
                    </div>
                  </div>
                )}
              </div>

              <div className={`text-sm ${manualStatus.tone === 'rise' ? 'text-emerald-300' : manualStatus.tone === 'fall' ? 'text-red-300' : 'text-slate-500'}`}>
                {manualStatus.text}
              </div>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
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
                      <div className="text-xs text-slate-500">
                        阶段 {pos.positionStage || 'initial'} / 加{pos.addOnCount || 0} / 减{pos.trimCount || 0}
                      </div>
                      {pos.manualOnlyExit ? (
                        <div className="text-xs text-amber-300">
                          手动持仓，仅允许手动卖出
                        </div>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-200">{pos.currentPrice?.toFixed(3)}</td>
                  <td className="px-4 py-3 text-slate-400">{pos.entryPrice?.toFixed(3)}</td>
                  <td className="px-4 py-3 text-slate-200">{formatMoney(pos.value)}</td>
                  <td className={`px-4 py-3 font-medium ${pos.pnlPct >= 0 ? 'text-rise' : 'text-fall'}`}>{formatPct(pos.pnlPct)}</td>
                  <td className="px-4 py-3 text-slate-400">
                    <div>{pos.holdDays || 0}天</div>
                    <div className="text-xs text-slate-500">可卖 {pos.sellableQuantity ?? pos.quantity ?? 0} 股</div>
                  </td>
                  <td className="px-4 py-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge tone={pos.exitShouldExit ? 'warn' : Number(pos.exitUrgency || 0) >= 70 ? 'sky' : 'neutral'}>
                            紧迫度 {pos.exitUrgency || 0}
                          </Badge>
                        {pos.lastEvaluatedAt ? <span className="text-xs text-slate-500">{pos.lastEvaluatedAt}</span> : null}
                        </div>
                      <div className="max-w-[240px] text-xs leading-5 text-slate-400">{pos.manualOnlyExit ? '手动持仓不参与自动卖出' : (pos.exitSummary || '暂无诊断')}</div>
                      <div className="max-w-[240px] text-xs leading-5 text-slate-500">{pos.managementSummary || '暂无仓位管理动作'}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><Badge tone={pos.confidence === 'HIGH' ? 'rise' : pos.confidence === 'LOW' ? 'warn' : 'neutral'}>{pos.confidence || 'UNKNOWN'}</Badge></td>
                  <td className="px-4 py-3">
                    <div className="flex min-w-[150px] flex-col gap-2">
                      <input
                        type="number"
                        min="100"
                        step="100"
                        value={sellQuantities[pos.symbol] || ''}
                        onChange={event => setSellQuantities(prev => ({ ...prev, [pos.symbol]: event.target.value }))}
                        placeholder={`默认卖${pos.sellableQuantity ?? pos.quantity ?? 0}`}
                        className="w-32 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-red-400"
                      />
                      <button
                        onClick={() => handleSell(pos)}
                        disabled={sellingSymbol === pos.symbol || Number(pos.sellableQuantity || 0) <= 0}
                        className="w-32 rounded-lg bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                      >
                        {sellingSymbol === pos.symbol ? '卖出中...' : '卖出/减仓'}
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            />
          </Card>

          <Card title="操作说明" subtitle="模拟盘和实盘已拆分到两个页面">
            <div className="space-y-4 text-sm text-slate-400">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 leading-7">
                <div>模拟盘页只做查询、手动模拟买入、手动卖出和持仓观察。</div>
                <div>实盘入口已移到顶部导航的“实盘助手”。</div>
                <div>这样可以避免在模拟盘页面里误触实盘状态和下单动作。</div>
              </div>
              <a
                href="/live"
                className="inline-flex rounded-xl bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-amber-300"
              >
                打开实盘助手
              </a>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="本轮不开仓原因" subtitle={tradeDecision.skippedReason || '最近一轮交易层摘要'}>
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {tradeDecision.recoveryMode ? <Badge tone="warn">空仓恢复模式</Badge> : null}
                <Badge tone={Number(tradeDecision.portfolioDrawdown || 0) > 5 ? 'warn' : 'neutral'}>
                  组合回撤 {Number(tradeDecision.portfolioDrawdown || 0).toFixed(2)}%
                </Badge>
                <Badge tone="neutral">交易时段内均可开仓</Badge>
                <Badge tone="rise">交易所开市是唯一时间边界</Badge>
              </div>
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
                  <Badge tone="rise">加仓候选 {tradeDecision.addOnCandidateCount || 0}</Badge>
                  <Badge tone="rise">已加仓 {tradeDecision.addOnAcceptedCount || 0}</Badge>
                  <Badge tone="warn">已减仓 {tradeDecision.trimAcceptedCount || 0}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(tradeDecision.rejectSummary || []).map(item => (
                    <Badge key={`${item.key}-${item.count}`} tone="warn">{item.label} {item.count}只</Badge>
                  ))}
                {(!tradeDecision.rejectSummary || tradeDecision.rejectSummary.length === 0) ? <span className="text-sm text-slate-400">最近没有明显拒绝项</span> : null}
              </div>
                <div className="space-y-2">
                  {(tradeDecision.addOns || []).slice(0, 4).map(item => (
                    <div key={`addon-${item.symbol}-${item.reason}`} className="rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                        <Badge tone="rise">加仓</Badge>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">数量 {item.quantity || 0} / 金额 {formatMoney(item.positionValue || 0)}</div>
                      <div className="mt-2 text-sm text-slate-300">{item.reason}</div>
                    </div>
                  ))}
                  {(tradeDecision.trims || []).slice(0, 4).map(item => (
                    <div key={`trim-${item.symbol}-${item.reason}`} className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                        <Badge tone="warn">减仓</Badge>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">数量 {item.quantity || 0} / 浮盈 {item.pnlPct ?? 0}%</div>
                      <div className="mt-2 text-sm text-slate-300">{item.reason}</div>
                    </div>
                  ))}
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
                      <div className="mt-1 text-xs text-slate-500">
                        价格 {item.price != null ? Number(item.price).toFixed(2) : '-'} · 涨幅 {item.changePercent != null ? `${Number(item.changePercent).toFixed(2)}%` : '-'} · 盘中 {item.intradayReturnPct != null ? `${Number(item.intradayReturnPct).toFixed(2)}%` : '-'}
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
