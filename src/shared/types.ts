export type DbType = 'mysql' | 'mariadb' | 'postgres' | 'cockroach' | 'redshift' | 'sqlite' | 'mssql'

export const DB_TYPES: { value: DbType; label: string; port: number; dialect: Dialect }[] = [
  { value: 'mysql', label: 'MySQL', port: 3306, dialect: 'mysql' },
  { value: 'mariadb', label: 'MariaDB', port: 3306, dialect: 'mysql' },
  { value: 'postgres', label: 'PostgreSQL', port: 5432, dialect: 'postgres' },
  { value: 'cockroach', label: 'CockroachDB', port: 26257, dialect: 'postgres' },
  { value: 'redshift', label: 'Amazon Redshift', port: 5439, dialect: 'postgres' },
  { value: 'mssql', label: 'SQL Server', port: 1433, dialect: 'mssql' },
  { value: 'sqlite', label: 'SQLite', port: 0, dialect: 'sqlite' }
]

export type Dialect = 'mysql' | 'postgres' | 'sqlite' | 'mssql'

export function dialectOf(t: DbType): Dialect {
  return DB_TYPES.find((d) => d.value === t)!.dialect
}

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  authMethod: 'password' | 'key' | 'agent'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export interface ConnectionConfig {
  id: string
  name: string
  type: DbType
  color: string
  host: string
  port: number
  user: string
  password?: string
  database: string
  filePath?: string
  ssl: boolean
  sslRejectUnauthorized: boolean
  trustServerCertificate?: boolean
  readOnly: boolean
  ssh: SshConfig
  createdAt?: number
  lastUsedAt?: number
}

export type CellValue = string | number | boolean | null

export interface ResultColumn {
  name: string
  type?: string
}

export interface QueryResult {
  columns: ResultColumn[]
  rows: CellValue[][]
  rowCount: number
  affectedRows?: number
  command?: string
  durationMs: number
  truncated?: boolean
}

export interface TableInfo {
  name: string
  schema?: string
  type: 'table' | 'view'
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  primaryKey: boolean
  autoIncrement?: boolean
  comment?: string
  ordinal: number
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  type?: string
}

export interface ForeignKeyInfo {
  name: string
  column: string
  refSchema?: string
  refTable: string
  refColumn: string
  onUpdate?: string
  onDelete?: string
}

/** a foreign key in another table that points at the table being changed */
export interface ReferencingKey {
  name: string
  table: string
  schema?: string
  column: string
  refColumn: string
  onDelete: string
  onUpdate?: string
  /** rows in the referencing table that point at the rows being deleted (when it could be counted) */
  affected?: number | null
}

export interface DestructiveCheck {
  index: number
  kind: 'delete' | 'update' | 'truncate' | 'drop-table' | 'drop-database'
  sql: string
  table?: string
  hasWhere: boolean
  where?: string
  limit?: number
  approximate?: boolean
  note?: string
  count: number | null
  countError?: string
  total: number | null
  preview?: { columns: ResultColumn[]; rows: CellValue[][] }
  referencedBy: ReferencingKey[]
  /** UPDATE: the SET list */
  assignments?: { column: string; expr: string }[]
  /** UPDATE: matched rows whose values would actually change (null = unknown) */
  changing?: number | null
  /** UPDATE: before → after for the first matched rows */
  diff?: { key: string; changes: { column: string; before: CellValue; after: CellValue }[] }[]
  /** problems detected up front (NOT NULL, unique, unknown column …) */
  warnings: string[]
  /** the statement touches every row of the table */
  matchesAll: boolean
}

export interface RoutineInfo {
  name: string
  schema?: string
  type: 'function' | 'procedure'
}

export interface TableRef {
  name: string
  schema?: string
}

export interface FilterCondition {
  column: string
  op: string
  value: string
}

/** Operators that don't take a value; every other operator is skipped when its value is empty */
const NO_VALUE_OPS = new Set(['IS NULL', 'IS NOT NULL'])

export function filterNeedsValue(op: string): boolean {
  return !NO_VALUE_OPS.has(op.toUpperCase())
}

/** A builder line counts only when it has a column and, unless its operator needs no value, a non-blank value */
export function isActiveFilter(f: FilterCondition): boolean {
  if (!f.column) return false
  return !filterNeedsValue(f.op) || f.value.trim() !== ''
}

export interface SelectOptions {
  limit: number
  offset: number
  orderBy?: { column: string; dir: 'ASC' | 'DESC' }[]
  where?: string
  filters?: FilterCondition[]
  /** how builder filters are combined (default AND) */
  filterJoin?: 'AND' | 'OR'
}

export interface SelectResult {
  columns: ResultColumn[]
  rows: CellValue[][]
  totalCount: number | null
}

export interface RowChanges {
  table: TableRef
  primaryKeys: string[]
  updates: { pk: Record<string, CellValue>; values: Record<string, CellValue> }[]
  inserts: Record<string, CellValue>[]
  deletes: Record<string, CellValue>[]
}

export interface CompletionTable {
  name: string
  schema?: string
  columns: string[]
}

export interface SessionInfo {
  sessionId: string
  config: ConnectionConfig
  dialect: Dialect
  currentDatabase: string
  serverVersion: string
  supportsSchemas: boolean
  defaultSchema?: string
}

export interface HistoryEntry {
  id: string
  sql: string
  connectionName: string
  database: string
  executedAt: number
  durationMs: number
  success: boolean
  error?: string
}

export interface SavedQuery {
  id: string
  title: string
  sql: string
  connectionId?: string
  createdAt: number
  updatedAt: number
}

export type ExportFormat = 'csv' | 'json' | 'sql' | 'markdown' | 'xlsx'
/** formats that produce text (usable for copy-to-clipboard) */
export type TextExportFormat = Exclude<ExportFormat, 'xlsx'>

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  pageSize: number
  editorFontSize: number
  maxResultRows: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  pageSize: 100,
  editorFontSize: 14,
  maxResultRows: 50000
}
