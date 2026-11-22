import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useApp } from '../store'

export function ContextMenu(): JSX.Element | null {
  const menu = useApp((s) => s.contextMenu)
  const hide = useApp((s) => s.hideMenu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 6),
      y: Math.min(menu.y, window.innerHeight - r.height - 6)
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (): void => hide()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu, hide])

  if (!menu) return null
  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={`ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
            onClick={() => {
              hide()
              it.onClick?.()
            }}
          >
            {it.icon}
            <span>{it.label}</span>
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
          </div>
        )
      )}
    </div>
  )
}

export function Toasts(): JSX.Element {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? (
            <AlertCircle size={15} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={15} color="var(--success)" style={{ flexShrink: 0, marginTop: 1 }} />
          ) : (
            <Info size={15} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
          )}
          <div style={{ flex: 1 }}>{t.message}</div>
          <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function PromptModal(): JSX.Element | null {
  const prompt = useApp((s) => s.prompt)
  const close = useApp((s) => s.closePrompt)
  const [value, setValue] = useState('')
  useEffect(() => {
    if (prompt) setValue(prompt.value)
  }, [prompt])
  if (!prompt) return null
  return (
    <div className="modal-backdrop" onMouseDown={() => close(null)}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          close(value.trim() || null)
        }}
      >
        <h2>{prompt.title}</h2>
        <div className="field">
          {prompt.label && <label>{prompt.label}</label>}
          <input
            className="q-input"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && close(null)}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {prompt.okLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function Modal(props: {
  title: string
  onClose: () => void
  children: React.ReactNode
  actions?: React.ReactNode
  wide?: boolean
}): JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props])
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className={`modal${props.wide ? ' wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        {props.children}
        <div className="modal-actions">{props.actions}</div>
      </div>
    </div>
  )
}
