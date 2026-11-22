import { useState } from 'react'
import type { AppSettings } from '@shared/types'
import { useApp } from '../store'
import { Modal } from './Overlays'

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const [form, setForm] = useState<AppSettings>(settings)
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]): void => setForm((f) => ({ ...f, [k]: v }))

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await update(form)
              onClose()
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Theme</label>
        <select className="select" value={form.theme} onChange={(e) => set('theme', e.target.value as AppSettings['theme'])}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Follow system</option>
        </select>
      </div>
      <div className="row">
        <div className="field">
          <label>Table page size</label>
          <input
            className="q-input"
            type="number"
            min={10}
            max={5000}
            value={form.pageSize}
            onChange={(e) => set('pageSize', Math.max(10, Math.min(5000, Number(e.target.value) || 100)))}
          />
        </div>
        <div className="field">
          <label>Editor font size</label>
          <input
            className="q-input"
            type="number"
            min={10}
            max={24}
            value={form.editorFontSize}
            onChange={(e) => set('editorFontSize', Math.max(10, Math.min(24, Number(e.target.value) || 14)))}
          />
        </div>
      </div>
      <div className="field">
        <label>Max rows kept per query result</label>
        <input
          className="q-input"
          type="number"
          min={100}
          value={form.maxResultRows}
          onChange={(e) => set('maxResultRows', Math.max(100, Number(e.target.value) || 50000))}
        />
      </div>
    </Modal>
  )
}
