import type { CellValue, Dialect, TextExportFormat } from './types'

function csvCell(v: CellValue): string {
  if (v === null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function sqlLiteral(v: CellValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/'/g, "''")}'`
}

function quoteId(id: string, dialect: Dialect): string {
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
      const d = opts.dialect ?? 'postgres'
      const t = opts.tableName ? opts.tableName : 'my_table'
      const cols = columns.map((c) => quoteId(c, d)).join(', ')
      return rows.map((r) => `INSERT INTO ${t} (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n') + '\n'
    }
  }
}

export function formatTsv(columns: string[] | null, rows: CellValue[][]): string {
  const cell = (v: CellValue): string => (v === null ? 'NULL' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '))
  const lines = rows.map((r) => r.map(cell).join('\t'))
  if (columns) lines.unshift(columns.join('\t'))
  return lines.join('\n')
}
