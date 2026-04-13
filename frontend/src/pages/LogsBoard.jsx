import { useState, useEffect } from 'react'
import { Navigation } from '../components/common/Navigation'
import { Card } from '../components/common/Card'
import { api } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { useScrollRestore } from '../hooks/useScrollRestore'

export function LogsBoard() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)

  useScrollRestore('logs')

  const fetchData = async () => {
    try {
      const data = await api.getLogs()
      setLogs(data)
    } catch (err) {
      console.error('获取日志失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useAutoRefresh(fetchData, 15000)

  if (loading) return <div className="flex min-h-screen items-center justify-center text-slate-400">加载中...</div>

  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-6 text-3xl font-bold text-slate-100">扫描日志</h1>
        <Navigation />

        <Card title="最近扫描记录" subtitle={`共 ${logs.length} 条`}>
          <div className="space-y-3">
            {logs.map((log, idx) => (
              <div key={idx} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-slate-200">{log.bjTime}</span>
                    <span className="ml-4 text-sm text-slate-400">耗时 {log.duration}ms</span>
                  </div>
                  <button
                    onClick={() => setExpandedId(expandedId === idx ? null : idx)}
                    className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
                  >
                    {expandedId === idx ? '收起' : '展开'}
                  </button>
                </div>
                {log.summary && (
                  <div className="mt-2 text-sm text-slate-400">
                    候选: {log.summary.picks || 0} | 市场: {log.summary.market || 0}
                  </div>
                )}
                {expandedId === idx && log.steps && (
                  <div className="mt-4 space-y-2 border-t border-slate-800 pt-4">
                    {log.steps.map((step, i) => (
                      <div key={i} className="text-sm">
                        <div className="font-medium text-slate-300">{step.step}</div>
                        <pre className="mt-1 overflow-x-auto rounded bg-slate-950/80 p-2 text-xs text-slate-400">
                          {JSON.stringify(step.data, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
