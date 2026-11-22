import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import type { CompletionTable } from '@shared/types'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}
loader.config({ monaco })

monaco.editor.defineTheme('quarry-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c792ea', fontStyle: 'bold' },
    { token: 'string', foreground: 'c3e88d' },
    { token: 'number', foreground: 'f78c6c' },
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    { token: 'operator', foreground: '89ddff' },
    { token: 'predefined', foreground: '82aaff' }
  ],
  colors: {
    'editor.background': '#1b1e24',
    'editor.lineHighlightBackground': '#23272f',
    'editorLineNumber.foreground': '#4b5263',
    'editorGutter.background': '#1b1e24',
    'editor.selectionBackground': '#3b4252',
    'editorWidget.background': '#21252b'
  }
})

monaco.editor.defineTheme('quarry-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '7c3aed', fontStyle: 'bold' },
    { token: 'string', foreground: '15803d' },
    { token: 'number', foreground: 'c2410c' },
    { token: 'comment', foreground: '9ca3af', fontStyle: 'italic' }
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f5f6f8'
  }
})

/** completion metadata per session id; models carry the session id in their URI */
const completionBySession = new Map<string, CompletionTable[]>()
export function setCompletion(sid: string, tables: CompletionTable[]): void {
  completionBySession.set(sid, tables)
}

const KEYWORDS = `SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS JOIN INNER LEFT RIGHT FULL OUTER CROSS ON
USING GROUP BY ORDER ASC DESC HAVING LIMIT OFFSET FETCH NEXT ROWS ONLY TOP DISTINCT AS UNION ALL INTERSECT EXCEPT INSERT INTO
VALUES UPDATE SET DELETE CREATE TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES DROP ALTER ADD COLUMN RENAME TO
TRUNCATE DEFAULT CHECK CONSTRAINT CASE WHEN THEN ELSE END CAST COALESCE COUNT SUM AVG MIN MAX WITH RECURSIVE RETURNING
BEGIN COMMIT ROLLBACK TRANSACTION EXPLAIN ANALYZE SHOW DESCRIBE USE DATABASE SCHEMA IF REPLACE NOW CURRENT_TIMESTAMP
TRUE FALSE OVER PARTITION ROW_NUMBER RANK DENSE_RANK LAG LEAD`
  .split(/\s+/)
  .filter(Boolean)

const FUNCTIONS = `COUNT SUM AVG MIN MAX COALESCE NULLIF CAST CONCAT LOWER UPPER TRIM LENGTH SUBSTRING REPLACE ROUND
ABS NOW DATE EXTRACT ROW_NUMBER RANK DENSE_RANK LAG LEAD`
  .split(/\s+/)
  .filter(Boolean)

/** Statement templates; ${TABLE} is replaced with the table referenced in the query (or the first table) */
const SNIPPETS: { label: string; detail: string; body: string }[] = [
  { label: 'SELECT', detail: 'SELECT … FROM … WHERE', body: 'SELECT ${1:*}\nFROM ${2:${TABLE}}\nWHERE ${3:1 = 1};' },
  { label: 'SELECT COUNT', detail: 'count rows', body: 'SELECT COUNT(*)\nFROM ${1:${TABLE}}\nWHERE ${2:1 = 1};' },
  { label: 'SELECT JOIN', detail: 'SELECT … JOIN … ON', body: 'SELECT ${1:*}\nFROM ${2:${TABLE}} a\nJOIN ${3:other} b ON b.${4:id} = a.${5:id}\nWHERE ${6:1 = 1};' },
  { label: 'GROUP BY', detail: 'aggregate query', body: 'SELECT ${1:column}, COUNT(*) AS total\nFROM ${2:${TABLE}}\nGROUP BY ${1:column}\nORDER BY total DESC;' },
  { label: 'INSERT INTO', detail: 'INSERT … VALUES', body: 'INSERT INTO ${1:${TABLE}} (${2:column})\nVALUES (${3:value});' },
  { label: 'UPDATE', detail: 'UPDATE … SET … WHERE', body: 'UPDATE ${1:${TABLE}}\nSET ${2:column} = ${3:value}\nWHERE ${4:id} = ${5:1};' },
  { label: 'DELETE FROM', detail: 'DELETE … WHERE', body: 'DELETE FROM ${1:${TABLE}}\nWHERE ${2:id} = ${3:1};' },
  { label: 'CREATE TABLE', detail: 'new table', body: 'CREATE TABLE ${1:new_table} (\n  id ${2:INTEGER} PRIMARY KEY,\n  ${3:name} ${4:VARCHAR(255)} NOT NULL\n);' },
  { label: 'ALTER TABLE ADD COLUMN', detail: 'add column', body: 'ALTER TABLE ${1:${TABLE}} ADD ${2:column} ${3:VARCHAR(255)};' },
  { label: 'CREATE INDEX', detail: 'new index', body: 'CREATE INDEX ${1:idx_name} ON ${2:${TABLE}} (${3:column});' },
  { label: 'WITH (CTE)', detail: 'common table expression', body: 'WITH ${1:cte} AS (\n  SELECT ${2:*} FROM ${3:${TABLE}}\n)\nSELECT * FROM ${1:cte};' },
  { label: 'CASE WHEN', detail: 'conditional expression', body: 'CASE WHEN ${1:condition} THEN ${2:value} ELSE ${3:other} END' }
]

function sessionOf(model: monaco.editor.ITextModel): string {
  return model.uri.path.split('/')[1] ?? ''
}

/** Map aliases & names to tables referenced in the query: FROM x a, JOIN y AS b, UPDATE z */
function referencedTables(sql: string, tables: CompletionTable[]): Map<string, CompletionTable> {
  const map = new Map<string, CompletionTable>()
  const re = /\b(?:from|join|update|into)\s+((?:[`"[]?[\w$]+[`"\]]?\.)?[`"[]?[\w$]+[`"\]]?)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/gi
  const strip = (s: string): string => s.replace(/[`"[\]]/g, '')
  const reserved = new Set(KEYWORDS.map((k) => k.toLowerCase()))
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const full = strip(m[1])
    const [a, b] = full.split('.')
    const name = (b ?? a).toLowerCase()
    const schema = b ? a.toLowerCase() : undefined
    const t = tables.find((x) => x.name.toLowerCase() === name && (!schema || x.schema?.toLowerCase() === schema))
    if (!t) continue
    map.set(t.name.toLowerCase(), t)
    if (m[2] && !reserved.has(m[2].toLowerCase())) map.set(m[2].toLowerCase(), t)
  }
  return map
}

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', ' '],
  provideCompletionItems(model, position) {
    const tables = completionBySession.get(sessionOf(model)) ?? []
    const word = model.getWordUntilPosition(position)
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
    const lineBefore = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
    const K = monaco.languages.CompletionItemKind
    const fullText = model.getValue()
    const refs = referencedTables(fullText, tables)

    // after "x." -> columns of table/alias x, or tables of schema x
    const dot = /([`"[]?[\w$]+[`"\]]?)\.$/.exec(lineBefore)
    if (dot) {
      const key = dot[1].replace(/[`"[\]]/g, '').toLowerCase()
      const t = refs.get(key) ?? tables.find((x) => x.name.toLowerCase() === key)
      if (t) {
        return {
          suggestions: t.columns.map((c) => ({ label: c, kind: K.Field, insertText: c, range, detail: t.name }))
        }
      }
      const inSchema = tables.filter((x) => x.schema?.toLowerCase() === key)
      return {
        suggestions: inSchema.map((x) => ({ label: x.name, kind: K.Struct, insertText: x.name, range, detail: x.schema }))
      }
    }

    // only offer bare words (no single-char trigger on space unless something typed)
    if (lineBefore.endsWith(' ') && !word.word) {
      const prev = /(\w+)\s+$/.exec(lineBefore)?.[1]?.toLowerCase()
      if (!prev || !['from', 'join', 'update', 'into', 'table', 'select', 'where', 'by', 'and', 'or', 'on', ','].includes(prev)) {
        return { suggestions: [] }
      }
    }

    // what kind of thing is expected here? (tables after FROM/JOIN/..., columns elsewhere)
    const textBefore = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, word.startColumn))
    const lastKw = /\b(select|from|join|update|into|table|where|on|set|by|having|and|or|values)\b[^;]*$/i
      .exec(textBefore)?.[1]
      ?.toLowerCase()
    const wantTables = !!lastKw && ['from', 'join', 'update', 'into', 'table'].includes(lastKw)
    const atStatementStart = /(^|;)\s*$/.test(textBefore.slice(0, textBefore.length))
    const rank = { col: wantTables ? '3' : '1', table: wantTables ? '1' : '3', kw: '4', snip: atStatementStart ? '0' : '5' }

    const suggestions: monaco.languages.CompletionItem[] = []
    const seen = new Set<string>()
    for (const t of refs.values()) {
      for (const c of t.columns) {
        if (seen.has(c)) continue
        seen.add(c)
        suggestions.push({ label: c, kind: K.Field, insertText: c, range, detail: `column · ${t.name}`, sortText: rank.col + c })
      }
    }
    for (const t of tables) {
      suggestions.push({
        label: t.name,
        kind: K.Struct,
        insertText: t.name,
        range,
        detail: t.schema ? `table · ${t.schema}` : 'table',
        sortText: rank.table + t.name
      })
    }
    for (const k of KEYWORDS) {
      suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: rank.kw + k })
    }
    for (const fn of FUNCTIONS) {
      suggestions.push({
        label: fn + '()',
        kind: K.Function,
        insertText: fn + '($0)',
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        detail: 'function',
        sortText: rank.kw + fn
      })
    }
    const firstTable = [...refs.values()][0]?.name ?? tables[0]?.name ?? 'table_name'
    for (const s of SNIPPETS) {
      suggestions.push({
        label: s.label,
        kind: K.Snippet,
        insertText: s.body.replace(/\$\{TABLE\}/g, firstTable),
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        detail: s.detail,
        documentation: s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d/g, '').replace(/\$\{TABLE\}/g, firstTable),
        sortText: rank.snip + s.label,
        filterText: s.label
      })
    }
    return { suggestions }
  }
})

export { monaco }
