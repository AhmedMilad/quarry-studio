import sql from 'mssql'
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
import { splitGoBatches } from '@shared/sql'
import { BaseDriver, normalizeRows, type Exec, type ExecResult } from './base'

interface ColMeta {
  index: number
  name: string
  type?: { declaration?: string }
}

export class MssqlDriver extends BaseDriver {
  readonly dialect = 'mssql' as const
  supportsSchemas = true
  defaultSchema: string | undefined = 'dbo'
  private pool!: sql.ConnectionPool
  private running = new Map<string, sql.Request>()

  async connect(): Promise<void> {
    const c = this.config
    this.pool = new sql.ConnectionPool({
      server: this.target.host,
      port: this.target.port,
      user: c.user || undefined,
      password: c.password || undefined,
      database: this.database || undefined,
      connectionTimeout: 15000,
      requestTimeout: 0,
      pool: { max: 6, min: 0 },
      options: {
        encrypt: c.ssl,
        trustServerCertificate: c.trustServerCertificate ?? !c.sslRejectUnauthorized,
        enableArithAbort: true,
        appName: 'Quarry Studio'
      }
    })
    await this.pool.connect()
    const r = await this.pool.request().query('SELECT DB_NAME() AS db, SCHEMA_NAME() AS s')
    this.database = r.recordset[0].db
    if (r.recordset[0].s) this.defaultSchema = r.recordset[0].s
  }

  async disconnect(): Promise<void> {
    await this.pool?.close().catch(() => undefined)
  }

  private async q(text: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const req = this.pool.request()
    for (const [k, v] of Object.entries(params)) req.input(k, v)
    const r = await req.query(text)
    return r.recordset ?? []
  }

  async serverVersion(): Promise<string> {
    const r = await this.q(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS v, @@VERSION AS full_v`)
    const full = String(r[0].full_v).split('\n')[0].replace(/\s*\(.*$/, '').trim()
    return `${full} (${r[0].v})`
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.q('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name')
    return r.map((x) => String(x.name))
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.q(
      `SELECT s.name FROM sys.schemas s
       WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND s.name NOT LIKE 'db[_]%'
       ORDER BY s.name`
    )
    return r.map((x) => String(x.name))
  }

  async listTables(schema = this.defaultSchema): Promise<TableInfo[]> {
    const r = await this.q(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = @schema ORDER BY TABLE_NAME`,
      { schema }
    )
    return r.map((x) => ({ name: String(x.name), schema, type: String(x.type).includes('VIEW') ? 'view' : 'table' }))
  }

  async listColumns(t: TableRef): Promise<ColumnInfo[]> {
    const schema = t.schema ?? this.defaultSchema
    const r = await this.q(
      `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.CHARACTER_MAXIMUM_LENGTH AS len,
              c.NUMERIC_PRECISION AS prec, c.NUMERIC_SCALE AS scale, c.IS_NULLABLE AS nullable,
              c.COLUMN_DEFAULT AS def, c.ORDINAL_POSITION AS pos,
              COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS ident,
              CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS pk
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN (
         SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
       WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table ORDER BY c.ORDINAL_POSITION`,
      { schema, table: t.name }
    )
    return r.map((x) => {
      let type = String(x.type)
      if (x.len !== null && x.len !== undefined) type += `(${Number(x.len) === -1 ? 'max' : x.len})`
      else if (['decimal', 'numeric'].includes(type)) type += `(${x.prec},${x.scale})`
      return {
        name: String(x.name),
        dataType: type,
        nullable: x.nullable === 'YES',
        defaultValue: x.def === null ? null : String(x.def),
        primaryKey: Number(x.pk) === 1,
        autoIncrement: Number(x.ident) === 1,
        ordinal: Number(x.pos)
      }
    })
  }

  async listIndexes(t: TableRef): Promise<IndexInfo[]> {
    const r = await this.q(
      `SELECT i.name AS name, i.is_unique AS uniq, i.is_primary_key AS prim, i.type_desc AS type, c.name AS col
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@obj) AND i.name IS NOT NULL
       ORDER BY i.name, ic.key_ordinal`,
      { obj: this.qualified({ ...t, schema: t.schema ?? this.defaultSchema }) }
    )
    const map = new Map<string, IndexInfo>()
    for (const x of r) {
      const name = String(x.name)
      if (!map.has(name))
        map.set(name, { name, columns: [], unique: Boolean(x.uniq), primary: Boolean(x.prim), type: String(x.type) })
      map.get(name)!.columns.push(String(x.col))
    }
    return [...map.values()]
  }

  async listForeignKeys(t: TableRef): Promise<ForeignKeyInfo[]> {
    const r = await this.q(
      `SELECT fk.name AS name, pc.name AS col, SCHEMA_NAME(rt.schema_id) AS rschema, rt.name AS rtable, rc.name AS rcol,
              fk.update_referential_action_desc AS upd, fk.delete_referential_action_desc AS del
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       WHERE fk.parent_object_id = OBJECT_ID(@obj)
       ORDER BY fk.name, fkc.constraint_column_id`,
      { obj: this.qualified({ ...t, schema: t.schema ?? this.defaultSchema }) }
    )
    return r.map((x) => ({
      name: String(x.name),
      column: String(x.col),
      refSchema: String(x.rschema),
      refTable: String(x.rtable),
      refColumn: String(x.rcol),
      onUpdate: String(x.upd).replace(/_/g, ' '),
      onDelete: String(x.del).replace(/_/g, ' ')
    }))
  }

  async listReferencing(t: TableRef): Promise<ReferencingKey[]> {
    const r = await this.q(
      `SELECT fk.name AS name, SCHEMA_NAME(pt.schema_id) AS s, pt.name AS t, pc.name AS c, rcol.name AS rc,
              fk.delete_referential_action_desc AS del, fk.update_referential_action_desc AS upd
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.columns rcol ON rcol.object_id = fkc.referenced_object_id AND rcol.column_id = fkc.referenced_column_id
       WHERE fk.referenced_object_id = OBJECT_ID(@obj)
       ORDER BY pt.name, fk.name`,
      { obj: this.qualified({ ...t, schema: t.schema ?? this.defaultSchema }) }
    )
    return r.map((x) => ({
      name: String(x.name),
      schema: String(x.s),
      table: String(x.t),
      column: String(x.c),
      refColumn: String(x.rc),
      onDelete: String(x.del).replace(/_/g, ' '),
      onUpdate: String(x.upd).replace(/_/g, ' ')
    }))
  }

  async listRoutines(schema = this.defaultSchema): Promise<RoutineInfo[]> {
    const r = await this.q(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM INFORMATION_SCHEMA.ROUTINES
       WHERE ROUTINE_SCHEMA = @schema ORDER BY ROUTINE_NAME`,
      { schema }
    )
    return r.map((x) => ({ name: String(x.name), schema, type: x.type === 'PROCEDURE' ? 'procedure' : 'function' }))
  }

  async getDDL(t: TableRef, kind: 'table' | 'view'): Promise<string> {
    const ref = { ...t, schema: t.schema ?? this.defaultSchema }
    if (kind === 'view') {
      const r = await this.q('SELECT OBJECT_DEFINITION(OBJECT_ID(@obj)) AS def', { obj: this.qualified(ref) })
      return String(r[0]?.def ?? '')
    }
    const cols = await this.listColumns(ref)
    const idx = await this.listIndexes(ref)
    const fks = await this.listForeignKeys(ref)
    const lines = cols.map(
      (c) =>
        `  ${this.quote(c.name)} ${c.dataType}${c.autoIncrement ? ' IDENTITY(1,1)' : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${
          c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''
        }`
    )
    const pk = idx.find((i) => i.primary)
    if (pk) lines.push(`  CONSTRAINT ${this.quote(pk.name)} PRIMARY KEY (${pk.columns.map((c) => this.quote(c)).join(', ')})`)
    const fkGroups = new Map<string, ForeignKeyInfo[]>()
    for (const f of fks) fkGroups.set(f.name, [...(fkGroups.get(f.name) ?? []), f])
    for (const [name, group] of fkGroups) {
      const f = group[0]
      lines.push(
        `  CONSTRAINT ${this.quote(name)} FOREIGN KEY (${group.map((g) => this.quote(g.column)).join(', ')}) REFERENCES ${this.quote(
          f.refSchema!
        )}.${this.quote(f.refTable)} (${group.map((g) => this.quote(g.refColumn)).join(', ')})`
      )
    }
    let ddl = `CREATE TABLE ${this.qualified(ref)} (\n${lines.join(',\n')}\n);`
    for (const i of idx.filter((x) => !x.primary)) {
      ddl += `\n\nCREATE ${i.unique ? 'UNIQUE ' : ''}${i.type === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${this.quote(
        i.name
      )} ON ${this.qualified(ref)} (${i.columns.map((c) => this.quote(c)).join(', ')});`
    }
    return ddl
  }

  async completionMeta(): Promise<CompletionTable[]> {
    const r = await this.q(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
    )
    const map = new Map<string, CompletionTable>()
    for (const x of r) {
      const key = `${x.s}.${x.t}`
      if (!map.has(key)) map.set(key, { name: String(x.t), schema: String(x.s), columns: [] })
      map.get(key)!.columns.push(String(x.c))
    }
    return [...map.values()]
  }

  protected async runRaw(text: string, queryId: string, maxRows: number): Promise<QueryResult[]> {
    const out: QueryResult[] = []
    for (const batch of splitGoBatches(text)) {
      const req = this.pool.request()
      req.arrayRowMode = true
      this.running.set(queryId, req)
      const started = performance.now()
      try {
        const r = (await req.query(batch)) as unknown as {
          recordsets: unknown[][][]
          columns?: ColMeta[][]
          rowsAffected: number[]
        }
        const durationMs = Math.round(performance.now() - started)
        const sets = r.recordsets ?? []
        if (sets.length) {
          sets.forEach((rows, i) => {
            const meta = r.columns?.[i] ?? []
            out.push({
              columns: meta.map((m) => ({ name: m.name, type: m.type?.declaration })),
              rows: normalizeRows(rows, maxRows),
              rowCount: rows.length,
              truncated: rows.length > maxRows,
              durationMs
            })
          })
        } else {
          out.push({
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: (r.rowsAffected ?? []).reduce((a, b) => a + b, 0),
            command: 'OK',
            durationMs
          })
        }
      } finally {
        this.running.delete(queryId)
      }
    }
    return out
  }

  async cancel(queryId: string): Promise<void> {
    this.running.get(queryId)?.cancel()
  }

  private async execOn(req: sql.Request, text: string, params: CellValue[]): Promise<ExecResult> {
    params.forEach((p, i) => req.input(`p${i + 1}`, p))
    req.arrayRowMode = true
    const r = (await req.query(text)) as unknown as {
      recordset?: unknown[][]
      columns?: ColMeta[][]
      rowsAffected: number[]
    }
    const meta = r.columns?.[0] ?? []
    const columns: ResultColumn[] = meta.map((m) => ({ name: m.name, type: m.type?.declaration }))
    return {
      columns,
      rows: normalizeRows(r.recordset ?? []),
      affectedRows: (r.rowsAffected ?? []).reduce((a, b) => a + b, 0)
    }
  }

  exec: Exec = async (text, params = []) => this.execOn(this.pool.request(), text, params)

  async transaction(fn: (exec: Exec) => Promise<void>): Promise<void> {
    const tx = new sql.Transaction(this.pool)
    await tx.begin()
    try {
      await fn((text, params = []) => this.execOn(new sql.Request(tx), text, params))
      await tx.commit()
    } catch (e) {
      await tx.rollback().catch(() => undefined)
      throw e
    }
  }
}
