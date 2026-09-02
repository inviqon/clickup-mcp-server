import { describe, expect, it } from 'vitest'
import { bulletList, nameWithId, omitEmpty, paginate, truncateResponse } from '../../src/format/common.js'

describe('paginate', () => {
  it('reports has_more and next_offset when more remain', () => {
    const p = paginate([1, 2, 3, 4, 5], { offset: 0, limit: 2 })
    expect(p).toEqual({ total: 5, count: 2, offset: 0, items: [1, 2], has_more: true, next_offset: 2 })
  })

  it('omits next_offset on the last page', () => {
    const p = paginate([1, 2, 3], { offset: 2, limit: 2 })
    expect(p.has_more).toBe(false)
    expect(p.next_offset).toBeUndefined()
    // toBeUndefined() alone would also pass for a key present with value
    // `undefined`, which serialises differently to JSON than an absent key.
    // Pin the stronger property: the key itself must not exist.
    expect('next_offset' in p).toBe(false)
    expect(Object.keys(p)).not.toContain('next_offset')
  })

  it('uses a server reported total when the local slice is partial', () => {
    const p = paginate([1, 2], { offset: 0, limit: 2, total: 100 })
    expect(p.total).toBe(100)
    expect(p.has_more).toBe(true)
  })

  it('returns an empty page when offset is beyond the array length', () => {
    const p = paginate([1, 2, 3], { offset: 10, limit: 2 })
    expect(p).toEqual({ total: 3, count: 0, offset: 10, items: [], has_more: false })
    expect('next_offset' in p).toBe(false)
  })

  it('caps count at the remaining items when limit exceeds what is left', () => {
    const p = paginate([1, 2, 3], { offset: 1, limit: 50 })
    expect(p).toEqual({ total: 3, count: 2, offset: 1, items: [2, 3], has_more: false })
    expect('next_offset' in p).toBe(false)
  })

  it('bases has_more on the actual returned count, not the requested limit', () => {
    // The caller only holds a partial upstream page (2 items) but knows,
    // from the API's own metadata, that the true total is much larger. A
    // has_more computed from `limit` (50) rather than the real `count` (2)
    // would wrongly say false here and hide the remaining items.
    const p = paginate([1, 2], { offset: 0, limit: 50, total: 10 })
    expect(p.count).toBe(2)
    expect(p.has_more).toBe(true)
    expect(p.next_offset).toBe(2)
  })
})

describe('truncateResponse', () => {
  it('returns the text unchanged when within budget', () => {
    expect(truncateResponse('short', { maxChars: 100, retryHint: 'x' })).toBe('short')
  })

  it('announces truncation and names the way to get the rest', () => {
    const input = 'x'.repeat(200)
    const out = truncateResponse(input, {
      maxChars: 100, retryHint: "use offset=10 or narrow with 'statuses'",
    })
    expect(out.length).toBeLessThanOrEqual(100 + 200)
    expect(out).toContain('Response truncated')
    expect(out).toContain("use offset=10 or narrow with 'statuses'")
    // The above bound alone would pass a notice-only implementation that
    // never actually shortens the body. Pin that truncation really happened.
    expect(out.length).toBeLessThan(input.length)
  })

  // The notice used to read "showing a partial result of N item(s)" with N
  // as the TOTAL count, which an agent reads as "N items are here".
  it('names how many items were dropped, never the total', () => {
    const out = truncateResponse('x'.repeat(500), {
      maxChars: 100, droppedItems: 17, retryHint: 'offset=8',
    })
    expect(out).toContain('17 item(s) not shown')
  })

  it('claims no item count when it does not know one', () => {
    const out = truncateResponse('x'.repeat(500), { maxChars: 100, retryHint: 'offset=8' })
    expect(out).not.toMatch(/item\(s\)/)
  })
})

describe('omitEmpty', () => {
  it('drops undefined, null and empty string but keeps false and zero', () => {
    expect(omitEmpty({ a: undefined, b: null, c: '', d: false, e: 0, f: 'x' }))
      .toEqual({ d: false, e: 0, f: 'x' })
  })

  it('keeps false and zero as their own keys, not merely absent from the dropped set', () => {
    const result = omitEmpty({ d: false, e: 0 })
    expect(Object.keys(result).sort()).toEqual(['d', 'e'])
    expect(result.d).toBe(false)
    expect(result.e).toBe(0)
  })
})

describe('bulletList', () => {
  it('skips entries with no value instead of printing a placeholder', () => {
    expect(bulletList([['Status', 'open'], ['Due', undefined]]))
      .toEqual(['- **Status**: open'])
  })
})

describe('nameWithId', () => {
  it('renders the id verbatim next to the name', () => {
    expect(nameWithId('Fix login redirect', '86abc123')).toBe('Fix login redirect (86abc123)')
  })
})
