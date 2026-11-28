import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Braces,
  ChevronRight,
  Clipboard,
  Code2,
  CopyPlus,
  Columns3,
  Database,
  Download,
  Eraser,
  Eye,
  FileCode2,
  History,
  KeyRound,
  Layers,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Star,
  Table2,
  Trash2,
  X,
  FileSpreadsheet
} from 'lucide-react'
import type { ColumnInfo, ExportFormat, HistoryEntry, SavedQuery, TableInfo } from '@shared/types'
import { api } from '../api'
import { useApp, type SessionState } from '../store'

type Panel = 'entities' | 'saved' | 'history'

export function Sidebar({ sid }: { sid: string }): JSX.Element {
  const s = useApp((st) => st.sessions[sid]) as SessionState
  const width = useApp((st) => st.sidebarWidth)
  const [panel, setPanel] = useState<Panel>('entities')

  return (
    <div className="sidebar" style={{ width }}>
      <SidebarHeader sid={sid} s={s} />
      <div className="sidebar-tabs">
        <button className={panel === 'entities' ? 'active' : ''} onClick={() => setPanel('entities')}>
          <Layers size={13} /> Entities
        </button>
        <button className={panel === 'saved' ? 'active' : ''} onClick={() => setPanel('saved')}>
          <Star size={13} /> Saved
        </button>
        <button className={panel === 'history' ? 'active' : ''} onClick={() => setPanel('history')}>
          <History size={13} /> History
        </button>
      </div>
      {s.loading && <div className="loading-bar" />}
      {panel === 'entities' && <EntityTree sid={sid} s={s} />}
      {panel === 'saved' && <SavedList sid={sid} />}
      {panel === 'history' && <HistoryList sid={sid} />}
    </div>
  )
}

function SidebarHeader({ sid, s }: { sid: string; s: SessionState }): JSX.Element {
  const useDatabase = useApp((st) => st.useDatabase)
  const setSchema = useApp((st) => st.setSchema)
  const refresh = useApp((st) => st.refreshTables)
  const disconnect = useApp((st) => st.disconnect)
  const { info } = s
  const isSqlite = info.dialect === 'sqlite'
  const dbs = s.databases.includes(info.currentDatabase) || !info.currentDatabase ? s.databases : [info.currentDatabase, ...s.databases]

  return (
    <div className="sidebar-head">
      <div className="conn-title">
        <span className="color-dot" style={{ background: info.config.color }} />
        <span className="name" title={info.serverVersion}>
          {info.config.name}
        </span>
        <button className="icon-btn" title="Refresh the table list (Ctrl+Shift+R)" onClick={() => refresh(sid)}>
          <RefreshCw size={14} className={s.loading ? 'spin' : ''} />
        </button>
        <button className="icon-btn" title="Disconnect" onClick={() => disconnect(sid)}>
          <Plug size={14} />
        </button>
      </div>
      {!isSqlite && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Database size={14} className="faint" style={{ flexShrink: 0 }} />
          <select
            className="select sm"
            value={info.currentDatabase ?? ''}
            onChange={(e) => useDatabase(sid, e.target.value)}
          >
            {!info.currentDatabase && <option value="">Select a database…</option>}
            {dbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
      {info.supportsSchemas && s.schemas.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Braces size={14} className="faint" style={{ flexShrink: 0 }} />
          <select className="select sm" value={s.schema ?? ''} onChange={(e) => setSchema(sid, e.target.value)}>
            {s.schemas.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

function EntityTree({ sid, s }: { sid: string; s: SessionState }): JSX.Element {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const f = filter.toLowerCase()
  const tables = useMemo(() => s.tables.filter((t) => t.type === 'table' && t.name.toLowerCase().includes(f)), [s.tables, f])
  const views = useMemo(() => s.tables.filter((t) => t.type === 'view' && t.name.toLowerCase().includes(f)), [s.tables, f])
  const routines = useMemo(() => s.routines.filter((r) => r.name.toLowerCase().includes(f)), [s.routines, f])
  const toggle = (k: string): void => setCollapsed((c) => ({ ...c, [k]: !c[k] }))
  const refreshTables = useApp((st) => st.refreshTables)
  const showMenu = useApp((st) => st.showMenu)
  const refreshList = (): void => void refreshTables(sid)
  // right-click anywhere in the list except on a table (tables have their own menu)
  const listMenu = (e: React.MouseEvent): void => {
    if ((e.target as Element).closest('.tree-item')) return
    e.preventDefault()
    showMenu(e.clientX, e.clientY, [
      { label: 'Refresh list', icon: <RefreshCw size={14} />, shortcut: 'Ctrl+Shift+R', onClick: refreshList }
    ])
  }

  const section = (key: string, title: string, count: number): JSX.Element => (
    <div className="tree-section" onClick={() => toggle(key)}>
      <ChevronRight size={12} className={`chev${collapsed[key] ? '' : ' open'}`} style={{ transition: 'transform .12s', transform: collapsed[key] ? '' : 'rotate(90deg)' }} />
      {title}
      <span style={{ marginLeft: 'auto', fontWeight: 500 }}>{count}</span>
      <button
        className="icon-btn tree-section-refresh"
        title="Refresh the list (Ctrl+Shift+R)"
        onClick={(e) => {
          e.stopPropagation() // don't collapse the section
          refreshList()
        }}
      >
        <RefreshCw size={11} className={s.loading ? 'spin' : ''} />
      </button>
    </div>
  )

  return (
    <>
      <div style={{ padding: '8px 10px 4px', position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 19, top: 15 }} className="faint" />
        <input
          className="q-input sm"
          style={{ paddingLeft: 27, paddingRight: filter ? 26 : 9 }}
          placeholder="Filter tables"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="icon-btn" style={{ position: 'absolute', right: 12, top: 9, width: 22, height: 22 }} onClick={() => setFilter('')}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="sidebar-body" onContextMenu={listMenu}>
        {!s.info.currentDatabase && s.info.dialect === 'mysql' && (
          <div className="empty-note">Select a database above to browse its tables.</div>
        )}
        {section('tables', 'Tables', tables.length)}
        {!collapsed.tables && tables.map((t) => <TableNode key={`t-${t.schema}-${t.name}`} sid={sid} t={t} />)}
        {views.length > 0 && section('views', 'Views', views.length)}
        {!collapsed.views && views.map((t) => <TableNode key={`v-${t.schema}-${t.name}`} sid={sid} t={t} />)}
        {routines.length > 0 && section('routines', 'Routines', routines.length)}
        {!collapsed.routines &&
          routines.map((r) => (
            <div key={`r-${r.name}`} className="tree-item" style={{ paddingLeft: 26 }} title={r.type}>
              <Code2 size={14} className="kind-icon routine" />
              <span className="label">{r.name}</span>
              <span className="faint" style={{ fontSize: 10.5 }}>
                {r.type === 'procedure' ? 'PROC' : 'FN'}
              </span>
            </div>
          ))}
        {!s.loading && s.tables.length === 0 && s.info.currentDatabase && (
          <div className="empty-note">No tables in this {s.info.supportsSchemas ? 'schema' : 'database'}.</div>
        )}
      </div>
    </>
  )
}

const TableNode = memo(function TableNode({ sid, t }: { sid: string; t: TableInfo }): JSX.Element {
  const openTableTab = useApp((st) => st.openTableTab)
  const openQueryTab = useApp((st) => st.openQueryTab)
  const refresh = useApp((st) => st.refreshSession)
  const showMenu = useApp((st) => st.showMenu)
  const toast = useApp((st) => st.toast)
  const dialect = useApp((st) => st.sessions[sid]?.info.dialect)
  const readOnly = useApp((st) => st.sessions[sid]?.info.config.readOnly)
  const [open, setOpen] = useState(false)
  const [cols, setCols] = useState<ColumnInfo[] | null>(null)

  useEffect(() => {
    if (open && !cols) {
      api
        .listColumns(sid, t)
        .then(setCols)
        .catch((e) => toast(e.message, 'error'))
    }
  }, [open, cols, sid, t, toast])

  const q = useCallback(
    (id: string) => (dialect === 'mysql' ? '`' + id + '`' : dialect === 'mssql' ? `[${id}]` : `"${id}"`),
    [dialect]
  )
  const fq = t.schema ? `${q(t.schema)}.${q(t.name)}` : q(t.name)

  const exportAs = async (format: ExportFormat): Promise<void> => {
    try {
      const p = await api.exportTable(sid, t, format, {})
      if (p) toast(`Exported to ${p}`, 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const menu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const sel = dialect === 'mssql' ? `SELECT TOP 100 * FROM ${fq};` : `SELECT * FROM ${fq} LIMIT 100;`
    showMenu(e.clientX, e.clientY, [
      { label: 'Open data', icon: <Table2 size={14} />, onClick: () => openTableTab(sid, t, 'data') },
      {
        label: 'Open in new tab',
        icon: <CopyPlus size={14} />,
        shortcut: 'Ctrl+Click',
        onClick: () => openTableTab(sid, t, 'data', true)
      },
      { label: 'View structure', icon: <Columns3 size={14} />, onClick: () => openTableTab(sid, t, 'structure') },
      { label: 'New query: SELECT', icon: <FileCode2 size={14} />, onClick: () => openQueryTab(sid, sel) },
      {
        label: 'Copy name',
        icon: <Clipboard size={14} />,
        onClick: () => navigator.clipboard.writeText(t.name)
      },
      {
        label: 'Copy DDL',
        icon: <Code2 size={14} />,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(await api.getDDL(sid, t, t.type))
            toast('DDL copied to clipboard', 'success')
          } catch (err) {
            toast((err as Error).message, 'error')
          }
        }
      },
      { separator: true },
      { label: 'Export as CSV', icon: <Download size={14} />, onClick: () => exportAs('csv') },
      { label: 'Export as JSON', icon: <Download size={14} />, onClick: () => exportAs('json') },
      { label: 'Export as SQL inserts', icon: <Download size={14} />, onClick: () => exportAs('sql') },
      { label: 'Export as Excel (.xlsx)', icon: <FileSpreadsheet size={14} color="#1d7044" />, onClick: () => exportAs('xlsx') },
      { separator: true },
      ...(t.type === 'table'
        ? [
            {
              label: 'Truncate table',
              icon: <Eraser size={14} />,
              danger: true,
              disabled: readOnly,
              onClick: async () => {
                if (!(await api.confirm(`Truncate ${t.name}?`, 'All rows will be permanently deleted.', 'Truncate'))) return
                try {
                  await api.truncate(sid, t)
                  toast(`Truncated ${t.name}`, 'success')
                } catch (err) {
                  toast((err as Error).message, 'error')
                }
              }
            }
          ]
        : []),
      {
        label: `Drop ${t.type}`,
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: readOnly,
        onClick: async () => {
          if (!(await api.confirm(`Drop ${t.type} ${t.name}?`, 'This cannot be undone.', 'Drop'))) return
          try {
            await api.drop(sid, t, t.type)
            toast(`Dropped ${t.name}`, 'success')
            refresh(sid)
          } catch (err) {
            toast((err as Error).message, 'error')
          }
        }
      }
    ])
  }

  return (
    <>
      <div
        className="tree-item"
        onClick={(e) => openTableTab(sid, t, 'data', e.ctrlKey || e.metaKey)}
        onMouseDown={(e) => {
          // middle-click opens another tab of this table
          if (e.button === 1) {
            e.preventDefault()
            openTableTab(sid, t, 'data', true)
          }
        }}
        onContextMenu={menu}
        title={t.schema ? `${t.schema}.${t.name}` : t.name}
      >
        <ChevronRight
          size={13}
          className={`chev${open ? ' open' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        />
        {t.type === 'view' ? <Eye size={14} className="kind-icon view" /> : <Table2 size={14} className="kind-icon table" />}
        <span className="label">{t.name}</span>
        <span className="hover-actions">
          <button
            className="icon-btn"
            style={{ width: 20, height: 20 }}
            title="Structure"
            onClick={(e) => {
              e.stopPropagation()
              openTableTab(sid, t, 'structure')
            }}
          >
            <Columns3 size={12} />
          </button>
        </span>
      </div>
      {open &&
        (cols ? (
          cols.map((c) => (
            <div key={c.name} className="tree-col" title={`${c.name} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`}>
              {c.primaryKey ? <KeyRound size={11} color="var(--accent)" /> : <span style={{ width: 11 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
              <span className="t">{c.dataType}</span>
            </div>
          ))
        ) : (
          <div className="tree-col faint">Loading…</div>
        ))}
    </>
  )
})

function SavedList({ sid }: { sid: string }): JSX.Element {
  const version = useApp((st) => st.savedVersion)
  const bump = useApp((st) => st.bumpSaved)
  const openQueryTab = useApp((st) => st.openQueryTab)
  const showMenu = useApp((st) => st.showMenu)
  const ask = useApp((st) => st.ask)
  const [items, setItems] = useState<SavedQuery[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    api.listSaved().then(setItems)
  }, [version])

  const shown = items.filter(
    (x) => !filter || x.title.toLowerCase().includes(filter.toLowerCase()) || x.sql.toLowerCase().includes(filter.toLowerCase())
  )

  return (
    <>
      <div style={{ padding: '8px 10px 6px' }}>
        <input className="q-input sm" placeholder="Filter saved queries" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="sidebar-body" style={{ paddingTop: 0 }}>
        {shown.length === 0 && (
          <div className="empty-note">
            No saved queries.
            <br />
            Press <span className="kbd">Ctrl+S</span> in a query tab to save it.
          </div>
        )}
        {shown.map((q) => (
          <div
            key={q.id}
            className="list-item"
            onClick={() => openQueryTab(sid, q.sql, q.title, q.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              showMenu(e.clientX, e.clientY, [
                { label: 'Open', icon: <FileCode2 size={14} />, onClick: () => openQueryTab(sid, q.sql, q.title, q.id) },
                {
                  label: 'Rename',
                  icon: <Pencil size={14} />,
                  onClick: async () => {
                    const title = await ask('Rename query', q.title, { okLabel: 'Rename' })
                    if (title) {
                      await api.saveQuery({ ...q, title })
                      bump()
                    }
                  }
                },
                { label: 'Copy SQL', icon: <Clipboard size={14} />, onClick: () => navigator.clipboard.writeText(q.sql) },
                { separator: true },
                {
                  label: 'Delete',
                  icon: <Trash2 size={14} />,
                  danger: true,
                  onClick: async () => {
                    await api.deleteSaved(q.id)
                    bump()
                  }
                }
              ])
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Star size={12} color="var(--accent)" /> {q.title}
            </div>
            <div className="sql">{q.sql}</div>
            <div className="meta">{new Date(q.updatedAt).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </>
  )
}

function HistoryList({ sid }: { sid: string }): JSX.Element {
  const version = useApp((st) => st.historyVersion)
  const bump = useApp((st) => st.bumpHistory)
  const openQueryTab = useApp((st) => st.openQueryTab)
  const [items, setItems] = useState<HistoryEntry[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    api.listHistory().then(setItems)
  }, [version])

  const shown = items.filter((x) => !filter || x.sql.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)

  return (
    <>
      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6 }}>
        <input className="q-input sm" placeholder="Search history" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button
          className="icon-btn"
          title="Clear history"
          onClick={async () => {
            if (await api.confirm('Clear all query history?', undefined, 'Clear')) {
              await api.clearHistory()
              bump()
            }
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="sidebar-body" style={{ paddingTop: 0 }}>
        {shown.length === 0 && <div className="empty-note">No queries run yet.</div>}
        {shown.map((h) => (
          <div key={h.id} className="list-item" onClick={() => openQueryTab(sid, h.sql)} title={h.error ?? 'Open in new tab'}>
            <div className="sql">{h.sql}</div>
            <div className="meta">
              <span className="color-dot" style={{ background: h.success ? 'var(--success)' : 'var(--danger)', width: 7, height: 7 }} />
              <span>{new Date(h.executedAt).toLocaleString()}</span>
              <span>{h.durationMs} ms</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.connectionName}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
