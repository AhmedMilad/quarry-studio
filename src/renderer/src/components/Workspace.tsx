import { useEffect } from 'react'
import { Columns3, Database, FileCode2, Lock, Plus, Server, Table2, X } from 'lucide-react'
import { DB_TYPES } from '@shared/types'
import { setCompletion } from '../monaco'
import { isTypingTarget, runTabCommand } from '../commands'
import { useApp, type SessionState } from '../store'
import { Sidebar } from './Sidebar'
import { QueryTab } from './QueryTab'
import { TableTab } from './TableTab'

export function Workspace({ sid, visible }: { sid: string; visible: boolean }): JSX.Element {
  const s = useApp((st) => st.sessions[sid]) as SessionState
  const openQueryTab = useApp((st) => st.openQueryTab)
  const closeTab = useApp((st) => st.closeTab)
  const closeOtherTabs = useApp((st) => st.closeOtherTabs)
  const setActiveTab = useApp((st) => st.setActiveTab)
  const setSidebarWidth = useApp((st) => st.setSidebarWidth)
  const showMenu = useApp((st) => st.showMenu)

  useEffect(() => {
    setCompletion(sid, s.completion)
  }, [sid, s.completion])

  useEffect(() => {
    if (!visible) return
    // Capture phase: runs before Monaco / inputs, so shortcuts work wherever focus is.
    // Uses e.code (physical key) so shortcuts also work with non-Latin layouts (e.g. Arabic).
    const onKey = (e: KeyboardEvent): void => {
      const app = useApp.getState()
      if (app.prompt || document.querySelector('.modal-backdrop')) return
      const st = app.sessions[sid]
      if (!st) return
      const mod = e.ctrlKey || e.metaKey
      const tabId = st.activeTabId
      const handled = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }

      if (e.code === 'F5' && !mod) {
        if (runTabCommand(tabId, 'refresh')) handled()
        return
      }
      // Esc: let the active tab undo one layer (filter / unapplied edits / selection).
      // Not while a menu is open, a grid cell is being edited, or the SQL editor has focus.
      if (e.code === 'Escape' && !mod && !e.shiftKey && !e.altKey) {
        const el = document.activeElement
        if (app.contextMenu) return
        if (isTypingTarget(el) && !el?.closest('.filter-bar')) return
        // a multi-cell range is the innermost thing to undo
        const rangeGrid = document
          .querySelector(`.workspace[data-sid="${sid}"] .tab-content:not(.hidden) [data-range="multi"]`)
        if (rangeGrid) {
          rangeGrid.dispatchEvent(new Event('quarry-clear-range'))
          handled()
          return
        }
        if (runTabCommand(tabId, 'escape')) handled()
        return
      }
      // Delete: mark ticked rows for deletion (not while typing / editing a cell)
      if (e.code === 'Delete' && !mod && !e.shiftKey && !e.altKey) {
        if (isTypingTarget(document.activeElement)) return
        if (runTabCommand(tabId, 'deleteRows')) handled()
        return
      }
      if (!mod || e.altKey) return

      switch (e.code) {
        case 'KeyS':
          if (!e.shiftKey && runTabCommand(tabId, 'save')) handled()
          break
        case 'Enter':
        case 'NumpadEnter':
          if (runTabCommand(tabId, e.shiftKey ? 'runAll' : 'run')) handled()
          break
        case 'KeyF':
          // Ctrl+Shift+F formats SQL; Ctrl+F focuses the table filter (query tabs keep Monaco's find)
          if (runTabCommand(tabId, e.shiftKey ? 'format' : 'find')) handled()
          break
        case 'KeyA':
          // select all rows — unless the user is typing, where Ctrl+A selects text as usual
          if (!e.shiftKey && !isTypingTarget(document.activeElement) && runTabCommand(tabId, 'selectAll')) handled()
          break
        case 'KeyD':
          // table tabs: add a row / remove the last added row (query tabs keep Monaco's Ctrl+D)
          if (runTabCommand(tabId, e.shiftKey ? 'removeNewRow' : 'addRow')) handled()
          break
        case 'KeyL':
          // table tabs: add / remove a filter line (query tabs keep Monaco's Ctrl+L / Ctrl+Shift+L)
          if (runTabCommand(tabId, e.shiftKey ? 'removeFilter' : 'addFilter')) handled()
          break
        case 'KeyC':
          if (!e.shiftKey && !isTypingTarget(document.activeElement) && runTabCommand(tabId, 'copySelection')) handled()
          break
        case 'KeyR':
          if (!e.shiftKey && runTabCommand(tabId, 'refresh')) handled()
          break
        case 'KeyT':
          handled()
          if (!e.shiftKey) openQueryTab(sid)
          else if (!app.reopenClosedTab(sid)) app.toast('No recently closed tabs', 'info')
          break
        case 'KeyW':
          handled()
          if (tabId) closeTab(sid, tabId)
          break
        case 'Tab': {
          handled()
          const i = st.tabs.findIndex((t) => t.id === tabId)
          const n = st.tabs.length
          if (n) setActiveTab(sid, st.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n].id)
          break
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, sid, openQueryTab, closeTab, setActiveTab])

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const el = e.currentTarget as HTMLElement
    el.classList.add('dragging')
    const move = (ev: MouseEvent): void => setSidebarWidth(ev.clientX - 52)
    const up = (): void => {
      el.classList.remove('dragging')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const active = s.tabs.find((t) => t.id === s.activeTabId)
  const typeLabel = DB_TYPES.find((d) => d.value === s.info.config.type)?.label

  return (
    <div className="workspace" data-sid={sid} style={{ display: visible ? 'flex' : 'none' }}>
      <Sidebar sid={sid} />
      <div className="resizer" onMouseDown={startDrag} />
      <div className="app-main">
        <div className="tabbar">
          <div className="tabs-scroll">
            {s.tabs.map((t) => (
              <div
                key={t.id}
                className={`tab${t.id === s.activeTabId ? ' active' : ''}`}
                onClick={() => setActiveTab(sid, t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(sid, t.id)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  showMenu(e.clientX, e.clientY, [
                    { label: 'Close', shortcut: 'Ctrl+W', onClick: () => closeTab(sid, t.id) },
                    { label: 'Close others', onClick: () => closeOtherTabs(sid, t.id) },
                    {
                      label: 'Reopen closed tab',
                      shortcut: 'Ctrl+Shift+T',
                      disabled: s.closedTabs.length === 0,
                      onClick: () => useApp.getState().reopenClosedTab(sid)
                    },
                    {
                      label: 'Close all',
                      onClick: () => s.tabs.forEach((x) => closeTab(sid, x.id))
                    }
                  ])
                }}
                title={t.kind === 'table' ? `${t.table.schema ? t.table.schema + '.' : ''}${t.table.name}` : t.title}
              >
                {t.kind === 'query' ? (
                  <FileCode2 size={13} color="var(--info)" />
                ) : t.view === 'structure' ? (
                  <Columns3 size={13} color="var(--accent)" />
                ) : (
                  <Table2 size={13} color="var(--accent)" />
                )}
                <span className="title">{t.title}</span>
                <button
                  className="icon-btn close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(sid, t.id)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="tab-add">
            <button className="icon-btn" title="New query (Ctrl+T)" onClick={() => openQueryTab(sid)}>
              <Plus size={15} />
            </button>
          </div>
        </div>

        {s.tabs.map((t) => (
          <div key={t.id} className={`tab-content${t.id === s.activeTabId ? '' : ' hidden'}`}>
            {t.kind === 'query' ? (
              <QueryTab sid={sid} tab={t} active={visible && t.id === s.activeTabId} />
            ) : (
              <TableTab sid={sid} tab={t} />
            )}
          </div>
        ))}
        {!active && (
          <div className="welcome">
            <FileCode2 size={40} strokeWidth={1.2} className="faint" />
            <div style={{ fontSize: 15, color: 'var(--text)' }}>No open tabs</div>
            <div className="shortcuts">
              <span className="kbd">Ctrl+T</span> <span>New query tab</span>
              <span className="kbd">Ctrl+W</span> <span>Close tab</span>
              <span className="kbd">Ctrl+Shift+T</span> <span>Reopen closed tab</span>
              <span className="kbd">Ctrl+Tab</span> <span>Next tab (Ctrl+Shift+Tab: previous)</span>
              <span className="kbd">Ctrl+Click</span> <span>Open table in a new tab</span>
              <span className="kbd">Ctrl+Enter</span> <span>Run statement</span>
              <span className="kbd">Ctrl+Shift+Enter</span> <span>Run all</span>
              <span className="kbd">Ctrl+S</span> <span>Save query</span>
              <span className="kbd">Ctrl+Shift+F</span> <span>Format SQL</span>
              <span className="kbd">Ctrl+P</span> <span>Quick open (tables, queries, connections)</span>
              <span className="kbd">Ctrl+U</span> <span>Next connection (Ctrl+Shift+U: previous)</span>
              <span className="kbd">Alt+1…9</span> <span>Jump to connection N (Alt+0: manager)</span>
              <span className="kbd">F5</span> <span>Refresh table data</span>
              <span className="kbd">Ctrl+F</span> <span>Filter table data</span>
              <span className="kbd">Esc</span> <span>Clear filter / discard unapplied changes</span>
              <span className="kbd">Delete</span> <span>Mark ticked rows for deletion (Ctrl+S applies)</span>
              <span className="kbd">Ctrl+D</span> <span>Add row (Ctrl+Shift+D: remove new rows, bottom up)</span>
              <span className="kbd">Ctrl+L</span> <span>Add filter line (Ctrl+Shift+L: remove)</span>
              <span className="kbd">Ctrl+N</span> <span>New connection</span>
              <span className="kbd">Ctrl+Q</span> <span>Quit Quarry Studio</span>
              <span className="kbd">Ctrl+A</span> <span>Select all rows (Ctrl+C copies them)</span>
            </div>
            <button className="btn primary" onClick={() => openQueryTab(sid)}>
              <Plus size={13} /> New query
            </button>
          </div>
        )}

        <div className="statusbar">
          <span className="item">
            <span className="color-dot" style={{ background: s.info.config.color }} />
            {s.info.config.name}
          </span>
          <span className="item">
            <Server size={12} /> {typeLabel}
            {s.info.serverVersion ? ` · ${s.info.serverVersion}` : ''}
          </span>
          {s.info.currentDatabase && (
            <span className="item">
              <Database size={12} /> {s.info.currentDatabase}
              {s.schema ? ` / ${s.schema}` : ''}
            </span>
          )}
          {s.info.config.ssh?.enabled && <span className="item">via SSH {s.info.config.ssh.host}</span>}
          {s.info.config.readOnly && (
            <span className="item" style={{ color: 'var(--accent)' }}>
              <Lock size={12} /> read-only
            </span>
          )}
          <span className="spacer" />
          <span className="item">{s.tables.length} tables</span>
        </div>
      </div>
    </div>
  )
}
