import { Moon, Plus, Settings, Sun } from 'lucide-react'
import { useApp } from '../store'
import { DB_META, readableTextOn } from './DbBadge'
import { blankConnection } from './ConnectionManager'

export function Logo({ size = 32 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="rail-logo" aria-label="Quarry Studio">
      <defs>
        <linearGradient id="qg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc35c" />
          <stop offset="1" stopColor="#e8890c" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#qg)" />
      <path d="M18 24 L32 16 L46 24 L32 32 Z" fill="#1a1305" opacity="0.9" />
      <path d="M18 32 L32 40 L46 32" stroke="#1a1305" strokeWidth="4" fill="none" strokeLinejoin="round" opacity="0.75" />
      <path d="M18 40 L32 48 L46 40" stroke="#1a1305" strokeWidth="4" fill="none" strokeLinejoin="round" opacity="0.55" />
    </svg>
  )
}

export function Rail({ onSettings }: { onSettings: () => void }): JSX.Element {
  const order = useApp((s) => s.order)
  const sessions = useApp((s) => s.sessions)
  const activeSid = useApp((s) => s.activeSid)
  const setActive = useApp((s) => s.setActive)
  const setEditing = useApp((s) => s.setEditing)
  const disconnect = useApp((s) => s.disconnect)
  const showMenu = useApp((s) => s.showMenu)
  const theme = useApp((s) => s.settings.theme)
  const updateSettings = useApp((s) => s.updateSettings)

  return (
    <div className="rail">
      <Logo />
      {order.map((sid) => {
        const s = sessions[sid]
        if (!s) return null
        const c = s.info.config
        const initials = c.name
          .split(/[\s_\-./@:]+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]!.toUpperCase())
          .join('')
        return (
          <div
            key={sid}
            className={`rail-item conn${activeSid === sid ? ' active' : ''}`}
            style={{ background: c.color, color: readableTextOn(c.color), borderColor: c.color }}
            title={`${c.name} — ${s.info.currentDatabase || c.host}`}
            onClick={() => setActive(sid)}
            onContextMenu={(e) => {
              e.preventDefault()
              showMenu(e.clientX, e.clientY, [
                { label: 'Switch to', onClick: () => setActive(sid) },
                { label: 'Disconnect', danger: true, onClick: () => disconnect(sid) }
              ])
            }}
          >
            {initials || DB_META[c.type].abbr}
            {/* the small dot shows the database type, the badge itself carries the connection colour */}
            <span className="dot" style={{ background: DB_META[c.type].color }} title={c.type} />
          </div>
        )
      })}
      {order.length > 0 && <div className="rail-sep" />}
      <div
        className={`rail-item${activeSid === null ? ' active' : ''}`}
        title="New connection (Ctrl+N)"
        onClick={() => setEditing(blankConnection())}
      >
        <Plus size={18} />
      </div>
      <span className="spacer" />
      <button
        className="icon-btn"
        title="Toggle theme"
        onClick={() => updateSettings({ theme: theme === 'light' ? 'dark' : 'light' })}
      >
        {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
      </button>
      <button className="icon-btn" title="Settings" onClick={onSettings}>
        <Settings size={16} />
      </button>
    </div>
  )
}
