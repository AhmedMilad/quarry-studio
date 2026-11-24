import type { DestructiveCheck } from '@shared/types'
import { analyzeDestructive } from '@shared/destructive'
import type { BaseDriver } from './drivers/base'

/**
 * Work out what UPDATE / DELETE / TRUNCATE / DROP statements in `sql` would affect, using read-only
 * queries only. Nothing here modifies data and nothing is recorded in the query history.
 */
export async function checkDestructive(driver: BaseDriver, sql: string): Promise<DestructiveCheck[]> {
  const num = async (q: string): Promise<number> => Number((await driver.exec(q)).rows[0]?.[0] ?? 0)
  const stmts = analyzeDestructive(sql, driver.dialect).slice(0, 20)
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  return Promise.all(
    stmts.map(async (st) => {
      const check: DestructiveCheck = {
        index: st.index,
        kind: st.kind,
        sql: st.sql,
        table: st.table ? (st.table.schema ? `${st.table.schema}.${st.table.name}` : st.table.name) : undefined,
        hasWhere: st.hasWhere,
        where: st.where,
        limit: st.limit,
        approximate: st.approximate,
        note: st.note,
        count: null,
        total: null,
        referencedBy: [],
        assignments: st.assignments?.map((a) => ({ column: a.column, expr: a.expr })),
        warnings: [],
        matchesAll: false
      }
      const tableRef = st.table ? { name: st.table.name, schema: st.table.schema } : null

      if (st.countSql) {
        try {
          check.count = await num(st.countSql)
        } catch (e) {
          check.countError = (e as Error).message
        }
      }
      if (st.totalSql) check.total = await num(st.totalSql).catch(() => null)
      check.matchesAll =
        st.kind === 'truncate' ||
        st.kind === 'drop-table' ||
        ((st.kind === 'delete' || st.kind === 'update') &&
          (!st.hasWhere || (check.count !== null && check.total !== null && check.total > 0 && check.count >= check.total && !st.approximate)))

      if (st.kind === 'update' && st.changingSql && check.count) {
        check.changing = await num(st.changingSql).catch(() => null)
      }

      // preview: UPDATE shows before → after, DELETE shows the rows
      if (st.previewSql && check.count) {
        try {
          const r = await driver.exec(st.previewSql)
          if (st.kind === 'update' && st.assignments?.length) {
            const names = r.columns.map((c) => c.name)
            const firstReal = names.findIndex((n) => !n.startsWith('q__new_'))
            check.diff = r.rows.slice(0, 5).map((row) => ({
              key: firstReal >= 0 ? `${names[firstReal]} = ${row[firstReal] === null ? 'NULL' : String(row[firstReal])}` : '',
              // only columns that really exist in the table (a misspelled column has no "before")
              changes: st.assignments!.flatMap((a, i) => {
                const oldIdx = names.findIndex((n) => same(n, a.column))
                const newIdx = names.indexOf(`q__new_${i}`)
                return oldIdx >= 0 && newIdx >= 0 ? [{ column: a.column, before: row[oldIdx], after: row[newIdx] }] : []
              })
            }))
            if (check.diff.every((d) => d.changes.length === 0)) check.diff = undefined
          } else {
            check.preview = { columns: r.columns, rows: r.rows.slice(0, 5) }
          }
        } catch {
          // e.g. SET col = DEFAULT can't be selected: fall back to the plain rows
          if (st.previewPlainSql) {
            const r = await driver.exec(st.previewPlainSql).catch(() => null)
            if (r) check.preview = { columns: r.columns, rows: r.rows.slice(0, 5) }
          }
        }
      }

      // UPDATE: catch problems before running (unknown column, NOT NULL, unique, primary key)
      if (st.kind === 'update' && tableRef && st.assignments?.length) {
        const [cols, idx] = await Promise.all([
          driver.listColumns(tableRef).catch(() => []),
          driver.listIndexes(tableRef).catch(() => [])
        ])
        const literal = /^('([^']|'')*'|-?\d+(\.\d+)?|true|false)$/i
        for (const a of st.assignments) {
          const col = cols.find((c) => same(c.name, a.column))
          if (cols.length && !col) {
            check.warnings.push(`Column "${a.column}" does not exist in ${check.table} — the query will fail.`)
            continue
          }
          if (!col) continue
          if (/^null$/i.test(a.expr) && !col.nullable) {
            check.warnings.push(`"${col.name}" is NOT NULL — setting it to NULL will fail.`)
          }
          if (col.primaryKey) check.warnings.push(`"${col.name}" is part of the primary key — rows will get a new identity.`)
          const unique = idx.find((i) => (i.unique || i.primary) && i.columns.length === 1 && same(i.columns[0], col.name))
          if (unique && literal.test(a.expr) && (check.count ?? 0) > 1) {
            check.warnings.push(
              `"${col.name}" must be unique (${unique.name}) — setting ${check.count} rows to the same value will fail.`
            )
          }
          if (col.autoIncrement && !col.primaryKey) check.warnings.push(`"${col.name}" is auto-generated.`)
        }
      }

      if (tableRef && st.kind !== 'drop-database') {
        try {
          let refs = await driver.listReferencing(tableRef)
          // an UPDATE only matters to foreign keys that point at a column it changes
          if (st.kind === 'update') {
            const changed = new Set((st.assignments ?? []).map((a) => a.column.toLowerCase()))
            refs = refs.filter((r) => changed.has(r.refColumn.toLowerCase()))
          }
          // count child rows pointing at the affected rows (one level deep)
          await Promise.all(
            refs.map(async (r) => {
              if (!st.baseSql || check.count === 0) return
              const child = driver.qualified({ name: r.table, schema: r.schema })
              const q = `${st.ctePrefix ? st.ctePrefix + ' ' : ''}SELECT COUNT(*) AS n FROM ${child} WHERE ${driver.quote(
                r.column
              )} IN (SELECT ${driver.quote(r.refColumn)} ${st.baseSql})`
              r.affected = await num(q).catch(() => null)
            })
          )
          check.referencedBy = refs
        } catch {
          /* relationship info is optional */
        }
      }
      return check
    })
  )
}
