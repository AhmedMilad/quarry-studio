import type { RefObject } from 'react'
import { Code2, Filter, Minus, Plus, X } from 'lucide-react'
import type { FilterCondition, ResultColumn } from '@shared/types'
import { filterNeedsValue } from '@shared/types'

const OPS = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS NULL', 'IS NOT NULL']

interface Props {
  barRef: RefObject<HTMLDivElement>
  columns: ResultColumn[]
  filters: FilterCondition[]
  setFilters: (f: FilterCondition[]) => void
  mode: 'builder' | 'raw'
  setMode: (m: 'builder' | 'raw') => void
  rawWhere: string
  setRawWhere: (w: string) => void
  join: 'AND' | 'OR'
  changeJoin: (j: 'AND' | 'OR') => void
  /** applied conditions; Clear is disabled when there are none */
  activeCount: number
  onApply: () => void
  onClear: () => void
}

/** The table tab's filter bar: condition builder (AND / OR) or a raw WHERE clause */
export function FilterBar({
  barRef,
  columns,
  filters,
  setFilters,
  mode,
  setMode,
  rawWhere,
  setRawWhere,
  join,
  changeJoin,
  activeCount,
  onApply,
  onClear
}: Props): JSX.Element {
  return (
    <div className="filter-bar" ref={barRef}>
      <div className="filter-row">
        <div className="seg">
          <button className={mode === 'builder' ? 'active' : ''} onClick={() => setMode('builder')}>
            <Filter size={12} /> Builder
          </button>
          <button className={mode === 'raw' ? 'active' : ''} onClick={() => setMode('raw')}>
            <Code2 size={12} /> SQL
          </button>
        </div>
        {mode === 'raw' ? (
          <input
            className="q-input sm mono"
            placeholder="WHERE clause, e.g. id > 10 AND status = 'active'"
            value={rawWhere}
            onChange={(e) => setRawWhere(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onApply()}
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
        <button className="btn sm" onClick={onApply}>
          Apply
        </button>
        <button
          className="btn sm ghost"
          title={activeCount > 0 ? 'Clear filters (Esc)' : 'No filter applied'}
          disabled={activeCount === 0}
          onClick={onClear}
        >
          <X size={12} /> Clear
        </button>
      </div>
      {mode === 'builder' &&
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
              onKeyDown={(e) => e.key === 'Enter' && onApply()}
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
  )
}
