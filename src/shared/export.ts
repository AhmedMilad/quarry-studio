import type { CellValue, Dialect, TextExportFormat } from './types'

function csvCell(v: CellValue): string {
  if (v === null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function sqlLiteral(v: CellValue, dialect?: Dialect): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return dialect === 'mssql' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

export function quoteId(id: string, dialect: Dialect): string {
  if (dialect === 'mysql') return '`' + id.replace(/`/g, '``') + '`'
  if (dialect === 'mssql') return '[' + id.replace(/]/g, ']]') + ']'
  return '"' + id.replace(/"/g, '""') + '"'
}

export function formatRows(
  format: TextExportFormat,
  columns: string[],
  rows: CellValue[][],
  opts: { tableName?: string; dialect?: Dialect } = {}
): string {
  switch (format) {
    case 'csv':
      return [columns.map((c) => csvCell(c)).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n'
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
        null,
        2
      )
    case 'markdown': {
      const esc = (v: CellValue): string => (v === null ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '))
      return [
        `| ${columns.map((c) => esc(c)).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)
      ].join('\n') + '\n'
    }
    case 'sql': {
      return insertStatements(opts.tableName ?? 'my_table', columns, rows, opts.dialect ?? 'postgres') + '\n'
    }
  }
}

export function formatTsv(columns: string[] | null, rows: CellValue[][]): string {
  const cell = (v: CellValue): string => (v === null ? 'NULL' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
  const lines = rows.map((r) => r.map(cell).join('\t'))
  if (columns) lines.unshift(columns.join('\t'))
  return lines.join('\n')
}

/** One `INSERT INTO table (cols) VALUES (...);` per row. `table` is used as given (already quoted/qualified). */
export function insertStatements(table: string, columns: string[], rows: CellValue[][], dialect: Dialect): string {
  const cols = columns.map((c) => quoteId(c, dialect)).join(', ')
  return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => sqlLiteral(v, dialect)).join(', ')});`).join('\n')
}

/**
 * The table a query result came from, when the statement is a plain single-table SELECT
 * (no JOIN, sub-select or set operation). Returned as written in the SQL, e.g. `public.users`.
 */
export function selectSourceTable(sql: string): string | null {
  const body = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '')
  if (!/^select\b/i.test(body)) return null
  if (/\b(join|union|intersect|except|group\s+by)\b/i.test(body) || /\(\s*select\b/i.test(body)) return null
  const ident = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`
  const m = new RegExp(String.raw`\bfrom\s+(${ident}(?:\s*\.\s*${ident}){0,2})(\s|,|$)`, 'i').exec(body)
  if (!m || m[2] === ',') return null
  // "FROM a, b" is a join too
  if (new RegExp(String.raw`\bfrom\s+${ident}(?:\s*\.\s*${ident}){0,2}(?:\s+(?:as\s+)?\w+)?\s*,`, 'i').test(body)) return null
  return m[1].replace(/\s*\.\s*/g, '.') // `a . b` → `a.b`, keeping spaces inside quoted names
}
