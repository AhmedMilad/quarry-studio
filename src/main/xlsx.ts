import ExcelJS from 'exceljs'
import type { CellValue } from '@shared/types'

const EXCEL_MAX_ROWS = 1_048_575 // minus the header row
const EXCEL_MAX_CELL = 32_767

// plain numbers only: no leading zeros (phone numbers, codes) and ≤ 15 significant digits (Excel precision)
const NUMERIC = /^-?(0|[1-9]\d{0,14})(\.\d{1,15})?$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/

function toExcel(v: CellValue): { value: ExcelJS.CellValue; fmt?: string } {
  if (v === null) return { value: null }
  if (typeof v === 'number' || typeof v === 'boolean') return { value: v }
  const s = String(v)
  if (NUMERIC.test(s)) return { value: Number(s) }
  const d = DATE.exec(s)
  if (d) {
    const [, y, mo, da, h, mi, se, ms] = d
    // build in UTC: ExcelJS serialises Dates as UTC, so the sheet shows the same wall-clock time
    const date = new Date(
      Date.UTC(+y, +mo - 1, +da, h ? +h : 0, mi ? +mi : 0, se ? +se : 0, ms ? Math.round(+`0.${ms}` * 1000) : 0)
    )
    if (!isNaN(date.getTime())) return { value: date, fmt: h ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd' }
  }
  return { value: s.length > EXCEL_MAX_CELL ? s.slice(0, EXCEL_MAX_CELL - 1) + '…' : s }
}

/** Build an .xlsx workbook: bold frozen header, auto-filter, sized columns, typed numbers & dates */
export async function buildXlsx(columns: string[], rows: CellValue[][], sheetName = 'Data'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Quarry Studio'
  wb.created = new Date()
  // sheet names: max 31 chars, no []:*?/\
  const ws = wb.addWorksheet(sheetName.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Data', {
    views: [{ state: 'frozen', ySplit: 1 }]
  })

  const header = ws.addRow(columns)
  header.font = { bold: true }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }

  const widths = columns.map((c) => Math.min(60, Math.max(8, c.length + 2)))
  const limit = Math.min(rows.length, EXCEL_MAX_ROWS)
  for (let i = 0; i < limit; i++) {
    const src = rows[i]
    const converted = src.map(toExcel)
    const row = ws.addRow(converted.map((x) => x.value))
    converted.forEach((x, j) => {
      if (x.fmt) row.getCell(j + 1).numFmt = x.fmt
      if (i < 200) {
        const len = x.fmt ? x.fmt.length : src[j] === null ? 0 : String(src[j]).length
        if (len + 2 > widths[j]) widths[j] = Math.min(60, len + 2)
      }
    })
  }
  ws.columns.forEach((col, j) => {
    col.width = widths[j]
  })
  if (columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

export const XLSX_ROW_LIMIT = EXCEL_MAX_ROWS
