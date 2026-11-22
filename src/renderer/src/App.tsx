import { useEffect, useState } from 'react'
import { useApp } from './store'
import { Rail } from './components/Rail'
import { ConnectionManager, blankConnection } from './components/ConnectionManager'
import { Workspace } from './components/Workspace'
import { ContextMenu, PromptModal, Toasts } from './components/Overlays'
import { SettingsModal } from './components/SettingsModal'
import { Palette } from './components/Palette'

export default function App(): JSX.Element {
  const init = useApp((s) => s.init)
  const order = useApp((s) => s.order)
  const activeSid = useApp((s) => s.activeSid)
  const theme = useApp((s) => s.settings.theme)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    init()
  }, [init])

  // App-wide shortcuts (capture phase, physical keys so they work on any keyboard layout)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const st = useApp.getState()
      const handled = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }
      const mod = e.ctrlKey || e.metaKey
      // Ctrl+P: quick open
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyP') {
        handled()
        setPaletteOpen((o) => !o)
        return
      }
      if (st.prompt || document.querySelector('.modal-backdrop')) return
      // Ctrl+N: new connection form
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyN') {
        handled()
        st.setEditing(blankConnection())
        return
      }
      // Ctrl+U / Ctrl+Shift+U: next / previous connection
      if (mod && !e.altKey && e.code === 'KeyU') {
        handled()
        const ids = st.order
        if (!ids.length) return
        const i = st.activeSid ? ids.indexOf(st.activeSid) : -1
        const next = e.shiftKey ? (i <= 0 ? ids.length - 1 : i - 1) : (i + 1) % ids.length
        st.setActive(ids[next])
        return
      }
      // Alt+1..9: jump to connection N, Alt+0: connection manager
      if (e.altKey && !mod && !e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        handled()
        const n = Number(e.code.slice(5))
        if (n === 0) st.setActive(null)
        else if (st.order[n - 1]) st.setActive(st.order[n - 1])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <Rail onSettings={() => setSettingsOpen(true)} />
      {activeSid === null && <ConnectionManager />}
      {order.map((sid) => (
        <Workspace key={sid} sid={sid} visible={sid === activeSid} />
      ))}
      <ContextMenu />
      <Toasts />
      <PromptModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
