import { useEffect, useState } from 'react'
import { Clipboard, Code2, KeyRound, Loader2 } from 'lucide-react'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from '@shared/types'
import { api } from '../../api'
import { useApp, type TableTabState } from '../../store'

/** The Structure view of a table tab: columns, indexes, foreign keys and DDL */
export function TableStructure({ sid, tab }: { sid: string; tab: TableTabState }): JSX.Element {
  const openQueryTab = useApp((s) => s.openQueryTab)
  const toast = useApp((s) => s.toast)
  const [cols, setCols] = useState<ColumnInfo[] | null>(null)
  const [idx, setIdx] = useState<IndexInfo[]>([])
  const [fks, setFks] = useState<ForeignKeyInfo[]>([])
  const [ddl, setDdl] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      api.listColumns(sid, tab.table),
      api.listIndexes(sid, tab.table).catch(() => []),
      api.listForeignKeys(sid, tab.table).catch(() => []),
      api.getDDL(sid, tab.table, tab.tableType).catch((e) => `-- Could not generate DDL: ${e.message}`)
    ])
      .then(([c, i, f, d]) => {
        setCols(c)
        setIdx(i)
        setFks(f)
        setDdl(d)
      })
      .catch((e) => setError(e.message))
  }, [sid, tab.table, tab.tableType])

  if (error) return <div className="results-msg error"><div className="error-box">{error}</div></div>
  if (!cols) return <div className="results-msg"><Loader2 size={20} className="spin" /></div>

  return (
    <div className="structure">
      <h3>
        Columns <span className="badge">{cols.length}</span>
      </h3>
      <table className="meta">
        <thead>
          <tr>
            <th style={{ width: 36 }}>#</th>
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            <th>Extra</th>
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={c.name}>
              <td className="faint">{c.ordinal}</td>
              <td className="mono">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {c.primaryKey && <KeyRound size={12} color="var(--accent)" />}
                  {c.name}
                </span>
              </td>
              <td className="mono muted">{c.dataType}</td>
              <td>{c.nullable ? <span className="muted">YES</span> : <b>NO</b>}</td>
              <td className="mono muted">{c.defaultValue ?? <span className="cell-null">NULL</span>}</td>
              <td>
                <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                  {c.primaryKey && <span className="badge accent">PK</span>}
                  {c.autoIncrement && <span className="badge">auto</span>}
                  {c.comment && <span className="muted">{c.comment}</span>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>
        Indexes <span className="badge">{idx.length}</span>
      </h3>
      {idx.length ? (
        <table className="meta">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Unique</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {idx.map((i) => (
              <tr key={i.name}>
                <td className="mono">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {i.primary && <KeyRound size={12} color="var(--accent)" />}
                    {i.name}
                  </span>
                </td>
                <td className="mono muted">{i.columns.join(', ')}</td>
                <td>{i.unique ? 'YES' : <span className="muted">NO</span>}</td>
                <td className="muted">{i.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">No indexes</div>
      )}

      <h3>
        Foreign keys <span className="badge">{fks.length}</span>
      </h3>
      {fks.length ? (
        <table className="meta">
          <thead>
            <tr>
              <th>Name</th>
              <th>Column</th>
              <th>References</th>
              <th>On update</th>
              <th>On delete</th>
            </tr>
          </thead>
          <tbody>
            {fks.map((f, i) => (
              <tr key={`${f.name}-${i}`}>
                <td className="mono">{f.name}</td>
                <td className="mono">{f.column}</td>
                <td className="mono muted">
                  {f.refTable}.{f.refColumn}
                </td>
                <td className="muted">{f.onUpdate}</td>
                <td className="muted">{f.onDelete}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">No foreign keys</div>
      )}

      <h3>
        DDL
        <span className="spacer" />
        <button
          className="btn sm"
          onClick={() => {
            navigator.clipboard.writeText(ddl)
            toast('DDL copied', 'success')
          }}
        >
          <Clipboard size={12} /> Copy
        </button>
        <button className="btn sm" onClick={() => openQueryTab(sid, ddl, `${tab.table.name} DDL`)}>
          <Code2 size={12} /> Open in editor
        </button>
      </h3>
      <pre className="ddl">{ddl}</pre>
    </div>
  )
}
