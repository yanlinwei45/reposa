import { useState, useEffect } from 'react'
import { Navigation } from '../components/common/Navigation'
import { Card } from '../components/common/Card'
import { Badge } from '../components/common/Badge'
import { TableShell } from '../components/common/TableShell'
import { api } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { useScrollRestore } from '../hooks/useScrollRestore'

function renderTagCell(item) {
  return (
    <div className="flex flex-wrap gap-1">
      {item.strategy?.positiveTags?.map((tag, i) => (
        <Badge key={`good-${i}`} tone="rise">{tag}</Badge>
      ))}
      {item.strategy?.riskTags?.map((tag, i) => (
        <Badge key={`risk-${i}`} tone="warn">{tag}</Badge>
      ))}
      {item.researchSelected ? <Badge tone="neutral">研究入选</Badge> : null}
      {item.history?.degraded ? <Badge tone="warn">历史降级</Badge> : null}
    </div>
  )
}

function renderCandidateRow(item, idx) {
  return (
    <tr key={`${item.symbol}-${idx}`} className="hover:bg-slate-800/40">
      <td className="px-4 py-3">
        <a href={`https://quote.eastmoney.com/${item.symbol}.html`} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
          {item.symbol}
        </a>
      </td>
      <td className="px-4 py-3 text-slate-200">{item.name}</td>
      <td className="px-4 py-3 text-slate-200">{item.price?.toFixed(2) || '-'}</td>
      <td className={`px-4 py-3 font-medium ${(item.changePercent || 0) >= 0 ? 'text-rise' : 'text-fall'}`}>
        {item.changePercent != null ? `${item.changePercent >= 0 ? '+' : ''}${item.changePercent.toFixed(2)}%` : '-'}
      </td>
      <td className="px-4 py-3 text-slate-200">{item.score?.toFixed(1) || '-'}</td>
      <td className="px-4 py-3 text-slate-200">{item.historyScore?.toFixed(1) || '-'}</td>
      <td className="px-4 py-3 font-medium text-slate-100">{item.combinedScore?.toFixed(1) || '-'}</td>
      <td className="px-4 py-3">{renderTagCell(item)}</td>
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

  const columns = [
    { key: 'symbol', title: '代码' },
    { key: 'name', title: '名称' },
    { key: 'price', title: '价格' },
    { key: 'changePercent', title: '涨跌幅' },
    { key: 'score', title: '评分' },
    { key: 'historyScore', title: '历史分' },
    { key: 'combinedScore', title: '综合分' },
    { key: 'tags', title: '标签' },
  ]

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-6 text-3xl font-bold text-slate-100">A股实时观察</h1>
        <Navigation />

        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

        <div className="mb-6 grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Card title="筛选漏斗" subtitle={`初筛 ${diagnostics.initialCandidateCount || 0} 只 · 主候选 ${diagnostics.finalPickCount || 0} 只 · 观察候选 ${diagnostics.observationCount || 0} 只`}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {filterSummary.length > 0 ? filterSummary.slice(0, 6).map(item => (
                <Badge key={item.key} tone="warn">{item.label} {item.count}只</Badge>
              )) : <span className="text-sm text-slate-400">当前没有明显淘汰项</span>}
            </div>
          </Card>

          <Card title="本轮诊断" subtitle={state.strategyPicks?.length ? '主候选已产出，可直接看交易池。' : '主候选为空，先看观察池和过滤原因。'}>
            {filteredSamples.length > 0 ? (
              <div className="space-y-3">
                {filteredSamples.slice(0, 4).map(item => (
                  <div key={`${item.symbol}-${item.reason}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-100">{item.symbol} {item.name}</div>
                        <div className="mt-1 text-xs text-slate-400">日内 {item.score || 0} 分 · 历史 {item.historyScore || 0} 分</div>
                      </div>
                      <Badge tone="warn">被拦截</Badge>
                    </div>
                    <div className="mt-2 text-sm text-slate-300">{item.reason}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-slate-400">暂无诊断样本</div>
            )}
          </Card>
        </div>

        <Card title="主候选" subtitle={`最后扫描: ${state.lastScanAt || '-'} | 最后更新: ${lastUpdate || '-'}`}>
          <TableShell
            columns={columns}
            rows={state.strategyPicks || []}
            emptyText="当前没有可交易主候选"
            renderRow={renderCandidateRow}
          />
        </Card>

        <div className="mt-6">
          <Card title="观察候选" subtitle="这些票通过了初筛或研究池优先级较高，但暂时不满足主交易条件。">
            <TableShell
              columns={columns}
              rows={state.observationPicks || []}
              emptyText="当前没有观察候选"
              renderRow={renderCandidateRow}
            />
          </Card>
        </div>
      </div>
    </div>
  )
}
