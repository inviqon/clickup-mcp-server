const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const DURATION_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

export type ResolveDateOptions = {
  timezone: string
  now?: Date | undefined
}

export type ResolvedDate = {
  epochMs: number
  iso: string
}

/**
 * Returns the timezone offset, in minutes east of UTC, that applies to
 * `epochMs` in `timezone`. Computed from the instant itself via
 * Intl.DateTimeFormat so it reflects DST correctly (no hardcoded offset).
 */
function offsetMinutesAt(epochMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type)
    if (part === undefined) {
      throw new Error(`Could not compute timezone offset for "${timezone}"`)
    }
    return Number(part.value)
  }
  // The wall-clock time in `timezone` for this instant, read as if it were UTC.
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  )
  // The difference between that wall clock and the true UTC instant is the offset.
  return Math.round((asUtc - epochMs) / 60_000)
}

/**
 * Builds the epoch milliseconds for a given wall-clock date/time in `timezone`,
 * resolving the timezone offset by iterating once (DST transitions can shift
 * the offset a single time near the boundary, so a fixed point is reached
 * after at most two passes).
 */
function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): number {
  let guessEpoch = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let i = 0; i < 2; i++) {
    const offsetMinutes = offsetMinutesAt(guessEpoch, timezone)
    const candidate = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000
    if (candidate === guessEpoch) {
      return candidate
    }
    guessEpoch = candidate
  }
  return guessEpoch
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = String(abs % 60).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

/**
 * Formats an instant as ISO 8601 with the offset that applies in `timezone`
 * at that instant, for example "2026-09-02T11:00:00+02:00".
 */
export function formatDate(epochMs: number, timezone: string): string {
  const offsetMinutes = offsetMinutesAt(epochMs, timezone)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type)
    if (part === undefined) {
      throw new Error(`Could not compute timezone offset for "${timezone}"`)
    }
    return part.value
  }
  const hour = get('hour') === '24' ? '00' : get('hour')
  return (
    `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}` +
    formatOffset(offsetMinutes)
  )
}

/**
 * Returns the year/month/day (in `timezone`) that the given instant falls on.
 */
function zonedYmd(epochMs: number, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function addDaysToYmd(
  ymd: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  // Use UTC-based arithmetic on the plain calendar date; no timezone involved
  // because we are only shifting a calendar day count, not an instant.
  const asUtc = Date.UTC(ymd.year, ymd.month - 1, ymd.day) + days * 86_400_000
  const d = new Date(asUtc)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

const PARSE_ERROR_SUFFIX =
  'Accepted: epoch milliseconds, ISO 8601, "today", "tomorrow", "next monday", "in 3 days".'

function parseError(input: string): Error {
  return new Error(`Could not parse date "${input}". ${PARSE_ERROR_SUFFIX}`)
}

/**
 * Resolves a date expression (see the module-level grammar) into an absolute
 * instant. Deliberately narrow: anything outside the supported grammar throws
 * rather than being guessed at, so a resolution mistake is loud, not silent.
 */
export function resolveDate(input: string | number, opts: ResolveDateOptions): ResolvedDate {
  const { timezone } = opts
  const now = opts.now ?? new Date()

  if (typeof input === 'number') {
    return { epochMs: input, iso: formatDate(input, timezone) }
  }

  const trimmed = input.trim()

  if (/^-?\d+$/.test(trimmed)) {
    const epochMs = Number(trimmed)
    return { epochMs, iso: formatDate(epochMs, timezone) }
  }

  const isoCandidate = Date.parse(trimmed)
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) && !Number.isNaN(isoCandidate)) {
    return { epochMs: isoCandidate, iso: formatDate(isoCandidate, timezone) }
  }

  const lower = trimmed.toLowerCase()

  const dayWithTime = lower.match(/^(today|tomorrow|yesterday)(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (dayWithTime !== null) {
    const [, dayWord, hourStr, minuteStr] = dayWithTime
    const dayOffset = dayWord === 'today' ? 0 : dayWord === 'tomorrow' ? 1 : -1
    const baseYmd = addDaysToYmd(zonedYmd(now.getTime(), timezone), dayOffset)
    const hour = hourStr !== undefined ? Number(hourStr) : 0
    const minute = minuteStr !== undefined ? Number(minuteStr) : 0
    const epochMs = zonedTimeToEpoch(baseYmd.year, baseYmd.month, baseYmd.day, hour, minute, 0, timezone)
    return { epochMs, iso: formatDate(epochMs, timezone) }
  }

  const nextLast = lower.match(/^(next|last)\s+([a-z]+)$/)
  if (nextLast !== null) {
    const [, direction, weekdayName] = nextLast as [string, string, string]
    const targetWeekday = WEEKDAYS.indexOf(weekdayName)
    if (targetWeekday === -1) {
      throw parseError(input)
    }
    const todayYmd = zonedYmd(now.getTime(), timezone)
    const todayEpoch = Date.UTC(todayYmd.year, todayYmd.month - 1, todayYmd.day)
    const currentWeekday = new Date(todayEpoch).getUTCDay()
    let deltaDays: number
    if (direction === 'next') {
      deltaDays = ((targetWeekday - currentWeekday + 7 - 1) % 7) + 1
    } else {
      deltaDays = -(((currentWeekday - targetWeekday + 7 - 1) % 7) + 1)
    }
    const targetYmd = addDaysToYmd(todayYmd, deltaDays)
    const epochMs = zonedTimeToEpoch(targetYmd.year, targetYmd.month, targetYmd.day, 0, 0, 0, timezone)
    return { epochMs, iso: formatDate(epochMs, timezone) }
  }

  const relative = lower.match(/^in\s+(\d+)\s+(minutes?|hours?|days?|weeks?)$/)
  const relativeAgo = lower.match(/^(\d+)\s+(minutes?|hours?|days?|weeks?)\s+ago$/)
  const relativeMatch = relative ?? relativeAgo
  if (relativeMatch !== null) {
    const [, amountStr, unit] = relativeMatch as [string, string, string]
    const amount = Number(amountStr)
    const unitMs = DURATION_UNIT_MS[unit]
    if (unitMs === undefined) {
      throw parseError(input)
    }
    const sign = relative !== null ? 1 : -1
    const epochMs = now.getTime() + sign * amount * unitMs
    return { epochMs, iso: formatDate(epochMs, timezone) }
  }

  throw parseError(input)
}

const DURATION_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?$/

/**
 * Parses a duration expression into milliseconds: a bare number (or numeric
 * string) is milliseconds; otherwise "1h30m", "45m" or "2h" style tokens.
 * Throws on anything else, including a fully empty match like "" or "h".
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    return input
  }

  const trimmed = input.trim()

  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed)
  }

  const match = DURATION_PATTERN.exec(trimmed)
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(
      `Could not parse duration "${input}". Accepted: a number of milliseconds, or a combination like "1h30m", "45m", "2h".`,
    )
  }
  const hours = match[1] !== undefined ? Number(match[1]) : 0
  const minutes = match[2] !== undefined ? Number(match[2]) : 0
  return hours * 3_600_000 + minutes * 60_000
}
