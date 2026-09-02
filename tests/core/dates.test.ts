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

  it('resolves "in 3 days" across a DST fall-back boundary, keeping the wall-clock time', () => {
    // 2026-10-25 is when Berlin falls back from CEST to CET.
    const octNow = new Date('2026-10-24T09:00:00Z') // 11:00 CEST Berlin, a Saturday
    expect(resolveDate('in 3 days', { timezone: tz, now: octNow }).iso)
      .toBe('2026-10-27T11:00:00+01:00')
  })

  it('resolves "4 days ago" across a DST spring-forward boundary, keeping the wall-clock time', () => {
    // 2026-03-29 is when Berlin springs forward from CET to CEST.
    const aprNow = new Date('2026-04-01T09:00:00Z') // 11:00 CEST Berlin, a Wednesday
    expect(resolveDate('4 days ago', { timezone: tz, now: aprNow }).iso)
      .toBe('2026-03-28T11:00:00+01:00')
  })

  // A date-only ISO string names a wall clock, not an instant. `Date.parse`
  // read it as UTC midnight, so for any user west of UTC
  // clickup_create_task({due_date: "2026-09-05"}) set September 4th - and
  // clickup_get_my_day derived dayStart, dayEnd and the displayed date from
  // it, producing a short window labelled with the wrong day. Tested in
  // New York specifically: in Berlin (UTC+2) a UTC regression still lands
  // on the right calendar date and would pass unnoticed.
  it('resolves a date-only ISO string to midnight in the configured timezone, not UTC', () => {
    const r = resolveDate('2026-09-05', { timezone: 'America/New_York', now })
    expect(r.iso).toBe('2026-09-05T00:00:00-04:00')
    expect(r.epochMs).toBe(Date.parse('2026-09-05T04:00:00Z'))
  })

  it('resolves a date-only ISO string the same way "today" does', () => {
    expect(resolveDate('2026-09-02', { timezone: tz, now }).epochMs)
      .toBe(resolveDate('today', { timezone: tz, now }).epochMs)
  })

  it('resolves an offsetless ISO date-time in the configured timezone', () => {
    expect(resolveDate('2026-09-05T14:00', { timezone: 'America/New_York', now }).iso)
      .toBe('2026-09-05T14:00:00-04:00')
  })

  it('still honours an explicit offset rather than reinterpreting it', () => {
    expect(resolveDate('2026-09-05T14:00:00+02:00', { timezone: 'America/New_York', now }).epochMs)
      .toBe(Date.parse('2026-09-05T12:00:00Z'))
  })

  it('rejects an ISO date with an out-of-range day instead of rolling over', () => {
    expect(() => resolveDate('2026-02-30', { timezone: tz, now }))
      .toThrow(/Could not parse date "2026-02-30"/)
  })

  it('rejects an ISO date with month 13', () => {
    expect(() => resolveDate('2026-13-01', { timezone: tz, now }))
      .toThrow(/Could not parse date "2026-13-01"/)
  })

  it('accepts the last valid day of February in a leap year', () => {
    expect(resolveDate('2028-02-29T00:00:00Z', { timezone: tz, now }).epochMs)
      .toBe(Date.parse('2028-02-29T00:00:00Z'))
  })

  it('rejects February 29 in a non-leap year', () => {
    expect(() => resolveDate('2026-02-29T00:00:00Z', { timezone: tz, now }))
      .toThrow(/Could not parse date "2026-02-29T00:00:00Z"/)
  })

  it('rejects a valid calendar date with a malformed time portion', () => {
    expect(() => resolveDate('2026-01-01Tzzzz', { timezone: tz, now }))
      .toThrow(/Could not parse date "2026-01-01Tzzzz"/)
  })

  it('rejects "in N days" when it lands on a DST spring-forward gap', () => {
    // now is 02:30 CET Berlin on 2026-03-28, the day before the gap; adding
    // 1 calendar day lands on 2026-03-29 02:30, which never happens.
    const beforeGap = new Date('2026-03-28T01:30:00Z')
    expect(() => resolveDate('in 1 day', { timezone: tz, now: beforeGap }))
      .toThrow(/Could not parse date "in 1 day"/)
  })

  it('rejects an hour above 23', () => {
    expect(() => resolveDate('today 25:00', { timezone: tz, now }))
      .toThrow(/Could not parse date "today 25:00"/)
  })

  it('rejects a minute above 59', () => {
    expect(() => resolveDate('today 12:99', { timezone: tz, now }))
      .toThrow(/Could not parse date "today 12:99"/)
  })

  it('rejects a wall-clock time that does not exist in a DST spring-forward gap', () => {
    // Berlin clocks jump from 02:00 to 03:00 on 2026-03-29; 02:30 never happens.
    const gapDay = new Date('2026-03-29T10:00:00Z')
    expect(() => resolveDate('today 02:30', { timezone: tz, now: gapDay }))
      .toThrow(/Could not parse date "today 02:30"/)
  })

  it('resolves an ambiguous DST fall-back wall-clock time to its earlier occurrence', () => {
    // Berlin clocks fall back at 2026-10-25 03:00 CEST -> 02:00 CET, so
    // 02:30 happens twice. We deliberately pick the earlier (CEST) instant.
    const ambiguousDay = new Date('2026-10-25T10:00:00Z')
    expect(resolveDate('today 02:30', { timezone: tz, now: ambiguousDay }).iso)
      .toBe('2026-10-25T02:30:00+02:00')
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
