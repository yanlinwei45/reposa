export function Badge({ children, tone = 'neutral' }) {
  const toneClasses = {
    rise: 'bg-red-500/15 text-red-400 border-red-500/20',
    fall: 'bg-green-500/15 text-green-400 border-green-500/20',
    sky: 'bg-sky-500/15 text-sky-300 border-sky-500/20',
    neutral: 'bg-slate-700/60 text-slate-200 border-slate-600',
    warn: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
  }

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses[tone] || toneClasses.neutral}`}>
      {children}
    </span>
  )
}
