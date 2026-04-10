import { useState, useEffect } from 'react'
import { Navigation } from '../components/common/Navigation'
import { Card } from '../components/common/Card'
import { Badge } from '../components/common/Badge'
import { TableShell } from '../components/common/TableShell'
import { api } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { useScrollRestore } from '../hooks/useScrollRestore'

function reasonTone(key) {
  if (['main', 'continuation'].includes(key)) return 'rise'
  if (['observation'].includes(key)) return 'sky'
  return 'warn'
}

function bucketTone(bucket) {
  if (bucket === 'main' || bucket === 'continuation') return 'rise'
  if (bucket === 'observation') return 'sky'
  return 'neutral'
}

function ReasonList({ items, emptyText = '暂无' }) {
  if (!items?.length) {
    return <div className="text-sm text-slate-400">{emptyText}</div>
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <div key={`${item.key}-${item.count}`} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <div className="text-sm text-slate-300">{item.label}</div>
          <Badge tone="warn">{item.count}</Badge>
        </div>
      ))}
    </div>
  )
}

function renderTagCell(item) {
  const continuationRejectedChecks = item.strategy?.selectedReason?.continuationRejectedChecks || []
  const continuationSecondary = item.strategy?.selectedReason?.continuationSecondary

  return (
    <div className="flex min-w-[240px] max-w-[320px] flex-wrap gap-1">
      {item.strategy?.bucket === 'main' ? <Badge tone="rise">低吸主池</Badge> : null}
      {item.strategy?.bucket === 'observation' ? <Badge tone="sky">转强观察</Badge> : null}
      {item.strategy?.bucket === 'continuation' && continuationSecondary ? <Badge tone="sky">二阶延续</Badge> : null}
      {item.strategy?.observationBias ? <Badge tone="warn">更像转强不是低吸</Badge> : null}
      {item.strategy?.positiveTags?.map((tag, i) => (
        <Badge key={`good-${i}`} tone="rise">{tag}</Badge>
      ))}
      {item.strategy?.riskTags?.map((tag, i) => (
        <Badge key={`risk-${i}`} tone="warn">{tag}</Badge>
      ))}
      {continuationRejectedChecks.map((tag, i) => (
        <Badge key={`reject-${i}`} tone="neutral">未升格:{tag}</Badge>
      ))}
      {item.researchSelected ? <Badge tone="neutral">研究入选</Badge> : null}
      {item.history?.degraded ? <Badge tone="warn">历史降级</Badge> : null}
    </div>
  )
}

function renderCandidateRow(item, idx) {
  const bucketLabel = item.strategy?.bucketLabel || (item.strategy?.bucket === 'main' ? '低吸主池' : item.strategy?.bucket === 'observation' ? '转强观察' : '高分样本')
  const selectedDayScore = item.selectedDayScore ?? item.strategy?.selectedDayScore ?? item.score
  const continuationRejectedChecks = item.strategy?.selectedReason?.continuationRejectedChecks || []
  const continuationSecondary = item.strategy?.selectedReason?.continuationSecondary
  const hasLivePrice = item.price != null
  const displayPrice = hasLivePrice ? item.price?.toFixed(2) : (item.prevClose != null ? `${item.prevClose.toFixed(2)}*` : '-')
  const displayChange = item.changePercent != null
    ? `${item.changePercent >= 0 ? '+' : ''}${item.changePercent.toFixed(2)}%`
    : '未开盘'
  const statusText = item.strategy?.bucket === 'continuation'
    ? (continuationSecondary
      ? '从观察池里按更严条件升格的二阶延续，只保留少量轻微过热但承接足够的票。'
      : '强势延续，可交易但只在上午窗口评估开仓。')
    : item.strategy?.bucket === 'observation'
      ? `当前不满足主交易池${continuationRejectedChecks.length ? `，未升格原因: ${continuationRejectedChecks.join('/')}` : ''}。`
      : item.strategy?.bucket === 'main'
        ? '满足回调低吸资格。'
        : '当前未进入主池/观察池，仅作为高分样本展示。'

  return (
    <tr key={`${item.symbol}-${idx}`} className="hover:bg-slate-800/40">
      <td className="whitespace-nowrap px-4 py-3 align-top text-slate-500">{idx + 1}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <a href={`https://quote.eastmoney.com/${item.symbol}.html`} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
          {item.symbol}
        </a>
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-slate-200">{item.name}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <Badge tone={item.strategy?.bucket === 'main' ? 'rise' : item.strategy?.bucket === 'observation' ? 'sky' : 'neutral'}>
          {bucketLabel}
        </Badge>
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-slate-200">
        <div>{displayPrice}</div>
        {!hasLivePrice && item.prevClose != null ? <div className="mt-1 text-xs text-slate-500">昨收价</div> : null}
      </td>
      <td className={`whitespace-nowrap px-4 py-3 align-top font-medium ${item.changePercent == null ? 'text-slate-500' : (item.changePercent >= 0 ? 'text-rise' : 'text-fall')}`}>
        {displayChange}
        {item.changePercent == null ? <div className="mt-1 text-xs text-slate-500">09:30后刷新</div> : null}
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-slate-200">
        <div>{item.score?.toFixed(1) || '-'}</div>
        {selectedDayScore != null && Number(selectedDayScore) !== Number(item.score)
          ? <div className="mt-1 text-xs text-slate-500">选桶 {Number(selectedDayScore).toFixed(1)}</div>
          : null}
      </td>
      <td className="whitespace-nowrap px-4 py-3 align-top text-slate-200">{item.historyScore?.toFixed(1) || '-'}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top font-medium text-slate-100">{item.combinedScore?.toFixed(1) || '-'}</td>
      <td className="min-w-[260px] max-w-[320px] px-4 py-3 align-top text-xs leading-6 text-slate-400">
        {statusText}
      </td>
      <td className="px-4 py-3 align-top">{renderTagCell(item)}</td>
    </tr>
  )
}

export function ScanBoard() {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)

  useScrollRestore('scan')

  const fetchData = async () => {
    try {
      const [stateData] = await Promise.all([api.getState()])
      setState(stateData)
      setLastUpdate(new Date().toLocaleTimeString('zh-CN'))
    } catch (err) {
      console.error('获取数据失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useAutoRefresh(fetchData, 30000)

  if (loading) return <div className="flex min-h-screen items-center justify-center text-slate-400">加载中...</div>
  if (!state) return <div className="flex min-h-screen items-center justify-center text-slate-400">无数据</div>

  const regimeColor = state.marketRegime?.regime === 'BULL' ? 'rise' : state.marketRegime?.regime === 'BEAR' ? 'fall' : 'neutral'
  const regimeText = state.marketRegime?.regime === 'BULL' ? '牛市' : state.marketRegime?.regime === 'BEAR' ? '熊市' : state.marketRegime?.regime === 'NEUTRAL' ? '震荡' : '未知'
  const diagnostics = state.diagnostics || {}
  const filterSummary = diagnostics.filterSummary || []
  const filteredSamples = diagnostics.filteredSamples || []
  const bucketDistribution = diagnostics.bucketDistribution || []
  const mainRejectSummary = diagnostics.mainRejectSummary || []
  const observationRejectSummary = diagnostics.observationRejectSummary || []
  const continuationRejectSummary = diagnostics.continuationRejectSummary || []
  const continuationDemotionSummary = diagnostics.continuationDemotionSummary || []
  const bucketSamples = diagnostics.bucketSamples || []
  const tradeDecision = diagnostics.tradeDecision || {}
  const dataQuality = diagnostics.dataQuality || {}
  const tradeRejectSummary = tradeDecision.rejectSummary || []
  const tradeRejected = tradeDecision.rejected || []
  const fallbackRows = [...(state.market || [])]
    .sort((a, b) => (b.combinedScore || b.score || 0) - (a.combinedScore || a.score || 0))
    .slice(0, 12)
  const mainRows = state.strategyPicks || []
  const observationRows = state.observationPicks || []

  const columns = [
    { key: 'rank', title: '#' },
    { key: 'symbol', title: '代码' },
    { key: 'name', title: '名称' },
    { key: 'bucket', title: '分桶' },
    { key: 'price', title: '价格' },
    { key: 'changePercent', title: '涨跌幅' },
    { key: 'score', title: '评分' },
    { key: 'historyScore', title: '历史分' },
    { key: 'combinedScore', title: '综合分' },
    { key: 'reason', title: '状态说明' },
    { key: 'tags', title: '标签' },
  ]

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1680px]">
        <h1 className="mb-3 text-3xl font-bold text-slate-100">A股实时观察</h1>
        <p className="mb-6 max-w-5xl text-sm leading-7 text-slate-400">
          主池只保留真正的回调低吸标的，盘中拉升转强但不再适合低吸的股票会被稳定放进观察池，不再和主池混排。
        </p>
        {dataQuality.beforeOpen ? (
          <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            当前是盘前阶段，东财很多股票的实时价、涨跌幅、成交额会返回空值。页面里带 `*` 的价格是昨收，09:30 后会自动切回实时价。
          </div>
        ) : null}
        <Navigation />

        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          <Card>
            <div className="text-sm text-slate-400">扫描轮次</div>
            <div className="mt-2 text-3xl font-bold text-slate-100">{state.scanRounds}</div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">市场股票数</div>
            <div className="mt-2 text-3xl font-bold text-slate-100">{state.marketCount}</div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">策略候选</div>
            <div className="mt-2 text-3xl font-bold text-slate-100">{state.strategyPicks?.length || 0}</div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">观察候选</div>
            <div className="mt-2 text-3xl font-bold text-slate-100">{state.observationPicks?.length || 0}</div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">市场环境</div>
            <div className="mt-2">
              <Badge tone={regimeColor}>{regimeText}</Badge>
            </div>
          </Card>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,1fr)]">
          <Card title="筛选漏斗" subtitle={`初筛 ${diagnostics.initialCandidateCount || 0} 只 · 主候选 ${diagnostics.finalPickCount || 0} 只 · 观察候选 ${diagnostics.observationCount || 0} 只`}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">研究池</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{state.researchWatchlist?.count || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">研究候选</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{diagnostics.researchCandidateCount || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">主候选</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{state.strategyPicks?.length || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">观察候选</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{state.observationPicks?.length || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">历史通过后可交易</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{diagnostics.tradeableAfterHistoryCount || 0}</div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {filterSummary.length > 0 ? filterSummary.slice(0, 6).map(item => (
                <Badge key={item.key} tone="warn">{item.label} {item.count}只</Badge>
              )) : <span className="text-sm text-slate-400">当前没有明显淘汰项</span>}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {bucketDistribution.length > 0 ? bucketDistribution.map(item => (
                <Badge key={item.key} tone={reasonTone(item.key)}>{item.label} {item.count}只</Badge>
              )) : <span className="text-sm text-slate-400">暂无分桶统计</span>}
            </div>
          </Card>

          <Card title="本轮诊断" subtitle={state.strategyPicks?.length ? '主候选已产出，继续看交易层为何开/不开。' : '主候选为空，优先看历史过滤、分桶和交易拒绝原因。'}>
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">主池为何过不去</div>
                <ReasonList items={mainRejectSummary} emptyText="当前没有明显主池拦截项" />
              </div>
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">观察池主要来源</div>
                <ReasonList items={observationRejectSummary} emptyText="当前没有明显观察池拦截项" />
              </div>
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">延续池为何进不来</div>
                <ReasonList items={continuationRejectSummary} emptyText="当前没有明显延续池拦截项" />
              </div>
              <div>
                <div className="mb-2 text-xs uppercase tracking-[0.18em] text-slate-500">趋势延续为何降级观察</div>
                <ReasonList items={continuationDemotionSummary} emptyText="当前没有趋势延续降级样本" />
              </div>
            </div>
          </Card>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,1fr)]">
          <Card
            title="交易层诊断"
            subtitle={
              tradeDecision?.skippedReason
                ? `最近一轮未开新仓: ${tradeDecision.skippedReason}`
                : '最近一轮交易决策摘要'
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">主候选数</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.strategyCandidateCount || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">交易筛后</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.buyCandidateCount || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">通过买入</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.acceptedCount || 0}</div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">拒绝买入</div>
                <div className="mt-2 text-2xl font-semibold text-slate-100">{tradeDecision.rejectedCount || 0}</div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {tradeDecision.recoveryMode ? <Badge tone="warn">空仓恢复模式</Badge> : null}
              <Badge tone={state.marketRegime?.regime === 'BULL' ? 'rise' : state.marketRegime?.regime === 'BEAR' ? 'fall' : 'neutral'}>
                {tradeDecision.marketRegime || state.marketRegime?.regime || 'UNKNOWN'}
              </Badge>
              <Badge tone="neutral">可用仓位 {tradeDecision.availablePositions ?? 0}</Badge>
              <Badge tone={Number(tradeDecision.portfolioDrawdown || 0) > 5 ? 'warn' : 'neutral'}>
                回撤 {Number(tradeDecision.portfolioDrawdown || 0).toFixed(2)}%
              </Badge>
            </div>
            <div className="mt-4">
              <ReasonList items={tradeRejectSummary} emptyText="最近一轮没有交易拒绝" />
            </div>
          </Card>

          <Card title="最近被拒样本" subtitle="直接看具体股票为何没有开仓">
            {tradeRejected.length > 0 ? (
              <div className="space-y-3">
                {tradeRejected.slice(0, 5).map(item => (
                  <div key={`${item.symbol}-${item.reason}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-400">日内 {item.dayScore || 0} 分 · 历史 {item.historyScore || 0} 分</div>
                      </div>
                      <Badge tone="warn">{item.rejectCategory || '被拒'}</Badge>
                    </div>
                    <div className="mt-2 text-sm text-slate-300">{item.reason}</div>
                  </div>
                ))}
              </div>
            ) : filteredSamples.length > 0 ? (
              <div className="space-y-3">
                {filteredSamples.slice(0, 4).map(item => (
                  <div key={`${item.symbol}-${item.reason}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-400">日内 {item.score || 0} 分 · 历史 {item.historyScore || 0} 分</div>
                      </div>
                      <Badge tone="warn">历史拦截</Badge>
                    </div>
                    <div className="mt-2 text-sm text-slate-300">{item.reason}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-slate-400">暂无样本</div>
            )}
          </Card>
        </div>

        <div className="mb-6">
          <Card title="分桶迁移样本" subtitle="看哪些票被放进观察池，避免误以为它们凭空消失">
            {bucketSamples.length > 0 ? (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {bucketSamples.slice(0, 6).map(item => (
                  <div key={`${item.symbol}-${item.bucket}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-400">日内 {item.dayScore || 0} 分 · 历史 {item.historyScore || 0} 分 · 综合 {item.combinedScore || 0} 分</div>
                      </div>
                      <Badge tone={reasonTone(item.bucket)}>{item.bucketLabel}</Badge>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(item.failedPullback || []).map(key => <Badge key={`${item.symbol}-p-${key}`} tone="warn">主池:{key}</Badge>)}
                      {(item.failedObservation || []).map(key => <Badge key={`${item.symbol}-o-${key}`} tone="sky">观察:{key}</Badge>)}
                      {(item.failedContinuation || []).map(key => <Badge key={`${item.symbol}-c-${key}`} tone="neutral">延续:{key}</Badge>)}
                      {(item.continuationRejectedChecks || []).map(key => <Badge key={`${item.symbol}-d-${key}`} tone="warn">降级:{key}</Badge>)}
                      {item.continuationSecondary ? <Badge tone="rise">已二阶放行</Badge> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-slate-400">当前没有迁移样本</div>
            )}
          </Card>
        </div>

        <div className="mb-6">
          <Card title="候选池总览" subtitle="先看主候选和观察候选是否都还在，再看交易层为什么不开仓。">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">主候选</div>
                <div className="mt-3 space-y-2">
                  {mainRows.slice(0, 5).map(item => (
                    <div key={`main-${item.symbol}`} className="flex items-start justify-between gap-3 rounded-xl bg-slate-900/70 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-500">日 {Number(item.selectedDayScore ?? item.score ?? 0).toFixed(1)} · 历史 {Number(item.historyScore || 0).toFixed(1)} · 综合 {Number(item.combinedScore || 0).toFixed(1)}</div>
                      </div>
                      <Badge tone={bucketTone(item.strategy?.bucket)}>{item.strategy?.bucketLabel || '主候选'}</Badge>
                    </div>
                  ))}
                  {mainRows.length === 0 ? <div className="text-sm text-slate-400">当前没有主候选</div> : null}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">观察候选</div>
                <div className="mt-3 space-y-2">
                  {observationRows.slice(0, 5).map(item => (
                    <div key={`obs-${item.symbol}`} className="flex items-start justify-between gap-3 rounded-xl bg-slate-900/70 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-500">日 {Number(item.selectedDayScore ?? item.score ?? 0).toFixed(1)} · 历史 {Number(item.historyScore || 0).toFixed(1)} · 综合 {Number(item.combinedScore || 0).toFixed(1)}</div>
                      </div>
                      <Badge tone={bucketTone(item.strategy?.bucket)}>{item.strategy?.bucketLabel || '观察候选'}</Badge>
                    </div>
                  ))}
                  {observationRows.length === 0 ? <div className="text-sm text-slate-400">当前没有观察候选</div> : null}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">交易层结论</div>
                <div className="mt-3 space-y-2">
                  <div className="rounded-xl bg-slate-900/70 px-3 py-2 text-sm text-slate-300">
                    最近一轮: {tradeDecision.skippedReason || '已执行交易或无阻塞'}
                  </div>
                  {(tradeRejected || []).slice(0, 4).map(item => (
                    <div key={`reject-${item.symbol}-${item.reason}`} className="rounded-xl bg-slate-900/70 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                        <Badge tone="warn">{item.rejectCategory || '被拒'}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{item.reason}</div>
                    </div>
                  ))}
                  {(!tradeRejected || tradeRejected.length === 0) ? <div className="text-sm text-slate-400">最近没有交易拒绝样本</div> : null}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">市场高分观察</div>
                <div className="mt-3 space-y-2">
                  {fallbackRows.slice(0, 5).map(item => (
                    <div key={`fallback-${item.symbol}`} className="flex items-start justify-between gap-3 rounded-xl bg-slate-900/70 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-500">日 {Number(item.selectedDayScore ?? item.score ?? 0).toFixed(1)} · 历史 {Number(item.historyScore || 0).toFixed(1)} · 综合 {Number(item.combinedScore || 0).toFixed(1)}</div>
                      </div>
                      <Badge tone="neutral">未进主池</Badge>
                    </div>
                  ))}
                  {fallbackRows.length === 0 ? <div className="text-sm text-slate-400">当前没有高分样本</div> : null}
                </div>
              </div>
            </div>
          </Card>
        </div>

        <Card
          title="主候选"
          subtitle={
            state.strategyPicks?.length
              ? `最后扫描: ${state.lastScanAt || '-'} | 最后更新: ${lastUpdate || '-'}`
              : `当前无合格主池 | 最后扫描: ${state.lastScanAt || '-'}`
          }
        >
          <TableShell
            columns={columns}
            rows={mainRows}
            emptyText="当前没有真实主候选"
            renderRow={renderCandidateRow}
            tableClassName="min-w-[1220px]"
          />
        </Card>

        <div className="mt-6">
          <Card
            title="市场高分样本"
            subtitle="这些只是市场里分数靠前的样本，用来辅助观察盘面，不代表已经通过主策略或会自动开仓。"
          >
            <TableShell
              columns={columns}
              rows={fallbackRows}
              emptyText="当前没有高分样本"
              renderRow={renderCandidateRow}
              tableClassName="min-w-[1220px]"
            />
          </Card>
        </div>

        <div className="mt-6">
          <Card
            title="观察候选"
            subtitle={
              state.observationPicks?.length
                ? '这些票多半是盘中转强、离高点过近或短线涨幅过大，不再按低吸逻辑开仓。'
                : '当前观察池为空，说明本轮没有接近可交易的转强/延续观察样本。'
            }
          >
            <TableShell
              columns={columns}
              rows={observationRows}
              emptyText="当前没有观察候选"
              renderRow={renderCandidateRow}
              tableClassName="min-w-[1220px]"
            />
          </Card>
        </div>
      </div>
    </div>
  )
}
