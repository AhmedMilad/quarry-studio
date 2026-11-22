import type {
  AppSettings,
  CellValue,
  ColumnInfo,
  CompletionTable,
  ConnectionConfig,
  DestructiveCheck,
  Dialect,
  ExportFormat,
  ForeignKeyInfo,
  HistoryEntry,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  RowChanges,
  SavedQuery,
  SelectOptions,
  SelectResult,
  SessionInfo,
  TableInfo,
  TableRef
} from '@shared/types'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.bridge.invoke(channel, ...args)
  if (!r.ok) throw new Error(r.error)
  return r.data as T
}

type FileFilter = { name: string; extensions: string[] }

export const api = {
  listConnections: () => call<ConnectionConfig[]>('connections:list'),
  saveConnection: (c: ConnectionConfig) => call<ConnectionConfig>('connections:save', c),
  deleteConnection: (id: string) => call<void>('connections:delete', id),
  testConnection: (c: ConnectionConfig) => call<string>('connections:test', c),

  openSession: (c: ConnectionConfig) => call<SessionInfo>('session:open', c),
  closeSession: (id: string) => call<void>('session:close', id),
  useDatabase: (id: string, db: string) => call<SessionInfo>('session:useDatabase', id, db),

  listDatabases: (id: string) => call<string[]>('db:listDatabases', id),
  listSchemas: (id: string) => call<string[]>('db:listSchemas', id),
  listTables: (id: string, schema?: string) => call<TableInfo[]>('db:listTables', id, schema),
  listColumns: (id: string, t: TableRef) => call<ColumnInfo[]>('db:listColumns', id, t),
  listIndexes: (id: string, t: TableRef) => call<IndexInfo[]>('db:listIndexes', id, t),
  listForeignKeys: (id: string, t: TableRef) => call<ForeignKeyInfo[]>('db:listForeignKeys', id, t),
  listRoutines: (id: string, schema?: string) => call<RoutineInfo[]>('db:listRoutines', id, schema),
  getDDL: (id: string, t: TableRef, kind: 'table' | 'view') => call<string>('db:getDDL', id, t, kind),
  completion: (id: string, schema?: string) => call<CompletionTable[]>('db:completion', id, schema),

  query: (id: string, sql: string, queryId: string) => call<QueryResult[]>('db:query', id, sql, queryId),
  cancel: (id: string, queryId: string) => call<void>('db:cancel', id, queryId),
  checkDestructive: (id: string, sql: string) => call<DestructiveCheck[]>('db:checkDestructive', id, sql),
  select: (id: string, t: TableRef, o: SelectOptions) => call<SelectResult>('db:select', id, t, o),
  applyChanges: (id: string, c: RowChanges) => call<void>('db:applyChanges', id, c),
  drop: (id: string, t: TableRef, kind: 'table' | 'view') => call<void>('db:drop', id, t, kind),
  truncate: (id: string, t: TableRef) => call<void>('db:truncate', id, t),

  exportRows: (p: {
    format: ExportFormat
    columns: string[]
    rows: CellValue[][]
    name: string
    tableName?: string
    dialect?: Dialect
  }) => call<string | null>('export:rows', p),
  exportTable: (id: string, t: TableRef, format: ExportFormat, opts: Pick<SelectOptions, 'where' | 'filters' | 'filterJoin' | 'orderBy'>) =>
    call<string | null>('export:table', id, t, format, opts),

  listHistory: () => call<HistoryEntry[]>('history:list'),
  clearHistory: () => call<void>('history:clear'),
  listSaved: () => call<SavedQuery[]>('saved:list'),
  saveQuery: (q: Partial<SavedQuery> & { title: string; sql: string }) => call<SavedQuery>('saved:save', q),
  deleteSaved: (id: string) => call<void>('saved:delete', id),
  getSettings: () => call<AppSettings>('settings:get'),
  setSettings: (s: Partial<AppSettings>) => call<AppSettings>('settings:set', s),

  openFile: (opts: { title?: string; filters?: FileFilter[] } = {}) => call<string | null>('dialog:openFile', opts),
  saveFile: (opts: { title?: string; defaultPath?: string; filters?: FileFilter[] } = {}) =>
    call<string | null>('dialog:saveFile', opts),
  confirm: (message: string, detail?: string, okLabel?: string) =>
    call<boolean>('dialog:confirm', { message, detail, okLabel }),
  openExternal: (url: string) => call<void>('app:openExternal', url)
}
