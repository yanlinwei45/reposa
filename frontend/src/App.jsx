import { useMemo } from 'react'
import { ScanBoard } from './pages/ScanBoard'
import { PaperBoard } from './pages/PaperBoard'
import { LogsBoard } from './pages/LogsBoard'
import { LiveBoard } from './pages/LiveBoard'

export default function App() {
  const path = useMemo(() => window.location.pathname, [])

  if (path === '/paper') return <PaperBoard />
  if (path === '/live') return <LiveBoard />
  if (path === '/logs') return <LogsBoard />
  return <ScanBoard />
}
