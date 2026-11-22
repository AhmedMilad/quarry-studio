import Database from 'better-sqlite3'
import { basename } from 'path'
import type {
  CellValue,
  ColumnInfo,
  CompletionTable,
  ForeignKeyInfo,
  IndexInfo,
  ReferencingKey,
  QueryResult,
  RoutineInfo,
  TableInfo,
  TableRef
} from '@shared/types'
import { splitStatements } from '@shared/sql'
import { BaseDriver, normalizeRows, type Exec, type ExecResult } from './base'

export class SqliteDriver extends BaseDriver {
  readonly dialect = 'sqlite' as const
  private db!: Database.Database

  async connect(): Promise<void> {
    const file = this.config.filePath
    if (!file) throw new Error('No SQLite database file selected')
    this.db = new Database(file, { readonly: this.config.readOnly, fileMustExist: false })
    this.db.pragma('foreign_keys = ON')
    this.database = basename(file)
  }

  async disconnect(): Promise<void> {
    this.db?.close()
  }

  private all(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[]
  }

  async serverVersion(): Promise<string> {
    return 'SQLite ' + String(this.all('SELECT sqlite_version() AS v')[0].v)
  }

  async listDatabases(): Promise<string[]> {
    return [this.database]
  }

  async listTables(): Promise<TableInfo[]> {
    return this.all(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name`
    ).map((x) => ({ name: String(x.name), type: x.type === 'view' ? 'view' : 'table' }))
  }

  async listColumns(t: TableRef): Promise<ColumnInfo[]> {
    const info = this.all(`PRAGMA table_info(${this.quote(t.name)})`)
    const pkCount = info.filter((x) => Number(x.pk) > 0).length
    return info.map((x) => ({
      name: String(x.name),
      dataType: String(x.type || 'ANY'),
      nullable: Number(x.notnull) === 0 && Number(x.pk) === 0,
      defaultValue: x.dflt_value === null ? null : String(x.dflt_value),
      primaryKey: Number(x.pk) > 0,
      // an INTEGER PRIMARY KEY aliases rowid and is auto-assigned
      autoIncrement: Number(x.pk) > 0 && pkCount === 1 && /^integer$/i.test(String(x.type)),
      ordinal: Number(x.cid) + 1
    }))
  }

  async listIndexes(t: TableRef): Promise<IndexInfo[]> {
    return this.all(`PRAGMA index_list(${this.quote(t.name)})`).map((x) => ({
      name: String(x.name),
      unique: Number(x.unique) === 1,
      primary: x.origin === 'pk',
      type: String(x.origin),
      columns: this.all(`PRAGMA index_info(${this.quote(String(x.name))})`).map((c) => String(c.name))
    }))
  }

  async listForeignKeys(t: TableRef): Promise<ForeignKeyInfo[]> {
    return this.all(`PRAGMA foreign_key_list(${this.quote(t.name)})`).map((x) => ({
      name: `fk_${t.name}_${x.id}`,
      column: String(x.from),
      refTable: String(x.table),
      refColumn: String(x.to ?? ''),
      onUpdate: String(x.on_update),
      onDelete: String(x.on_delete)
    }))
  }

  async listReferencing(t: TableRef): Promise<ReferencingKey[]> {
    const out: ReferencingKey[] = []
    const tables = this.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    for (const { name } of tables) {
      for (const fk of this.all(`PRAGMA foreign_key_list(${this.quote(String(name))})`)) {
        if (String(fk.table).toLowerCase() !== t.name.toLowerCase()) continue
        out.push({
          name: `fk_${name}_${fk.id}`,
          table: String(name),
          column: String(fk.from),
          refColumn: fk.to === null ? 'rowid' : String(fk.to),
          onDelete: String(fk.on_delete),
          onUpdate: String(fk.on_update)
        })
      }
    }
    return out
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    return []
  }

  async getDDL(t: TableRef): Promise<string> {
    const main = this.all(`SELECT sql FROM sqlite_master WHERE name = ?`, [t.name])[0]?.sql
    const idx = this.all(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, [t.name])
    return [String(main ?? '') + ';', ...idx.map((i) => String(i.sql) + ';')].join('\n\n')
  }

  async completionMeta(): Promise<CompletionTable[]> {
    const tables = await this.listTables()
    return tables.map((t) => ({
      name: t.name,
      columns: this.all(`PRAGMA table_info(${this.quote(t.name)})`).map((c) => String(c.name))
    }))
  }

  protected async runRaw(sql: string, _queryId: string, maxRows: number): Promise<QueryResult[]> {
    const out: QueryResult[] = []
    for (const s of splitStatements(sql)) {
      const started = performance.now()
      const stmt = this.db.prepare(s.text)
      if (stmt.reader) {
        stmt.raw(true)
        const rows = stmt.all() as unknown[][]
        out.push({
          columns: stmt.columns().map((c) => ({ name: c.name, type: c.type ?? undefined })),
          rows: normalizeRows(rows, maxRows),
          rowCount: rows.length,
          truncated: rows.length > maxRows,
          durationMs: Math.round(performance.now() - started)
        })
      } else {
        const info = stmt.run()
        out.push({
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: info.changes,
          command: 'OK',
          durationMs: Math.round(performance.now() - started)
        })
      }
    }
    return out
  }

  exec: Exec = async (sql, params = []) => this.execSync(sql, params)

  private execSync(sql: string, params: CellValue[]): ExecResult {
    const stmt = this.db.prepare(sql)
    const p = params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v))
    if (stmt.reader) {
      stmt.raw(true)
      return {
        columns: stmt.columns().map((c) => ({ name: c.name, type: c.type ?? undefined })),
        rows: normalizeRows(stmt.all(...p) as unknown[][])
      }
    }
    const info = stmt.run(...p)
    return { columns: [], rows: [], affectedRows: info.changes }
  }

  async transaction(fn: (exec: Exec) => Promise<void>): Promise<void> {
    this.db.exec('BEGIN')
    try {
      await fn(async (sql, params = []) => this.execSync(sql, params))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
