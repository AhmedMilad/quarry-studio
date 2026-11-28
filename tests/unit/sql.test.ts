import { describe, expect, it } from 'vitest'
import { isReadOnlyStatement, splitGoBatches, splitStatements, statementAt, useDatabaseTarget } from '@shared/sql'

const texts = (sql: string): string[] => splitStatements(sql).map((s) => s.text.trim())

describe('splitStatements', () => {
  it('splits on semicolons', () => {
    const parts = texts('SELECT 1; SELECT 2;SELECT 3')
    expect(parts).toHaveLength(3)
    expect(parts.map((p) => p.replace(/;$/, ''))).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('ignores semicolons inside strings, identifiers and comments', () => {
    const sql = `SELECT ';' AS a, "x;y" FROM t -- c;omment
      ; SELECT \`a;b\` /* block ; comment */ FROM u`
    expect(texts(sql)).toHaveLength(2)
  })

  it('handles escaped quotes', () => {
    expect(texts("SELECT 'it''s; fine'; SELECT 2")).toHaveLength(2)
  })

  it('keeps PostgreSQL dollar-quoted bodies together', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT f()`
    expect(texts(sql)).toHaveLength(2)
    expect(texts(sql)[0]).toContain('END;')
  })

  it('drops empty statements', () => {
    expect(texts(';;  ; SELECT 1 ;; ')).toHaveLength(1)
  })

  it('reports offsets that point back into the script', () => {
    const sql = 'SELECT 1;\nSELECT 2'
    for (const s of splitStatements(sql)) expect(sql.slice(s.start, s.end + 1)).toContain(s.text.trim().replace(/;$/, ''))
  })
})

describe('statementAt', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\nSELECT 3'
  it('returns the statement under the cursor', () => {
    expect(statementAt(sql, sql.indexOf('2'))?.text).toContain('SELECT 2')
    expect(statementAt(sql, sql.indexOf('3'))?.text).toContain('SELECT 3')
  })
  it('falls back to the previous statement in whitespace', () => {
    expect(statementAt(sql, sql.indexOf('\n\n') + 1)?.text).toContain('SELECT 1')
  })
  it('returns null for an empty script', () => {
    expect(statementAt('   ', 0)).toBeNull()
  })
})

describe('splitGoBatches', () => {
  it('splits T-SQL on GO lines only', () => {
    expect(splitGoBatches('SELECT 1\nGO\nSELECT 2 -- not GOing\ngo -- comment\nSELECT 3')).toEqual([
      'SELECT 1',
      'SELECT 2 -- not GOing',
      'SELECT 3'
    ])
  })
})

describe('isReadOnlyStatement', () => {
  it.each(['SELECT 1', 'show tables', '  -- c\nSELECT 1', 'EXPLAIN SELECT 1', 'PRAGMA table_info(t)', 'WITH x AS (SELECT 1) SELECT * FROM x'])(
    'allows %s',
    (sql) => expect(isReadOnlyStatement(sql)).toBe(true)
  )

  it.each([
    'DELETE FROM t',
    'UPDATE t SET a = 1',
    'SELECT 1; DROP TABLE t',
    'INSERT INTO t VALUES (1)',
    // a CTE in front of a write is still a write
    'WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)',
    'WITH x AS (SELECT 1) UPDATE t SET a = 1',
    'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'with recursive r(n) as (select 1) delete from t'
  ])('blocks %s', (sql) => expect(isReadOnlyStatement(sql)).toBe(false))
})

describe('useDatabaseTarget', () => {
  it.each([
    ['USE shop', 'shop'],
    ['use `my-db`;', 'my-db'],
    ['USE [Sales DB]', 'Sales DB'],
    ['USE "warehouse"', 'warehouse'],
    ['-- switch\nUSE shop; SELECT 1', 'shop'],
    ['USE a; SELECT 1; USE b', 'b']
  ])('mysql: %s → %s', (sql, db) => expect(useDatabaseTarget(sql, 'mysql')).toBe(db))

  it('reads T-SQL batches', () => expect(useDatabaseTarget('USE master\nGO\nUSE [app]\nGO', 'mssql')).toBe('app'))

  it.each(['SELECT 1', "SELECT 'USE shop'", 'USE', 'USE a b', 'used = 1'])('no switch for %s', (sql) =>
    expect(useDatabaseTarget(sql, 'mysql')).toBeNull()
  )

  it('PostgreSQL and SQLite have no USE', () => {
    expect(useDatabaseTarget('USE shop', 'postgres')).toBeNull()
    expect(useDatabaseTarget('USE shop', 'sqlite')).toBeNull()
  })
})
