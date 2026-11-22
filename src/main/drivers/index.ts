import type { ConnectionConfig } from '@shared/types'
import type { BaseDriver, ConnectTarget } from './base'
import { MysqlDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { MssqlDriver } from './mssql'
import { SqliteDriver } from './sqlite'

export function createDriver(config: ConnectionConfig, database: string, target: ConnectTarget): BaseDriver {
  switch (config.type) {
    case 'mysql':
    case 'mariadb':
      return new MysqlDriver(config, database, target)
    case 'postgres':
    case 'cockroach':
    case 'redshift':
      return new PostgresDriver(config, database, target)
    case 'mssql':
      return new MssqlDriver(config, database, target)
    case 'sqlite':
      return new SqliteDriver(config, database, target)
    default:
      throw new Error(`Unsupported database type: ${config.type}`)
  }
}

export type { BaseDriver }
