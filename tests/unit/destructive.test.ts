import { describe, expect, it } from 'vitest'
import { analyzeDestructive } from '@shared/destructive'

/** shape checks for the statement analysis; the numbers are checked against real databases in tests/db */
describe('analyzeDestructive', () => {
  it('ignores reads and inserts', () => {
    expect(analyzeDestructive('SELECT 1; INSERT INTO t VALUES (1); SHOW TABLES', 'mysql')).toEqual([])
  })

  it('finds every destructive statement in a script, in order', () => {
    const r = analyzeDestructive('DELETE FROM a WHERE x = 1; SELECT 1; UPDATE b SET y = 2; TRUNCATE TABLE c; DROP TABLE d', 'postgres')
    expect(r.map((s) => [s.kind, s.table?.name])).toEqual([
      ['delete', 'a'],
      ['update', 'b'],
      ['truncate', 'c'],
      ['drop-table', 'd']
    ])
    expect(r.map((s) => s.index)).toEqual([0, 2, 3, 4])
  })

  it('DELETE: WHERE presence, table parsing and count SQL', () => {
    const [d] = analyzeDestructive('DELETE FROM "public"."users" WHERE id > 5', 'postgres')
    expect(d.kind).toBe('delete')
    expect(d.table).toMatchObject({ name: 'users', schema: 'public' })
    expect(d.hasWhere).toBe(true)
    expect(d.countSql).toMatch(/^SELECT COUNT\(\*\)/i)
    expect(d.countSql).toContain('id > 5')

    const [all] = analyzeDestructive('DELETE FROM users', 'postgres')
    expect(all.hasWhere).toBe(false)
  })

  it('UPDATE: SET list, WHERE and the "actually changes" query', () => {
    const [u] = analyzeDestructive("UPDATE users SET plan = 'pro', credit = credit + 1 WHERE id IN (1, 2)", 'mysql')
    expect(u.kind).toBe('update')
    expect(u.assignments).toEqual([
      { column: 'plan', ref: 'plan', expr: "'pro'" },
      { column: 'credit', ref: 'credit', expr: 'credit + 1' }
    ])
    expect(u.where).toBe('id IN (1, 2)')
    expect(u.changingSql).toContain('<=>') // MySQL null-safe equality
  })

  it('UPDATE: commas inside expressions do not split the SET list', () => {
    const [u] = analyzeDestructive("UPDATE t SET a = COALESCE(b, 'x,y'), c = 1", 'postgres')
    expect(u.assignments?.map((a) => a.column)).toEqual(['a', 'c'])
  })

  it('keywords inside strings are not clauses', () => {
    const [u] = analyzeDestructive("UPDATE t SET note = 'see WHERE clause' ", 'postgres')
    expect(u.hasWhere).toBe(false)
  })

  it('LIMIT / TOP caps are recognised', () => {
    expect(analyzeDestructive('DELETE FROM t WHERE a = 1 ORDER BY id LIMIT 2', 'mysql')[0].limit).toBe(2)
    expect(analyzeDestructive('DELETE TOP (3) FROM t WHERE a = 1', 'mssql')[0].limit).toBe(3)
  })

  it('WITH … DELETE / UPDATE keeps the CTE in generated SQL', () => {
    const [d] = analyzeDestructive('WITH x AS (SELECT id FROM t WHERE a = 1) DELETE FROM t WHERE id IN (SELECT id FROM x)', 'postgres')
    expect(d.kind).toBe('delete')
    expect(d.countSql?.startsWith('WITH x AS')).toBe(true)
  })

  it('multi-table forms are flagged approximate', () => {
    const [u] = analyzeDestructive('UPDATE a JOIN b ON a.id = b.a_id SET a.x = 1 WHERE b.y = 2', 'mysql')
    expect(u.approximate).toBe(true)
  })

  it('TRUNCATE several tables at once', () => {
    expect(analyzeDestructive('TRUNCATE TABLE a, b', 'postgres').map((s) => s.table?.name)).toEqual(['a', 'b'])
  })

  it('DROP DATABASE is reported without a count', () => {
    const [d] = analyzeDestructive('DROP DATABASE IF EXISTS shop', 'mysql')
    expect(d.kind).toBe('drop-database')
    expect(d.countSql).toBeNull()
  })

  it('comments anywhere are ignored, but comment-like text inside strings is kept', () => {
    const [d] = analyzeDestructive("DELETE FROM t /* why? */ WHERE a = '-- not a comment' -- trailing", 'postgres')
    expect(d.where).toBe("a = '-- not a comment'")
    expect(d.countSql).not.toContain('why')
  })

  it('leading comments do not hide a statement', () => {
    expect(analyzeDestructive('-- careful\n/* really */ DELETE FROM t', 'sqlite')).toHaveLength(1)
  })
})
