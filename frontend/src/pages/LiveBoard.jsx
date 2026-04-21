import { useEffect, useMemo, useState } from 'react'
import { Navigation } from '../components/common/Navigation'
import { Card } from '../components/common/Card'
import { Badge } from '../components/common/Badge'
import { api } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { useScrollRestore } from '../hooks/useScrollRestore'

function liveStatusTone(liveStatus) {
  if (!liveStatus?.enabled) return 'warn'
  if (liveStatus?.connected && liveStatus?.loggedIn) return 'rise'
  if (liveStatus?.connected) return 'sky'
  return 'neutral'
}

function liveStatusText(liveStatus) {
  if (!liveStatus?.enabled) return '配置未启用'
  if (liveStatus?.connected && liveStatus?.loggedIn) return '已连接且已登录'
  if (liveStatus?.connected) return '窗口已打开，等待登录'
  return '未连接'
}

export function LiveBoard() {
  const [loading, setLoading] = useState(true)
  const [liveBusy, setLiveBusy] = useState(false)
  const [liveStatus, setLiveStatus] = useState(null)
  const [liveOrder, setLiveOrder] = useState({
    side: 'BUY',
    symbol: '',
    price: '',
    quantity: '',
    password: '',
    submit: false,
  })
  const [liveMessage, setLiveMessage] = useState({
    tone: 'neutral',
    text: '实盘助手只负责网页填单与可选提交，不会保存交易密码。',
  })

  useScrollRestore('live')

  const fetchStatus = async () => {
    try {
      const status = await api.getLiveStatus()
      setLiveStatus(status)
    } catch (err) {
      setLiveMessage({ tone: 'fall', text: `获取实盘状态失败: ${err.message}` })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
  }, [])

  useAutoRefresh(fetchStatus, 3000)

  const statusTone = useMemo(() => liveStatusTone(liveStatus), [liveStatus])
  const statusText = useMemo(() => liveStatusText(liveStatus), [liveStatus])

  const handleStartLiveSession = async () => {
    try {
      setLiveBusy(true)
      const result = await api.startLiveSession()
      setLiveStatus(result.status || null)
      setLiveMessage({ tone: 'rise', text: result.message || '实盘窗口已打开。' })
    } catch (err) {
      setLiveMessage({ tone: 'fall', text: `打开实盘窗口失败: ${err.message}` })
    } finally {
      setLiveBusy(false)
    }
  }

  const handleStopLiveSession = async () => {
    try {
      setLiveBusy(true)
      const result = await api.stopLiveSession()
      setLiveStatus(result.status || null)
      setLiveMessage({ tone: 'neutral', text: '实盘窗口已关闭。' })
      setLiveOrder(prev => ({ ...prev, password: '' }))
    } catch (err) {
      setLiveMessage({ tone: 'fall', text: `关闭实盘窗口失败: ${err.message}` })
    } finally {
      setLiveBusy(false)
    }
  }

  const handleLiveOrder = async () => {
    const side = String(liveOrder.side || 'BUY').toUpperCase()
    const symbol = liveOrder.symbol.trim()
    const price = Number(liveOrder.price)
    const quantity = Number(liveOrder.quantity)

    if (!symbol) {
      setLiveMessage({ tone: 'fall', text: '请输入实盘股票代码。' })
      return
    }
    if (!(price > 0)) {
      setLiveMessage({ tone: 'fall', text: '请输入有效的实盘价格。' })
      return
    }
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity % 100 !== 0) {
      setLiveMessage({ tone: 'fall', text: '实盘数量必须是100股整数倍。' })
      return
    }

    const actionLabel = liveOrder.submit ? '提交到东方财富' : '仅填单'
    const confirmed = window.confirm(
      `实盘${side === 'SELL' ? '卖出' : '买入'} ${symbol}\n价格: ${price.toFixed(3)}\n数量: ${quantity}股\n模式: ${actionLabel}\n\n确认继续？`
    )
    if (!confirmed) return

    try {
      setLiveBusy(true)
      const result = await api.placeLiveOrder({
        side,
        symbol,
        price,
        quantity,
        password: liveOrder.password,
        submit: liveOrder.submit,
      })
      setLiveStatus(result.status || null)
      setLiveMessage({ tone: 'rise', text: result.message || '实盘指令已发送。' })
      setLiveOrder(prev => ({
        ...prev,
        symbol,
        price: price.toFixed(3),
        quantity: String(quantity),
        password: '',
      }))
    } catch (err) {
      setLiveMessage({ tone: 'fall', text: `实盘指令失败: ${err.message}` })
    } finally {
      setLiveBusy(false)
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-slate-400">加载中...</div>

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-100">东方财富实盘助手</h1>
            <p className="mt-2 text-sm text-slate-400">独立于模拟盘页面，只负责打开东财网页、填单和可选提交。</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={fetchStatus}
              disabled={liveBusy}
              className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50"
            >
              刷新状态
            </button>
          </div>
        </div>

        <Navigation />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
          <Card>
            <div className="text-sm text-slate-400">当前状态</div>
            <div className="mt-3">
              <Badge tone={statusTone}>{statusText}</Badge>
            </div>
            <div className="mt-3 text-xs leading-6 text-slate-500">
              {liveStatus?.enabled ? '实盘模块已启用' : '请先在配置中开启 liveTrading.enabled'}
            </div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">浏览器窗口</div>
            <div className="mt-3 text-2xl font-semibold text-slate-100">{liveStatus?.connected ? '已打开' : '未打开'}</div>
            <div className="mt-2 text-xs text-slate-500">{liveStatus?.startedAt || '尚未启动'}</div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">登录状态</div>
            <div className="mt-3 text-2xl font-semibold text-slate-100">{liveStatus?.loggedIn ? '已登录' : '未登录'}</div>
            <div className="mt-2 text-xs text-slate-500">{liveStatus?.productName || '东方财富网页交易'}</div>
          </Card>
          <Card>
            <div className="text-sm text-slate-400">最近操作</div>
            <div className="mt-3 text-base font-semibold text-slate-100">{liveStatus?.lastAction || '暂无'}</div>
            <div className="mt-2 text-xs text-slate-500">{liveStatus?.lastActionAt || '尚无时间戳'}</div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card title="窗口控制" subtitle="先打开东财页面并手动完成登录" className="xl:col-span-1">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={handleStartLiveSession}
                  disabled={liveBusy || liveStatus?.connected}
                  className="rounded-xl bg-amber-400 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-amber-300 disabled:opacity-50"
                >
                  {liveBusy && !liveStatus?.connected ? '打开中...' : '打开东方财富实盘窗口'}
                </button>
                <button
                  onClick={handleStopLiveSession}
                  disabled={liveBusy || !liveStatus?.connected}
                  className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                >
                  关闭窗口
                </button>
              </div>

              <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-4 text-xs leading-6 text-amber-200">
                交易密码只在当前表单里使用，不会持久化保存。默认建议先用“只填单”，人工核对东财页面的代码、价格和数量，再决定是否点击提交。
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm leading-7 text-slate-400">
                <div>1. 打开东方财富实盘窗口。</div>
                <div>2. 在东财页面里手动登录。</div>
                <div>3. 先用只填单模式验证 DOM 和表单映射。</div>
                <div>4. 确认无误后再启用“点击提交到东方财富”。</div>
              </div>
            </div>
          </Card>

          <Card title="实盘委托" subtitle="只做单笔手动委托，不接自动策略下单" className="xl:col-span-2">
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm text-slate-400">方向</span>
                  <select
                    value={liveOrder.side}
                    onChange={(event) => setLiveOrder(prev => ({ ...prev, side: event.target.value }))}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400"
                  >
                    <option value="BUY">买入 BUY</option>
                    <option value="SELL">卖出 SELL</option>
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm text-slate-400">股票代码</span>
                  <input
                    value={liveOrder.symbol}
                    onChange={(event) => setLiveOrder(prev => ({ ...prev, symbol: event.target.value }))}
                    placeholder="如 603936 或 sh603936"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400"
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm text-slate-400">委托价格</span>
                  <input
                    type="number"
                    min="0"
                    step="0.001"
                    value={liveOrder.price}
                    onChange={(event) => setLiveOrder(prev => ({ ...prev, price: event.target.value }))}
                    placeholder="如 12.340"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400"
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm text-slate-400">数量</span>
                  <input
                    type="number"
                    min="100"
                    step="100"
                    value={liveOrder.quantity}
                    onChange={(event) => setLiveOrder(prev => ({ ...prev, quantity: event.target.value }))}
                    placeholder="必须为100股整数倍"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400"
                  />
                </label>
              </div>

              <label className="space-y-2">
                <span className="text-sm text-slate-400">交易密码</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={liveOrder.password}
                  onChange={(event) => setLiveOrder(prev => ({ ...prev, password: event.target.value }))}
                  placeholder="按需手动输入，不保存"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-amber-400"
                />
              </label>

              <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={liveOrder.submit}
                  onChange={(event) => setLiveOrder(prev => ({ ...prev, submit: event.target.checked }))}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-amber-400 focus:ring-amber-400"
                />
                点击提交到东方财富
              </label>

              <button
                onClick={handleLiveOrder}
                disabled={liveBusy || !liveStatus?.enabled || !liveStatus?.connected}
                className="w-full rounded-xl bg-red-500 px-4 py-3 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-50"
              >
                {liveBusy ? '处理中...' : liveOrder.submit ? '提交实盘委托' : '填入实盘委托'}
              </button>

              <div className={`text-sm ${liveMessage.tone === 'rise' ? 'text-emerald-300' : liveMessage.tone === 'fall' ? 'text-red-300' : 'text-slate-500'}`}>
                {liveMessage.text}
              </div>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card title="最近填单" subtitle="这里只显示最近一次发送到东财网页的委托草稿">
            {liveStatus?.lastOrderDraft ? (
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
                <div>方向: {liveStatus.lastOrderDraft.side}</div>
                <div>代码: {liveStatus.lastOrderDraft.symbol}</div>
                <div>价格: {Number(liveStatus.lastOrderDraft.price || 0).toFixed(3)}</div>
                <div>数量: {liveStatus.lastOrderDraft.quantity || 0} 股</div>
                <div>金额: {Number(liveStatus.lastOrderDraft.amount || 0).toFixed(2)}</div>
                <div>提交模式: {liveStatus.lastOrderDraft.submit ? '已点提交' : '仅填单'}</div>
              </div>
            ) : (
              <div className="text-sm text-slate-500">暂无最近填单记录</div>
            )}
          </Card>

          <Card title="错误与限制" subtitle="启动前先确认风险边界">
            <div className="space-y-3 text-sm text-slate-400">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                最近错误: <span className="text-slate-200">{liveStatus?.lastError || '暂无'}</span>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                当前仅支持手动单笔实盘，不支持策略自动连续下单，不保存密码，不做后台无人值守执行。
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
