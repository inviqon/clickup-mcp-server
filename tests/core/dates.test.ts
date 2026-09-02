import { describe, expect, it } from 'vitest'
import { formatDate, parseDuration, resolveDate } from '../../src/core/dates.js'

const tz = 'Europe/Berlin'
const now = new Date('2026-09-02T09:00:00Z') // 11:00 Berlin, a Wednesday

describe('resolveDate', () => {
  it('passes an epoch number through unchanged', () => {
    expect(resolveDate(1756803600000, { timezone: tz, now }).epochMs).toBe(1756803600000)
  })

  it('accepts an ISO string', () => {
    expect(resolveDate('2026-09-05T14:00:00+02:00', { timezone: tz, now }).iso)
      .toBe('2026-09-05T14:00:00+02:00')
  })

  it('resolves "tomorrow 17:00" in the configured timezone', () => {
    const r = resolveDate('tomorrow 17:00', { timezone: tz, now })
    expect(r.iso).toBe('2026-09-03T17:00:00+02:00')
  })

  it('resolves "today" to the start of the day in the configured timezone', () => {
    expect(resolveDate('today', { timezone: tz, now }).iso).toBe('2026-09-02T00:00:00+02:00')
  })

  it('resolves "next monday" to the following Monday, not today', () => {
    expect(resolveDate('next monday', { timezone: tz, now }).iso)
      .toBe('2026-09-07T00:00:00+02:00')
  })

  it('resolves relative offsets', () => {
    expect(resolveDate('in 3 days', { timezone: tz, now }).iso)
      .toBe('2026-09-05T11:00:00+02:00')
  })

  it('rejects an unparseable string instead of guessing', () => {
    expect(() => resolveDate('sometime soon', { timezone: tz, now }))
      .toThrow(/Could not parse date "sometime soon"/)
  })

  it('names the accepted formats in the error', () => {
    expect(() => resolveDate('nope', { timezone: tz, now })).toThrow(/ISO 8601/)
  })

  it('accepts a numeric string as epoch milliseconds', () => {
    expect(resolveDate('1756803600000', { timezone: tz, now }).epochMs).toBe(1756803600000)
  })

  it('resolves "next monday" to a week later when today already is Monday', () => {
    const monday = new Date('2026-08-31T09:00:00Z') // 11:00 Berlin, a Monday
    expect(resolveDate('next monday', { timezone: tz, now: monday }).iso)
      .toBe('2026-09-07T00:00:00+02:00')
  })

  it('resolves "last monday" to the previous Monday, never today', () => {
    const monday = new Date('2026-08-31T09:00:00Z') // 11:00 Berlin, a Monday
    expect(resolveDate('last monday', { timezone: tz, now: monday }).iso)
      .toBe('2026-08-24T00:00:00+02:00')
  })

  it('resolves "yesterday" with a time of day', () => {
    expect(resolveDate('yesterday 08:30', { timezone: tz, now }).iso)
      .toBe('2026-09-01T08:30:00+02:00')
  })

  it('resolves "<n> <unit> ago"', () => {
    expect(resolveDate('2 hours ago', { timezone: tz, now }).iso)
      .toBe('2026-09-02T09:00:00+02:00')
  })

  it('rejects "next <word>" when the word is not a weekday', () => {
    expect(() => resolveDate('next fortnight', { timezone: tz, now }))
      .toThrow(/Could not parse date "next fortnight"/)
  })

  it('resolves in-January to +01:00, proving the offset is not hardcoded', () => {
    const januaryNow = new Date('2026-01-14T09:00:00Z') // Berlin winter time, a Wednesday
    expect(resolveDate('today', { timezone: tz, now: januaryNow }).iso)
      .toBe('2026-01-14T00:00:00+01:00')
  })
})

describe('parseDuration', () => {
  it.each([
    ['1h30m', 5_400_000],
    ['45m', 2_700_000],
    ['2h', 7_200_000],
    ['90', 90],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it('rejects nonsense rather than returning zero', () => {
    expect(() => parseDuration('a while')).toThrow(/Could not parse duration/)
  })

  it('parses "0" as zero milliseconds, not as a parse failure', () => {
    expect(parseDuration('0')).toBe(0)
  })

  it('accepts a bare number as milliseconds', () => {
    expect(parseDuration(1500)).toBe(1500)
  })
})

describe('formatDate', () => {
  it('renders with the timezone offset so mistakes are visible', () => {
    expect(formatDate(Date.parse('2026-09-02T09:00:00Z'), tz))
      .toBe('2026-09-02T11:00:00+02:00')
  })
})
