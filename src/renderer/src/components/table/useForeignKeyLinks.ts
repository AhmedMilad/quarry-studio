import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FilterCondition, ForeignKeyInfo, ResultColumn } from '@shared/types'
import { api } from '../../api'
import { useApp, type TableTabState } from '../../store'
import { colKey, type GridColumn, type GridRow } from '../DataTable'

type FkLink = NonNullable<GridColumn['fk']>

/**
 * Foreign-key columns of a table tab, as links: column name → { target, open(row) }.
 * Opening a link shows the referenced row, filtered on the key (all columns of a composite key), in an open tab of
 * that table if there is one, otherwise in a new tab.
 */
export function useForeignKeyLinks(sid: string, tab: TableTabState, columns: ResultColumn[]): Map<string, FkLink> {
  const [fks, setFks] = useState<ForeignKeyInfo[]>([])
  useEffect(() => {
    api
      .listForeignKeys(sid, tab.table)
      .then(setFks)
      .catch(() => setFks([]))
  }, [sid, tab.table])

  const sessionTables = useApp((s) => s.sessions[sid]?.tables)
  const openTableTab = useApp((s) => s.openTableTab)
  const followFk = useCallback(
    async (group: ForeignKeyInfo[], row: GridRow) => {
      const ref = group[0]
      const refTable = { name: ref.refTable, schema: ref.refSchema ?? tab.table.schema }
      let refCols = group.map((f) => f.refColumn)
      // SQLite allows "REFERENCES t" without a column: that means t's primary key
      if (refCols.some((c) => !c)) {
        const pk = (await api.listColumns(sid, refTable).catch(() => [])).filter((c) => c.primaryKey).map((c) => c.name)
        refCols = refCols.map((c, i) => c || pk[i] || '')
      }
      const filters: FilterCondition[] = []
      for (let i = 0; i < group.length; i++) {
        const idx = columns.findIndex((c) => c.name === group[i].column)
        const v = idx >= 0 ? row[colKey(idx)] : null
        if (v === null || v === undefined || !refCols[i]) return
        filters.push({ column: refCols[i], op: '=', value: String(v) })
      }
      const info =
        sessionTables?.find((t) => t.name === refTable.name && (!refTable.schema || !t.schema || t.schema === refTable.schema)) ??
        { ...refTable, type: 'table' as const }
      openTableTab(sid, info, 'data', false, filters) // reuses an open tab of that table
    },
    [sid, tab.table.schema, columns, sessionTables, openTableTab]
  )

  return useMemo(() => {
    // group by constraint so composite keys follow all their columns at once
    const groups = new Map<string, ForeignKeyInfo[]>()
    for (const f of fks) groups.set(f.name, [...(groups.get(f.name) ?? []), f])
    const links = new Map<string, FkLink>()
    for (const g of groups.values()) {
      for (const f of g) {
        if (links.has(f.column)) continue
        links.set(f.column, {
          target: `${f.refTable}${f.refColumn ? '.' + f.refColumn : ''}`,
          open: (row: GridRow) => void followFk(g, row)
        })
      }
    }
    return links
  }, [fks, followFk])
}
