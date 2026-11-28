import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import DataGrid, { SelectColumn, type Column, type DataGridHandle, type SortColumn } from 'react-data-grid'
import 'react-data-grid/lib/styles.css'
import { ArrowDown, ArrowUp, Braces, FileCode2, Link2, ClipboardPaste, Clipboard, Copy, Eraser, Eye, KeyRound, PenLine } from 'lucide-react'
import type { CellValue, Dialect, ResultColumn } from '@shared/types'
import { formatTsv, insertStatements } from '@shared/export'
import { useApp, type MenuItem } from '../store'
import { isTypingTarget } from '../commands'
import { Modal } from './Overlays'
import { CellEditor } from './CellEditor'

export interface GridRow {
  __id: number
  __state?: 'new' | 'deleted'
  [key: string]: unknown
}

export interface GridColumn extends ResultColumn {
  pk?: boolean
  /** false for NOT NULL columns (undefined = unknown, treated as nullable) */
  nullable?: boolean
  /** foreign key: the value is rendered as a link that opens the referenced row */
  fk?: { target: string; open: (row: GridRow) => void }
}

export const colKey = (i: number): string => `c${i}`

export function toGridRows(rows: CellValue[][], startId = 0): GridRow[] {
  return rows.map((r, i) => {
    const o: GridRow = { __id: startId + i }
    for (let j = 0; j < r.length; j++) o[colKey(j)] = r[j]
    return o
  })
}

export function rowValues(row: GridRow, ncols: number): CellValue[] {
  const out: CellValue[] = []
  for (let j = 0; j < ncols; j++) out.push((row[colKey(j)] ?? null) as CellValue)
  return out
}

function renderValue(v: unknown): JSX.Element | string {
  if (v === undefined) return <span className="cell-null">DEFAULT</span>
  if (v === null) return <span className="cell-null">NULL</span>
  if (typeof v === 'boolean') return <span className="cell-bool">{v ? 'true' : 'false'}</span>
  if (typeof v === 'number') return <span className="cell-num">{String(v)}</span>
  const s = String(v)
  return s.length > 500 ? s.slice(0, 500) + '…' : s
}

function estimateWidth(c: GridColumn, rows: GridRow[], key: string): number {
  let max = c.name.length + (c.type ? c.type.length * 0.7 : 0) + (c.pk ? 3 : 0) + (c.fk ? 3 : 0)
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const v = rows[i][key]
    const len = v === null || v === undefined ? 4 : String(v).length
    if (len > max) max = len
  }
  return Math.max(80, Math.min(380, Math.round(max * 7.6 + 30)))
}

interface Props {
  columns: GridColumn[]
  rows: GridRow[]
  editable?: boolean
  onRowsChange?: (rows: GridRow[]) => void
  rowOffset?: number
  sortColumns?: SortColumn[]
  onSortColumnsChange?: (s: SortColumn[]) => void
  selectedRows?: ReadonlySet<number>
  onSelectedRowsChange?: (s: Set<number>) => void
  isEdited?: (row: GridRow, key: string) => boolean
  extraMenu?: (row: GridRow, key: string) => MenuItem[]
  /** select (and focus) the first data cell once rows first arrive, so the keyboard works straight away */
  autoSelectFirstCell?: boolean
  /** whether this grid's tab is the visible one; on becoming visible it takes keyboard focus back */
  active?: boolean
  /** enables "Copy as INSERT": the (quoted, qualified) table name to insert into, and the SQL dialect */
  insertTarget?: { table: string; dialect: Dialect }
}

export function DataTable(props: Props): JSX.Element {
  const { columns, rows, editable, rowOffset = 0 } = props
  const theme = useApp((s) => s.settings.theme)
  const showMenu = useApp((s) => s.showMenu)
  const toast = useApp((s) => s.toast)
  const [viewer, setViewer] = useState<{ name: string; value: unknown } | null>(null)
  const ask = useApp((s) => s.ask)

  // ---------- cell range selection (drag, Shift+click, Shift+arrows) ----------
  const [range, setRange] = useState<CellRange | null>(null)
  const shiftRef = useRef(false)
  const dragRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const lead = (props.onSelectedRowsChange ? 1 : 0) + 1 // checkbox column + row-number column
  const ncols = columns.length
  const b = range ? bounds(range) : null
  const rangeSize = b ? (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1) : 0
  const multi = rangeSize > 1

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.__id, i])), [rows])

  // first load: put the cursor on the first data cell (once per grid), before the first paint. Opening a table is deliberate, so this
  // takes focus even from the sidebar search; only a dialog/palette or this tab's own filter bar keep it.
  const gridRef = useRef<DataGridHandle>(null)
  const autoSelected = useRef(false)
  const pointerAt = useRef(0)
  const activeRef = useRef(props.active)
  const rowsLenRef = useRef(rows.length)
  rowsLenRef.current = rows.length
  activeRef.current = props.active
  useLayoutEffect(() => {
    if (!props.autoSelectFirstCell || autoSelected.current || !rows.length || !columns.length) return
    const el = gridRef.current?.element
    if (!el || el.offsetParent === null) return // tab not visible
    const active = document.activeElement
    if (active?.closest('.modal-backdrop, .palette')) return
    if (active && active !== document.body && el.closest('.tab-content')?.contains(active) && !el.contains(active)) return
    autoSelected.current = true
    gridRef.current?.selectCell({ rowIdx: 0, idx: lead })
  }, [props.autoSelectFirstCell, rows.length, columns.length, lead, props.active])

  // tab became visible again (switched to, or the tab in front was closed): give the keyboard back to
  // the selected cell, so arrows keep working without a mouse click. Only when focus isn't somewhere else.
  useEffect(() => {
    if (!props.active) return
    const id = window.setTimeout(() => {
      const el = gridRef.current?.element
      if (!el || el.offsetParent === null || !rows.length) return
      const a = document.activeElement
      const lost = !a || a === document.body || (a as HTMLElement).offsetParent === null
      if (!lost) return
      const cell = el.querySelector<HTMLElement>('[role=gridcell][aria-selected=true]')
      if (cell) cell.focus({ preventScroll: true })
      else if (props.autoSelectFirstCell) gridRef.current?.selectCell({ rowIdx: 0, idx: lead })
    }, 0)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active])

  // a new result set / page / column layout invalidates the range
  useEffect(() => setRange(null), [columns, rowOffset])
  useEffect(() => {
    setRange((r) => (r && (r.a.r >= rows.length || r.f.r >= rows.length) ? null : r))
  }, [rows.length])

  const cellFromEvent = (e: { target: EventTarget | null }): Pos | null => {
    const cell = (e.target as Element | null)?.closest?.('[role=gridcell]')
    const row = cell?.closest('[role=row]')
    if (!cell || !row) return null
    const c = Number(cell.getAttribute('aria-colindex')) - 1 - lead
    const r = Number(row.getAttribute('aria-rowindex')) - 2
    if (c < 0 || c >= ncols || r < 0 || r >= rows.length) return null
    return { r, c }
  }

  useEffect(() => {
    const up = (): void => {
      dragRef.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // Esc (routed from the Workspace) clears a multi-cell range
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const clear = (): void => setRange((r) => (r ? { a: r.f, f: r.f } : r))
    el.addEventListener('quarry-clear-range', clear)
    return () => el.removeEventListener('quarry-clear-range', clear)
  }, [])

  // 'quarry-focus-grid' (sent by the table tab when focus leaves the filter bar): keyboard back to the grid,
  // on the selected cell, or the first data cell if none is selected yet
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const focusGrid = (): void => {
      const cell = gridRef.current?.element?.querySelector<HTMLElement>('[role=gridcell][aria-selected=true]')
      if (cell) cell.focus({ preventScroll: true })
      else if (rowsLenRef.current) gridRef.current?.selectCell({ rowIdx: 0, idx: lead })
    }
    el.addEventListener('quarry-focus-grid', focusGrid)
    return () => el.removeEventListener('quarry-focus-grid', focusGrid)
  }, [lead])

  const rangeCells = useCallback((): { r: number; c: number }[] => {
    if (!b) return []
    const out: { r: number; c: number }[] = []
    for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) out.push({ r, c })
    return out
  }, [b])

  const rangeValues = (): CellValue[][] => {
    if (!b) return []
    const out: CellValue[][] = []
    for (let r = b.r1; r <= b.r2; r++) {
      const line: CellValue[] = []
      for (let c = b.c1; c <= b.c2; c++) line.push((rows[r]?.[colKey(c)] ?? null) as CellValue)
      out.push(line)
    }
    return out
  }

  const copyRange = (): void => {
    navigator.clipboard.writeText(formatTsv(null, rangeValues()))
    toast(`${rangeSize} cells copied`, 'success')
  }

  /** set every cell of the range to one value (editable grids only) */
  const fillRange = (value: CellValue): void => {
    if (!b || !props.onRowsChange) return
    // NULL never goes into a NOT NULL column
    const cols: number[] = []
    for (let c = b.c1; c <= b.c2; c++) if (value !== null || columns[c]?.nullable !== false) cols.push(c)
    const skipped = b.c2 - b.c1 + 1 - cols.length
    if (skipped) {
      const names = columns.slice(b.c1, b.c2 + 1).filter((c) => c.nullable === false).map((c) => c.name)
      toast(`${names.join(', ')} ${names.length === 1 ? "doesn't" : "don't"} allow NULL`, cols.length ? 'info' : 'error')
    }
    if (!cols.length) return
    const next = rows.slice()
    for (let r = b.r1; r <= b.r2; r++) {
      if (next[r].__state === 'deleted') continue
      const row = { ...next[r] }
      for (const c of cols) row[colKey(c)] = value
      next[r] = row
    }
    props.onRowsChange(next)
  }

  /** paste clipboard TSV at the range's top-left; a single value fills the whole range */
  const pasteClipboard = async (): Promise<void> => {
    if (!props.onRowsChange) return
    const start = b ? { r: b.r1, c: b.c1 } : null
    if (!start) return
    const text = (await navigator.clipboard.readText()).replace(/\r\n?/g, '\n').replace(/\n$/, '')
    if (!text) return
    const grid = text.split('\n').map((l) => l.split('\t'))
    const conv = (v: string): CellValue => (v === 'NULL' ? null : v)
    if (grid.length === 1 && grid[0].length === 1 && multi) {
      fillRange(conv(grid[0][0]))
      toast(`Pasted into ${rangeSize} cells`, 'success')
      return
    }
    const next = rows.slice()
    let count = 0
    let lastR = start.r
    let lastC = start.c
    grid.forEach((line, i) => {
      const r = start.r + i
      if (r >= next.length || next[r].__state === 'deleted') return
      const row = { ...next[r] }
      line.forEach((v, j) => {
        const c = start.c + j
        if (c >= ncols) return
        row[colKey(c)] = conv(v)
        count++
        lastR = Math.max(lastR, r)
        lastC = Math.max(lastC, c)
      })
      next[r] = row
    })
    if (!count) return
    props.onRowsChange(next)
    setRange({ a: start, f: { r: lastR, c: lastC } })
    toast(`Pasted into ${count} cell${count === 1 ? '' : 's'}`, 'success')
  }

  const onKeyDownCapture = (e: React.KeyboardEvent): void => {
    shiftRef.current = e.shiftKey
    if (isTypingTarget(e.target as Element)) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.code === 'KeyC' && multi) {
      e.preventDefault()
      e.stopPropagation()
      copyRange()
    } else if (mod && e.code === 'KeyV' && editable && props.onRowsChange) {
      e.preventDefault()
      e.stopPropagation()
      pasteClipboard().catch((err) => toast((err as Error).message, 'error'))
    } else if (e.code === 'Delete' && e.shiftKey && !mod && !e.altKey && editable && props.onRowsChange && b) {
      // Shift+Delete: set the selected cell / range to NULL (plain Delete marks rows for deletion)
      e.preventDefault()
      e.stopPropagation()
      fillRange(null)
    }
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    shiftRef.current = e.shiftKey
    if (e.button !== 0) return
    const p = cellFromEvent(e)
    if (!p) return
    if (e.shiftKey) {
      setRange((r) => ({ a: r?.a ?? p, f: p }))
      e.preventDefault() // no text selection on shift+click
      return
    }
    dragRef.current = true
    setRange({ a: p, f: p })
  }

  const onMouseOver = (e: React.MouseEvent): void => {
    if (!dragRef.current) return
    const p = cellFromEvent(e)
    if (p) setRange((r) => (r && (r.f.r !== p.r || r.f.c !== p.c) ? { a: r.a, f: p } : r))
  }

  const isDark =
    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const gridColumns = useMemo<Column<GridRow>[]>(() => {
    const cols: Column<GridRow>[] = []
    if (props.onSelectedRowsChange) cols.push({ ...SelectColumn, frozen: true })
    cols.push({
      key: '__rownum',
      name: '',
      width: Math.max(44, String(rowOffset + rows.length).length * 8 + 18),
      frozen: true,
      resizable: false,
      sortable: false,
      cellClass: 'rowno',
      headerCellClass: 'rowno',
      renderCell: ({ rowIdx, row }) => (row.__state === 'new' ? '+' : rowOffset + rowIdx + 1)
    })
    columns.forEach((c, i) => {
      const key = colKey(i)
      cols.push({
        key,
        name: c.name,
        width: estimateWidth(c, rows, key),
        resizable: true,
        sortable: !!props.onSortColumnsChange,
        editable: editable ? (row) => row.__state !== 'deleted' : false,
        renderEditCell: editable ? (p) => <CellEditor {...p} nullable={c.nullable !== false} /> : undefined,
        cellClass: (row) => {
          const edited = props.isEdited?.(row, key) ? 'cell-edited' : ''
          if (!b || !multi || i < b.c1 || i > b.c2) return edited || undefined
          const r = rowIndex.get(row.__id) ?? -1
          return r >= b.r1 && r <= b.r2 ? `${edited} cell-range` : edited || undefined
        },
        renderHeaderCell: ({ sortDirection }) => (
          <div className="col-head" title={`${c.name}${c.type ? ` (${c.type})` : ''}`}>
            {c.pk && <KeyRound size={11} className="pk" />}
            {c.fk && (
              <span className="fk-icon" title={`Foreign key → ${c.fk.target}`}>
                <Link2 size={11} />
              </span>
            )}
            <span className="n">{c.name}</span>
            {c.type && <span className="ty">{c.type}</span>}
            {sortDirection === 'ASC' && <ArrowUp size={12} />}
            {sortDirection === 'DESC' && <ArrowDown size={12} />}
          </div>
        ),
        renderCell: ({ row }) => {
          const v = row[key]
          if (!c.fk || v === null || v === undefined || row.__state === 'deleted') return renderValue(v)
          const fk = c.fk
          return (
            <span
              className="fk-link"
              title={`Open the referenced row in ${fk.target}`}
              onMouseDown={(e) => e.stopPropagation()} // don't start a range drag
              onClick={(e) => {
                e.stopPropagation()
                fk.open(row)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {renderValue(v)}
            </span>
          )
        }
      })
    })
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, editable, rowOffset, rows.length > 0, props.onSelectedRowsChange, props.isEdited, props.onSortColumnsChange, b?.r1, b?.r2, b?.c1, b?.c2, multi, rowIndex])

  const copy = (text: string, what = 'Copied'): void => {
    navigator.clipboard.writeText(text)
    toast(what, 'success')
  }

  const stats = multi ? rangeStats(rangeValues()) : null

  return (
    <div
      ref={wrapRef}
      className="dt-wrap"
      data-range={multi ? 'multi' : undefined}
      onMouseDownCapture={onMouseDown}
      onMouseOver={onMouseOver}
      onKeyDownCapture={onKeyDownCapture}
      onPointerDownCapture={() => (pointerAt.current = Date.now())}
      onBlur={(e) => {
        // focus fell out of the grid to nowhere (the focused cell was re-rendered away, a menu closed…):
        // put it back on the selected cell so the arrow keys keep working
        if (!props.autoSelectFirstCell || e.relatedTarget) return
        window.setTimeout(() => {
          const a = document.activeElement
          if ((a && a !== document.body) || !activeRef.current || !document.hasFocus()) return
          const el = gridRef.current?.element
          if (!el || el.offsetParent === null) return
          el.querySelector<HTMLElement>('[role=gridcell][aria-selected=true]')?.focus({ preventScroll: true })
        }, 50)
      }}
      onFocusCapture={(e) => {
        // Keyboard focus entering the grid while no data cell is selected (Tab, focus coming back…) makes the
        // grid select the first *header* cell, i.e. the select-all checkbox. Start on the first data cell instead.
        // Real clicks on a header (sorting, ticking all rows) are left alone.
        if (!props.autoSelectFirstCell || !rows.length || Date.now() - pointerAt.current < 500) return
        // moving inside the grid (e.g. Up from the first row onto the column headers) is deliberate
        const from = e.relatedTarget as Node | null
        if (from && e.currentTarget.contains(from)) return
        const t = e.target as HTMLElement
        if (t !== gridRef.current?.element && !t.closest('[role=columnheader]')) return
        if (e.currentTarget.querySelector('[role=gridcell][aria-selected=true]')) return
        window.setTimeout(() => gridRef.current?.selectCell({ rowIdx: 0, idx: lead }), 0)
      }}
    >
      <DataGrid<GridRow, unknown, number>
        ref={gridRef}
        className={`q-grid ${isDark ? 'rdg-dark' : 'rdg-light'}`}
        columns={gridColumns}
        rows={rows}
        rowKeyGetter={(r) => r.__id}
        rowHeight={28}
        headerRowHeight={32}
        onRowsChange={props.onRowsChange}
        onSelectedCellChange={({ rowIdx, column }) => {
          if (!column.key.startsWith('c')) return
          const p = { r: rowIdx, c: Number(column.key.slice(1)) }
          if (shiftRef.current) setRange((r) => ({ a: r?.a ?? p, f: p }))
          else if (!dragRef.current) setRange((r) => (r && r.a.r === r.f.r && r.a.c === r.f.c && r.a.r === p.r && r.a.c === p.c ? r : { a: p, f: p }))
        }}
        sortColumns={props.sortColumns}
        onSortColumnsChange={props.onSortColumnsChange}
        selectedRows={props.selectedRows}
        onSelectedRowsChange={props.onSelectedRowsChange}
        rowClass={(r) => (r.__state === 'new' ? 'row-new' : r.__state === 'deleted' ? 'row-deleted' : undefined)}
        onCopy={({ sourceRow, sourceColumnKey }) => {
          const v = sourceRow[sourceColumnKey]
          navigator.clipboard.writeText(v === null || v === undefined ? 'NULL' : String(v))
        }}
        onCellDoubleClick={({ row, column }, e) => {
          if (!editable && column.key.startsWith('c')) {
            e.preventGridDefault()
            setViewer({ name: String(column.name), value: row[column.key] })
          }
        }}
        onCellContextMenu={({ row, column, selectCell }, e) => {
          e.preventGridDefault()
          e.preventDefault()
          const key = column.key
          const here = cellFromEvent(e)
          const inRange = !!(multi && b && here && here.r >= b.r1 && here.r <= b.r2 && here.c >= b.c1 && here.c <= b.c2)
          if (!inRange) selectCell()
          const canEdit = editable && !!props.onRowsChange
          const rangeItems: MenuItem[] = inRange
            ? [
                { label: `Copy ${rangeSize} cells`, icon: <Clipboard size={14} />, shortcut: 'Ctrl+C', onClick: copyRange },
                ...(canEdit
                  ? [
                      { label: `Paste into range`, icon: <ClipboardPaste size={14} />, shortcut: 'Ctrl+V', onClick: () => pasteClipboard() },
                      { label: `Set ${rangeSize} cells to NULL`, icon: <Eraser size={14} />, onClick: () => fillRange(null) },
                      {
                        label: `Set ${rangeSize} cells to value…`,
                        icon: <PenLine size={14} />,
                        onClick: async () => {
                          const v = await ask(`Set ${rangeSize} cells to`, '', { label: 'Value (type NULL for null)', okLabel: 'Set' })
                          if (v !== null) fillRange(v === 'NULL' ? null : v)
                        }
                      }
                    ]
                  : []),
                { separator: true }
              ]
            : []
          const v = row[key]
          const values = rowValues(row, columns.length)
          const items: MenuItem[] = [
            ...rangeItems,
            ...(key.startsWith('c') && !inRange
              ? [
                  {
                    label: 'Copy value',
                    icon: <Clipboard size={14} />,
                    shortcut: 'Ctrl+C',
                    onClick: () => copy(v === null || v === undefined ? 'NULL' : String(v))
                  },
                  { label: 'View value', icon: <Eye size={14} />, onClick: () => setViewer({ name: String(column.name), value: v }) }
                ]
              : []),
            {
              label: 'Copy row (TSV)',
              icon: <Copy size={14} />,
              onClick: () => copy(formatTsv(null, [values]), 'Row copied')
            },
            {
              label: 'Copy row as JSON',
              icon: <Braces size={14} />,
              onClick: () =>
                copy(JSON.stringify(Object.fromEntries(columns.map((c, i) => [c.name, values[i]])), null, 2), 'Row copied')
            },
            ...(props.insertTarget
              ? (() => {
                  const { table, dialect } = props.insertTarget
                  // which rows: the ticked rows (if the clicked one is among them), else the rows a cell range spans, else this row
                  const ticked = props.selectedRows?.has(row.__id) ? rows.filter((r) => props.selectedRows!.has(r.__id)) : []
                  const target =
                    ticked.length > 1 ? ticked : inRange && b && b.r2 > b.r1 ? rows.slice(b.r1, b.r2 + 1) : [row]
                  const n = target.length
                  return [
                    {
                      label: n > 1 ? `Copy ${n} rows as INSERT` : 'Copy row as INSERT',
                      icon: <FileCode2 size={14} />,
                      onClick: () =>
                        copy(
                          insertStatements(table, columns.map((c) => c.name), target.map((r) => rowValues(r, columns.length)), dialect),
                          n > 1 ? `${n} INSERT statements copied` : 'INSERT statement copied'
                        )
                    }
                  ]
                })()
              : []),
            {
              label: 'Copy all rows (TSV with header)',
              icon: <Copy size={14} />,
              onClick: () =>
                copy(
                  formatTsv(
                    columns.map((c) => c.name),
                    rows.map((r) => rowValues(r, columns.length))
                  ),
                  `${rows.length} rows copied`
                )
            },
            ...(props.extraMenu ? [{ separator: true } as MenuItem, ...props.extraMenu(row, key)] : [])
          ]
          showMenu(e.clientX, e.clientY, items)
        }}
      />
      {stats && b && (
        <div className="range-badge">
          <span>
            {b.r2 - b.r1 + 1} × {b.c2 - b.c1 + 1}
          </span>
          <span>{rangeSize} cells</span>
          {stats.numeric > 0 && (
            <>
              <span>Sum {fmtNum(stats.sum)}</span>
              <span>Avg {fmtNum(stats.sum / stats.numeric)}</span>
              <span>Min {fmtNum(stats.min)}</span>
              <span>Max {fmtNum(stats.max)}</span>
            </>
          )}
          <span className="faint">Ctrl+C copy · Esc clear</span>
        </div>
      )}
      {viewer && <CellViewer name={viewer.name} value={viewer.value} onClose={() => setViewer(null)} />}
    </div>
  )
}

interface Pos {
  r: number
  c: number
}
interface CellRange {
  a: Pos // anchor (where the selection started)
  f: Pos // focus (where it ends)
}

function bounds(range: CellRange): { r1: number; r2: number; c1: number; c2: number } {
  return {
    r1: Math.min(range.a.r, range.f.r),
    r2: Math.max(range.a.r, range.f.r),
    c1: Math.min(range.a.c, range.f.c),
    c2: Math.max(range.a.c, range.f.c)
  }
}

function rangeStats(values: CellValue[][]): { numeric: number; sum: number; min: number; max: number } {
  let numeric = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const line of values)
    for (const v of line) {
      if (v === null || v === '' || typeof v === 'boolean') continue
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(n)) continue
      numeric++
      sum += n
      if (n < min) min = n
      if (n > max) max = n
    }
  return { numeric, sum, min, max }
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function CellViewer({ name, value, onClose }: { name: string; value: unknown; onClose: () => void }): JSX.Element {
  const text = value === null || value === undefined ? 'NULL' : String(value)
  let pretty = text
  try {
    if (/^\s*[[{]/.test(text)) pretty = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    /* not json */
  }
  return (
    <Modal
      title={name}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn" onClick={() => navigator.clipboard.writeText(text)}>
            <Clipboard size={13} /> Copy
          </button>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <pre className="cell-viewer">{pretty}</pre>
      <div className="faint" style={{ fontSize: 11.5 }}>
        {text.length.toLocaleString()} characters
      </div>
    </Modal>
  )
}
