export function TableShell({ columns, rows, renderRow, emptyText = '暂无数据', tableClassName = '' }) {
  const classes = ['w-full min-w-full divide-y divide-slate-800 text-sm', tableClassName].filter(Boolean).join(' ')

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-slate-800">
      <div className="w-full overflow-x-auto">
        <table className={classes}>
          <thead className="bg-slate-950/80">
            <tr>
              {columns.map(col => (
                <th key={col.key} className="whitespace-nowrap px-4 py-3 text-left font-medium text-slate-400">
                  {col.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/60">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-400">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
