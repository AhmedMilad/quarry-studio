import { useEffect, useMemo, useState } from 'react'
import {
  Copy,
  Database,
  FolderOpen,
  FilePlus,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Plug,
  Plus,
  Search,
  Shield,
  Trash2,
  Zap
} from 'lucide-react'
import { DB_TYPES, dialectOf, type ConnectionConfig, type DbType } from '@shared/types'
import { api } from '../api'
import { useApp } from '../store'
import { CONNECTION_COLORS, DbBadge } from './DbBadge'

export function blankConnection(type: DbType = 'mysql'): ConnectionConfig {
  const meta = DB_TYPES.find((d) => d.value === type)!
  return {
    id: '',
    name: '',
    type,
    color: CONNECTION_COLORS[0],
    host: 'localhost',
    port: meta.port,
    user: TYPE_HINTS[type].user,
    password: '',
    database: '',
    filePath: '',
    ssl: false,
    sslRejectUnauthorized: false,
    trustServerCertificate: true,
    readOnly: false,
    ssh: { enabled: false, host: '', port: 22, user: '', authMethod: 'password', password: '', privateKeyPath: '', passphrase: '' }
  }
}

/** Per-type defaults and form hints */
export const TYPE_HINTS: Record<DbType, { user: string; database: string; url: string }> = {
  mysql: { user: 'root', database: 'my_database', url: 'mysql://user:password@localhost:3306/database' },
  mariadb: { user: 'root', database: 'my_database', url: 'mariadb://user:password@localhost:3306/database' },
  postgres: { user: 'postgres', database: 'postgres', url: 'postgres://user:password@localhost:5432/database' },
  cockroach: {
    user: 'root',
    database: 'defaultdb',
    url: 'postgresql://user:password@host:26257/defaultdb?sslmode=require'
  },
  redshift: {
    user: 'awsuser',
    database: 'dev',
    url: 'redshift://user:password@cluster.region.redshift.amazonaws.com:5439/dev'
  },
  mssql: { user: 'sa', database: 'master', url: 'sqlserver://user:password@localhost:1433/database' },
  sqlite: { user: '', database: '', url: '' }
}

const SCHEME_TYPES: Record<string, DbType> = {
  mysql: 'mysql',
  mysqlx: 'mysql',
  mariadb: 'mariadb',
  postgres: 'postgres',
  postgresql: 'postgres',
  cockroachdb: 'cockroach',
  cockroach: 'cockroach',
  redshift: 'redshift',
  sqlserver: 'mssql',
  mssql: 'mssql',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  file: 'sqlite'
}

const truthySsl = (v: string | null | undefined): boolean =>
  !!v && ['require', 'required', 'verify-full', 'verify-ca', 'verify_identity', 'true', '1', 'yes'].includes(v.toLowerCase())

/**
 * Parse a connection URL. `current` is the type selected in the form: when the URL's scheme belongs
 * to the same family (e.g. a postgresql:// URL while CockroachDB or Redshift is selected, or mysql://
 * while MariaDB is selected) the selected type is kept.
 */
function parseUrl(raw: string, current: DbType): Partial<ConnectionConfig> | null {
  try {
    let url = raw.trim().replace(/^jdbc:/i, '')
    const scheme = /^([a-z0-9+.-]+):/i.exec(url)?.[1]?.toLowerCase().split('+')[0]
    const urlType = scheme ? SCHEME_TYPES[scheme] : undefined
    if (!urlType) return null
    const type = dialectOf(urlType) === dialectOf(current) ? current : urlType

    if (type === 'sqlite') {
      const path = url.replace(/^[a-z0-9]+:(\/\/)?/i, '')
      return { type, filePath: decodeURIComponent(path.startsWith('/') ? path : '/' + path) }
    }

    // SQL Server JDBC style: sqlserver://host:1433;databaseName=db;user=sa;password=x;encrypt=true
    let semicolonParams: Record<string, string> = {}
    if (dialectOf(type) === 'mssql' && url.includes(';')) {
      const [head, ...rest] = url.split(';')
      url = head
      semicolonParams = Object.fromEntries(
        rest
          .map((kv) => kv.split('='))
          .filter((p) => p.length >= 2)
          .map(([k, ...v]) => [k.trim().toLowerCase(), v.join('=').trim()])
      )
    }

    const u = new URL(url)
    const meta = DB_TYPES.find((d) => d.value === type)!
    const q = (k: string): string | null => u.searchParams.get(k)
    const ssl =
      truthySsl(q('sslmode')) ||
      truthySsl(q('ssl-mode')) ||
      truthySsl(q('ssl')) ||
      truthySsl(q('encrypt')) ||
      truthySsl(semicolonParams.encrypt)
    return {
      type,
      host: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : meta.port,
      user: decodeURIComponent(u.username) || semicolonParams.user || semicolonParams.username || '',
      password: decodeURIComponent(u.password) || semicolonParams.password || '',
      database:
        decodeURIComponent(u.pathname.replace(/^\//, '')) ||
        semicolonParams.databasename ||
        semicolonParams.database ||
        q('database') ||
        '',
      ssl
    }
  } catch {
    return null
  }
}

function describe(c: ConnectionConfig): string {
  if (c.type === 'sqlite') return c.filePath || 'No file'
  return `${c.user ? c.user + '@' : ''}${c.host}:${c.port}${c.database ? '/' + c.database : ''}`
}

export function ConnectionManager(): JSX.Element {
  const connections = useApp((s) => s.connections)
  const editing = useApp((s) => s.editingConnection)
  const setEditing = useApp((s) => s.setEditing)
  const loadConnections = useApp((s) => s.loadConnections)
  const connect = useApp((s) => s.connect)
  const toast = useApp((s) => s.toast)
  const showMenu = useApp((s) => s.showMenu)

  const [form, setForm] = useState<ConnectionConfig>(() => editing ?? blankConnection())
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<'test' | 'connect' | 'save' | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (editing) setForm(editing)
    setTestResult(null)
  }, [editing])

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const setSsh = <K extends keyof ConnectionConfig['ssh']>(k: K, v: ConnectionConfig['ssh'][K]): void =>
    setForm((f) => ({ ...f, ssh: { ...f.ssh, [k]: v } }))

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return connections.filter((c) => !q || c.name.toLowerCase().includes(q) || describe(c).toLowerCase().includes(q))
  }, [connections, search])
  const recent = useMemo(
    () =>
      [...filtered]
        .filter((c) => c.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 5),
    [filtered]
  )
  const sorted = useMemo(() => [...filtered].sort((a, b) => a.name.localeCompare(b.name)), [filtered])

  const changeType = (type: DbType): void => {
    const meta = DB_TYPES.find((d) => d.value === type)!
    const prevDefault = DB_TYPES.find((d) => d.value === form.type)!.port
    setForm((f) => ({
      ...f,
      type,
      port: f.port === prevDefault || !f.port ? meta.port : f.port,
      user: f.user === blankConnection(f.type).user ? blankConnection(type).user : f.user
    }))
    setTestResult(null)
  }

  const displayName = (c: ConnectionConfig): string =>
    c.name.trim() ||
    (c.type === 'sqlite' ? (c.filePath ?? '').split(/[\\/]/).pop() || 'SQLite' : `${c.host}${c.database ? '/' + c.database : ''}`)

  const validate = (): string | null => {
    if (form.type === 'sqlite') return form.filePath ? null : 'Choose a SQLite database file'
    if (!form.host) return 'Host is required'
    if (!form.port) return 'Port is required'
    if (form.ssh.enabled && (!form.ssh.host || !form.ssh.user)) return 'SSH host and user are required'
    return null
  }

  const doTest = async (): Promise<void> => {
    const err = validate()
    if (err) return setTestResult({ ok: false, msg: err })
    setBusy('test')
    setTestResult(null)
    try {
      const v = await api.testConnection(form)
      setTestResult({ ok: true, msg: `Connection successful — ${v}` })
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const doSave = async (): Promise<ConnectionConfig | null> => {
    const err = validate()
    if (err) {
      setTestResult({ ok: false, msg: err })
      return null
    }
    setBusy('save')
    try {
      const saved = await api.saveConnection({ ...form, name: displayName(form) })
      setForm(saved)
      await loadConnections()
      toast(`Saved "${saved.name}"`, 'success')
      return saved
    } catch (e) {
      toast((e as Error).message, 'error')
      return null
    } finally {
      setBusy(null)
    }
  }

  const doConnect = async (c: ConnectionConfig = form): Promise<void> => {
    if (c === form) {
      const err = validate()
      if (err) return setTestResult({ ok: false, msg: err })
    }
    setBusy('connect')
    setTestResult(null)
    try {
      await connect({ ...c, name: displayName(c) })
    } catch (e) {
      if (c === form) setTestResult({ ok: false, msg: (e as Error).message })
      else toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const doDelete = async (c: ConnectionConfig): Promise<void> => {
    if (!(await api.confirm(`Delete connection "${c.name}"?`, 'This cannot be undone.', 'Delete'))) return
    await api.deleteConnection(c.id)
    await loadConnections()
    if (form.id === c.id) setForm(blankConnection(form.type))
  }

  const pickFile = async (create: boolean): Promise<void> => {
    const filters = [
      { name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'] },
      { name: 'All Files', extensions: ['*'] }
    ]
    const p = create
      ? await api.saveFile({ title: 'Create SQLite database', defaultPath: 'database.sqlite', filters })
      : await api.openFile({ title: 'Open SQLite database', filters })
    if (p) setForm((f) => ({ ...f, filePath: p, name: f.name || p.split(/[\\/]/).pop() || '' }))
  }

  const applyUrl = (): void => {
    const parsed = parseUrl(url, form.type)
    if (!parsed) return toast('Could not parse connection URL', 'error')
    setForm((f) => ({ ...f, ...parsed }))
    setUrl('')
    toast('Connection details imported from URL', 'success')
  }

  const itemMenu = (e: React.MouseEvent, c: ConnectionConfig): void => {
    e.preventDefault()
    showMenu(e.clientX, e.clientY, [
      { label: 'Connect', icon: <Plug size={14} />, onClick: () => doConnect(c) },
      { label: 'Edit', icon: <Pencil size={14} />, onClick: () => setForm(c) },
      {
        label: 'Duplicate',
        icon: <Copy size={14} />,
        onClick: () => setForm({ ...c, id: '', name: `${c.name} (copy)`, createdAt: undefined, lastUsedAt: undefined })
      },
      { separator: true },
      { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => doDelete(c) }
    ])
  }

  const renderItem = (c: ConnectionConfig, keyPrefix: string): JSX.Element => (
    <div
      key={keyPrefix + c.id}
      className={`cm-item${form.id === c.id ? ' selected' : ''}`}
      onClick={() => {
        setForm(c)
        setTestResult(null)
      }}
      onDoubleClick={() => doConnect(c)}
      onContextMenu={(e) => itemMenu(e, c)}
      title="Double-click to connect"
    >
      <DbBadge type={c.type} color={c.color} />
      <div className="info">
        <div className="n" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
          {c.readOnly && <Lock size={11} className="faint" />}
        </div>
        <div className="d">{describe(c)}</div>
      </div>
    </div>
  )

  const isSqlite = form.type === 'sqlite'

  return (
    <div className="cm">
      <div className="cm-list">
        <div className="cm-list-head">
          <h2>
            <Database size={17} color="var(--accent)" /> Connections
            <span className="spacer" />
            <button
              className="btn sm"
              onClick={() => {
                setForm(blankConnection(form.type))
                setTestResult(null)
              }}
            >
              <Plus size={13} /> New
            </button>
          </h2>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: 9 }} className="faint" />
            <input
              className="q-input sm"
              style={{ paddingLeft: 28 }}
              placeholder="Search connections"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="cm-items">
          {connections.length === 0 && (
            <div className="empty-note">
              No saved connections yet.
              <br />
              Fill in the form and click <b>Save</b>.
            </div>
          )}
          {recent.length > 0 && !search && (
            <>
              <div className="cm-group">Recent</div>
              {recent.map((c) => renderItem(c, 'r-'))}
            </>
          )}
          {sorted.length > 0 && (
            <>
              <div className="cm-group">Saved ({sorted.length})</div>
              {sorted.map((c) => renderItem(c, 's-'))}
            </>
          )}
        </div>
      </div>

      <div className="cm-form-wrap">
        <form
          className="cm-form"
          onSubmit={(e) => {
            e.preventDefault()
            doConnect()
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1>{form.id ? form.name || 'Edit connection' : 'New connection'}</h1>
            <span className="spacer" />
            {form.id && (
              <button type="button" className="btn ghost sm" onClick={() => doDelete(form)}>
                <Trash2 size={13} /> Delete
              </button>
            )}
          </div>

          <div className="field">
            <label>Connection type</label>
            <div className="type-grid">
              {DB_TYPES.map((t) => (
                <div
                  key={t.value}
                  className={`type-card${form.type === t.value ? ' active' : ''}`}
                  onClick={() => changeType(t.value)}
                >
                  <DbBadge type={t.value} size={22} />
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {!isSqlite && (
            <div className="field">
              <label>Import from URL (optional)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="q-input mono"
                  placeholder={TYPE_HINTS[form.type].url}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyUrl()
                    }
                  }}
                />
                <button type="button" className="btn" onClick={applyUrl} disabled={!url.trim()}>
                  <Link2 size={13} /> Import
                </button>
              </div>
            </div>
          )}

          <div className="panel">
            {isSqlite ? (
              <div className="field">
                <label>Database file</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="q-input mono"
                    value={form.filePath ?? ''}
                    placeholder="/path/to/database.sqlite"
                    onChange={(e) => set('filePath', e.target.value)}
                  />
                  <button type="button" className="btn" onClick={() => pickFile(false)}>
                    <FolderOpen size={13} /> Open
                  </button>
                  <button type="button" className="btn" onClick={() => pickFile(true)}>
                    <FilePlus size={13} /> Create
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="row">
                  <div className="field" style={{ flex: 3 }}>
                    <label>Host</label>
                    <input className="q-input" value={form.host} onChange={(e) => set('host', e.target.value)} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Port</label>
                    <input
                      className="q-input"
                      type="number"
                      value={form.port || ''}
                      onChange={(e) => set('port', Number(e.target.value))}
                    />
                  </div>
                </div>
                <div className="row">
                  <div className="field">
                    <label>User</label>
                    <input className="q-input" value={form.user} onChange={(e) => set('user', e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Password</label>
                    <input
                      className="q-input"
                      type="password"
                      value={form.password ?? ''}
                      onChange={(e) => set('password', e.target.value)}
                    />
                  </div>
                </div>
                <div className="field">
                  <label>Default database (optional)</label>
                  <input
                    className="q-input"
                    value={form.database}
                    placeholder={TYPE_HINTS[form.type].database}
                    onChange={(e) => set('database', e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <label className="checkbox">
                    <input type="checkbox" checked={form.ssl} onChange={(e) => set('ssl', e.target.checked)} />
                    <Shield size={13} /> Enable SSL / TLS
                  </label>
                  {form.ssl && (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={form.sslRejectUnauthorized}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            sslRejectUnauthorized: e.target.checked,
                            trustServerCertificate: !e.target.checked
                          }))
                        }
                      />
                      Verify server certificate
                    </label>
                  )}
                </div>
              </>
            )}
          </div>

          {!isSqlite && (
            <div className="panel">
              <label className="checkbox panel-title" style={{ color: 'var(--text)' }}>
                <input type="checkbox" checked={form.ssh.enabled} onChange={(e) => setSsh('enabled', e.target.checked)} />
                <KeyRound size={14} /> Connect through SSH tunnel
              </label>
              {form.ssh.enabled && (
                <>
                  <div className="row">
                    <div className="field" style={{ flex: 3 }}>
                      <label>SSH host</label>
                      <input className="q-input" value={form.ssh.host} onChange={(e) => setSsh('host', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label>SSH port</label>
                      <input
                        className="q-input"
                        type="number"
                        value={form.ssh.port || ''}
                        onChange={(e) => setSsh('port', Number(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="row">
                    <div className="field">
                      <label>SSH user</label>
                      <input className="q-input" value={form.ssh.user} onChange={(e) => setSsh('user', e.target.value)} />
                    </div>
                    <div className="field">
                      <label>Authentication</label>
                      <select
                        className="select"
                        value={form.ssh.authMethod}
                        onChange={(e) => setSsh('authMethod', e.target.value as ConnectionConfig['ssh']['authMethod'])}
                      >
                        <option value="password">Password</option>
                        <option value="key">Private key file</option>
                        <option value="agent">SSH agent</option>
                      </select>
                    </div>
                  </div>
                  {form.ssh.authMethod === 'password' && (
                    <div className="field">
                      <label>SSH password</label>
                      <input
                        className="q-input"
                        type="password"
                        value={form.ssh.password ?? ''}
                        onChange={(e) => setSsh('password', e.target.value)}
                      />
                    </div>
                  )}
                  {form.ssh.authMethod === 'key' && (
                    <div className="row">
                      <div className="field" style={{ flex: 2 }}>
                        <label>Private key</label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            className="q-input mono"
                            value={form.ssh.privateKeyPath ?? ''}
                            placeholder="~/.ssh/id_rsa"
                            onChange={(e) => setSsh('privateKeyPath', e.target.value)}
                          />
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              const p = await api.openFile({ title: 'Select private key' })
                              if (p) setSsh('privateKeyPath', p)
                            }}
                          >
                            <FolderOpen size={13} />
                          </button>
                        </div>
                      </div>
                      <div className="field" style={{ flex: 1 }}>
                        <label>Passphrase</label>
                        <input
                          className="q-input"
                          type="password"
                          value={form.ssh.passphrase ?? ''}
                          onChange={(e) => setSsh('passphrase', e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="panel">
            <div className="row">
              <div className="field" style={{ flex: 2 }}>
                <label>Connection name</label>
                <input
                  className="q-input"
                  value={form.name}
                  placeholder={displayName({ ...form, name: '' })}
                  onChange={(e) => set('name', e.target.value)}
                />
              </div>
              <div className="field" style={{ flex: 1.4 }}>
                <label>Color</label>
                <div className="colors" style={{ height: 30 }}>
                  {CONNECTION_COLORS.map((c) => (
                    <div
                      key={c}
                      className={`color-swatch${form.color === c ? ' active' : ''}`}
                      style={{ background: c }}
                      onClick={() => set('color', c)}
                    />
                  ))}
                </div>
              </div>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={form.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />
              <Lock size={13} /> Read-only mode (block writes and edits)
            </label>
          </div>

          {testResult && <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>{testResult.msg}</div>}

          <div className="form-actions">
            <button type="button" className="btn" onClick={doTest} disabled={!!busy}>
              {busy === 'test' ? <Loader2 size={13} className="spin" /> : <Zap size={13} />} Test
            </button>
            <span className="spacer" />
            <button type="button" className="btn" onClick={doSave} disabled={!!busy}>
              {busy === 'save' && <Loader2 size={13} className="spin" />}
              {form.id ? 'Save changes' : 'Save'}
            </button>
            <button type="submit" className="btn primary" disabled={!!busy}>
              {busy === 'connect' ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} Connect
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
