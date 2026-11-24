import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CellValue, ConnectionConfig, DbType, Dialect } from '@shared/types'
import { createDriver, type BaseDriver } from '../../src/main/drivers'

/**
 * Database targets for the driver tests.
 *
 * SQLite always runs (a temp file). The servers run when a URL is set:
 *   QS_TEST_MYSQL=mysql://user:pass@127.0.0.1:3306/qs_test
 *   QS_TEST_POSTGRES=postgres://user:pass@127.0.0.1:5432/qs_test
 *   QS_TEST_MSSQL=mssql://sa:pass@127.0.0.1:1433/master
 * The tests create and drop their own tables (prefixed qs_) in that database — use a throwaway one.
 */
export interface Target {
  name: string
  dialect: Dialect
  connect: () => Promise<BaseDriver>
}

function baseConfig(type: DbType): ConnectionConfig {
  return {
    id: 'test',
    name: `test ${type}`,
    type,
    color: '#888888',
    host: '',
    port: 0,
    user: '',
    database: '',
    ssl: false,
    sslRejectUnauthorized: false,
    trustServerCertificate: true,
    readOnly: false,
    ssh: { enabled: false, host: '', port: 22, user: '', authMethod: 'password' }
  }
}

function fromUrl(type: DbType, raw: string, defaultPort: number): Target {
  const u = new URL(raw)
  const config: ConnectionConfig = {
    ...baseConfig(type),
    host: u.hostname,
    port: Number(u.port) || defaultPort,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, ''))
  }
  const dialect: Dialect = type === 'mssql' ? 'mssql' : type === 'mysql' ? 'mysql' : 'postgres'
  return {
    name: type,
    dialect,
    connect: async () => {
      const d = createDriver(config, config.database, { host: config.host, port: config.port })
      await d.connect()
      return d
    }
  }
}

export function sqliteTarget(readOnly = false, file?: string): Target {
  const path = file ?? join(mkdtempSync(join(tmpdir(), 'qs-test-')), 'test.db')
  return {
    name: 'sqlite',
    dialect: 'sqlite',
    connect: async () => {
      const config = { ...baseConfig('sqlite'), filePath: path, readOnly }
      const d = createDriver(config, '', { host: '', port: 0 })
      await d.connect()
      return d
    }
  }
}

export function targets(): Target[] {
  const out: Target[] = [sqliteTarget()]
  if (process.env.QS_TEST_MYSQL) out.push(fromUrl('mysql', process.env.QS_TEST_MYSQL, 3306))
  if (process.env.QS_TEST_POSTGRES) out.push(fromUrl('postgres', process.env.QS_TEST_POSTGRES, 5432))
  if (process.env.QS_TEST_MSSQL) out.push(fromUrl('mssql', process.env.QS_TEST_MSSQL, 1433))
  return out
}

/** run one statement through the same path the query editor uses */
export async function run(d: BaseDriver, sql: string): Promise<void> {
  await d.runQuery(sql, `t-${Math.random()}`, 10_000)
}

export async function rows(d: BaseDriver, sql: string): Promise<CellValue[][]> {
  const r = await d.runQuery(sql, `t-${Math.random()}`, 10_000)
  return r[r.length - 1]?.rows ?? []
}

/**
 * Fixture: 10 customers, 20 orders (2 per customer, ON DELETE CASCADE).
 *   customer i: tier = ['free','pro','team'][i % 3]  →  pro: 1,4,7,10 · team: 2,5,8 · free: 3,6,9
 *               credit = i * 10, email NULL for 4 and 8, name of 2 is O'Brien
 *   order i:    customer = ((i - 1) % 10) + 1, status = odd ? 'paid' : 'pending', qty = i % 3 + 1
 */
export async function resetFixture(d: BaseDriver): Promise<void> {
  const dropOrders = d.dialect === 'mssql' ? "IF OBJECT_ID('qs_orders') IS NOT NULL DROP TABLE qs_orders" : 'DROP TABLE IF EXISTS qs_orders'
  const dropCustomers =
    d.dialect === 'mssql' ? "IF OBJECT_ID('qs_customers') IS NOT NULL DROP TABLE qs_customers" : 'DROP TABLE IF EXISTS qs_customers'
  await run(d, dropOrders)
  await run(d, dropCustomers)
  const text = d.dialect === 'mssql' ? 'NVARCHAR(100)' : 'VARCHAR(100)'
  const engine = d.dialect === 'mysql' ? ' ENGINE=InnoDB' : ''
  await run(
    d,
    `CREATE TABLE qs_customers (id INT NOT NULL PRIMARY KEY, name ${text} NOT NULL, tier ${text}, credit INT NOT NULL, email ${text} UNIQUE)${engine}`
  )
  await run(
    d,
    `CREATE TABLE qs_orders (id INT NOT NULL PRIMARY KEY, customer_id INT, status ${text}, qty INT,
       CONSTRAINT fk_qs_orders_customer FOREIGN KEY (customer_id) REFERENCES qs_customers (id) ON DELETE CASCADE)${engine}`
  )
  const tiers = ['free', 'pro', 'team']
  const customers: string[] = []
  for (let i = 1; i <= 10; i++) {
    const name = i === 2 ? "O''Brien" : `Customer ${i}`
    const email = i % 4 === 0 ? 'NULL' : `'c${i}@example.com'`
    customers.push(`(${i}, '${name}', '${tiers[i % 3]}', ${i * 10}, ${email})`)
  }
  await run(d, `INSERT INTO qs_customers (id, name, tier, credit, email) VALUES ${customers.join(', ')}`)
  const orders: string[] = []
  for (let i = 1; i <= 20; i++) orders.push(`(${i}, ${((i - 1) % 10) + 1}, '${i % 2 ? 'paid' : 'pending'}', ${(i % 3) + 1})`)
  await run(d, `INSERT INTO qs_orders (id, customer_id, status, qty) VALUES ${orders.join(', ')}`)
}

export async function dropFixture(d: BaseDriver): Promise<void> {
  await run(d, d.dialect === 'mssql' ? "IF OBJECT_ID('qs_orders') IS NOT NULL DROP TABLE qs_orders" : 'DROP TABLE IF EXISTS qs_orders')
  await run(d, d.dialect === 'mssql' ? "IF OBJECT_ID('qs_customers') IS NOT NULL DROP TABLE qs_customers" : 'DROP TABLE IF EXISTS qs_customers')
}

/** id → row snapshot of a table, for before/after comparisons */
export async function snapshot(d: BaseDriver, table: string): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (const r of await rows(d, `SELECT * FROM ${table}`)) out.set(Number(r[0]), JSON.stringify(r.map((v) => (v === null ? null : String(v)))))
  return out
}
