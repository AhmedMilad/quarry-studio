import pg from 'pg'
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
import { BaseDriver, normalizeRows, type Exec, type ExecResult } from './base'

// Keep temporal and numeric types as the server renders them, to avoid timezone / precision surprises
const RAW_OIDS = new Set([1082, 1083, 1114, 1184, 1266, 1186, 20, 1700, 790])
const customTypes = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') => {
    if (RAW_OIDS.has(oid)) return (v: string) => v
    return pg.types.getTypeParser(oid, format as 'text')
  }
}

type PgResult = pg.QueryArrayResult<unknown[]>

export class PostgresDriver extends BaseDriver {
  readonly dialect = 'postgres' as const
  supportsSchemas = true
  defaultSchema: string | undefined = 'public'
  private pool!: pg.Pool
  private running = new Map<string, number>()
  private typeNames = new Map<number, string>()

  async connect(): Promise<void> {
    const c = this.config
    this.pool = new pg.Pool({
      host: this.target.host,
      port: this.target.port,
      user: c.user || undefined,
      password: c.password || undefined,
      database: this.database || (c.type === 'redshift' ? 'dev' : 'postgres'),
      ssl: c.ssl ? { rejectUnauthorized: c.sslRejectUnauthorized } : undefined,
      max: 6,
      connectionTimeoutMillis: 15000,
      types: customTypes,
      application_name: 'Quarry Studio'
    })
    this.pool.on('error', () => undefined)
    const client = await this.pool.connect()
    try {
      const r = await client.query('SELECT current_database() AS db, current_schema() AS s')
      this.database = r.rows[0].db
      if (r.rows[0].s) this.defaultSchema = r.rows[0].s
    } finally {
      client.release()
    }
    this.loadTypeNames().catch(() => undefined)
  }

  private async loadTypeNames(): Promise<void> {
    const r = await this.pool.query('SELECT oid, typname FROM pg_type')
    for (const row of r.rows) this.typeNames.set(Number(row.oid), String(row.typname))
  }

  async disconnect(): Promise<void> {
    await this.pool?.end().catch(() => undefined)
  }

  private async q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const r = await this.pool.query(sql, params)
    return r.rows
  }

  async serverVersion(): Promise<string> {
    const r = await this.q('SELECT version() AS v')
    return String(r[0].v).split(' on ')[0].replace(/,.*$/, '')
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.q('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')
    return r.map((x) => String(x.datname))
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.q(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name NOT IN ('information_schema','crdb_internal')
       ORDER BY schema_name`
    )
    return r.map((x) => String(x.schema_name))
  }

  async listTables(schema = this.defaultSchema): Promise<TableInfo[]> {
    const r = await this.q(
      `SELECT table_name AS name, table_type AS type FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema]
    )
    const tables: TableInfo[] = r.map((x) => ({
      name: String(x.name),
      schema,
      type: String(x.type).includes('VIEW') ? 'view' : 'table'
    }))
    if (this.config.type === 'postgres') {
      try {
        const mv = await this.q('SELECT matviewname AS name FROM pg_matviews WHERE schemaname = $1 ORDER BY 1', [schema])
        for (const m of mv) tables.push({ name: String(m.name), schema, type: 'view' })
      } catch {
        /* ignore */
      }
    }
    return tables
  }

  async listColumns(t: TableRef): Promise<ColumnInfo[]> {
    const schema = t.schema ?? this.defaultSchema
    const r = await this.q(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS def, a.attnum AS pos,
              EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk,
              col_description(c.oid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE c.relname = $1 AND n.nspname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [t.name, schema]
    )
    return r.map((x) => ({
      name: String(x.name),
      dataType: String(x.type),
      nullable: Boolean(x.nullable),
      defaultValue: x.def === null ? null : String(x.def),
      primaryKey: Boolean(x.pk),
      autoIncrement: String(x.def ?? '').startsWith('nextval(') || /unique_rowid/.test(String(x.def ?? '')),
      comment: x.comment ? String(x.comment) : undefined,
      ordinal: Number(x.pos)
    }))
  }

  async listIndexes(t: TableRef): Promise<IndexInfo[]> {
    try {
      const r = await this.q(
        `SELECT i.relname AS name, ix.indisunique AS uniq, ix.indisprimary AS prim, am.amname AS type,
                array_to_string(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                  FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k), ',') AS cols
         FROM pg_index ix
         JOIN pg_class tc ON tc.oid = ix.indrelid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = tc.relnamespace
         JOIN pg_am am ON am.oid = i.relam
         WHERE tc.relname = $1 AND n.nspname = $2 ORDER BY i.relname`,
        [t.name, t.schema ?? this.defaultSchema]
      )
      return r.map((x) => ({
        name: String(x.name),
        columns: String(x.cols).split(','),
        unique: Boolean(x.uniq),
        primary: Boolean(x.prim),
        type: String(x.type)
      }))
    } catch {
      return []
    }
  }

  async listForeignKeys(t: TableRef): Promise<ForeignKeyInfo[]> {
    try {
      const r = await this.q(
        `SELECT con.conname AS name, att.attname AS col, rn.nspname AS rschema, rc.relname AS rtable,
                ratt.attname AS rcol, con.confupdtype AS upd, con.confdeltype AS del
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, rcol, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.col
         JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = k.rcol
         WHERE con.contype = 'f' AND c.relname = $1 AND n.nspname = $2
         ORDER BY con.conname, k.ord`,
        [t.name, t.schema ?? this.defaultSchema]
      )
      const rule: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
      return r.map((x) => ({
        name: String(x.name),
        column: String(x.col),
        refSchema: String(x.rschema),
        refTable: String(x.rtable),
        refColumn: String(x.rcol),
        onUpdate: rule[String(x.upd)],
        onDelete: rule[String(x.del)]
      }))
    } catch {
      return []
    }
  }

  async listReferencing(t: TableRef): Promise<ReferencingKey[]> {
    const rule: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
    try {
      const r = await this.q(
        `SELECT con.conname AS name, n.nspname AS s, c.relname AS t, att.attname AS col, ratt.attname AS rcol,
                con.confdeltype AS del, con.confupdtype AS upd
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = con.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(col, rcol)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.col
         JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = k.rcol
         WHERE con.contype = 'f' AND rc.relname = $1 AND rn.nspname = $2
         ORDER BY c.relname, con.conname`,
        [t.name, t.schema ?? this.defaultSchema]
      )
      return r.map((x) => ({
        name: String(x.name),
        schema: String(x.s),
        table: String(x.t),
        column: String(x.col),
        refColumn: String(x.rcol),
        onDelete: rule[String(x.del)] ?? String(x.del),
        onUpdate: rule[String(x.upd)] ?? String(x.upd)
      }))
    } catch {
      return []
    }
  }

  async listRoutines(schema = this.defaultSchema): Promise<RoutineInfo[]> {
    try {
      const r = await this.q(
        `SELECT DISTINCT routine_name AS name, routine_type AS type FROM information_schema.routines
         WHERE routine_schema = $1 ORDER BY routine_name`,
        [schema]
      )
      return r.map((x) => ({ name: String(x.name), schema, type: x.type === 'PROCEDURE' ? 'procedure' : 'function' }))
    } catch {
      return []
    }
  }

  async getDDL(t: TableRef, kind: 'table' | 'view'): Promise<string> {
    const schema = t.schema ?? this.defaultSchema!
    if (this.config.type === 'cockroach') {
      const r = await this.q(`SHOW CREATE ${this.qualified({ ...t, schema })}`)
      return String(r[0].create_statement)
    }
    if (kind === 'view') {
      const r = await this.q(
        `SELECT pg_get_viewdef(c.oid, true) AS def, c.relkind AS kind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = $2`,
        [t.name, schema]
      )
      const mat = r[0]?.kind === 'm' ? 'MATERIALIZED ' : ''
      return `CREATE OR REPLACE ${mat}VIEW ${this.qualified({ ...t, schema })} AS\n${r[0]?.def ?? ''}`
    }
    const cols = await this.listColumns({ ...t, schema })
    const cons = await this.q(
      `SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS def FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = $1 AND n.nspname = $2 ORDER BY con.contype DESC, con.conname`,
      [t.name, schema]
    )
    const idx = await this.q(
      `SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = $2
       AND indexname NOT IN (SELECT conname FROM pg_constraint)`,
      [t.name, schema]
    )
    const lines = cols.map(
      (c) =>
        `  ${this.quote(c.name)} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}${
          c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''
        }`
    )
    for (const c of cons) lines.push(`  CONSTRAINT ${this.quote(String(c.name))} ${c.def}`)
    let ddl = `CREATE TABLE ${this.qualified({ ...t, schema })} (\n${lines.join(',\n')}\n);`
    for (const i of idx) ddl += `\n\n${i.indexdef};`
    return ddl
  }

  async completionMeta(schema = this.defaultSchema): Promise<CompletionTable[]> {
    const r = await this.q(
      `SELECT table_schema AS s, table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema','crdb_internal','pg_extension')
       ORDER BY table_schema = $1 DESC, table_schema, table_name, ordinal_position LIMIT 50000`,
      [schema]
    )
    const map = new Map<string, CompletionTable>()
    for (const x of r) {
      const key = `${x.s}.${x.t}`
      if (!map.has(key)) map.set(key, { name: String(x.t), schema: String(x.s), columns: [] })
      map.get(key)!.columns.push(String(x.c))
    }
    return [...map.values()]
  }

  private typeName(oid: number): string | undefined {
    return this.typeNames.get(oid)
  }

  protected async runRaw(sql: string, queryId: string, maxRows: number): Promise<QueryResult[]> {
    const client = await this.pool.connect()
    const pid = (client as unknown as { processID: number }).processID
    this.running.set(queryId, pid)
    const started = performance.now()
    try {
      const res = (await client.query({ text: sql, rowMode: 'array' })) as PgResult | PgResult[]
      const durationMs = Math.round(performance.now() - started)
      const list = Array.isArray(res) ? res : [res]
      return list.map((r) => {
        const isSelect = r.fields && r.fields.length > 0
        if (isSelect) {
          return {
            columns: r.fields.map((f) => ({ name: f.name, type: this.typeName(f.dataTypeID) })),
            rows: normalizeRows(r.rows as unknown[][], maxRows),
            rowCount: r.rows.length,
            truncated: r.rows.length > maxRows,
            command: r.command,
            durationMs
          }
        }
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          affectedRows: r.rowCount ?? 0,
          command: r.command,
          durationMs
        }
      })
    } finally {
      this.running.delete(queryId)
      client.release()
    }
  }

  async cancel(queryId: string): Promise<void> {
    const pid = this.running.get(queryId)
    if (pid) await this.pool.query('SELECT pg_cancel_backend($1)', [pid])
  }

  private toExec(r: PgResult): ExecResult {
    return {
      columns: (r.fields ?? []).map((f) => ({ name: f.name, type: this.typeName(f.dataTypeID) })),
      rows: normalizeRows(r.rows as unknown[][]),
      affectedRows: r.rowCount ?? undefined
    }
  }

  exec: Exec = async (sql, params = []) => {
    const r = await this.pool.query({ text: sql, values: params, rowMode: 'array' })
    return this.toExec(r as PgResult)
  }

  async transaction(fn: (exec: Exec) => Promise<void>): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await fn(async (sql, params: CellValue[] = []) => {
        const r = await client.query({ text: sql, values: params, rowMode: 'array' })
        return this.toExec(r as PgResult)
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    } finally {
      client.release()
    }
  }
}
