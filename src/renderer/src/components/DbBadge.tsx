import type { DbType } from '@shared/types'

export const DB_META: Record<DbType, { abbr: string; color: string }> = {
  mysql: { abbr: 'MY', color: '#00758f' },
  mariadb: { abbr: 'MA', color: '#a0522d' },
  postgres: { abbr: 'PG', color: '#336791' },
  cockroach: { abbr: 'CR', color: '#6933ff' },
  redshift: { abbr: 'RS', color: '#8c4fff' },
  mssql: { abbr: 'MS', color: '#cc2927' },
  sqlite: { abbr: 'SL', color: '#0f80cc' }
}

/** Dark or light text, whichever reads better on the given hex background */
export function readableTextOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff'
}

/**
 * Database-type abbreviation badge. Pass `color` (a saved connection's colour) to use it as the
 * background instead of the database type's brand colour.
 */
export function DbBadge({ type, size = 30, color }: { type: DbType; size?: number; color?: string }): JSX.Element {
  const m = DB_META[type]
  const bg = color ?? m.color
  return (
    <div
      className="ico"
      style={{ background: bg, color: readableTextOn(bg), width: size, height: size, fontSize: Math.max(8, size * 0.33) }}
      title={type}
    >
      {m.abbr}
    </div>
  )
}

export const CONNECTION_COLORS = ['#9aa2ae', '#ef5350', '#f5a524', '#e5c07b', '#4caf7d', '#26a69a', '#5c9cf5', '#ab47bc', '#ec407a']
