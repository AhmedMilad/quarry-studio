import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Dialect } from '@shared/types'
import type { BaseDriver } from '../../src/main/drivers'
import { checkDestructive } from '../../src/main/destructive-check'
import { dropFixture, resetFixture, run, snapshot, targets } from '../helpers/db'

/**
 * The confirmation dialog must predict what a statement will do. Each case is checked twice:
 * against the expected numbers (worked out from the fixture, see tests/helpers/db.ts), and against
 * what really happens when the statement is run on a fresh copy of the data.
 */
interface Case {
  sql: string
  /** rows the dialog should say are deleted / updated */
  count: number
  /** UPDATE: rows whose values actually change */
  changing?: number
  /** the statement hits every row */
  matchesAll?: boolean
  /** DELETE on customers: orders removed by the cascade */
  cascaded?: number
  only?: Dialect[]
}

const CASES: Case[] = [
  { sql: "DELETE FROM qs_customers WHERE plan = 'free'", count: 3, cascaded: 6 },
  { sql: 'DELETE FROM qs_customers', count: 10, matchesAll: true, cascaded: 20 },
  { sql: 'DELETE FROM qs_customers WHERE credit > 50 AND email IS NOT NULL', count: 4, cascaded: 8 },
  { sql: "DELETE FROM qs_orders WHERE customer_id IN (SELECT id FROM qs_customers WHERE plan = 'pro')", count: 8 },
  { sql: "DELETE FROM qs_customers WHERE name = 'O''Brien'", count: 1, cascaded: 2 },
  { sql: '-- tidy up\nDELETE FROM qs_orders WHERE qty = 3;', count: 7 },
  { sql: "UPDATE qs_customers SET plan = 'pro'", count: 10, changing: 6, matchesAll: true },
  { sql: "UPDATE qs_customers SET credit = credit + 1 WHERE plan = 'team'", count: 3, changing: 3 },
  { sql: 'UPDATE qs_customers SET email = NULL WHERE id <= 4', count: 4, changing: 3 },
  { sql: "UPDATE qs_customers SET plan = 'free', credit = 30 WHERE id = 3", count: 1, changing: 0 },
  { sql: "UPDATE qs_orders SET status = 'paid' WHERE status = 'paid'", count: 10, changing: 0 },
  {
    sql: "WITH f AS (SELECT id FROM qs_customers WHERE plan = 'free') DELETE FROM qs_customers WHERE id IN (SELECT id FROM f)",
    count: 3,
    cascaded: 6
  },
  // dialect-specific forms
  { sql: "DELETE FROM qs_customers WHERE plan = 'free' ORDER BY id LIMIT 2", count: 2, only: ['mysql'] },
  { sql: "UPDATE qs_customers SET credit = 0 WHERE plan = 'pro' ORDER BY id LIMIT 3", count: 3, only: ['mysql'] },
  { sql: "DELETE TOP (2) FROM qs_customers WHERE plan = 'free'", count: 2, only: ['mssql'] },
  {
    sql: "UPDATE qs_customers SET credit = 0 FROM qs_orders o WHERE o.customer_id = qs_customers.id AND o.status = 'pending'",
    count: 5,
    only: ['postgres', 'sqlite']
  },
  {
    sql: "DELETE FROM qs_customers c USING qs_orders o WHERE o.customer_id = c.id AND o.status = 'pending' AND c.plan = 'team'",
    count: 2,
    only: ['postgres']
  }
]

describe.each(targets())('confirmation dialog predictions: $name', (target) => {
  let d: BaseDriver
  beforeAll(async () => {
    d = await target.connect()
  })
  afterAll(async () => {
    await dropFixture(d)
    await d.disconnect()
  })

  const cases = CASES.filter((c) => !c.only || c.only.includes(target.dialect))
  it.each(cases)('$sql', async (c) => {
    await resetFixture(d)
    const [check] = await checkDestructive(d, c.sql)
    expect(check, 'statement not recognised').toBeTruthy()
    expect(check.countError).toBeUndefined()

    // 1. what the dialog says
    expect(check.count).toBe(c.count)
    if (c.changing !== undefined) expect(check.changing).toBe(c.changing)
    expect(check.matchesAll).toBe(!!c.matchesAll)
    if (c.cascaded !== undefined) {
      const ref = check.referencedBy.find((r) => r.table.toLowerCase() === 'qs_orders')
      expect(ref?.affected).toBe(c.cascaded)
    }

    // 2. what really happens
    const table = check.table?.toLowerCase().includes('orders') ? 'qs_orders' : 'qs_customers'
    const before = await snapshot(d, table)
    await run(d, c.sql)
    const after = await snapshot(d, table)
    if (check.kind === 'delete') {
      expect([...before.keys()].filter((id) => !after.has(id))).toHaveLength(check.count!)
    } else {
      const changed = [...before.keys()].filter((id) => before.get(id) !== after.get(id)).length
      expect(changed).toBe(c.changing ?? check.changing ?? c.count)
    }
  })

  it('never changes data while checking', async () => {
    await resetFixture(d)
    const before = await snapshot(d, 'qs_customers')
    await checkDestructive(d, "DELETE FROM qs_customers; UPDATE qs_customers SET plan = 'x'; TRUNCATE TABLE qs_orders")
    expect(await snapshot(d, 'qs_customers')).toEqual(before)
  })
})
