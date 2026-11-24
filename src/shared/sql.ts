export interface Statement {
  text: string
  start: number
  end: number
}

/**
 * Split a SQL script into statements on `;`, respecting quotes, identifiers,
 * line/block comments and PostgreSQL dollar-quoted strings.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  let start = 0
  let i = 0
  const n = sql.length

  const push = (end: number): void => {
    const raw = sql.slice(start, end)
    const text = raw.trim()
    if (text && !isOnlyComments(text)) {
      const lead = raw.length - raw.trimStart().length
      out.push({ text, start: start + lead, end: start + lead + text.length })
    }
  }

  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(sql[i - 1]))) {
      // MySQL style comment; only when at start of a token
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '/' && next === '*') {
      const endIdx = sql.indexOf('*/', i + 2)
      i = endIdx === -1 ? n : endIdx + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      i++
      while (i < n) {
        if (sql[i] === '\\' && c !== '"') {
          i += 2
          continue
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      i++
      continue
    }
    if (c === '[') {
      const endIdx = sql.indexOf(']', i + 1)
      i = endIdx === -1 ? n : endIdx + 1
      continue
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const endIdx = sql.indexOf(tag, i + tag.length)
        i = endIdx === -1 ? n : endIdx + tag.length
        continue
      }
    }
    if (c === ';') {
      push(i)
      start = i + 1
    }
    i++
  }
  push(n)
  return out
}

function isOnlyComments(text: string): boolean {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim()
  return stripped.length === 0
}

/** Split T-SQL batches on lines containing only GO */
export function splitGoBatches(sql: string): string[] {
  return sql
    .split(/^\s*GO\s*(?:--.*)?$/gim)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Return the statement under the given character offset */
export function statementAt(sql: string, offset: number): Statement | null {
  const stmts = splitStatements(sql)
  if (!stmts.length) return null
  for (const s of stmts) {
    if (offset >= s.start && offset <= s.end + 1) return s
  }
  // cursor in whitespace between statements: choose the previous one
  let prev: Statement | null = null
  for (const s of stmts) {
    if (s.start > offset) break
    prev = s
  }
  return prev ?? stmts[0]
}

const READ_ONLY_PREFIX = /^\s*(select|show|explain|describe|desc|with|pragma|values|table)\b/i

export function isReadOnlyStatement(sql: string): boolean {
  return splitStatements(sql).every((s) => {
    const body = s.text.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/g, '')
    if (!READ_ONLY_PREFIX.test(body)) return false
    // WITH … can lead into a write (WITH x AS (…) DELETE …): judge it by its main statement
    if (/^\s*with\b/i.test(body)) return /^(select|values|table)$/i.test(mainKeywordAfterWith(body) ?? '')
    return true
  })
}

/**
 * The statement keyword that follows a WITH clause: the first SELECT / INSERT / UPDATE / DELETE / MERGE /
 * VALUES / TABLE outside parentheses, quotes and comments (CTE bodies are inside parentheses).
 */
function mainKeywordAfterWith(sql: string): string | null {
  let depth = 0
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      if (nl < 0) return null
      i = nl
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return null
      i = end + 1
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      while (j < sql.length && !(sql[j] === close && sql[j + 1] !== close)) j += sql[j] === close ? 2 : 1
      i = j
    } else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /[A-Za-z_]/.test(c) && !/[\w$]/.test(sql[i - 1] ?? ' ')) {
      const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))![0]
      if (/^(select|insert|update|delete|merge|values|table)$/i.test(word) && i > 0) return word.toLowerCase()
      i += word.length - 1
    }
  }
  return null
}
