import type {
  CellValue,
  ColumnInfo,
  CompletionTable,
  ConnectionConfig,
  Dialect,
  FilterCondition,
  ForeignKeyInfo,
  IndexInfo,
  ReferencingKey,
  QueryResult,
  ResultColumn,
  RoutineInfo,
  RowChanges,
  SelectOptions,
  SelectResult,
  TableInfo,
  TableRef
} from '@shared/types'
import { isActiveFilter } from '@shared/types'
import { isReadOnlyStatement } from '@shared/sql'

export interface ExecResult {
  columns: ResultColumn[]
  rows: CellValue[][]
  affectedRows?: number
}

export type Exec = (sql: string, params?: CellValue[]) => Promise<ExecResult>

export interface ConnectTarget {
  host: string
  port: number
}

export abstract class BaseDriver {
  abstract readonly dialect: Dialect
  supportsSchemas = false
  defaultSchema: string | undefined = undefined

  constructor(
    public config: ConnectionConfig,
    public database: string,
    protected target: ConnectTarget
  ) {}

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  abstract serverVersion(): Promise<string>
  abstract listDatabases(): Promise<string[]>
  async listSchemas(): Promise<string[]> {
    return []
  }
  abstract listTables(schema?: string): Promise<TableInfo[]>
  abstract listColumns(t: TableRef): Promise<ColumnInfo[]>
  abstract listIndexes(t: TableRef): Promise<IndexInfo[]>
  abstract listForeignKeys(t: TableRef): Promise<ForeignKeyInfo[]>
  abstract listRoutines(schema?: string): Promise<RoutineInfo[]>
  /** foreign keys in other tables that reference `t` */
  async listReferencing(_t: TableRef): Promise<ReferencingKey[]> {
    return []
  }
  abstract getDDL(t: TableRef, kind: 'table' | 'view'): Promise<string>
  abstract completionMeta(schema?: string): Promise<CompletionTable[]>
  /** Execute a raw (possibly multi-statement) script */
  protected abstract runRaw(sql: string, queryId: string, maxRows: number): Promise<QueryResult[]>
  /** Execute a single parameterised statement */
  abstract exec: Exec
  abstract transaction(fn: (exec: Exec) => Promise<void>): Promise<void>
  async cancel(_queryId: string): Promise<void> {
    throw new Error('Cancelling queries is not supported for this database')
  }

  async runQuery(sql: string, queryId: string, maxRows: number): Promise<QueryResult[]> {
    if (this.config.readOnly && !isReadOnlyStatement(sql)) {
      throw new Error('This connection is read-only. Only SELECT / SHOW / EXPLAIN statements are allowed.')
    }
    return this.runRaw(sql, queryId, maxRows)
  }

  quote(id: string): string {
    switch (this.dialect) {
      case 'mysql':
        return '`' + id.replace(/`/g, '``') + '`'
      case 'mssql':
        return '[' + id.replace(/]/g, ']]') + ']'
      default:
        return '"' + id.replace(/"/g, '""') + '"'
    }
  }

  qualified(t: TableRef): string {
    return t.schema && this.supportsSchemas ? `${this.quote(t.schema)}.${this.quote(t.name)}` : this.quote(t.name)
  }

  placeholder(i: number): string {
    if (this.dialect === 'postgres') return `$${i}`
    if (this.dialect === 'mssql') return `@p${i}`
    return '?'
  }

  protected paginate(sql: string, limit: number, offset: number, hasOrder: boolean): string {
    if (this.dialect === 'mssql') {
      return `${sql}${hasOrder ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
    }
    return `${sql} LIMIT ${limit} OFFSET ${offset}`
  }

  protected buildFilters(filters: FilterCondition[] | undefined, params: CellValue[]): string[] {
    const parts: string[] = []
    for (const f of filters ?? []) {
      if (!isActiveFilter(f)) continue
      const col = this.quote(f.column)
      const op = f.op.toUpperCase()
      if (op === 'IS NULL' || op === 'IS NOT NULL') {
        parts.push(`${col} ${op}`)
      } else if (op === 'IN' || op === 'NOT IN') {
        const vals = f.value.split(',').map((v) => v.trim()).filter(Boolean)
        if (!vals.length) continue
        const ph = vals.map((v) => {
          params.push(v)
          return this.placeholder(params.length)
        })
        parts.push(`${col} ${op} (${ph.join(', ')})`)
      } else if (['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'NOT LIKE', 'ILIKE'].includes(op)) {
        params.push(f.value)
        let actualOp = op === '!=' ? '<>' : op
        if (op === 'ILIKE' && this.dialect !== 'postgres') actualOp = 'LIKE'
        const lhs = op.includes('LIKE') && this.dialect === 'postgres' ? `CAST(${col} AS TEXT)` : col
        parts.push(`${lhs} ${actualOp} ${this.placeholder(params.length)}`)
      }
    }
    return parts
  }

  /** Builder conditions are joined with AND or OR (as a group); a raw WHERE clause is always ANDed */
  protected whereClause(opts: Pick<SelectOptions, 'where' | 'filters' | 'filterJoin'>, params: CellValue[]): string {
    const conds = this.buildFilters(opts.filters, params)
    const parts: string[] = []
    if (conds.length) {
      const joiner = opts.filterJoin === 'OR' ? ' OR ' : ' AND '
      parts.push(conds.length > 1 ? `(${conds.join(joiner)})` : conds[0])
    }
    if (opts.where && opts.where.trim()) parts.push(`(${opts.where.trim()})`)
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
  }

  async select(t: TableRef, opts: SelectOptions): Promise<SelectResult> {
    const params: CellValue[] = []
    const whereSql = this.whereClause(opts, params)
    const orderSql = opts.orderBy?.length
      ? ` ORDER BY ${opts.orderBy.map((o) => `${this.quote(o.column)} ${o.dir === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`
      : ''
    const base = `SELECT * FROM ${this.qualified(t)}${whereSql}${orderSql}`
    const sql = this.paginate(base, opts.limit, opts.offset, !!orderSql)
    const [data, count] = await Promise.all([
      this.exec(sql, params),
      this.exec(`SELECT COUNT(*) AS c FROM ${this.qualified(t)}${whereSql}`, params).catch(() => null)
    ])
    return {
      columns: data.columns,
      rows: data.rows,
      totalCount: count && count.rows[0] ? Number(count.rows[0][0]) : null
    }
  }

  async selectAll(t: TableRef, opts: Pick<SelectOptions, 'where' | 'filters' | 'filterJoin' | 'orderBy'>): Promise<ExecResult> {
    const params: CellValue[] = []
    const whereSql = this.whereClause(opts, params)
    const orderSql = opts.orderBy?.length
      ? ` ORDER BY ${opts.orderBy.map((o) => `${this.quote(o.column)} ${o.dir === 'DESC' ? 'DESC' : 'ASC'}`).join(', ')}`
      : ''
    return this.exec(`SELECT * FROM ${this.qualified(t)}${whereSql}${orderSql}`, params)
  }

  async applyChanges(c: RowChanges): Promise<void> {
    if (this.config.readOnly) throw new Error('This connection is read-only.')
    const table = this.qualified(c.table)
    await this.transaction(async (exec) => {
      for (const del of c.deletes) {
        const params: CellValue[] = []
        const where = this.pkWhere(del, params)
        await exec(`DELETE FROM ${table} WHERE ${where}`, params)
      }
      for (const upd of c.updates) {
        const params: CellValue[] = []
        const sets = Object.entries(upd.values).map(([k, v]) => {
          params.push(v)
          return `${this.quote(k)} = ${this.placeholder(params.length)}`
        })
        if (!sets.length) continue
        const where = this.pkWhere(upd.pk, params)
        await exec(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, params)
      }
      for (const ins of c.inserts) {
        const keys = Object.keys(ins)
        if (!keys.length) {
          await exec(
            this.dialect === 'mysql' ? `INSERT INTO ${table} () VALUES ()` : `INSERT INTO ${table} DEFAULT VALUES`,
            []
          )
          continue
        }
        const params = keys.map((k) => ins[k])
        const ph = keys.map((_, i) => this.placeholder(i + 1))
        await exec(`INSERT INTO ${table} (${keys.map((k) => this.quote(k)).join(', ')}) VALUES (${ph.join(', ')})`, params)
      }
    })
  }

  private pkWhere(pk: Record<string, CellValue>, params: CellValue[]): string {
    const parts = Object.entries(pk).map(([k, v]) => {
      if (v === null) return `${this.quote(k)} IS NULL`
      params.push(v)
      return `${this.quote(k)} = ${this.placeholder(params.length)}`
    })
    if (!parts.length) throw new Error('Cannot identify row: the table has no primary key')
    return parts.join(' AND ')
  }

  async dropTable(t: TableRef, kind: 'table' | 'view'): Promise<void> {
    if (this.config.readOnly) throw new Error('This connection is read-only.')
    await this.exec(`DROP ${kind === 'view' ? 'VIEW' : 'TABLE'} ${this.qualified(t)}`)
  }

  async truncateTable(t: TableRef): Promise<void> {
    if (this.config.readOnly) throw new Error('This connection is read-only.')
    if (this.dialect === 'sqlite') await this.exec(`DELETE FROM ${this.qualified(t)}`)
    else await this.exec(`TRUNCATE TABLE ${this.qualified(t)}`)
  }
}

/** Convert any driver value into something that survives IPC and renders in a grid */
export function normalizeValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return String(v)
    return formatUtcDate(v)
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v as Uint8Array)
    if (b.length > 4096) return `0x${b.subarray(0, 4096).toString('hex')}… (${b.length} bytes)`
    return '0x' + b.toString('hex')
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function formatUtcDate(d: Date): string {
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}:${p(d.getUTCSeconds())}`
  return d.getUTCMilliseconds() ? `${base}.${p(d.getUTCMilliseconds(), 3)}` : base
}

export function normalizeRows(rows: unknown[][], maxRows = Infinity): CellValue[][] {
  const limit = Math.min(rows.length, maxRows)
  const out: CellValue[][] = new Array(limit)
  for (let i = 0; i < limit; i++) {
    const r = rows[i]
    const nr: CellValue[] = new Array(r.length)
    for (let j = 0; j < r.length; j++) nr[j] = normalizeValue(r[j])
    out[i] = nr
  }
  return out
}
