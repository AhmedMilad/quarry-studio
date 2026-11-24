import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { insertStatements } from '@shared/export'
import type { BaseDriver } from '../../src/main/drivers'
import { dropFixture, resetFixture, rows, run, sqliteTarget, targets } from '../helpers/db'

/** The same behaviour is expected from every database driver. */
describe.each(targets())('driver contract: $name', (target) => {
  let d: BaseDriver
  const customers = { name: 'qs_customers' }
  const orders = { name: 'qs_orders' }

  beforeAll(async () => {
    d = await target.connect()
    if (d.defaultSchema) {
      Object.assign(customers, { schema: d.defaultSchema })
      Object.assign(orders, { schema: d.defaultSchema })
    }
  })
  afterAll(async () => {
    await dropFixture(d)
    await d.disconnect()
  })
  beforeEach(() => resetFixture(d))

  it('lists the tables', async () => {
    const names = (await d.listTables(d.defaultSchema)).map((t) => t.name.toLowerCase())
    expect(names).toEqual(expect.arrayContaining(['qs_customers', 'qs_orders']))
  })

  it('describes columns and the primary key', async () => {
    const cols = await d.listColumns(customers)
    expect(cols.map((c) => c.name.toLowerCase())).toEqual(['id', 'name', 'plan', 'credit', 'email'])
    expect(cols.filter((c) => c.primaryKey).map((c) => c.name.toLowerCase())).toEqual(['id'])
  })

  it('finds the foreign key in both directions', async () => {
    const fks = await d.listForeignKeys(orders)
    expect(fks).toHaveLength(1)
    expect(fks[0]).toMatchObject({ column: 'customer_id', refTable: 'qs_customers', refColumn: 'id' })
    const refs = await d.listReferencing(customers)
    expect(refs.map((r) => [r.table.toLowerCase(), r.column.toLowerCase()])).toEqual([['qs_orders', 'customer_id']])
    expect(refs[0].onDelete.toUpperCase()).toContain('CASCADE')
  })

  describe('select (table view)', () => {
    const ids = (r: { rows: unknown[][] }): number[] => r.rows.map((x) => Number(x[0])).sort((a, b) => a - b)

    it('pages and counts', async () => {
      const r = await d.select(customers, { limit: 3, offset: 3, orderBy: [{ column: 'id', dir: 'ASC' }] })
      expect(r.rows.map((x) => Number(x[0]))).toEqual([4, 5, 6])
      expect(r.totalCount).toBe(10)
    })

    it('sorts descending', async () => {
      const r = await d.select(customers, { limit: 1, offset: 0, orderBy: [{ column: 'credit', dir: 'DESC' }] })
      expect(Number(r.rows[0][0])).toBe(10)
    })

    it('filters with AND / OR', async () => {
      const and = await d.select(customers, {
        limit: 100,
        offset: 0,
        filters: [
          { column: 'plan', op: '=', value: 'pro' },
          { column: 'credit', op: '>', value: '40' }
        ]
      })
      expect(ids(and)).toEqual([7, 10])
      const or = await d.select(customers, {
        limit: 100,
        offset: 0,
        filterJoin: 'OR',
        filters: [
          { column: 'plan', op: '=', value: 'free' },
          { column: 'id', op: '=', value: '1' }
        ]
      })
      expect(ids(or)).toEqual([1, 3, 6, 9])
    })

    it('ignores filter lines with an empty value', async () => {
      const r = await d.select(customers, {
        limit: 100,
        offset: 0,
        filters: [
          { column: 'plan', op: '=', value: 'team' },
          { column: 'name', op: '=', value: '' }
        ]
      })
      expect(ids(r)).toEqual([2, 5, 8])
    })

    it('IS NULL, IN, LIKE and a raw WHERE', async () => {
      const isNull = await d.select(customers, { limit: 100, offset: 0, filters: [{ column: 'email', op: 'IS NULL', value: '' }] })
      expect(ids(isNull)).toEqual([4, 8])
      const inList = await d.select(customers, { limit: 100, offset: 0, filters: [{ column: 'id', op: 'IN', value: '2, 3 ,9' }] })
      expect(ids(inList)).toEqual([2, 3, 9])
      const like = await d.select(customers, { limit: 100, offset: 0, filters: [{ column: 'name', op: 'LIKE', value: "O'%" }] })
      expect(ids(like)).toEqual([2])
      const raw = await d.select(customers, { limit: 100, offset: 0, where: 'credit BETWEEN 30 AND 50' })
      expect(ids(raw)).toEqual([3, 4, 5])
    })
  })

  it('applies table edits in one transaction (insert, update, delete with cascade)', async () => {
    await d.applyChanges({
      table: customers,
      primaryKeys: ['id'],
      inserts: [{ id: 11, name: 'New', plan: 'free', credit: 0, email: null }],
      updates: [{ pk: { id: 1 }, values: { name: 'Renamed' } }],
      deletes: [{ id: 3 }]
    })
    expect(await rows(d, 'SELECT name FROM qs_customers WHERE id IN (1, 11) ORDER BY id')).toEqual([['Renamed'], ['New']])
    expect(Number((await rows(d, 'SELECT COUNT(*) FROM qs_customers WHERE id = 3'))[0][0])).toBe(0)
    expect(Number((await rows(d, 'SELECT COUNT(*) FROM qs_orders WHERE customer_id = 3'))[0][0])).toBe(0) // cascaded
  })

  it('rolls the whole batch back when one change fails', async () => {
    await expect(
      d.applyChanges({
        table: customers,
        primaryKeys: ['id'],
        inserts: [{ id: 1, name: 'duplicate key', plan: 'x', credit: 0, email: null }],
        updates: [{ pk: { id: 2 }, values: { name: 'should not stick' } }],
        deletes: []
      })
    ).rejects.toThrow()
    expect(String((await rows(d, 'SELECT name FROM qs_customers WHERE id = 2'))[0][0])).toBe("O'Brien")
  })

  it('"Copy as INSERT" output re-creates the rows exactly', async () => {
    const before = await rows(d, 'SELECT id, name, plan, credit, email FROM qs_customers ORDER BY id')
    const sql = insertStatements('qs_customers', ['id', 'name', 'plan', 'credit', 'email'], before, target.dialect)
    await run(d, 'DELETE FROM qs_orders')
    await run(d, 'DELETE FROM qs_customers')
    for (const stmt of sql.split('\n')) await run(d, stmt)
    const after = await rows(d, 'SELECT id, name, plan, credit, email FROM qs_customers ORDER BY id')
    expect(after.map((r) => r.map(String))).toEqual(before.map((r) => r.map(String)))
  })
})

describe('read-only connections', () => {
  it('refuse writes from the query editor, including CTE-prefixed ones', async () => {
    const rw = sqliteTarget()
    const d = await rw.connect()
    await resetFixture(d)
    const file = (d.config as { filePath: string }).filePath
    await d.disconnect()
    const ro = await sqliteTarget(true, file).connect()
    await expect(ro.runQuery('SELECT COUNT(*) FROM qs_customers', 'q', 10)).resolves.toBeTruthy()
    await expect(ro.runQuery('DELETE FROM qs_customers', 'q', 10)).rejects.toThrow(/read-only/)
    await expect(ro.runQuery('WITH x AS (SELECT 1) DELETE FROM qs_customers', 'q', 10)).rejects.toThrow(/read-only/)
    await ro.disconnect()
  })
})
