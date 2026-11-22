import mysql from 'mysql2/promise'
import type { FieldPacket, Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise'
import type {
  CellValue,
  ColumnInfo,
  CompletionTable,
  ForeignKeyInfo,
  IndexInfo,
  ReferencingKey,
  QueryResult,
  ResultColumn,
  RoutineInfo,
  TableInfo,
  TableRef
} from '@shared/types'
import { BaseDriver, normalizeRows, type Exec, type ExecResult } from './base'

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries((mysql as unknown as { Types: Record<string, number> }).Types ?? {}).map(([k, v]) => [v, k.toLowerCase()])
)

export class MysqlDriver extends BaseDriver {
  readonly dialect = 'mysql' as const
  private pool!: Pool
  private running = new Map<string, number>()

  async connect(): Promise<void> {
    const c = this.config
    this.pool = mysql.createPool({
      host: this.target.host,
      port: this.target.port,
      user: c.user || undefined,
      password: c.password || undefined,
      database: this.database || undefined,
      ssl: c.ssl ? { rejectUnauthorized: c.sslRejectUnauthorized } : undefined,
      multipleStatements: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectionLimit: 6,
      connectTimeout: 15000,
      charset: 'utf8mb4'
    })
    const conn = await this.pool.getConnection()
    conn.release()
  }

  async disconnect(): Promise<void> {
    await this.pool?.end().catch(() => undefined)
  }

  private async q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const [rows] = await this.pool.query(sql, params)
    return rows as Record<string, unknown>[]
  }

  async serverVersion(): Promise<string> {
    const r = await this.q('SELECT VERSION() AS v')
    return String(r[0].v)
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.q('SHOW DATABASES')
    return r.map((x) => String(Object.values(x)[0]))
  }

  async listTables(): Promise<TableInfo[]> {
    if (!this.database) return []
    const r = await this.q(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [this.database]
    )
    return r.map((x) => ({ name: String(x.name), type: String(x.type).includes('VIEW') ? 'view' : 'table' }))
  }

  async listColumns(t: TableRef): Promise<ColumnInfo[]> {
    const r = await this.q(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def,
              COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment, ORDINAL_POSITION AS pos
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [this.database, t.name]
    )
    return r.map((x) => ({
      name: String(x.name),
      dataType: String(x.type),
      nullable: x.nullable === 'YES',
      defaultValue: x.def === null ? null : String(x.def),
      primaryKey: x.ckey === 'PRI',
      autoIncrement: String(x.extra).includes('auto_increment'),
      comment: x.comment ? String(x.comment) : undefined,
      ordinal: Number(x.pos)
    }))
  }

  async listIndexes(t: TableRef): Promise<IndexInfo[]> {
    const r = await this.q(`SHOW INDEX FROM ${this.qualified(t)}`)
    const map = new Map<string, IndexInfo>()
    for (const x of r) {
      const name = String(x.Key_name)
      if (!map.has(name)) {
        map.set(name, {
          name,
          columns: [],
          unique: Number(x.Non_unique) === 0,
          primary: name === 'PRIMARY',
          type: String(x.Index_type)
        })
      }
      map.get(name)!.columns.push(String(x.Column_name ?? x.Expression))
    }
    return [...map.values()]
  }

  async listForeignKeys(t: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.q(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rschema,
              k.REFERENCED_TABLE_NAME AS rtable, k.REFERENCED_COLUMN_NAME AS rcol,
              rc.UPDATE_RULE AS onUpdate, rc.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [this.database, t.name]
    )
    return r.map((x) => ({
      name: String(x.name),
      column: String(x.col),
      refSchema: String(x.rschema),
      refTable: String(x.rtable),
      refColumn: String(x.rcol),
      onUpdate: String(x.onUpdate),
      onDelete: String(x.onDelete)
    }))
  }

  async listReferencing(t: TableRef): Promise<ReferencingKey[]> {
    const r = await this.q(
      `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS s, k.TABLE_NAME AS t, k.COLUMN_NAME AS c,
              k.REFERENCED_COLUMN_NAME AS rc, rc.DELETE_RULE AS del, rc.UPDATE_RULE AS upd
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME`,
      [t.schema ?? this.database, t.name]
    )
    return r.map((x) => ({
      name: String(x.name),
      schema: String(x.s),
      table: String(x.t),
      column: String(x.c),
      refColumn: String(x.rc),
      onDelete: String(x.del),
      onUpdate: String(x.upd)
    }))
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    if (!this.database) return []
    const r = await this.q(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
      [this.database]
    )
    return r.map((x) => ({ name: String(x.name), type: x.type === 'PROCEDURE' ? 'procedure' : 'function' }))
  }

  async getDDL(t: TableRef, kind: 'table' | 'view'): Promise<string> {
    const r = await this.q(`SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${this.qualified(t)}`)
    const row = r[0]
    return String(row['Create Table'] ?? row['Create View'] ?? Object.values(row)[1])
  }

  async completionMeta(): Promise<CompletionTable[]> {
    if (!this.database) return []
    const r = await this.q(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [this.database]
    )
    const map = new Map<string, string[]>()
    for (const x of r) {
      const t = String(x.t)
      if (!map.has(t)) map.set(t, [])
      map.get(t)!.push(String(x.c))
    }
    return [...map.entries()].map(([name, columns]) => ({ name, columns }))
  }

  protected async runRaw(sql: string, queryId: string, maxRows: number): Promise<QueryResult[]> {
    const conn: PoolConnection = await this.pool.getConnection()
    this.running.set(queryId, conn.threadId)
    const started = performance.now()
    try {
      const [res, fields] = await conn.query({ sql, rowsAsArray: true })
      const durationMs = Math.round(performance.now() - started)
      const f = fields as unknown
      const isMulti =
        Array.isArray(res) && Array.isArray(f) && (f.length === 0 || f[0] === undefined || Array.isArray(f[0]))
      const items: { res: unknown; fields?: FieldPacket[] }[] = isMulti
        ? (res as unknown[]).map((r, i) => ({ res: r, fields: (f as (FieldPacket[] | undefined)[])[i] }))
        : [{ res, fields: f as FieldPacket[] | undefined }]
      return items.map(({ res: r, fields: fp }) => {
        if (Array.isArray(r) && fp) {
          return {
            columns: fp.map((x) => ({ name: x.name, type: TYPE_NAMES[x.type ?? -1] })),
            rows: normalizeRows(r as unknown[][], maxRows),
            rowCount: r.length,
            truncated: r.length > maxRows,
            durationMs
          }
        }
        const h = r as ResultSetHeader
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: h?.affectedRows ?? 0,
          command: 'OK',
          durationMs
        }
      })
    } finally {
      this.running.delete(queryId)
      conn.release()
    }
  }

  async cancel(queryId: string): Promise<void> {
    const tid = this.running.get(queryId)
    if (tid) await this.pool.query(`KILL QUERY ${Number(tid)}`)
  }

  exec: Exec = async (sql, params = []) => {
    const [res, fields] = await this.pool.query({ sql, rowsAsArray: true }, params)
    return toExec(res, fields as FieldPacket[] | undefined)
  }

  async transaction(fn: (exec: Exec) => Promise<void>): Promise<void> {
    const conn = await this.pool.getConnection()
    try {
      await conn.beginTransaction()
      await fn(async (sql, params: CellValue[] = []) => {
        const [res, fields] = await conn.query({ sql, rowsAsArray: true }, params)
        return toExec(res, fields as FieldPacket[] | undefined)
      })
      await conn.commit()
    } catch (e) {
      await conn.rollback().catch(() => undefined)
      throw e
    } finally {
      conn.release()
    }
  }
}

function toExec(res: unknown, fields: FieldPacket[] | undefined): ExecResult {
  if (Array.isArray(res) && fields) {
    const columns: ResultColumn[] = fields.map((x) => ({ name: x.name, type: TYPE_NAMES[x.type ?? -1] }))
    return { columns, rows: normalizeRows(res as unknown[][]) }
  }
  return { columns: [], rows: [], affectedRows: (res as ResultSetHeader)?.affectedRows }
}
