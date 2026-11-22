import { useEffect, useRef } from 'react'
import { AlertTriangle, ArrowRight, Database, GitBranch, Link2, Loader2, PenLine, ShieldAlert, Trash2 } from 'lucide-react'
import type { CellValue, DestructiveCheck, ReferencingKey } from '@shared/types'

interface Props {
  checks: DestructiveCheck[] | null
  error?: string
  connectionName: string
  connectionColor: string
  database: string
  onCancel: () => void
  onConfirm: () => void
  /** the SQL being confirmed, so the right colour shows while the check is still loading */
  sqlHint?: string
}

const KIND_LABEL: Record<DestructiveCheck['kind'], string> = {
  delete: 'DELETE',
  update: 'UPDATE',
  truncate: 'TRUNCATE',
  'drop-table': 'DROP TABLE',
  'drop-database': 'DROP'
}

const fmt = (n: number): string => n.toLocaleString()
const plural = (n: number, word: string): string => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`

function cell(v: CellValue | undefined): string {
  if (v === null || v === undefined) return 'NULL'
  const s = String(v)
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

/** what a referencing foreign key does to the child rows for this statement */
function refEffect(c: DestructiveCheck, r: ReferencingKey): { text: string; tone: '' | 'cascade' | 'blocks' } {
  const rule = (c.kind === 'update' ? r.onUpdate : r.onDelete) ?? 'NO ACTION'
  const n = r.affected
  if (n == null) return { text: '', tone: '' }
  if (n === 0) return { text: 'no matching rows', tone: '' }
  if (/CASCADE/i.test(rule))
    return { text: c.kind === 'update' ? `${plural(n, 'row')} updated too` : `${plural(n, 'row')} also deleted`, tone: 'cascade' }
  if (/SET NULL/i.test(rule)) return { text: `${plural(n, 'row')} set to NULL`, tone: '' }
  if (/SET DEFAULT/i.test(rule)) return { text: `${plural(n, 'row')} set to default`, tone: '' }
  return { text: `${plural(n, 'row')} — will block the ${c.kind === 'update' ? 'update' : 'delete'}`, tone: 'blocks' }
}

export function DestructiveConfirm(p: Props): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        p.onCancel()
      }
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [p])

  const loading = !p.checks && !p.error
  const checks = p.checks ?? []
  const updates = checks.filter((c) => c.kind === 'update')
  const removals = checks.filter((c) => c.kind !== 'update')
  const allCounted = checks.length > 0 && checks.every((c) => c.count !== null || c.kind === 'drop-database')
  const sum = (list: DestructiveCheck[]): number => list.reduce((a, c) => a + (c.count ?? 0), 0)
  const updatedRows = sum(updates)
  const removedRows = sum(removals)
  const totalRows = updatedRows + removedRows
  const nothingMatches = allCounted && totalRows === 0 && checks.every((c) => c.kind === 'delete' || c.kind === 'update')
  const cascadeRows = checks.reduce(
    (a, c) =>
      a +
      c.referencedBy
        .filter((r) => /CASCADE/i.test((c.kind === 'update' ? r.onUpdate : r.onDelete) ?? ''))
        .reduce((x, r) => x + (r.affected ?? 0), 0),
    0
  )
  const allRowsHits = checks.filter((c) => c.matchesAll && (c.kind === 'delete' || c.kind === 'update'))
  // UPDATE-only confirmations use a calmer light-blue theme; anything that removes data stays red
  const updateOnly = checks.length > 0 ? updates.length === checks.length : /^\s*(with\b[\s\S]*?\b)?update\b/i.test(p.sqlHint ?? '')

  const title =
    updates.length === checks.length && checks.length
      ? 'Confirm update'
      : removals.length === checks.length && checks.every((c) => c.kind === 'delete')
        ? 'Confirm delete'
        : 'Confirm data-changing query'

  let confirmLabel = 'Run anyway'
  if (nothingMatches) confirmLabel = 'Run anyway (0 rows)'
  else if (allCounted && updates.length === checks.length) confirmLabel = `Update ${plural(updatedRows, 'row')}`
  else if (allCounted && checks.every((c) => c.kind === 'delete')) confirmLabel = `Delete ${plural(removedRows, 'row')}`
  else if (checks.length && checks.every((c) => c.kind === 'truncate')) confirmLabel = 'Truncate'
  else if (checks.length && checks.every((c) => c.kind.startsWith('drop'))) confirmLabel = 'Drop'

  const summaryParts: string[] = []
  if (removals.length) summaryParts.push(`${plural(removedRows, 'row')} will be ${removals.some((c) => c.kind.startsWith('drop')) ? 'removed' : 'deleted'}`)
  if (updates.length) summaryParts.push(`${plural(updatedRows, 'row')} will be updated`)

  return (
    <div className="modal-backdrop" onMouseDown={p.onCancel}>
      <div className={`modal wide destructive${updateOnly ? ' dc-update' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={18} className="dc-icon" />
          {title}
        </h2>

        <div className="dc-target">
          <span className="color-dot" style={{ background: p.connectionColor }} />
          <b>{p.connectionName}</b>
          {p.database && (
            <>
              <Database size={12} className="faint" /> {p.database}
            </>
          )}
        </div>

        {loading && (
          <div className="dc-loading">
            <Loader2 size={16} className="spin" /> Checking which rows will be affected…
          </div>
        )}
        {p.error && <div className="dc-warn">Could not analyse the query: {p.error}</div>}

        {!loading && checks.length > 0 && (
          <div className="dc-summary">
            {allCounted ? (
              nothingMatches ? (
                <span>No rows match — nothing will change.</span>
              ) : (
                <span>
                  {summaryParts.length === 1 ? (
                    <>
                      <b className="dc-big">{fmt(totalRows)}</b> {summaryParts[0].replace(/^[\d,.]+ /, '')}
                    </>
                  ) : (
                    <b>{summaryParts.join(' · ')}</b>
                  )}
                  {cascadeRows > 0 && (
                    <>
                      {' '}
                      + <b>{fmt(cascadeRows)}</b> related row{cascadeRows === 1 ? '' : 's'} via CASCADE
                    </>
                  )}
                </span>
              )
            ) : (
              <span>The number of affected rows could not be determined for every statement.</span>
            )}
          </div>
        )}

        {allRowsHits.map((c, i) => (
          <div key={i} className="dc-danger dc-allrows">
            <AlertTriangle size={16} />
            <span>
              <b>ALL ROWS:</b>{' '}
              {c.hasWhere ? 'the WHERE clause matches every row — ' : `this ${c.kind.toUpperCase()} has no WHERE clause — `}
              {c.kind === 'update' ? 'it changes' : 'it deletes'} <b>all {c.total !== null ? fmt(c.total) + ' ' : ''}rows</b> in{' '}
              <span className="mono">{c.table}</span>.
            </span>
          </div>
        ))}

        <div className="dc-list">
          {checks.map((c, i) => (
            <div key={i} className="dc-item">
              <div className="dc-head">
                <span className={`badge ${c.kind === 'update' ? 'dc-badge-update' : 'dc-badge-delete'}`}>{KIND_LABEL[c.kind]}</span>
                <span className="mono">{c.table ?? '?'}</span>
                <span className="spacer" />
                {c.count !== null ? (
                  <span>
                    <b>
                      {c.approximate ? '≈ ' : ''}
                      {fmt(c.count)}
                    </b>
                    {c.total !== null && (c.kind === 'delete' || c.kind === 'update') && (
                      <span className="faint">
                        {' '}
                        of {fmt(c.total)} ({c.total ? Math.round((c.count / c.total) * 1000) / 10 : 0}%)
                      </span>
                    )}{' '}
                    row{c.count === 1 ? '' : 's'}
                  </span>
                ) : c.kind !== 'drop-database' ? (
                  <span className="faint">count unavailable</span>
                ) : null}
              </div>
              <pre className="dc-sql">{c.sql.length > 400 ? c.sql.slice(0, 400) + '…' : c.sql}</pre>

              {c.kind === 'update' && c.assignments && c.assignments.length > 0 && (
                <div className="dc-set">
                  <PenLine size={12} />
                  {c.assignments.map((a, j) => (
                    <span key={j} className="dc-assign mono">
                      {a.column} = {a.expr.length > 50 ? a.expr.slice(0, 50) + '…' : a.expr}
                    </span>
                  ))}
                </div>
              )}
              {c.kind === 'update' && c.changing != null && c.count != null && c.count > 0 && (
                <div className="dc-note">
                  <b>{plural(c.changing, 'row')}</b> will actually change
                  {c.count - c.changing > 0 && <> · {plural(c.count - c.changing, 'row')} already have these values</>}
                </div>
              )}

              {c.warnings.map((w, j) => (
                <div key={j} className="dc-warn-strong">
                  <AlertTriangle size={13} /> {w}
                </div>
              ))}
              {c.limit !== undefined && <div className="dc-note">Limited to {fmt(c.limit)} rows by LIMIT / TOP.</div>}
              {c.note && <div className="dc-note">{c.note}</div>}
              {c.countError && <div className="dc-warn">Couldn’t count affected rows: {c.countError}</div>}

              {c.referencedBy.length > 0 && (
                <div className="dc-refs">
                  <div className="dc-refs-title">
                    <Link2 size={12} /> Referenced by
                  </div>
                  {c.referencedBy.map((r, j) => {
                    const eff = refEffect(c, r)
                    return (
                      <div key={j} className={`dc-ref ${eff.tone}`}>
                        <GitBranch size={12} />
                        <span className="mono">
                          {r.table}.{r.column}
                        </span>
                        <span className="faint">
                          ON {c.kind === 'update' ? 'UPDATE' : 'DELETE'} {(c.kind === 'update' ? r.onUpdate : r.onDelete) ?? 'NO ACTION'}
                        </span>
                        <span className="spacer" />
                        <span>{eff.text}</span>
                      </div>
                    )
                  })}
                </div>
              )}

              {c.diff && c.diff.length > 0 && (
                <div className="dc-preview">
                  <div className="dc-refs-title">
                    First {plural(c.diff.length, 'row')} — before → after
                  </div>
                  <div className="dc-preview-scroll">
                    <table className="meta">
                      <thead>
                        <tr>
                          <th>Row</th>
                          {c.diff[0].changes.map((ch, k) => (
                            <th key={k}>{ch.column}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {c.diff.map((d, k) => (
                          <tr key={k}>
                            <td className="mono faint">{d.key}</td>
                            {d.changes.map((ch, m) => {
                              const unchanged = cell(ch.before) === cell(ch.after)
                              return (
                                <td key={m} className="mono">
                                  {unchanged ? (
                                    <span className="faint">{cell(ch.before)} (no change)</span>
                                  ) : (
                                    <span className="dc-diff">
                                      <span className={`dc-before${ch.before === null ? ' cell-null' : ''}`}>{cell(ch.before)}</span>
                                      <ArrowRight size={11} />
                                      <span className={`dc-after${ch.after === null ? ' cell-null' : ''}`}>{cell(ch.after)}</span>
                                    </span>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!c.diff && c.preview && c.preview.rows.length > 0 && (
                <div className="dc-preview">
                  <div className="dc-refs-title">
                    First {plural(c.preview.rows.length, 'row')} {c.kind === 'update' ? 'to be updated' : 'to be deleted'}
                  </div>
                  <div className="dc-preview-scroll">
                    <table className="meta">
                      <thead>
                        <tr>
                          {c.preview.columns.map((col, k) => (
                            <th key={k}>{col.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {c.preview.rows.map((row, k) => (
                          <tr key={k}>
                            {row.map((v, m) => (
                              <td key={m} className={`mono${v === null ? ' cell-null' : ''}`}>
                                {cell(v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="dc-foot faint">This cannot be undone unless you are inside a transaction you can roll back.</div>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={p.onCancel}>
            Cancel
          </button>
          <button className="btn danger-solid" onClick={p.onConfirm} disabled={loading}>
            {updates.length === checks.length && checks.length ? <PenLine size={13} /> : <Trash2 size={13} />}{' '}
            {loading ? 'Checking…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
