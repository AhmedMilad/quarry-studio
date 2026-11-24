import { describe, expect, it } from 'vitest'
import { formatRows, formatTsv, insertStatements, quoteId, selectSourceTable } from '@shared/export'

const cols = ['id', 'name', 'note']
const data = [
  [1, "O'Brien, \"Omar\"", null],
  [2, 'line\nbreak', 'tab\there']
]

describe('formatRows', () => {
  it('csv quotes commas, quotes and newlines; NULL is empty', () => {
    expect(formatRows('csv', cols, data)).toBe('id,name,note\n1,"O\'Brien, ""Omar""",\n2,"line\nbreak",tab\there\n')
  })

  it('json keeps types and nulls', () => {
    expect(JSON.parse(formatRows('json', cols, data))).toEqual([
      { id: 1, name: "O'Brien, \"Omar\"", note: null },
      { id: 2, name: 'line\nbreak', note: 'tab\there' }
    ])
  })

  it('markdown escapes pipes and flattens newlines', () => {
    const md = formatRows('markdown', ['a'], [['x|y\nz'], [null]])
    expect(md).toBe('| a |\n| --- |\n| x\\|y z |\n| NULL |\n')
  })

  it('sql uses the table name and dialect quoting', () => {
    expect(formatRows('sql', ['id', 'name'], [[1, "it's"]], { tableName: '`users`', dialect: 'mysql' })).toBe(
      "INSERT INTO `users` (`id`, `name`) VALUES (1, 'it''s');\n"
    )
  })
})

describe('formatTsv', () => {
  it('writes NULL and flattens tabs/newlines', () => {
    expect(formatTsv(['a', 'b'], [[null, 'x\ty\nz']])).toBe('a\tb\nNULL\tx y z')
  })
  it('omits the header when columns is null', () => {
    expect(formatTsv(null, [[1, 2]])).toBe('1\t2')
  })
})

describe('quoteId', () => {
  it.each([
    ['mysql', 'we`ird', '`we``ird`'],
    ['mssql', 'we]ird', '[we]]ird]'],
    ['postgres', 'we"ird', '"we""ird"'],
    ['sqlite', 'plain', '"plain"']
  ] as const)('%s: %s → %s', (dialect, id, out) => expect(quoteId(id, dialect)).toBe(out))
})

describe('insertStatements', () => {
  it('one statement per row with escaped literals', () => {
    expect(insertStatements('"t"', ['a', 'b'], [[1, null], ["x'y", true]], 'postgres')).toBe(
      'INSERT INTO "t" ("a", "b") VALUES (1, NULL);\nINSERT INTO "t" ("a", "b") VALUES (\'x\'\'y\', TRUE);'
    )
  })
  it('writes booleans as 1/0 for SQL Server', () => {
    expect(insertStatements('[t]', ['flag'], [[true], [false]], 'mssql')).toBe(
      'INSERT INTO [t] ([flag]) VALUES (1);\nINSERT INTO [t] ([flag]) VALUES (0);'
    )
  })
})

describe('selectSourceTable', () => {
  it.each([
    ['SELECT * FROM users', 'users'],
    ['select id, name from public.users where id = 1;', 'public.users'],
    ['SELECT a FROM "my table" u ORDER BY a', '"my table"'],
    ['SELECT a FROM `db`.`t` LIMIT 5', '`db`.`t`'],
    ['SELECT a FROM [dbo].[t]', '[dbo].[t]'],
    ['-- comment\nSELECT * FROM t', 't']
  ])('%s → %s', (sql, table) => expect(selectSourceTable(sql)).toBe(table))

  it.each([
    'SELECT * FROM a JOIN b ON a.id = b.id',
    'SELECT * FROM a, b',
    'SELECT * FROM a UNION SELECT * FROM b',
    'SELECT plan, COUNT(*) FROM t GROUP BY plan',
    'SELECT * FROM (SELECT 1) x',
    'SELECT 1',
    'UPDATE t SET a = 1'
  ])('%s → null', (sql) => expect(selectSourceTable(sql)).toBeNull())
})
