import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SortColumn } from 'react-data-grid'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  Code2,
  Columns3,
  CopyPlus,
  Download,
  Filter,
  KeyRound,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  Undo2,
  X,
  FileSpreadsheet
} from 'lucide-react'
import type {
  CellValue,
  ColumnInfo,
  ExportFormat,
  FilterCondition,
  ForeignKeyInfo,
  IndexInfo,
  RowChanges
} from '@shared/types'
import { filterNeedsValue, isActiveFilter } from '@shared/types'
import { api } from '../api'
import { useApp, type TableTabState } from '../store'
import { registerTabCommands } from '../commands'
import { DataTable, colKey, rowValues, toGridRows, type GridColumn, type GridRow } from './DataTable'
import { formatTsv } from '@shared/export'

const OPS = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL']

export function TableTab({ sid, tab }: { sid: string; tab: TableTabState }): JSX.Element {
  const updateTab = useApp((s) => s.updateTab)
  return (
    <div className="query-tab">
      <div className="q-toolbar" style={{ minHeight: 40 }}>
        <div className="seg">
          <button className={tab.view === 'data' ? 'active' : ''} onClick={() => updateTab(sid, tab.id, { view: 'data' })}>
            <Table2 size={13} /> Data
          </button>
          <button
            className={tab.view === 'structure' ? 'active' : ''}
            onClick={() => updateTab(sid, tab.id, { view: 'structure' })}
          >
            <Columns3 size={13} /> Structure
          </button>
        </div>
        <span className="muted mono" style={{ fontSize: 12, marginLeft: 6 }}>
          {tab.table.schema ? `${tab.table.schema}.` : ''}
          {tab.table.name}
        </span>
        {tab.tableType === 'view' && <span className="badge">view</span>}
      </div>
      <div className="tab-content" style={{ display: tab.view === 'data' ? 'flex' : 'none' }}>
        <TableData sid={sid} tab={tab} />
      </div>
      {tab.view === 'structure' && <TableStructure sid={sid} tab={tab} />}
    </div>
  )
}

interface DataState {
  columns: GridColumn[]
  rows: GridRow[]
  total: number | null
  loading: boolean
  error?: string
}

function TableData({ sid, tab }: { sid: string; tab: TableTabState }): JSX.Element {
  const pageSize = useApp((s) => s.settings.pageSize)
  const readOnly = useApp((s) => s.sessions[sid]?.info.config.readOnly)
  const dialect = useApp((s) => s.sessions[sid]?.info.dialect)
  const toast = useApp((s) => s.toast)
  const showMenu = useApp((s) => s.showMenu)

  const [meta, setMeta] = useState<ColumnInfo[]>([])
  const [data, setData] = useState<DataState>({ columns: [], rows: [], total: null, loading: true })
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<SortColumn[]>([])
  const [filters, setFilters] = useState<FilterCondition[]>([])
  const [rawWhere, setRawWhere] = useState('')
  const [filterMode, setFilterMode] = useState<'builder' | 'raw'>('builder')
  const [join, setJoin] = useState<'AND' | 'OR'>('AND')
  const [applied, setApplied] = useState<{ filters: FilterCondition[]; where: string; join: 'AND' | 'OR' }>({
    filters: [],
    where: '',
    join: 'AND'
  })
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const original = useRef(new Map<number, CellValue[]>())
  const filterBarRef = useRef<HTMLDivElement>(null)
  const updateTab = useApp((s) => s.updateTab)
  const idSeq = useRef(1_000_000)

  const editable = tab.tableType === 'table' && !readOnly
  const pkCols = useMemo(() => meta.filter((c) => c.primaryKey).map((c) => c.name), [meta])

  useEffect(() => {
    api
      .listColumns(sid, tab.table)
      .then(setMeta)
      .catch(() => setMeta([]))
  }, [sid, tab.table])

  const load = useCallback(async () => {
    setData((d) => ({ ...d, loading: true, error: undefined }))
    try {
      const sortCol = sort[0]
      const r = await api.select(sid, tab.table, {
        limit: pageSize,
        offset: page * pageSize,
        orderBy: sortCol
          ? [{ column: data.columns[Number(sortCol.columnKey.slice(1))]?.name ?? '', dir: sortCol.direction }].filter(
              (o) => o.column
            )
          : undefined,
        filters: applied.filters,
        filterJoin: applied.join,
        where: applied.where
      })
      const rows = toGridRows(r.rows)
      original.current = new Map(rows.map((row, i) => [row.__id, r.rows[i]]))
      setSelected(new Set())
      setData({ columns: r.columns, rows, total: r.totalCount, loading: false })
    } catch (e) {
      setData((d) => ({ ...d, loading: false, error: (e as Error).message }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, tab.table, page, pageSize, sort, applied])

  useEffect(() => {
    load()
  }, [load])

  const columns = useMemo<GridColumn[]>(() => {
    const byName = new Map(meta.map((m) => [m.name, m]))
    return data.columns.map((c) => ({ ...c, type: byName.get(c.name)?.dataType ?? c.type, pk: byName.get(c.name)?.primaryKey }))
  }, [data.columns, meta])

  // ---- pending change tracking ----
  const isEdited = useCallback((row: GridRow, key: string): boolean => {
    if (row.__state) return false
    const orig = original.current.get(row.__id)
    if (!orig) return false
    const idx = Number(key.slice(1))
    const a = orig[idx]
    const b = row[key] as CellValue
    if (a === b) return false
    if (a === null || b === null) return true
    return String(a) !== String(b)
  }, [])

  const pending = useMemo(() => {
    let updates = 0
    let inserts = 0
    let deletes = 0
    for (const r of data.rows) {
      if (r.__state === 'new') inserts++
      else if (r.__state === 'deleted') deletes++
      else if (data.columns.some((_, i) => isEdited(r, colKey(i)))) updates++
    }
    return { updates, inserts, deletes, total: updates + inserts + deletes }
  }, [data.rows, data.columns, isEdited])

  const confirmDiscard = async (): Promise<boolean> =>
    pending.total === 0 || api.confirm('Discard pending changes?', `${pending.total} unsaved change(s) will be lost.`, 'Discard')

  const guarded = (fn: () => void) => async () => {
    if (await confirmDiscard()) fn()
  }

  const setRows = (rows: GridRow[]): void => setData((d) => ({ ...d, rows }))

  const addRow = (): void => {
    const row: GridRow = { __id: idSeq.current++, __state: 'new' }
    columns.forEach((_, i) => (row[colKey(i)] = undefined))
    setRows([row, ...data.rows])
  }

  /** new rows are inserted at the top, so bring the grid back to the top to show them */
  const scrollGridTop = (): void => {
    setTimeout(() => {
      const grid = filterBarRef.current?.parentElement?.querySelector('.rdg')
      if (grid) grid.scrollTop = 0
    }, 30)
  }

  // Ctrl+D: add a new row
  const addRowShortcut = (): void => {
    if (tab.view !== 'data') updateTab(sid, tab.id, { view: 'data' })
    if (!editable) {
      toast(readOnly ? 'This connection is read-only' : 'Views cannot be edited', 'info')
      return
    }
    addRow()
    scrollGridTop()
  }

  // Ctrl+Shift+D: remove unsaved new rows one per press, starting from the bottom-most one on screen
  const removeLastNewRow = (): void => {
    let newest: GridRow | null = null
    for (let i = data.rows.length - 1; i >= 0; i--) {
      if (data.rows[i].__state === 'new') {
        newest = data.rows[i]
        break
      }
    }
    if (!newest) {
      toast('No unsaved new rows to remove', 'info')
      return
    }
    const id = newest.__id
    setRows(data.rows.filter((r) => r.__id !== id))
    setSelected((s) => {
      if (!s.has(id)) return s
      const next = new Set(s)
      next.delete(id)
      return next
    })
  }

  const cloneRow = (src: GridRow): void => {
    const row: GridRow = { __id: idSeq.current++, __state: 'new' }
    columns.forEach((c, i) => {
      const m = meta.find((x) => x.name === c.name)
      row[colKey(i)] = m?.autoIncrement ? undefined : src[colKey(i)]
    })
    const idx = data.rows.findIndex((r) => r.__id === src.__id)
    const rows = [...data.rows]
    rows.splice(idx + 1, 0, row)
    setRows(rows)
  }

  const deleteRows = (ids: Iterable<number>): void => {
    const set = new Set(ids)
    setRows(
      data.rows
        .filter((r) => !(set.has(r.__id) && r.__state === 'new'))
        .map((r) => (set.has(r.__id) ? { ...r, __state: 'deleted' as const } : r))
    )
    setSelected(new Set())
  }

  // Delete key: mark the ticked rows for deletion (pending until Apply / Ctrl+S).
  // If every ticked row is already marked, Delete unmarks them instead.
  const deleteSelectedShortcut = (): void => {
    if (tab.view !== 'data') return
    if (!editable) {
      toast(readOnly ? 'This connection is read-only' : 'Views cannot be edited', 'info')
      return
    }
    if (selected.size === 0) {
      toast('Tick the rows to delete first (checkbox, or Ctrl+A for all)', 'info')
      return
    }
    const picked = data.rows.filter((r) => selected.has(r.__id))
    if (picked.length > 0 && picked.every((r) => r.__state === 'deleted')) {
      setRows(
        data.rows.map((r) => {
          if (!selected.has(r.__id) || r.__state !== 'deleted') return r
          const fresh: GridRow = { __id: r.__id }
          original.current.get(r.__id)?.forEach((v, i) => (fresh[colKey(i)] = v))
          return fresh
        })
      )
      setSelected(new Set())
      toast(`Restored ${picked.length} row${picked.length === 1 ? '' : 's'}`, 'info')
      return
    }
    const n = picked.filter((r) => r.__state !== 'deleted').length
    deleteRows(selected)
    toast(`${n} row${n === 1 ? '' : 's'} marked for deletion — Ctrl+S to apply, Esc to undo`, 'info')
  }

  const restoreRow = (id: number): void => {
    const orig = original.current.get(id)
    setRows(
      data.rows.map((r) => {
        if (r.__id !== id || !orig) return r
        const fresh: GridRow = { __id: id }
        orig.forEach((v, i) => (fresh[colKey(i)] = v))
        return fresh
      })
    )
  }

  const discard = (): void => {
    setRows(
      data.rows
        .filter((r) => r.__state !== 'new')
        .map((r) => {
          const orig = original.current.get(r.__id)!
          const fresh: GridRow = { __id: r.__id }
          orig.forEach((v, i) => (fresh[colKey(i)] = v))
          return fresh
        })
    )
  }

  const apply = async (): Promise<void> => {
    const changes: RowChanges = { table: tab.table, primaryKeys: pkCols, updates: [], inserts: [], deletes: [] }
    const pkOf = (orig: CellValue[]): Record<string, CellValue> =>
      Object.fromEntries(pkCols.map((pk) => [pk, orig[columns.findIndex((c) => c.name === pk)]]))
    for (const r of data.rows) {
      if (r.__state === 'new') {
        const values: Record<string, CellValue> = {}
        columns.forEach((c, i) => {
          const v = r[colKey(i)]
          if (v !== undefined) values[c.name] = v as CellValue
        })
        changes.inserts.push(values)
        continue
      }
      const orig = original.current.get(r.__id)!
      if (r.__state === 'deleted') {
        changes.deletes.push(pkOf(orig))
        continue
      }
      const values: Record<string, CellValue> = {}
      columns.forEach((c, i) => {
        if (isEdited(r, colKey(i))) values[c.name] = r[colKey(i)] as CellValue
      })
      if (Object.keys(values).length) changes.updates.push({ pk: pkOf(orig), values })
    }
    if ((changes.updates.length || changes.deletes.length) && !pkCols.length) {
      return toast('This table has no primary key, so rows cannot be updated or deleted safely.', 'error')
    }
    setSaving(true)
    try {
      await api.applyChanges(sid, changes)
      toast(
        `Saved: ${changes.updates.length} updated, ${changes.inserts.length} inserted, ${changes.deletes.length} deleted`,
        'success'
      )
      await load()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  // Ctrl+F: jump to the filter (adds a first condition in builder mode if there is none)
  const focusFilter = (): void => {
    if (tab.view !== 'data') updateTab(sid, tab.id, { view: 'data' })
    const focusLater = (): void => {
      setTimeout(() => {
        const bar = filterBarRef.current
        const el =
          filterMode === 'raw'
            ? bar?.querySelector<HTMLInputElement>('input')
            : bar?.querySelector<HTMLInputElement>('.filter-row + .filter-row input:not(:disabled)') ??
              bar?.querySelector<HTMLSelectElement>('.filter-row + .filter-row select')
        el?.focus()
        if (el instanceof HTMLInputElement) el.select()
      }, 30)
    }
    if (filterMode === 'builder' && filters.length === 0) {
      setFilters([{ column: columns[0]?.name ?? '', op: '=', value: '' }])
    }
    focusLater()
  }

  const focusFilterRow = (index: number): void => {
    setTimeout(() => {
      const rows = filterBarRef.current?.querySelectorAll('.filter-row + .filter-row')
      const row = rows?.[Math.min(index, (rows?.length ?? 1) - 1)]
      const el = row?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? row?.querySelector<HTMLSelectElement>('select')
      el?.focus()
    }, 30)
  }

  /** index of the filter line that currently has focus, or -1 */
  const focusedFilterIndex = (): number => {
    const rows = [...(filterBarRef.current?.querySelectorAll('.filter-row + .filter-row') ?? [])]
    return rows.findIndex((r) => r.contains(document.activeElement))
  }

  // Ctrl+L: add a filter line (after the focused one, or at the end)
  const addFilterLine = (): void => {
    if (tab.view !== 'data') updateTab(sid, tab.id, { view: 'data' })
    if (filterMode !== 'builder') setFilterMode('builder')
    const at = focusedFilterIndex()
    const insertAt = at >= 0 ? at + 1 : filters.length
    const next = [...filters]
    next.splice(insertAt, 0, { column: columns[0]?.name ?? '', op: '=', value: '' })
    setFilters(next)
    focusFilterRow(insertAt)
  }

  // Ctrl+Shift+L: remove the focused filter line (or the last one)
  const removeFilterLine = (): void => {
    if (filterMode !== 'builder' || filters.length === 0) return
    const at = focusedFilterIndex()
    const removeAt = at >= 0 ? at : filters.length - 1
    setFilters(filters.filter((_, j) => j !== removeAt))
    if (filters.length > 1) focusFilterRow(Math.max(0, removeAt - 1))
  }

  const hasFilters = (): boolean =>
    filters.length > 0 || rawWhere.trim() !== '' || applied.filters.length > 0 || applied.where.trim() !== ''

  /** remove all filter lines / raw WHERE and show unfiltered data again */
  const clearFilters = (): void => {
    setFilters([])
    setRawWhere('')
    if (applied.filters.length || applied.where) {
      setPage(0)
      setApplied({ filters: [], where: '', join })
    }
  }

  /**
   * Esc, one layer per press: cursor in the filter bar → clear the filter (reverse of Ctrl+F);
   * unapplied edits → discard them; active filter → clear it; selected rows → deselect.
   * Returns false when there was nothing to undo, so the key falls through.
   */
  const escape = (): boolean => {
    if (tab.view !== 'data') return false
    const inFilterBar = !!filterBarRef.current?.contains(document.activeElement)
    if (inFilterBar) {
      ;(document.activeElement as HTMLElement | null)?.blur()
      if (hasFilters()) {
        // clearing an applied filter reloads the page, so protect unapplied edits
        if (pending.total > 0 && (applied.filters.length || applied.where)) guarded(clearFilters)()
        else clearFilters()
      }
      return true
    }
    if (pending.total > 0) {
      const n = pending.total
      discard()
      toast(`Discarded ${n} unsaved change${n === 1 ? '' : 's'}`, 'info')
      return true
    }
    if (hasFilters()) {
      clearFilters()
      return true
    }
    if (selected.size > 0) {
      setSelected(new Set())
      return true
    }
    return false
  }

  // Ctrl+A: select every row on this page (press again to clear the selection)
  const selectAllRows = (): void => {
    if (tab.view !== 'data') return
    const ids = data.rows.map((r) => r.__id)
    setSelected(selected.size === ids.length && ids.length > 0 ? new Set() : new Set(ids))
  }

  // Ctrl+C with rows selected: copy them as tab-separated text with a header row
  const copySelected = (): boolean => {
    if (tab.view !== 'data' || selected.size === 0) return false
    const rows = data.rows.filter((r) => selected.has(r.__id)).map((r) => rowValues(r, columns.length))
    navigator.clipboard.writeText(formatTsv(columns.map((c) => c.name), rows))
    toast(`${rows.length} row${rows.length === 1 ? '' : 's'} copied`, 'success')
    return true
  }

  // Ctrl+S applies pending changes, F5 / Ctrl+R refreshes (routed from the Workspace)
  const cmdRef = useRef({ apply, refresh: guarded(load), pending: pending.total, saving, focusFilter, selectAllRows, copySelected, addFilterLine, removeFilterLine, escape, addRowShortcut, removeLastNewRow, deleteSelectedShortcut })
  cmdRef.current = { apply, refresh: guarded(load), pending: pending.total, saving, focusFilter, selectAllRows, copySelected, addFilterLine, removeFilterLine, escape, addRowShortcut, removeLastNewRow, deleteSelectedShortcut }
  useEffect(
    () =>
      registerTabCommands(tab.id, {
        save: () => {
          const c = cmdRef.current
          if (c.saving) return
          if (c.pending > 0) c.apply()
          else toast('No pending changes to save', 'info')
        },
        refresh: () => cmdRef.current.refresh(),
        find: () => cmdRef.current.focusFilter(),
        selectAll: () => cmdRef.current.selectAllRows(),
        copySelection: () => cmdRef.current.copySelected(),
        escape: () => cmdRef.current.escape(),
        addRow: () => cmdRef.current.addRowShortcut(),
        removeNewRow: () => cmdRef.current.removeLastNewRow(),
        deleteRows: () => cmdRef.current.deleteSelectedShortcut(),
        addFilter: () => cmdRef.current.addFilterLine(),
        removeFilter: () => cmdRef.current.removeFilterLine()
      }),
    [tab.id, toast]
  )

  const applyFilters = (joinOverride?: 'AND' | 'OR'): void => {
    setPage(0)
    setApplied({
      filters: filterMode === 'builder' ? filters.filter(isActiveFilter) : [],
      where: filterMode === 'raw' ? rawWhere : '',
      join: joinOverride ?? join
    })
  }

  // switching AND/OR re-runs the filter right away when builder filters are active
  const changeJoin = async (j: 'AND' | 'OR'): Promise<void> => {
    if (j === join) return
    setJoin(j)
    if (applied.filters.length > 1 && filterMode === 'builder' && (await confirmDiscard())) applyFilters(j)
  }

  const exportMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const doExport = async (format: ExportFormat, all: boolean): Promise<void> => {
      try {
        const p = all
          ? await api.exportTable(sid, tab.table, format, {
              filters: applied.filters,
              filterJoin: applied.join,
              where: applied.where
            })
          : await api.exportRows({
              format,
              columns: columns.map((c) => c.name),
              rows: data.rows.filter((x) => !x.__state).map((x) => rowValues(x, columns.length)),
              name: tab.table.name,
              tableName: tab.table.name,
              dialect
            })
        if (p) toast(`Exported to ${p}`, 'success')
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    }
    showMenu(r.left, r.bottom + 4, [
      { label: 'All rows (with filters) → CSV', icon: <Download size={14} />, onClick: () => doExport('csv', true) },
      { label: 'All rows (with filters) → JSON', icon: <Download size={14} />, onClick: () => doExport('json', true) },
      { label: 'All rows (with filters) → SQL', icon: <Download size={14} />, onClick: () => doExport('sql', true) },
      { label: 'All rows (with filters) → Excel', icon: <FileSpreadsheet size={14} color="#1d7044" />, onClick: () => doExport('xlsx', true) },
      { separator: true },
      { label: 'Current page → CSV', icon: <Download size={14} />, onClick: () => doExport('csv', false) },
      { label: 'Current page → JSON', icon: <Download size={14} />, onClick: () => doExport('json', false) },
      { label: 'Current page → Markdown', icon: <Download size={14} />, onClick: () => doExport('markdown', false) },
      { label: 'Current page → Excel', icon: <FileSpreadsheet size={14} color="#1d7044" />, onClick: () => doExport('xlsx', false) }
    ])
  }

  const totalPages = data.total !== null ? Math.max(1, Math.ceil(data.total / pageSize)) : null
  const activeFilterCount = applied.filters.length + (applied.where ? 1 : 0)

  return (
    <>
      <div className="filter-bar" ref={filterBarRef}>
        <div className="filter-row">
          <div className="seg">
            <button className={filterMode === 'builder' ? 'active' : ''} onClick={() => setFilterMode('builder')}>
              <Filter size={12} /> Builder
            </button>
            <button className={filterMode === 'raw' ? 'active' : ''} onClick={() => setFilterMode('raw')}>
              <Code2 size={12} /> SQL
            </button>
          </div>
          {filterMode === 'raw' ? (
            <input
              className="q-input sm mono"
              placeholder="WHERE clause, e.g. id > 10 AND status = 'active'"
              value={rawWhere}
              onChange={(e) => setRawWhere(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && guarded(() => applyFilters())()}
            />
          ) : filters.length === 0 ? (
            <button className="btn sm ghost" onClick={() => setFilters([{ column: columns[0]?.name ?? '', op: '=', value: '' }])}>
              <Plus size={12} /> Add filter
            </button>
          ) : (
            <>
              <span className="faint" style={{ fontSize: 12 }}>
                Match
              </span>
              <div className="seg" title="How conditions are combined">
                <button className={join === 'AND' ? 'active' : ''} onClick={() => changeJoin('AND')}>
                  ALL (AND)
                </button>
                <button className={join === 'OR' ? 'active' : ''} onClick={() => changeJoin('OR')}>
                  ANY (OR)
                </button>
              </div>
              <span className="faint" style={{ fontSize: 12 }}>
                {filters.length} condition{filters.length > 1 ? 's' : ''}
              </span>
            </>
          )}
          <span className="spacer" />
          <button className="btn sm" onClick={guarded(() => applyFilters())}>
            Apply
          </button>
          <button
            className="btn sm ghost"
            title={activeFilterCount > 0 ? 'Clear filters (Esc)' : 'No filter applied'}
            disabled={activeFilterCount === 0}
            onClick={guarded(clearFilters)}
          >
            <X size={12} /> Clear
          </button>
        </div>
        {filterMode === 'builder' &&
          filters.map((f, i) => (
            <div className="filter-row" key={i}>
              <button
                className={`join-pill${i === 0 ? ' first' : ''}`}
                disabled={i === 0}
                title={i === 0 ? undefined : 'Click to switch between AND / OR'}
                onClick={() => changeJoin(join === 'AND' ? 'OR' : 'AND')}
              >
                {i === 0 ? 'WHERE' : join}
              </button>
              <select
                className="select sm"
                value={f.column}
                onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
              >
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                className="select sm"
                value={f.op}
                onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
              >
                {OPS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
              {/* operators like IS NULL take no value: keep the field in place (disabled) so the row doesn't reflow */}
              <input
                className="q-input sm mono"
                disabled={!filterNeedsValue(f.op)}
                title={filterNeedsValue(f.op) ? undefined : `${f.op} doesn't take a value`}
                placeholder={
                  !filterNeedsValue(f.op) ? 'no value needed' : f.op.includes('IN') ? 'comma,separated,values' : f.op.includes('LIKE') ? '%text%' : 'value'
                }
                value={filterNeedsValue(f.op) ? f.value : ''}
                onChange={(e) => setFilters(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                onKeyDown={(e) => e.key === 'Enter' && guarded(() => applyFilters())()}
              />
              <button className="icon-btn" title="Remove line (Ctrl+Shift+L)" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>
                <Minus size={13} />
              </button>
              {i === filters.length - 1 && (
                <button
                  className="icon-btn"
                  title="Add line (Ctrl+L)"
                  onClick={() => setFilters([...filters, { column: columns[0]?.name ?? '', op: '=', value: '' }])}
                >
                  <Plus size={13} />
                </button>
              )}
            </div>
          ))}
      </div>

      <div className="results-body">
        {data.loading && <div className="loading-bar" style={{ position: 'absolute', left: 0, right: 0, top: 0, zIndex: 3 }} />}
        {data.error ? (
          <div className="results-msg error">
            <div className="error-box">{data.error}</div>
          </div>
        ) : (
          <div className="grid-wrap">
            <DataTable
              columns={columns}
              rows={data.rows}
              editable={editable}
              onRowsChange={setRows}
              rowOffset={page * pageSize}
              sortColumns={sort}
              onSortColumnsChange={async (s) => {
                if (await confirmDiscard()) {
                  setSort(s.slice(-1))
                  setPage(0)
                }
              }}
              selectedRows={selected}
              onSelectedRowsChange={setSelected}
              isEdited={isEdited}
              extraMenu={
                editable
                  ? (row, key) => [
                      ...(key.startsWith('c')
                        ? [
                            {
                              label: 'Set NULL',
                              icon: <X size={14} />,
                              disabled: row.__state === 'deleted',
                              onClick: () => setRows(data.rows.map((r) => (r.__id === row.__id ? { ...r, [key]: null } : r)))
                            }
                          ]
                        : []),
                      { label: 'Clone row', icon: <CopyPlus size={14} />, onClick: () => cloneRow(row) },
                      row.__state === 'deleted' || (!row.__state && columns.some((_, i) => isEdited(row, colKey(i))))
                        ? { label: 'Revert row', icon: <Undo2 size={14} />, onClick: () => restoreRow(row.__id) }
                        : {
                            label: selected.has(row.__id) && selected.size > 1 ? `Delete ${selected.size} rows` : 'Delete row',
                            icon: <Trash2 size={14} />,
                            danger: true,
                            onClick: () => deleteRows(selected.has(row.__id) ? selected : [row.__id])
                          }
                    ]
                  : undefined
              }
            />
          </div>
        )}
      </div>

      <div className="grid-footer">
        <button className="icon-btn" title="Refresh (discard)" onClick={guarded(load)}>
          <RefreshCw size={14} className={data.loading ? 'spin' : ''} />
        </button>
        {editable && (
          <>
            <button className="btn sm" onClick={addRow} title="Add row (Ctrl+D) · Ctrl+Shift+D removes new rows from the bottom up">
              <Plus size={12} /> Row
            </button>
            <button className="btn sm" disabled={selected.size === 0} onClick={() => deleteRows(selected)} title="Delete key">
              <Trash2 size={12} /> Delete{selected.size ? ` (${selected.size})` : ''}
            </button>
          </>
        )}
        <button className="btn sm" onClick={exportMenu}>
          <Download size={12} /> Export
        </button>
        {pending.total > 0 && (
          <>
            <span className="pending-pill">
              {pending.updates > 0 && `${pending.updates} edited`}
              {pending.inserts > 0 && ` ${pending.inserts} new`}
              {pending.deletes > 0 && ` ${pending.deletes} deleted`}
            </span>
            <button className="btn sm ghost" onClick={discard} disabled={saving} title="Esc">
              <Undo2 size={12} /> Discard
            </button>
            <button className="btn sm primary" onClick={apply} disabled={saving} title="Ctrl+S">
              {saving ? <Loader2 size={12} className="spin" /> : <Save size={12} />} Apply changes
            </button>
          </>
        )}
        <span className="spacer" />
        <span>
          {data.total !== null
            ? `${data.total === 0 ? 0 : (page * pageSize + 1).toLocaleString()}–${Math.min(
                (page + 1) * pageSize,
                data.total
              ).toLocaleString()} of ${data.total.toLocaleString()}`
            : `${data.rows.length} rows`}
        </span>
        <button className="icon-btn" disabled={page === 0} onClick={guarded(() => setPage(0))}>
          <ChevronsLeft size={14} />
        </button>
        <button className="icon-btn" disabled={page === 0} onClick={guarded(() => setPage(page - 1))}>
          <ChevronLeft size={14} />
        </button>
        <span style={{ minWidth: 70, textAlign: 'center' }}>
          Page {page + 1}
          {totalPages ? ` / ${totalPages}` : ''}
        </span>
        <button
          className="icon-btn"
          disabled={totalPages !== null ? page + 1 >= totalPages : data.rows.length < pageSize}
          onClick={guarded(() => setPage(page + 1))}
        >
          <ChevronRight size={14} />
        </button>
        <button
          className="icon-btn"
          disabled={totalPages === null || page + 1 >= totalPages}
          onClick={guarded(() => totalPages && setPage(totalPages - 1))}
        >
          <ChevronsRight size={14} />
        </button>
      </div>
    </>
  )
}

function TableStructure({ sid, tab }: { sid: string; tab: TableTabState }): JSX.Element {
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
