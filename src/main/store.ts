import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ConnectionConfig,
  type HistoryEntry,
  type SavedQuery
} from '@shared/types'

const dir = (): string => {
  const d = join(app.getPath('userData'), 'data')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function readJson<T>(name: string, fallback: T): T {
  const file = join(dir(), name)
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  const file = join(dir(), name)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

const ENC = 'enc:'
function encrypt(v?: string): string | undefined {
  if (!v) return v
  if (safeStorage.isEncryptionAvailable()) return ENC + safeStorage.encryptString(v).toString('base64')
  return v
}
function decrypt(v?: string): string | undefined {
  if (!v || !v.startsWith(ENC)) return v
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(ENC.length), 'base64'))
  } catch {
    return ''
  }
}

// ---------- connections ----------
export function listConnections(): ConnectionConfig[] {
  return readJson<ConnectionConfig[]>('connections.json', []).map((c) => ({
    ...c,
    password: decrypt(c.password),
    ssh: { ...c.ssh, password: decrypt(c.ssh?.password), passphrase: decrypt(c.ssh?.passphrase) }
  }))
}

export function saveConnection(c: ConnectionConfig): ConnectionConfig {
  const raw = readJson<ConnectionConfig[]>('connections.json', [])
  const conn: ConnectionConfig = { ...c, id: c.id || randomUUID(), createdAt: c.createdAt ?? Date.now() }
  const stored: ConnectionConfig = {
    ...conn,
    password: encrypt(conn.password),
    ssh: { ...conn.ssh, password: encrypt(conn.ssh?.password), passphrase: encrypt(conn.ssh?.passphrase) }
  }
  const idx = raw.findIndex((x) => x.id === conn.id)
  if (idx >= 0) raw[idx] = stored
  else raw.push(stored)
  writeJson('connections.json', raw)
  return conn
}

export function touchConnection(id: string): void {
  const raw = readJson<ConnectionConfig[]>('connections.json', [])
  const c = raw.find((x) => x.id === id)
  if (c) {
    c.lastUsedAt = Date.now()
    writeJson('connections.json', raw)
  }
}

export function deleteConnection(id: string): void {
  writeJson(
    'connections.json',
    readJson<ConnectionConfig[]>('connections.json', []).filter((x) => x.id !== id)
  )
}

// ---------- history ----------
const MAX_HISTORY = 1000
export function listHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>('history.json', [])
}
export function addHistory(e: Omit<HistoryEntry, 'id'>): void {
  const h = listHistory()
  h.unshift({ ...e, id: randomUUID() })
  writeJson('history.json', h.slice(0, MAX_HISTORY))
}
export function clearHistory(): void {
  writeJson('history.json', [])
}

// ---------- saved queries ----------
export function listSaved(): SavedQuery[] {
  return readJson<SavedQuery[]>('saved-queries.json', [])
}
export function saveQuery(q: Partial<SavedQuery> & { title: string; sql: string }): SavedQuery {
  const all = listSaved()
  const now = Date.now()
  const existing = q.id ? all.find((x) => x.id === q.id) : undefined
  const item: SavedQuery = {
    id: existing?.id ?? randomUUID(),
    title: q.title,
    sql: q.sql,
    connectionId: q.connectionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  writeJson('saved-queries.json', existing ? all.map((x) => (x.id === item.id ? item : x)) : [item, ...all])
  return item
}
export function deleteSaved(id: string): void {
  writeJson('saved-queries.json', listSaved().filter((x) => x.id !== id))
}

// ---------- settings ----------
export function getSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<AppSettings>>('settings.json', {}) }
}
export function setSettings(s: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...s }
  writeJson('settings.json', next)
  return next
}
