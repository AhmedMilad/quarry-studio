import { create } from 'zustand'
import type {
  AppSettings,
  CompletionTable,
  ConnectionConfig,
  RoutineInfo,
  SessionInfo,
  FilterCondition,
  TableInfo,
  TableRef
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { api } from './api'
import { monaco } from './monaco'

export interface QueryTabState {
  id: string
  kind: 'query'
  title: string
  initialSql: string
  savedId?: string
}

export interface TableTabState {
  id: string
  kind: 'table'
  title: string
  table: TableRef
  tableType: 'table' | 'view'
  view: 'data' | 'structure'
  /** filters already applied when the tab opens (e.g. following a foreign key) */
  initialFilters?: FilterCondition[]
}

export type Tab = QueryTabState | TableTabState

export interface SessionState {
  info: SessionInfo
  databases: string[]
  schemas: string[]
  schema?: string
  tables: TableInfo[]
  routines: RoutineInfo[]
  completion: CompletionTable[]
  loading: boolean
  tabs: Tab[]
  activeTabId: string | null
  queryCounter: number
  /** most recently closed last; used by Ctrl+Shift+T */
  closedTabs: Tab[]
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

export interface MenuItem {
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  shortcut?: string
  onClick?: () => void
}

interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface PromptState {
  title: string
  label?: string
  value: string
  okLabel?: string
  resolve: (v: string | null) => void
}

interface AppState {
  connections: ConnectionConfig[]
  sessions: Record<string, SessionState>
  order: string[]
  activeSid: string | null
  editingConnection: ConnectionConfig | null
  settings: AppSettings
  toasts: Toast[]
  contextMenu: ContextMenuState | null
  prompt: PromptState | null
  sidebarWidth: number
  historyVersion: number
  savedVersion: number

  init(): Promise<void>
  loadConnections(): Promise<void>
  setEditing(c: ConnectionConfig | null): void
  connect(c: ConnectionConfig): Promise<void>
  disconnect(sid: string): Promise<void>
  setActive(sid: string | null): void
  refreshSession(sid: string): Promise<void>
  useDatabase(sid: string, db: string): Promise<void>
  setSchema(sid: string, schema: string): Promise<void>
  openQueryTab(sid: string, sql?: string, title?: string, savedId?: string): void
  /** focuses an existing tab of this table unless `newTab` is set (always opens another one) */
  /** `filters` opens a new tab with those filters applied (used to follow a foreign key) */
  openTableTab(sid: string, t: TableInfo, view?: 'data' | 'structure', newTab?: boolean, filters?: FilterCondition[]): void
  closeTab(sid: string, tabId: string): void
  closeOtherTabs(sid: string, tabId: string): void
  /** reopen the most recently closed tab; returns false if there is none */
  reopenClosedTab(sid: string): boolean
  setActiveTab(sid: string, tabId: string): void
  updateTab(sid: string, tabId: string, patch: Partial<Tab>): void
  updateSettings(s: Partial<AppSettings>): Promise<void>
  toast(message: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
  showMenu(x: number, y: number, items: MenuItem[]): void
  hideMenu(): void
  ask(title: string, value?: string, opts?: { label?: string; okLabel?: string }): Promise<string | null>
  closePrompt(v: string | null): void
  setSidebarWidth(w: number): void
  bumpHistory(): void
  bumpSaved(): void
}

/**
 * Snapshot tabs being closed so Ctrl+Shift+T can bring them back.
 * Query tabs keep the SQL that was in the editor at close time, not just what they opened with.
 */
function remember(sid: string, closed: Tab[], tabs: Tab[]): Tab[] {
  const snap = tabs.map((t) => {
    if (t.kind !== 'query') return t
    const model = monaco.editor.getModels().find((m) => m.uri.path === `/${sid}/${t.id}.sql`)
    return model ? { ...t, initialSql: model.getValue() } : t
  })
  return [...closed, ...snap].slice(-25)
}

let toastSeq = 1
let tabSeq = 1
const newTabId = (): string => `tab-${Date.now().toString(36)}-${tabSeq++}`

export const useApp = create<AppState>((set, get) => {
  const patchSession = (sid: string, patch: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)): void =>
    set((st) => {
      const s = st.sessions[sid]
      if (!s) return {}
      const p = typeof patch === 'function' ? patch(s) : patch
      return { sessions: { ...st.sessions, [sid]: { ...s, ...p } } }
    })

  const loadMeta = async (sid: string): Promise<void> => {
    const s = get().sessions[sid]
    if (!s) return
    patchSession(sid, { loading: true })
    try {
      const schema = s.schema
      const [databases, schemas, tables, routines] = await Promise.all([
        api.listDatabases(sid).catch(() => [] as string[]),
        s.info.supportsSchemas ? api.listSchemas(sid).catch(() => [] as string[]) : Promise.resolve([] as string[]),
        api.listTables(sid, schema),
        api.listRoutines(sid, schema).catch(() => [] as RoutineInfo[])
      ])
      patchSession(sid, { databases, schemas, tables, routines, loading: false })
      api
        .completion(sid, schema)
        .then((completion) => patchSession(sid, { completion }))
        .catch(() => undefined)
    } catch (e) {
      patchSession(sid, { loading: false })
      get().toast((e as Error).message, 'error')
    }
  }

  return {
    connections: [],
    sessions: {},
    order: [],
    activeSid: null,
    editingConnection: null,
    settings: DEFAULT_SETTINGS,
    toasts: [],
    contextMenu: null,
    prompt: null,
    sidebarWidth: 280,
    historyVersion: 0,
    savedVersion: 0,

    async init() {
      const settings = await api.getSettings()
      set({ settings })
      await get().loadConnections()
    },

    async loadConnections() {
      const connections = await api.listConnections()
      set({ connections })
    },

    setEditing(c) {
      set({ editingConnection: c, activeSid: null })
    },

    async connect(c) {
      const info = await api.openSession(c)
      const sid = info.sessionId
      const session: SessionState = {
        info,
        databases: [],
        schemas: [],
        schema: info.defaultSchema,
        tables: [],
        routines: [],
        completion: [],
        loading: true,
        tabs: [],
        activeTabId: null,
        queryCounter: 0,
        closedTabs: []
      }
      set((st) => ({ sessions: { ...st.sessions, [sid]: session }, order: [...st.order, sid], activeSid: sid }))
      get().openQueryTab(sid)
      await loadMeta(sid)
      get().loadConnections()
    },

    async disconnect(sid) {
      await api.closeSession(sid).catch(() => undefined)
      set((st) => {
        const sessions = { ...st.sessions }
        delete sessions[sid]
        const order = st.order.filter((x) => x !== sid)
        return {
          sessions,
          order,
          activeSid: st.activeSid === sid ? (order[order.length - 1] ?? null) : st.activeSid
        }
      })
    },

    setActive(sid) {
      set({ activeSid: sid })
    },

    refreshSession(sid) {
      return loadMeta(sid)
    },

    async useDatabase(sid, db) {
      patchSession(sid, { loading: true })
      try {
        const info = await api.useDatabase(sid, db)
        patchSession(sid, { info, schema: info.defaultSchema, tables: [], completion: [] })
        await loadMeta(sid)
      } catch (e) {
        patchSession(sid, { loading: false })
        get().toast((e as Error).message, 'error')
      }
    },

    async setSchema(sid, schema) {
      patchSession(sid, { schema })
      await loadMeta(sid)
    },

    openQueryTab(sid, sql = '', title, savedId) {
      const s = get().sessions[sid]
      if (!s) return
      if (savedId) {
        const existing = s.tabs.find((t) => t.kind === 'query' && t.savedId === savedId)
        if (existing) return get().setActiveTab(sid, existing.id)
      }
      const n = s.queryCounter + 1
      const tab: QueryTabState = { id: newTabId(), kind: 'query', title: title ?? `Query #${n}`, initialSql: sql, savedId }
      patchSession(sid, { tabs: [...s.tabs, tab], activeTabId: tab.id, queryCounter: n })
    },

    openTableTab(sid, t, view = 'data', newTab = false, filters) {
      if (filters?.length) newTab = true
      const s = get().sessions[sid]
      if (!s) return
      const sameTable = s.tabs.filter(
        (x) => x.kind === 'table' && x.table.name === t.name && x.table.schema === t.schema
      ) as TableTabState[]
      const activeSame = sameTable.find((x) => x.id === s.activeTabId)
      const existing = newTab ? undefined : (activeSame ?? sameTable[sameTable.length - 1])
      if (existing) {
        patchSession(sid, {
          activeTabId: existing.id,
          tabs: s.tabs.map((x) => (x.id === existing.id ? { ...existing, view } : x))
        })
        return
      }
      // number duplicates: users, users (2), users (3)…
      const used = new Set(sameTable.map((x) => x.title))
      let title = t.name
      for (let n = 2; used.has(title); n++) title = `${t.name} (${n})`
      const tab: TableTabState = {
        id: newTabId(),
        kind: 'table',
        title,
        table: { name: t.name, schema: t.schema },
        tableType: t.type,
        view,
        ...(filters?.length ? { initialFilters: filters } : {})
      }
      patchSession(sid, { tabs: [...s.tabs, tab], activeTabId: tab.id })
    },

    closeTab(sid, tabId) {
      patchSession(sid, (s) => {
        const idx = s.tabs.findIndex((t) => t.id === tabId)
        if (idx < 0) return {}
        const tabs = s.tabs.filter((t) => t.id !== tabId)
        let activeTabId = s.activeTabId
        if (activeTabId === tabId) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
        return { tabs, activeTabId, closedTabs: remember(sid, s.closedTabs, [s.tabs[idx]]) }
      })
    },

    closeOtherTabs(sid, tabId) {
      patchSession(sid, (s) => ({
        tabs: s.tabs.filter((t) => t.id === tabId),
        activeTabId: tabId,
        closedTabs: remember(
          sid,
          s.closedTabs,
          s.tabs.filter((t) => t.id !== tabId)
        )
      }))
    },

    reopenClosedTab(sid) {
      const s = get().sessions[sid]
      const last = s?.closedTabs[s.closedTabs.length - 1]
      if (!s || !last) return false
      // fresh id: the old tab's editor model / command handlers are gone
      const tab: Tab = { ...last, id: newTabId() }
      patchSession(sid, { tabs: [...s.tabs, tab], activeTabId: tab.id, closedTabs: s.closedTabs.slice(0, -1) })
      return true
    },

    setActiveTab(sid, tabId) {
      patchSession(sid, { activeTabId: tabId })
    },

    updateTab(sid, tabId, patch) {
      patchSession(sid, (s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as Tab) : t)) }))
    },

    async updateSettings(s) {
      const settings = await api.setSettings(s)
      set({ settings })
    },

    toast(message, kind = 'info') {
      const id = toastSeq++
      set((st) => ({ toasts: [...st.toasts, { id, kind, message }] }))
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 3500)
    },

    dismissToast(id) {
      set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) }))
    },

    showMenu(x, y, items) {
      set({ contextMenu: { x, y, items } })
    },

    hideMenu() {
      set({ contextMenu: null })
    },

    ask(title, value = '', opts = {}) {
      return new Promise((resolve) => set({ prompt: { title, value, resolve, ...opts } }))
    },

    closePrompt(v) {
      get().prompt?.resolve(v)
      set({ prompt: null })
    },

    setSidebarWidth(w) {
      set({ sidebarWidth: Math.max(200, Math.min(600, w)) })
    },

    bumpHistory() {
      set((st) => ({ historyVersion: st.historyVersion + 1 }))
    },

    bumpSaved() {
      set((st) => ({ savedVersion: st.savedVersion + 1 }))
    }
  }
})

// test builds only (VITE_SMOKE=1 at build time): lets the smoke tests drive the store
if (import.meta.env.VITE_SMOKE) (window as unknown as { __app: typeof useApp }).__app = useApp
