import type { Dialect } from './types'
import { splitStatements } from './sql'

/**
 * Finds data-changing statements (UPDATE, DELETE, TRUNCATE, DROP TABLE/DATABASE/SCHEMA) in a script and,
 * where possible, derives read-only SQL that tells us what they would affect. Counting is done by
 * rewriting DELETE into SELECT COUNT(*) — never by running the DELETE and rolling back, which is not
 * safe on non-transactional engines (e.g. MySQL MyISAM).
 */

export type DestructiveKind = 'delete' | 'update' | 'truncate' | 'drop-table' | 'drop-database'

export interface Assignment {
  /** column name without quotes / table qualifier */
  column: string
  /** the column reference as written (e.g. `u."status"`) */
  ref: string
  /** the new-value expression as written */
  expr: string
}

export interface ParsedTable {
  /** as written in the query (quoted / qualified), safe to reuse in generated SQL */
  sql: string
  name: string
  schema?: string
}

export interface DestructiveStatement {
  index: number
  kind: DestructiveKind
  sql: string
  table?: ParsedTable
  /** WHERE condition as written (DELETE only) */
  where?: string
  hasWhere: boolean
  /** LIMIT / TOP cap on DELETE */
  limit?: number
  /** counts the rows the statement removes; null if we can't derive it */
  countSql: string | null
  /** true when countSql may over-count (multi-table DELETE with joins) */
  approximate?: boolean
  /** first few rows that would be removed (single-table DELETE only) */
  previewSql: string | null
  /** total rows in the table */
  totalSql: string | null
  /** extra caveat to show the user */
  note?: string
  /** `FROM <table> [WHERE …]` selecting exactly the rows removed (for counting cascaded child rows) */
  baseSql?: string | null
  /** leading WITH … clause that generated SQL must keep */
  ctePrefix?: string
  /** UPDATE: the SET list */
  assignments?: Assignment[]
  /** UPDATE: counts matched rows whose values would actually change */
  changingSql?: string | null
  /** UPDATE: plain `SELECT *` preview used if previewSql (with new values) fails */
  previewPlainSql?: string | null
}

const ID = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)'
const QID = `${ID}(?:\\s*\\.\\s*${ID}){0,2}`
const RESERVED_AFTER_TABLE = /^(where|using|order|limit|returning|output|from|with|option)$/i

function parseTable(text: string): ParsedTable {
  const parts = text.split(/\s*\.\s*/).map((p) => p.replace(/^[`"[]|[`"\]]$/g, ''))
  return {
    sql: text.trim(),
    name: parts[parts.length - 1],
    schema: parts.length > 1 ? parts[parts.length - 2] : undefined
  }
}

function stripLeadingComments(s: string): string {
  let t = s
  for (;;) {
    t = t.trimStart()
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n')
      if (nl < 0) return ''
      t = t.slice(nl + 1)
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/')
      if (end < 0) return ''
      t = t.slice(end + 2)
    } else return t
  }
}

function previewOf(base: string, dialect: Dialect, n = 5): string {
  return dialect === 'mssql' ? `SELECT TOP ${n} * ${base}` : `SELECT * ${base} LIMIT ${n}`
}

function analyzeDelete(stmt: string, index: number, dialect: Dialect): DestructiveStatement | null {
  const re = new RegExp(
    `^DELETE\\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\\s+)*(?:TOP\\s*\\(\\s*(\\d+)\\s*\\)\\s*(PERCENT\\s+)?)?(?:FROM\\s+)?(?:ONLY\\s+)?(${QID})(?:\\s+(?:AS\\s+)?([A-Za-z_][\\w$]*))?\\s*([\\s\\S]*)$`,
    'i'
  )
  let m = re.exec(stmt)
  // the "alias" may really be the next keyword (DELETE FROM t WHERE ...)
  if (m && m[4] && RESERVED_AFTER_TABLE.test(m[4])) {
    m = [...m] as RegExpExecArray
    m[5] = `${m[4]} ${m[5]}`
    m[4] = undefined as unknown as string
  }

  // multi-table forms: DELETE t1 FROM t1 JOIN t2 ...  /  DELETE t1, t2 FROM ...
  const multi = /^DELETE\s+(?!FROM\b)[\s\S]*?\bFROM\s+([\s\S]+)$/i.exec(stmt)
  if (multi && (!m || /^FROM\b/i.test(m[5] ?? ''))) {
    const fromClause = multi[1].replace(/\s+(?:OPTION|RETURNING)\b[\s\S]*$/i, '')
    let target = m ? parseTable(m[3]) : undefined
    // DELETE o FROM orders o JOIN ... → the target "o" is an alias of orders
    const items = new RegExp(`(?:^|,|\\bJOIN)\\s+(${QID})(?:\\s+(?:AS\\s+)?([A-Za-z_][\\w$]*))?`, 'gi')
    for (const it of (' ' + fromClause).matchAll(items)) {
      const t = parseTable(it[1])
      const alias = it[2] && !/^(on|where|join|inner|left|right|full|cross|using)$/i.test(it[2]) ? it[2] : undefined
      if (target && (alias === target.name || (!alias && t.name === target.name) || t.name === target.name)) {
        target = t
        break
      }
    }
    return {
      index,
      kind: 'delete',
      sql: stmt,
      table: target,
      hasWhere: /\bWHERE\b/i.test(fromClause),
      where: /\bWHERE\s+([\s\S]*)$/i.exec(fromClause)?.[1],
      countSql: `SELECT COUNT(*) AS n FROM ${fromClause}`,
      approximate: true,
      previewSql: null,
      totalSql: target ? `SELECT COUNT(*) AS n FROM ${target.sql}` : null,
      note: 'Multi-table DELETE: the count is of matching joined rows and may be higher than the rows actually removed.'
    }
  }
  if (!m) return null

  const top = m[1] ? Number(m[1]) : undefined
  const topPercent = !!m[2]
  const table = parseTable(m[3])
  const alias = m[4]
  let rest = (m[5] ?? '').trim()

  rest = rest.replace(/\bRETURNING\b[\s\S]*$/i, '').trim()
  rest = rest.replace(/^OUTPUT\b[\s\S]*?(?=\bWHERE\b|$)/i, '').trim()
  rest = rest.replace(/\bOPTION\s*\([\s\S]*\)\s*$/i, '').trim()

  let using: string | undefined
  let where: string | undefined
  let orderBy = ''
  let limit: number | undefined

  const usingM = /^USING\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]*))?$/i.exec(rest)
  if (usingM) {
    using = usingM[1]
    where = usingM[2]
  } else if (/^WHERE\b/i.test(rest)) {
    where = rest.replace(/^WHERE\s+/i, '')
  } else if (rest && !/^(ORDER\s+BY|LIMIT)\b/i.test(rest)) {
    // something we don't understand (e.g. WHERE CURRENT OF, vendor syntax)
    return {
      index,
      kind: 'delete',
      sql: stmt,
      table,
      hasWhere: /\bWHERE\b/i.test(rest),
      countSql: null,
      previewSql: null,
      totalSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
      note: 'Could not work out which rows this DELETE matches.'
    }
  }

  const tail = (s: string): string => {
    const lim = /\s+LIMIT\s+(\d+)\s*$/i.exec(s) ?? /^LIMIT\s+(\d+)\s*$/i.exec(s)
    if (lim) {
      limit = Number(lim[1])
      s = s.slice(0, lim.index)
    }
    const ord = /(?:^|\s+)ORDER\s+BY\s+[\s\S]*$/i.exec(s)
    if (ord) {
      orderBy = ' ' + ord[0].trim()
      s = s.slice(0, ord.index)
    }
    return s.trim()
  }
  if (where && /^CURRENT\s+OF\b/i.test(where)) {
    return {
      index,
      kind: 'delete',
      sql: stmt,
      table,
      where,
      hasWhere: true,
      countSql: null,
      previewSql: null,
      totalSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
      note: 'Deletes the row under a cursor (WHERE CURRENT OF) — exactly one row.'
    }
  }
  if (where !== undefined) where = tail(where) || undefined
  else if (rest) tail(rest)

  const from = `FROM ${table.sql}${alias ? ` ${alias}` : ''}`
  const cond = using
    ? ` WHERE EXISTS (SELECT 1 FROM ${using}${where ? ` WHERE ${where}` : ''})`
    : where
      ? ` WHERE ${where}`
      : ''
  const base = `${from}${cond}`

  let countSql: string
  let note: string | undefined
  if (top !== undefined && dialect === 'mssql') {
    countSql = `SELECT COUNT(*) AS n FROM (SELECT TOP (${top})${topPercent ? ' PERCENT' : ''} 1 AS x ${base}) q`
  } else if (limit !== undefined) {
    countSql = `SELECT COUNT(*) AS n FROM (SELECT 1 AS x ${base}${orderBy} LIMIT ${limit}) q`
  } else {
    countSql = `SELECT COUNT(*) AS n ${base}`
  }
  if (using) note = 'Uses USING: rows are counted when at least one joined row matches.'

  return {
    index,
    kind: 'delete',
    sql: stmt,
    table,
    where,
    hasWhere: !!(where || using),
    limit: top ?? limit,
    countSql,
    previewSql: previewOf(base + (limit === undefined ? orderBy : ''), dialect),
    totalSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
    note,
    baseSql: top === undefined && limit === undefined ? base : null
  }
}

/** split on a separator character outside parentheses / quotes */
function splitTopLevel(sql: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === sep && depth === 0) {
      out.push(sql.slice(start, i))
      start = i + 1
    }
  }
  out.push(sql.slice(start))
  return out.map((x) => x.trim()).filter(Boolean)
}

/** earliest of several top-level keywords, or null */
function firstTopLevel(sql: string, kws: string[]): { index: number; kw: string } | null {
  let best: { index: number; kw: string } | null = null
  for (const kw of kws) {
    const i = topLevelKeyword(sql, kw)
    if (i >= 0 && (!best || i < best.index)) best = { index: i, kw: kw.toUpperCase() }
  }
  return best
}

/** pull a trailing ORDER BY / LIMIT n off a clause */
function splitOrderLimit(s: string): { rest: string; orderBy: string; limit?: number } {
  let rest = s
  let limit: number | undefined
  let orderBy = ''
  const lim = /(?:^|\s+)LIMIT\s+(\d+)\s*$/i.exec(rest)
  if (lim) {
    limit = Number(lim[1])
    rest = rest.slice(0, lim.index)
  }
  const ord = topLevelKeyword(rest, 'ORDER')
  if (ord >= 0 && /^ORDER\s+BY\b/i.test(rest.slice(ord))) {
    orderBy = ' ' + rest.slice(ord).trim()
    rest = rest.slice(0, ord)
  }
  return { rest: rest.trim(), orderBy, limit }
}

/** dialect-specific "a equals b, treating NULLs as equal" */
function nullSafeEq(a: string, b: string, dialect: Dialect): string {
  switch (dialect) {
    case 'mysql':
      return `${a} <=> (${b})`
    case 'postgres':
      return `${a} IS NOT DISTINCT FROM (${b})`
    case 'sqlite':
      return `${a} IS (${b})`
    case 'mssql':
      return `(${a} = (${b}) OR (${a} IS NULL AND (${b}) IS NULL))`
  }
}

const unquote = (id: string): string => id.replace(/^[`"[]|[`"\]]$/g, '')

function analyzeUpdate(stmt: string, index: number, dialect: Dialect): DestructiveStatement {
  const unknown = (table?: ParsedTable, note = 'Could not work out which rows this UPDATE matches.'): DestructiveStatement => ({
    index,
    kind: 'update',
    sql: stmt,
    table,
    hasWhere: /\bWHERE\b/i.test(stmt),
    countSql: null,
    previewSql: null,
    totalSql: table ? `SELECT COUNT(*) AS n FROM ${table.sql}` : null,
    note
  })
  const head = new RegExp(
    `^UPDATE\\s+(?:(?:LOW_PRIORITY|IGNORE)\\s+)*(?:OR\\s+(?:ROLLBACK|ABORT|REPLACE|FAIL|IGNORE)\\s+)?(?:TOP\\s*\\(\\s*(\\d+)\\s*\\)\\s*(PERCENT\\s+)?)?(?:ONLY\\s+)?(${QID})(?:\\s+(?:AS\\s+)?([A-Za-z_][\\w$]*))?\\s+([\\s\\S]*)$`,
    'i'
  ).exec(stmt)
  if (!head) return unknown()
  const top = head[1] ? Number(head[1]) : undefined
  const topPercent = !!head[2]
  let table = parseTable(head[3])
  let alias: string | undefined = head[4]
  let rest = head[5]
  if (alias && /^(set|join|inner|left|right|cross|straight_join|natural|full)$/i.test(alias)) {
    rest = `${alias} ${rest}`
    alias = undefined
  }

  const setAt = topLevelKeyword(rest, 'SET')
  if (setAt < 0) return unknown(table)
  const joinPart = rest.slice(0, setAt).trim() // MySQL: UPDATE a JOIN b ON … SET …
  const afterSet = rest.slice(setAt + 3)
  const end = firstTopLevel(afterSet, ['FROM', 'WHERE', 'RETURNING', 'OUTPUT', 'ORDER', 'LIMIT', 'OPTION'])
  const setList = end ? afterSet.slice(0, end.index) : afterSet
  let tail = end ? afterSet.slice(end.index).trim() : ''

  const assignments: Assignment[] = []
  for (const part of splitTopLevel(setList, ',')) {
    const m = new RegExp(`^(${QID})\\s*=\\s*([\\s\\S]+)$`).exec(part)
    if (!m) continue
    const pieces = m[1].split(/\s*\.\s*/)
    assignments.push({ column: unquote(pieces[pieces.length - 1]), ref: m[1], expr: m[2].trim() })
  }

  // drop clauses that don't affect which rows match
  const ret = topLevelKeyword(tail, 'RETURNING')
  if (ret >= 0) tail = tail.slice(0, ret).trim()
  const opt = topLevelKeyword(tail, 'OPTION')
  if (opt >= 0) tail = tail.slice(0, opt).trim()
  if (/^OUTPUT\b/i.test(tail)) {
    const next = firstTopLevel(tail, ['FROM', 'WHERE'])
    tail = next ? tail.slice(next.index).trim() : ''
  }

  let from: string | undefined
  let where: string | undefined
  const whereAt = topLevelKeyword(tail, 'WHERE')
  if (/^FROM\b/i.test(tail)) from = tail.slice(4, whereAt >= 0 ? whereAt : undefined).trim()
  const afterWhere = whereAt >= 0 ? tail.slice(whereAt + 5) : /^(ORDER|LIMIT)\b/i.test(tail) ? tail : ''
  const ol = splitOrderLimit(afterWhere)
  if (whereAt >= 0) where = ol.rest || undefined
  if (where && /^CURRENT\s+OF\b/i.test(where)) return unknown(table, 'Updates the row under a cursor (WHERE CURRENT OF) — exactly one row.')
  const limit = top ?? ol.limit
  const target = alias ?? table.sql
  const totalSqlFor = (t: ParsedTable): string => `SELECT COUNT(*) AS n FROM ${t.sql}`

  // ---- multi-table forms: counts are approximate (joins can repeat rows) ----
  if (joinPart || (from && dialect === 'mssql')) {
    let fromClause = joinPart ? `${table.sql}${alias ? ` ${alias}` : ''} ${joinPart}` : from!
    if (!joinPart && from) {
      // UPDATE a SET … FROM t a JOIN … → resolve the alias to the real table
      const items = new RegExp(`(?:^|,|\\bJOIN)\\s+(${QID})(?:\\s+(?:AS\\s+)?([A-Za-z_][\\w$]*))?`, 'gi')
      for (const it of (' ' + from).matchAll(items)) {
        const t = parseTable(it[1])
        const a = it[2] && !/^(on|where|join|inner|left|right|full|cross)$/i.test(it[2]) ? it[2] : undefined
        if (a === table.name || t.name === table.name) {
          table = t
          break
        }
      }
      fromClause = from
    }
    return {
      index,
      kind: 'update',
      sql: stmt,
      table,
      where,
      hasWhere: !!where,
      limit,
      assignments,
      countSql: `SELECT COUNT(*) AS n FROM ${fromClause}${where ? ` WHERE ${where}` : ''}`,
      approximate: true,
      previewSql: null,
      totalSql: totalSqlFor(table),
      note: 'Multi-table UPDATE: the count is of matching joined rows and may be higher than the rows actually changed.'
    }
  }

  // ---- single table (optionally PostgreSQL / SQLite UPDATE … FROM) ----
  const fromSql = `FROM ${table.sql}${alias ? ` ${alias}` : ''}`
  const cond = from
    ? `EXISTS (SELECT 1 FROM ${from}${where ? ` WHERE ${where}` : ''})`
    : where
  const base = `${fromSql}${cond ? ` WHERE ${cond}` : ''}`

  let countSql: string
  if (top !== undefined && dialect === 'mssql') {
    countSql = `SELECT COUNT(*) AS n FROM (SELECT TOP (${top})${topPercent ? ' PERCENT' : ''} 1 AS x ${base}) q`
  } else if (ol.limit !== undefined) {
    countSql = `SELECT COUNT(*) AS n FROM (SELECT 1 AS x ${base}${ol.orderBy} LIMIT ${ol.limit}) q`
  } else {
    countSql = `SELECT COUNT(*) AS n ${base}`
  }

  const simple = !from && limit === undefined && assignments.length > 0
  const changingSql = simple
    ? `SELECT COUNT(*) AS n ${fromSql} WHERE ${where ? `(${where}) AND ` : ''}NOT (${assignments
        .map((a) => nullSafeEq(a.ref, a.expr, dialect))
        .join(' AND ')})`
    : null

  const newCols = assignments.map((a, i) => `(${a.expr}) AS q__new_${i}`).join(', ')
  const orderTail = ol.limit === undefined ? ol.orderBy : ''
  const previewPlainSql =
    dialect === 'mssql' ? `SELECT TOP 5 ${target}.* ${base}${orderTail}` : `SELECT ${target}.* ${base}${orderTail} LIMIT 5`
  const previewSql = assignments.length
    ? dialect === 'mssql'
      ? `SELECT TOP 5 ${target}.*, ${newCols} ${base}${orderTail}`
      : `SELECT ${target}.*, ${newCols} ${base}${orderTail} LIMIT 5`
    : previewPlainSql

  return {
    index,
    kind: 'update',
    sql: stmt,
    table,
    where,
    hasWhere: !!(where || from),
    limit,
    assignments,
    countSql,
    changingSql,
    previewSql,
    previewPlainSql,
    totalSql: totalSqlFor(table),
    baseSql: limit === undefined ? base : null,
    note: from ? 'Uses FROM: rows are counted when at least one joined row matches.' : undefined
  }
}

/** index of a keyword outside parentheses / quotes, or -1 */
function topLevelKeyword(sql: string, kw: string): number {
  let depth = 0
  let quote: string | null = null
  const re = new RegExp(`^${kw}\\b`, 'i')
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /\s/.test(sql[i - 1] ?? ' ') && re.test(sql.slice(i))) return i
  }
  return -1
}

export function analyzeDestructive(sql: string, dialect: Dialect): DestructiveStatement[] {
  const out: DestructiveStatement[] = []
  splitStatements(sql).forEach((s, index) => {
    const stmt = stripLeadingComments(s.text).replace(/;\s*$/, '')
    if (/^WITH\b/i.test(stmt)) {
      const upd = topLevelKeyword(stmt, 'UPDATE')
      const del = topLevelKeyword(stmt, 'DELETE')
      if (upd >= 0 && (del < 0 || upd < del)) {
        const prefix = stmt.slice(0, upd).trimEnd()
        const u = analyzeUpdate(stmt.slice(upd), index, dialect)
        const withCte = (q: string | null | undefined): string | null => (q ? `${prefix} ${q}` : null)
        out.push({
          ...u,
          sql: stmt,
          countSql: withCte(u.countSql),
          changingSql: withCte(u.changingSql),
          previewSql: withCte(u.previewSql),
          previewPlainSql: withCte(u.previewPlainSql),
          ctePrefix: prefix
        })
        return
      }
      const at = del
      if (at >= 0) {
        const prefix = stmt.slice(0, at).trimEnd()
        const d = analyzeDelete(stmt.slice(at), index, dialect)
        const withCte = (q: string | null): string | null => (q ? `${prefix} ${q}` : null)
        out.push(
          d
            ? { ...d, sql: stmt, countSql: withCte(d.countSql), previewSql: withCte(d.previewSql), ctePrefix: prefix }
            : { index, kind: 'delete', sql: stmt, hasWhere: /\bWHERE\b/i.test(stmt), countSql: null, previewSql: null, totalSql: null }
        )
      }
      return
    }
    if (/^UPDATE\b/i.test(stmt)) {
      out.push(analyzeUpdate(stmt, index, dialect))
      return
    }
    if (/^DELETE\b/i.test(stmt)) {
      const d = analyzeDelete(stmt, index, dialect)
      out.push(
        d ?? { index, kind: 'delete', sql: stmt, hasWhere: /\bWHERE\b/i.test(stmt), countSql: null, previewSql: null, totalSql: null }
      )
      return
    }
    const trunc = new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:ONLY\\s+)?(${QID}(?:\\s*,\\s*${QID})*)`, 'i').exec(stmt)
    if (trunc) {
      for (const t of trunc[1].split(/\s*,\s*/)) {
        const table = parseTable(t)
        out.push({
          index,
          kind: 'truncate',
          sql: stmt,
          table,
          hasWhere: false,
          countSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
          previewSql: null,
          totalSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
          baseSql: `FROM ${table.sql}`,
          note:
            dialect === 'mysql'
              ? 'TRUNCATE removes every row and commits immediately — it cannot be rolled back.'
              : 'TRUNCATE removes every row in the table.'
        })
      }
      return
    }
    const drop = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${QID}(?:\\s*,\\s*${QID})*)`, 'i').exec(stmt)
    if (drop) {
      for (const t of drop[1].split(/\s*,\s*/)) {
        const table = parseTable(t)
        out.push({
          index,
          kind: 'drop-table',
          sql: stmt,
          table,
          hasWhere: false,
          countSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
          previewSql: null,
          totalSql: `SELECT COUNT(*) AS n FROM ${table.sql}`,
          baseSql: `FROM ${table.sql}`,
          note: 'The table, its structure and all of its rows will be removed.'
        })
      }
      return
    }
    const dropDb = /^DROP\s+(DATABASE|SCHEMA)\s+(?:IF\s+EXISTS\s+)?(\S+)/i.exec(stmt)
    if (dropDb) {
      out.push({
        index,
        kind: 'drop-database',
        sql: stmt,
        table: parseTable(dropDb[2]),
        hasWhere: false,
        countSql: null,
        previewSql: null,
        totalSql: null,
        note: `The whole ${dropDb[1].toLowerCase()} and every table in it will be removed.`
      })
    }
  })
  return out
}
