export function Navigation() {
  const path = window.location.pathname
  const links = [
    { href: '/', label: '扫描看板' },
    { href: '/paper', label: '模拟盘' },
    { href: '/live', label: '实盘助手' },
    { href: '/logs', label: '扫描日志' },
  ]

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      {links.map(link => (
        <a
          key={link.href}
          href={link.href}
          className={`rounded-full px-4 py-2 text-sm font-medium transition ${path === link.href ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}
        >
          {link.label}
        </a>
      ))}
    </div>
  )
}
