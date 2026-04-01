import { useState, useEffect } from 'react'
import { Navigation } from '../components/common/Navigation'
import { Card } from '../components/common/Card'
import { Badge } from '../components/common/Badge'
import { TableShell } from '../components/common/TableShell'
import { api } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { useScrollRestore } from '../hooks/useScrollRestore'

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
            <div className="text-sm text-slate-400">市场环境</div>
            <div className="mt-2">
              <Badge tone={regimeColor}>{regimeText}</Badge>
            </div>
          </Card>
        </div>

        <Card title="候选股票" subtitle={`最后扫描: ${state.lastScanAt || '-'} | 最后更新: ${lastUpdate || '-'}`}>
          <TableShell
            columns={columns}
            rows={state.strategyPicks || []}
            emptyText="暂无候选"
            renderRow={(item, idx) => (
              <tr key={idx} className="hover:bg-slate-800/40">
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
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {item.strategy?.positiveTags?.map((tag, i) => (
                      <Badge key={i} tone="rise">{tag}</Badge>
                    ))}
                    {item.strategy?.riskTags?.map((tag, i) => (
                      <Badge key={i} tone="warn">{tag}</Badge>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          />
        </Card>
      </div>
    </div>
  )
}
