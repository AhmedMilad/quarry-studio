import { describe, expect, it } from 'vitest'
import { filterNeedsValue, isActiveFilter } from '@shared/types'

describe('filters', () => {
  it('IS NULL / IS NOT NULL need no value', () => {
    expect(filterNeedsValue('IS NULL')).toBe(false)
    expect(filterNeedsValue('is not null')).toBe(false)
    expect(filterNeedsValue('=')).toBe(true)
    expect(filterNeedsValue('LIKE')).toBe(true)
  })

  it('a line with an empty or blank value is ignored', () => {
    expect(isActiveFilter({ column: 'a', op: '=', value: '' })).toBe(false)
    expect(isActiveFilter({ column: 'a', op: '=', value: '   ' })).toBe(false)
    expect(isActiveFilter({ column: 'a', op: '=', value: '0' })).toBe(true)
  })

  it('a no-value operator applies without a value', () => {
    expect(isActiveFilter({ column: 'a', op: 'IS NULL', value: '' })).toBe(true)
  })

  it('a line without a column is ignored', () => {
    expect(isActiveFilter({ column: '', op: 'IS NULL', value: '' })).toBe(false)
  })
})
