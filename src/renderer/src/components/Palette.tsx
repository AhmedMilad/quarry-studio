import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Database, Eye, Plug, Search, Star, Table2 } from 'lucide-react'
import type { SavedQuery } from '@shared/types'
import { api } from '../api'
import { useApp } from '../store'

interface Item {
  key: string
  label: string
  detail?: string
  group: string
  icon: JSX.Element
  run: (alt: boolean, newTab: boolean) => void
}

/** Subsequence fuzzy match; higher is better, -1 means no match */
function score(text: string, q: string): number {
  if (!q) return 0
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx === 0) return 1000 - t.length
  if (idx > 0) return 800 - idx - t.length
  let s = 0
  let ti = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    streak = found === ti ? streak + 1 : 0
    s += 10 + streak * 5 - (found - ti)
    ti = found + 1
  }
  return s - t.length
}

export function Palette({ onClose }: { onClose: () => void }): JSX.Element {
  const activeSid = useApp((s) => s.activeSid)
  const session = useApp((s) => (s.activeSid ? s.sessions[s.activeSid] : undefined))
  const sessions = useApp((s) => s.sessions)
  const order = useApp((s) => s.order)
  const connections = useApp((s) => s.connections)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.listSaved().then(setSaved).catch(() => undefined)
  }, [])

  // a server connection with no database chosen yet (e.g. MySQL connected without a default database):
  // list its databases first, then tables once one is picked
  const pickDatabase = !!session && session.info.dialect !== 'sqlite' && !session.info.currentDatabase

  const items = useMemo<Item[]>(() => {
    const st = useApp.getState()
    const out: Item[] = []
    if (session && activeSid && pickDatabase) {
      for (const d of session.databases) {
        out.push({
          key: `d:${d}`,
          label: d,
          detail: 'use database',
          group: 'Databases',
          icon: <Database size={14} color="var(--accent)" />,
          run: () => void st.useDatabase(activeSid, d)
        })
      }
    } else if (session && activeSid) {
      for (const t of session.tables) {
        out.push({
          key: `t:${t.schema}:${t.name}`,
          label: t.name,
          detail: `${t.type}${t.schema ? ' · ' + t.schema : ''}`,
          group: t.type === 'view' ? 'Views' : 'Tables',
          icon: t.type === 'view' ? <Eye size={14} color="var(--info)" /> : <Table2 size={14} color="var(--accent)" />,
          run: (alt, newTab) => st.openTableTab(activeSid, t, alt ? 'structure' : 'data', newTab)
        })
      }
      for (const q of saved) {
        out.push({
          key: `q:${q.id}`,
          label: q.title,
          detail: q.sql.replace(/\s+/g, ' ').slice(0, 60),
          group: 'Saved queries',
          icon: <Star size={14} color="var(--accent)" />,
          run: () => st.openQueryTab(activeSid, q.sql, q.title, q.id)
        })
      }
    }
    order.forEach((sid, i) => {
      if (sid === activeSid) return
      const s = sessions[sid]
      if (!s) return
      out.push({
        key: `s:${sid}`,
        label: s.info.config.name,
        detail: `switch · Alt+${i + 1}`,
        group: 'Open connections',
        icon: <ArrowRightLeft size={14} color="var(--success)" />,
        run: () => st.setActive(sid)
      })
    })
    for (const c of connections) {
      out.push({
        key: `c:${c.id}`,
        label: c.name,
        detail: `connect · ${c.type}`,
        group: 'Saved connections',
        icon: <Plug size={14} className="faint" />,
        run: () => st.connect(c).catch((e) => st.toast((e as Error).message, 'error'))
      })
    }
    return out
  }, [session, activeSid, pickDatabase, saved, order, sessions, connections])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items.slice(0, 200)
    return items
      .map((it) => ({ it, s: score(it.label, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 200)
      .map((x) => x.it)
  }, [items, query])

  useEffect(() => setSel(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const choose = (it: Item | undefined, alt: boolean, newTab = false): void => {
    if (!it) return
    onClose()
    it.run(alt, newTab)
  }

  return (
    <div className="modal-backdrop" style={{ paddingTop: '10vh' }} onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} className="faint" />
          <input
            autoFocus
            placeholder={
              pickDatabase ? 'Select a database…' : session ? 'Search tables, views, saved queries, connections…' : 'Search connections…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(filtered.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(filtered[sel], e.shiftKey, e.ctrlKey || e.metaKey)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="empty-note">No matches</div>}
          {filtered.map((it, i) => (
            <div key={it.key}>
              {(i === 0 || filtered[i - 1].group !== it.group) && !query && <div className="palette-group">{it.group}</div>}
              <div
                className={`palette-item${i === sel ? ' active' : ''}`}
                onMouseMove={() => setSel(i)}
                onClick={(e) => choose(it, e.shiftKey, e.ctrlKey || e.metaKey)}
              >
                {it.icon}
                <span className="lbl">{it.label}</span>
                {it.detail && <span className="det">{it.detail}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="kbd">Enter</span> open
          </span>
          <span>
            <span className="kbd">Shift+Enter</span> open structure
          </span>
          <span>
            <span className="kbd">Ctrl+Enter</span> new tab
          </span>
          <span>
            <span className="kbd">Esc</span> close
          </span>
        </div>
      </div>
    </div>
  )
}
