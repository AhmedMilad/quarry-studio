import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { format as formatSql } from 'sql-formatter'
import {
  AlignLeft,
  CheckCircle2,
  ClipboardCopy,
  Download,
  Loader2,
  Play,
  PlayCircle,
  Save,
  Square,
  TriangleAlert,
  FileSpreadsheet
} from 'lucide-react'
import type { DestructiveCheck, Dialect, ExportFormat, QueryResult, TextExportFormat } from '@shared/types'
import { splitStatements, statementAt, useDatabaseTarget } from '@shared/sql'
import { analyzeDestructive } from '@shared/destructive'
import { DestructiveConfirm } from './DestructiveConfirm'
import { formatRows, selectSourceTable } from '@shared/export'
import { api } from '../api'
import { monaco } from '../monaco'
import { useApp, type QueryTabState } from '../store'
import { registerTabCommands } from '../commands'
import { DataTable, toGridRows, type GridColumn } from './DataTable'

const FORMAT_LANG: Record<Dialect, 'mysql' | 'postgresql' | 'transactsql' | 'sqlite'> = {
  mysql: 'mysql',
  postgres: 'postgresql',
  mssql: 'transactsql',
  sqlite: 'sqlite'
}

interface RunState {
  running: boolean
  queryId?: string
  results: QueryResult[]
  error?: string
  active: number
  startedAt?: number
  executedSql?: string
}

export function QueryTab({ sid, tab, active }: { sid: string; tab: QueryTabState; active: boolean }): JSX.Element {
  const dialect = useApp((s) => s.sessions[sid]?.info.dialect) as Dialect
  const fontSize = useApp((s) => s.settings.editorFontSize)
  const theme = useApp((s) => s.settings.theme)
  const updateTab = useApp((s) => s.updateTab)
  const toast = useApp((s) => s.toast)
  const ask = useApp((s) => s.ask)
  const bumpHistory = useApp((s) => s.bumpHistory)
  const bumpSaved = useApp((s) => s.bumpSaved)
  const showMenu = useApp((s) => s.showMenu)

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [editorHeight, setEditorHeight] = useState(0.42)
  const [state, setState] = useState<RunState>({ running: false, results: [], active: 0 })
  const [elapsed, setElapsed] = useState(0)
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const [confirm, setConfirm] = useState<{
    checks: DestructiveCheck[] | null
    error?: string
    sql: string
    resolve: (ok: boolean) => void
  } | null>(null)

  /** DELETE / TRUNCATE / DROP: show what would be affected and ask before running */
  const confirmDestructive = useCallback(
    (sql: string): Promise<boolean> =>
      new Promise((resolve) => {
        setConfirm({ checks: null, sql, resolve })
        api
          .checkDestructive(sid, sql)
          .then((checks) => setConfirm((c) => (c ? { ...c, checks } : c)))
          .catch((e) => setConfirm((c) => (c ? { ...c, checks: [], error: (e as Error).message } : c)))
      }),
    [sid]
  )
  const closeConfirm = (ok: boolean): void => {
    confirm?.resolve(ok)
    setConfirm(null)
    setTimeout(() => editorRef.current?.focus(), 30)
  }

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    if (!state.running) return
    const t = setInterval(() => setElapsed(Date.now() - (state.startedAt ?? Date.now())), 100)
    return () => clearInterval(t)
  }, [state.running, state.startedAt])

  useEffect(() => {
    if (active) setTimeout(() => editorRef.current?.focus(), 30)
  }, [active])

  const run = useCallback(
    async (mode: 'current' | 'all') => {
      const ed = editorRef.current
      if (!ed || state.running) return
      const model = ed.getModel()!
      const sel = ed.getSelection()
      let sql = ''
      let range: monaco.Range | null = null
      if (sel && !sel.isEmpty()) {
        sql = model.getValueInRange(sel)
      } else if (mode === 'all') {
        sql = model.getValue()
      } else {
        const text = model.getValue()
        const offset = model.getOffsetAt(ed.getPosition()!)
        const stmt = statementAt(text, offset)
        if (stmt) {
          sql = stmt.text
          const s = model.getPositionAt(stmt.start)
          const e = model.getPositionAt(stmt.end)
          range = new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column)
        }
      }
      if (!sql.trim()) return
      if (range) {
        decorations.current?.clear()
        decorations.current = ed.createDecorationsCollection([
          { range, options: { className: 'run-highlight', isWholeLine: false } }
        ])
        setTimeout(() => decorations.current?.clear(), 700)
      }
      const session = useApp.getState().sessions[sid]
      if (!session?.info.config.readOnly && analyzeDestructive(sql, dialect).length > 0) {
        if (!(await confirmDestructive(sql))) {
          toast('Query cancelled', 'info')
          return
        }
      }
      const queryId = `${tab.id}-${Date.now()}`
      setElapsed(0)
      setState((s) => ({ ...s, running: true, queryId, error: undefined, startedAt: Date.now(), executedSql: sql }))
      try {
        const results = await api.query(sid, sql, queryId)
        // prefer the last result set that returned rows
        let activeIdx = results.length - 1
        for (let i = results.length - 1; i >= 0; i--) {
          if (results[i].columns.length) {
            activeIdx = i
            break
          }
        }
        setState((s) => ({ ...s, running: false, results, active: Math.max(0, activeIdx), error: undefined }))
        // `USE other_db` only switched the one connection that ran it: switch the whole session instead, so the
        // database selector, the table list and every later query follow (and the pool starts clean)
        const app = useApp.getState()
        const useDb = useDatabaseTarget(sql, dialect)
        if (useDb && useDb !== app.sessions[sid]?.info.currentDatabase) {
          await app.useDatabase(sid, useDb)
          if (useApp.getState().sessions[sid]?.info.currentDatabase === useDb) toast(`Switched to database ${useDb}`, 'success')
        } else if (results.some((r) => r.command && !r.columns.length)) app.refreshSession(sid)
      } catch (e) {
        setState((s) => ({ ...s, running: false, results: [], error: (e as Error).message }))
      } finally {
        bumpHistory()
      }
    },
    [sid, tab.id, state.running, bumpHistory, dialect, confirmDestructive, toast]
  )

  const cancel = async (): Promise<void> => {
    if (!state.queryId) return
    try {
      await api.cancel(sid, state.queryId)
      toast('Cancel requested', 'info')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const formatQuery = useCallback(() => {
    const ed = editorRef.current
    if (!ed) return
    try {
      const formatted = formatSql(ed.getValue(), { language: FORMAT_LANG[dialect], keywordCase: 'upper', tabWidth: 2 })
      ed.executeEdits('format', [{ range: ed.getModel()!.getFullModelRange(), text: formatted }])
      ed.pushUndoStop()
    } catch (e) {
      toast('Could not format: ' + (e as Error).message, 'error')
    }
  }, [dialect, toast])

  const save = useCallback(async () => {
    const sql = editorRef.current?.getValue() ?? ''
    if (!sql.trim()) return toast('Nothing to save', 'info')
    let title = tab.title
    if (!tab.savedId) {
      const t = await ask('Save query', tab.title.startsWith('Query #') ? '' : tab.title, { label: 'Name', okLabel: 'Save' })
      if (!t) return
      title = t
    }
    const saved = await api.saveQuery({ id: tab.savedId, title, sql })
    updateTab(sid, tab.id, { savedId: saved.id, title: saved.title })
    bumpSaved()
    toast(`Saved "${saved.title}"`, 'success')
  }, [sid, tab, ask, updateTab, bumpSaved, toast])

  // keep latest callbacks for monaco actions registered once
  const handlers = useRef({ run, formatQuery, save })
  handlers.current = { run, formatQuery, save }

  // global shortcuts (work wherever focus is) are routed here by the Workspace
  useEffect(
    () =>
      registerTabCommands(tab.id, {
        save: () => handlers.current.save(),
        run: () => handlers.current.run('current'),
        runAll: () => handlers.current.run('all'),
        format: () => handlers.current.formatQuery()
      }),
    [tab.id]
  )

  const onMount: OnMount = (ed) => {
    editorRef.current = ed
    ed.addAction({
      id: 'run-current',
      label: 'Run current statement / selection',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => handlers.current.run('current')
    })
    ed.addAction({
      id: 'run-all',
      label: 'Run all',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => handlers.current.run('all')
    })
    ed.addAction({
      id: 'format-sql',
      label: 'Format SQL',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI
      ],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: () => handlers.current.formatQuery()
    })
    ed.addAction({
      id: 'save-query',
      label: 'Save query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => handlers.current.save()
    })
    ed.focus()
  }

  // ---- split resize ----
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const box = containerRef.current!.getBoundingClientRect()
    const el = e.currentTarget as HTMLElement
    el.classList.add('dragging')
    const move = (ev: MouseEvent): void => {
      setEditorHeight(Math.max(0.1, Math.min(0.9, (ev.clientY - box.top) / box.height)))
    }
    const up = (): void => {
      el.classList.remove('dragging')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const current = state.results[state.active]
  const gridColumns = useMemo<GridColumn[]>(() => current?.columns ?? [], [current])
  const gridRows = useMemo(() => (current ? toGridRows(current.rows) : []), [current])
  // "Copy as INSERT" targets the source table of a plain single-table SELECT, otherwise a placeholder name
  const insertTarget = useMemo(() => {
    if (!dialect) return undefined
    const stmts = state.executedSql ? splitStatements(state.executedSql) : []
    const sql = stmts.length === state.results.length ? stmts[state.active]?.text : stmts.length === 1 ? stmts[0].text : undefined
    return { table: (sql && selectSourceTable(sql)) || 'table_name', dialect }
  }, [dialect, state.executedSql, state.results.length, state.active])

  const exportMenu = (e: React.MouseEvent): void => {
    if (!current) return
    const cols = current.columns.map((c) => c.name)
    const doExport = async (format: ExportFormat): Promise<void> => {
      const p = await api.exportRows({ format, columns: cols, rows: current.rows, name: 'query-result', dialect })
      if (p) toast(`Exported to ${p}`, 'success')
    }
    const copyAs = (format: TextExportFormat): void => {
      navigator.clipboard.writeText(formatRows(format, cols, current.rows, { dialect }))
      toast(`${current.rows.length} rows copied as ${format.toUpperCase()}`, 'success')
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu(r.left, r.bottom + 4, [
      { label: 'Export Excel (.xlsx)…', icon: <FileSpreadsheet size={14} color="#1d7044" />, onClick: () => doExport('xlsx') },
      { label: 'Export CSV…', icon: <Download size={14} />, onClick: () => doExport('csv') },
      { label: 'Export JSON…', icon: <Download size={14} />, onClick: () => doExport('json') },
      { label: 'Export SQL inserts…', icon: <Download size={14} />, onClick: () => doExport('sql') },
      { label: 'Export Markdown…', icon: <Download size={14} />, onClick: () => doExport('markdown') },
      { separator: true },
      { label: 'Copy as CSV', icon: <ClipboardCopy size={14} />, onClick: () => copyAs('csv') },
      { label: 'Copy as JSON', icon: <ClipboardCopy size={14} />, onClick: () => copyAs('json') },
      { label: 'Copy as Markdown', icon: <ClipboardCopy size={14} />, onClick: () => copyAs('markdown') }
    ])
  }

  return (
    <div className="query-tab" ref={containerRef}>
      <div className="q-toolbar">
        <button className="btn primary" onClick={() => run('current')} disabled={state.running} title="Ctrl+Enter">
          <Play size={13} /> Run
        </button>
        <button className="btn" onClick={() => run('all')} disabled={state.running} title="Ctrl+Shift+Enter">
          <PlayCircle size={13} /> Run all
        </button>
        {state.running && (
          <button className="btn danger" onClick={cancel}>
            <Square size={12} /> Cancel
          </button>
        )}
        <span className="sep" />
        <button className="btn ghost" onClick={formatQuery} title="Format SQL (Ctrl+Shift+I or Ctrl+Shift+F)">
          <AlignLeft size={13} /> Format
        </button>
        <button className="btn ghost" onClick={save} title="Ctrl+S">
          <Save size={13} /> {tab.savedId ? 'Save' : 'Save as…'}
        </button>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11.5 }}>
          <span className="kbd">Ctrl+Enter</span> run statement · <span className="kbd">Ctrl+Shift+Enter</span> run all
        </span>
      </div>
      <div className="editor-wrap" style={{ height: `${editorHeight * 100}%` }}>
        <Editor
          defaultLanguage="sql"
          defaultValue={tab.initialSql}
          path={`${sid}/${tab.id}.sql`}
          theme={isDark ? 'quarry-dark' : 'quarry-light'}
          onMount={onMount}
          options={{
            fontSize,
            fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            renderLineHighlight: 'all',
            suggest: { showWords: false },
            quickSuggestions: { other: true, comments: false, strings: false },
            padding: { top: 8 },
            fixedOverflowWidgets: true
          }}
        />
      </div>
      <div className="hresizer" onMouseDown={startDrag} />
      <div className="results">
        <div className="results-head">
          <div className="result-tabs">
            {state.results.length > 1 &&
              state.results.map((r, i) => (
                <button key={i} className={i === state.active ? 'active' : ''} onClick={() => setState((s) => ({ ...s, active: i }))}>
                  Result {i + 1}
                  {r.columns.length ? ` · ${r.rowCount}` : ''}
                </button>
              ))}
            {state.results.length <= 1 && <span className="muted" style={{ fontWeight: 600, fontSize: 12 }}>Results</span>}
          </div>
          <span className="spacer" />
          {state.running && (
            <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <Loader2 size={13} className="spin" /> Running… {(elapsed / 1000).toFixed(1)}s
            </span>
          )}
          {!state.running && current && (
            <span className="muted" style={{ fontSize: 12 }}>
              {current.columns.length
                ? `${current.rowCount.toLocaleString()} row${current.rowCount === 1 ? '' : 's'}${current.truncated ? ` (showing first ${current.rows.length.toLocaleString()})` : ''}`
                : `${current.affectedRows ?? 0} affected`}{' '}
              · {current.durationMs} ms
            </span>
          )}
          {current && current.columns.length > 0 && (
            <button className="btn sm" onClick={exportMenu}>
              <Download size={12} /> Export
            </button>
          )}
        </div>
        <div className="results-body">
          {state.error ? (
            <div className="results-msg error">
              <div className="error-box">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>
                  <TriangleAlert size={14} /> Query failed
                </div>
                {state.error}
              </div>
            </div>
          ) : current ? (
            current.columns.length ? (
              <div className="grid-wrap">
                <DataTable columns={gridColumns} rows={gridRows} insertTarget={insertTarget} />
              </div>
            ) : (
              <div className="results-msg">
                <div className="success-box">
                  <CheckCircle2 size={18} /> Query executed successfully
                </div>
                <div>
                  {current.affectedRows ?? 0} row{current.affectedRows === 1 ? '' : 's'} affected
                  {state.results.length > 1 ? ` · ${state.results.length} statements` : ''} · {current.durationMs} ms
                </div>
              </div>
            )
          ) : (
            <div className="results-msg">
              {state.running ? (
                <Loader2 size={22} className="spin" />
              ) : (
                <>
                  <div>Run a query to see results here</div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    <span className="kbd">Ctrl+Enter</span> runs the statement under the cursor or the selection
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <DestructiveConfirm
          checks={confirm.checks}
          error={confirm.error}
          connectionName={useApp.getState().sessions[sid]?.info.config.name ?? ''}
          connectionColor={useApp.getState().sessions[sid]?.info.config.color ?? '#999'}
          database={useApp.getState().sessions[sid]?.info.currentDatabase ?? ''}
          sqlHint={confirm.sql}
          onCancel={() => closeConfirm(false)}
          onConfirm={() => closeConfirm(true)}
        />
      )}
    </div>
  )
}
