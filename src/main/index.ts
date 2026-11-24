import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import type {
  ConnectionConfig,
  ExportFormat,
  RowChanges,
  SelectOptions,
  SessionInfo,
  TableRef,
  CellValue,
  Dialect
} from '@shared/types'
import { formatRows } from '@shared/export'
import { checkDestructive } from './destructive-check'
import { buildXlsx, XLSX_ROW_LIMIT } from './xlsx'
import { createDriver, type BaseDriver } from './drivers'
import { openTunnel, type Tunnel } from './tunnel'
import * as store from './store'

interface Session {
  id: string
  config: ConnectionConfig
  driver: BaseDriver
  tunnel?: Tunnel
  version: string
}

const sessions = new Map<string, Session>()
let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Quarry Studio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#ffffff',
    autoHideMenuBar: true,
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

async function openDriver(config: ConnectionConfig, database?: string): Promise<{ driver: BaseDriver; tunnel?: Tunnel }> {
  let tunnel: Tunnel | undefined
  let target = { host: config.host || 'localhost', port: config.port }
  if (config.type !== 'sqlite' && config.ssh?.enabled) {
    tunnel = await openTunnel(config.ssh, target.host, target.port)
    target = { host: '127.0.0.1', port: tunnel.localPort }
  }
  const driver = createDriver(config, database ?? config.database, target)
  try {
    await driver.connect()
  } catch (e) {
    tunnel?.close()
    throw e
  }
  return { driver, tunnel }
}

async function sessionInfo(s: Session): Promise<SessionInfo> {
  return {
    sessionId: s.id,
    config: s.config,
    dialect: s.driver.dialect,
    currentDatabase: s.driver.database,
    serverVersion: s.version,
    supportsSchemas: s.driver.supportsSchemas,
    defaultSchema: s.driver.defaultSchema
  }
}

function getSession(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new Error('Connection is closed. Please reconnect.')
  return s
}

async function closeSession(s: Session): Promise<void> {
  sessions.delete(s.id)
  await s.driver.disconnect().catch(() => undefined)
  s.tunnel?.close()
}

/** Wrap handlers so errors reach the renderer with their original message */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      const err = e as Error & { code?: string }
      return { ok: false, error: err?.message || String(e) || 'Unknown error', code: err?.code }
    }
  })
}

const EXPORT_FILE: Record<ExportFormat, { ext: string; label: string }> = {
  csv: { ext: 'csv', label: 'CSV' },
  json: { ext: 'json', label: 'JSON' },
  sql: { ext: 'sql', label: 'SQL' },
  markdown: { ext: 'md', label: 'Markdown' },
  xlsx: { ext: 'xlsx', label: 'Excel Workbook' }
}

/** Ask where to save, then write rows in the chosen format. Returns the path, or null if cancelled. */
async function exportToFile(
  defaultName: string,
  format: ExportFormat,
  columns: string[],
  rows: CellValue[][],
  opts: { tableName?: string; dialect?: Dialect } = {}
): Promise<string | null> {
  const { ext, label } = EXPORT_FILE[format]
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: label, extensions: [ext] }]
  })
  if (r.canceled || !r.filePath) return null
  if (format === 'xlsx') {
    if (rows.length > XLSX_ROW_LIMIT) {
      throw new Error(`Excel supports at most ${XLSX_ROW_LIMIT.toLocaleString()} rows; this export has ${rows.length.toLocaleString()}. Use CSV instead.`)
    }
    await writeFile(r.filePath, await buildXlsx(columns, rows, defaultName))
  } else {
    await writeFile(r.filePath, formatRows(format, columns, rows, opts), 'utf8')
  }
  return r.filePath
}

function registerIpc(): void {
  // connections
  handle('connections:list', () => store.listConnections())
  handle('connections:save', (c: ConnectionConfig) => store.saveConnection(c))
  handle('connections:delete', (id: string) => store.deleteConnection(id))
  handle('connections:test', async (c: ConnectionConfig) => {
    const { driver, tunnel } = await openDriver(c)
    try {
      return await driver.serverVersion()
    } finally {
      await driver.disconnect()
      tunnel?.close()
    }
  })

  // sessions
  handle('session:open', async (c: ConnectionConfig) => {
    const { driver, tunnel } = await openDriver(c)
    const s: Session = { id: randomUUID(), config: c, driver, tunnel, version: '' }
    s.version = await driver.serverVersion().catch(() => '')
    sessions.set(s.id, s)
    if (c.id) store.touchConnection(c.id)
    return sessionInfo(s)
  })
  handle('session:close', async (id: string) => {
    const s = sessions.get(id)
    if (s) await closeSession(s)
  })
  handle('session:useDatabase', async (id: string, database: string) => {
    const s = getSession(id)
    const { driver, tunnel } = await openDriver(s.config, database)
    await s.driver.disconnect().catch(() => undefined)
    s.tunnel?.close()
    s.driver = driver
    s.tunnel = tunnel
    return sessionInfo(s)
  })

  // metadata
  handle('db:listDatabases', (id: string) => getSession(id).driver.listDatabases())
  handle('db:listSchemas', (id: string) => getSession(id).driver.listSchemas())
  handle('db:listTables', (id: string, schema?: string) => getSession(id).driver.listTables(schema))
  handle('db:listColumns', (id: string, t: TableRef) => getSession(id).driver.listColumns(t))
  handle('db:listIndexes', (id: string, t: TableRef) => getSession(id).driver.listIndexes(t))
  handle('db:listForeignKeys', (id: string, t: TableRef) => getSession(id).driver.listForeignKeys(t))
  handle('db:listRoutines', (id: string, schema?: string) => getSession(id).driver.listRoutines(schema))
  handle('db:getDDL', (id: string, t: TableRef, kind: 'table' | 'view') => getSession(id).driver.getDDL(t, kind))
  handle('db:completion', (id: string, schema?: string) => getSession(id).driver.completionMeta(schema))

  // queries
  handle('db:query', async (id: string, sql: string, queryId: string) => {
    const s = getSession(id)
    const started = Date.now()
    const { maxResultRows } = store.getSettings()
    try {
      const results = await s.driver.runQuery(sql, queryId, maxResultRows)
      store.addHistory({
        sql,
        connectionName: s.config.name,
        database: s.driver.database,
        executedAt: started,
        durationMs: Date.now() - started,
        success: true
      })
      return results
    } catch (e) {
      store.addHistory({
        sql,
        connectionName: s.config.name,
        database: s.driver.database,
        executedAt: started,
        durationMs: Date.now() - started,
        success: false,
        error: (e as Error).message
      })
      throw e
    }
  })
  handle('db:cancel', (id: string, queryId: string) => getSession(id).driver.cancel(queryId))
  handle('db:checkDestructive', (id: string, sql: string) => checkDestructive(getSession(id).driver, sql))
  handle('db:select', (id: string, t: TableRef, opts: SelectOptions) => getSession(id).driver.select(t, opts))
  handle('db:applyChanges', (id: string, c: RowChanges) => getSession(id).driver.applyChanges(c))
  handle('db:drop', (id: string, t: TableRef, kind: 'table' | 'view') => getSession(id).driver.dropTable(t, kind))
  handle('db:truncate', (id: string, t: TableRef) => getSession(id).driver.truncateTable(t))

  // export
  handle(
    'export:rows',
    async (p: { format: ExportFormat; columns: string[]; rows: CellValue[][]; name: string; tableName?: string; dialect?: Dialect }) =>
      exportToFile(p.name, p.format, p.columns, p.rows, { tableName: p.tableName, dialect: p.dialect })
  )
  handle(
    'export:table',
    async (id: string, t: TableRef, format: ExportFormat, opts: Pick<SelectOptions, 'where' | 'filters' | 'filterJoin' | 'orderBy'>) => {
      const s = getSession(id)
      const r = await s.driver.selectAll(t, opts)
      return exportToFile(
        t.name,
        format,
        r.columns.map((c) => c.name),
        r.rows,
        { tableName: s.driver.qualified(t), dialect: s.driver.dialect }
      )
    }
  )

  // history / saved / settings
  handle('history:list', () => store.listHistory())
  handle('history:clear', () => store.clearHistory())
  handle('saved:list', () => store.listSaved())
  handle('saved:save', (q) => store.saveQuery(q))
  handle('saved:delete', (id: string) => store.deleteSaved(id))
  handle('settings:get', () => store.getSettings())
  handle('settings:set', (s) => store.setSettings(s))

  // dialogs
  handle('dialog:openFile', async (opts: { title?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showOpenDialog(win!, { title: opts?.title, properties: ['openFile'], filters: opts?.filters })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('dialog:saveFile', async (opts: { title?: string; defaultPath?: string; filters?: Electron.FileFilter[] }) => {
    const r = await dialog.showSaveDialog(win!, { title: opts?.title, defaultPath: opts?.defaultPath, filters: opts?.filters })
    return r.canceled ? null : r.filePath
  })
  handle('dialog:confirm', async (opts: { message: string; detail?: string; okLabel?: string }) => {
    const r = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: [opts.okLabel ?? 'OK', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: opts.message,
      detail: opts.detail
    })
    return r.response === 0
  })
  handle('app:openExternal', (url: string) => shell.openExternal(url))
}

app.whenReady().then(() => {
  // Minimal menu: keeps clipboard shortcuts & devtools, but leaves Ctrl+R / Ctrl+W / Ctrl+T free for the app
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // macOS: the app menu already has Quit (Cmd+Q); elsewhere add File → Quit (Ctrl+Q)
      ...(process.platform === 'darwin'
        ? [{ role: 'appMenu' as const }]
        : [{ label: 'File', submenu: [{ role: 'quit' as const, label: 'Quit Quarry Studio', accelerator: 'Ctrl+Q' }] }]),
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'toggleDevTools', accelerator: 'F12' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen', accelerator: 'F11' }
        ]
      }
    ])
  )
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await Promise.all([...sessions.values()].map(closeSession))
  if (process.platform !== 'darwin') app.quit()
})
