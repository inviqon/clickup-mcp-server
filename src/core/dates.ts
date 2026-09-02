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
 * Returns year/month/day/hour/minute/second in `timezone` for the given
 * instant, in one Intl call.
 */
function zonedDateTimeParts(
  epochMs: number,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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
      throw new Error(`Could not read "${type}" for timezone "${timezone}"`)
    }
    return Number(part.value)
  }
  const hour = get('hour')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  }
}

/**
 * Builds the epoch milliseconds for a given wall-clock date/time in
 * `timezone`.
 *
 * DST is handled explicitly rather than incidentally: the offset in effect
 * at the start and at the end of the target calendar day brackets any
 * single DST transition within that day, giving up to two candidate
 * instants. Each candidate is checked by reformatting it back through
 * `timezone` and comparing against the requested wall clock:
 *   - No candidate matches -> the wall clock time does not exist (a
 *     spring-forward gap, e.g. Berlin's 2026-03-29 02:30). Returns `null`
 *     so the caller can fail loudly instead of silently rolling over to a
 *     different hour, which is exactly the failure mode this module exists
 *     to prevent.
 *   - Both candidates match -> the wall clock time is ambiguous (a
 *     fall-back repeated hour, e.g. Berlin's 2026-10-25 02:30, which occurs
 *     once in CEST and once in CET). This deliberately resolves to the
 *     EARLIER of the two instants (the occurrence before the transition).
 *   - Otherwise there is exactly one match, the normal case.
 */
function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): number | null {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const offsetAtStart = offsetMinutesAt(Date.UTC(year, month - 1, day, 0, 0, 0), timezone)
  const offsetAtEnd = offsetMinutesAt(Date.UTC(year, month - 1, day, 23, 59, 0), timezone)
  const candidateEpochs = Array.from(
    new Set([naiveUtc - offsetAtStart * 60_000, naiveUtc - offsetAtEnd * 60_000]),
  )
  const matches = candidateEpochs.filter((candidate) => {
    const parts = zonedDateTimeParts(candidate, timezone)
    return (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === second
    )
  })
  if (matches.length === 0) {
    return null
  }
  return Math.min(...matches)
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

/**
 * Whether year/month/day form a real calendar date. `Date.parse` alone is
 * not a sufficient check: it normalizes out-of-range days (e.g.
 * "2026-02-30" silently becomes 2026-03-02) instead of rejecting them.
 */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth
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

  const isoDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoDateMatch !== null) {
    const [, yearStr, monthStr, dayStr] = isoDateMatch as [string, string, string, string]
    const year = Number(yearStr)
    const month = Number(monthStr)
    const day = Number(dayStr)
    if (!isValidCalendarDate(year, month, day)) {
      throw parseError(input)
    }

    // An ISO string that carries no offset ("2026-09-05", or
    // "2026-09-05T14:00") names a WALL CLOCK, and the only wall clock this
    // server has is `timezone`. `Date.parse` resolves the date-only form in
    // UTC and the date-time form in the host's own local zone, neither of
    // which is necessarily the configured one: for a user in
    // America/New_York, `due_date: "2026-09-05"` was set to September 4th,
    // silently, while "today" resolved correctly. Routed through
    // `zonedTimeToEpoch` like every other branch here, so all of them agree
    // on which zone a bare date means. A form that DOES carry an offset
    // (`Z`, `+02:00`) already names an instant and is left to `Date.parse`.
    const local = trimmed.match(/^\d{4}-\d{2}-\d{2}(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/)
    if (local !== null) {
      const [, hourStr, minuteStr, secondStr] = local
      const epochMs = zonedTimeToEpoch(
        year,
        month,
        day,
        hourStr !== undefined ? Number(hourStr) : 0,
        minuteStr !== undefined ? Number(minuteStr) : 0,
        secondStr !== undefined ? Number(secondStr) : 0,
        timezone,
      )
      if (epochMs === null) {
        throw parseError(input)
      }
      return { epochMs, iso: formatDate(epochMs, timezone) }
    }

    const isoCandidate = Date.parse(trimmed)
    if (Number.isNaN(isoCandidate)) {
      throw parseError(input)
    }
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
    if (hour > 23 || minute > 59) {
      throw parseError(input)
    }
    const epochMs = zonedTimeToEpoch(baseYmd.year, baseYmd.month, baseYmd.day, hour, minute, 0, timezone)
    if (epochMs === null) {
      throw parseError(input)
    }
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
    if (epochMs === null) {
      throw parseError(input)
    }
    return { epochMs, iso: formatDate(epochMs, timezone) }
  }

  const relative = lower.match(/^in\s+(\d+)\s+(minutes?|hours?|days?|weeks?)$/)
  const relativeAgo = lower.match(/^(\d+)\s+(minutes?|hours?|days?|weeks?)\s+ago$/)
  const relativeMatch = relative ?? relativeAgo
  if (relativeMatch !== null) {
    const [, amountStr, unitWord] = relativeMatch as [string, string, string]
    const amount = Number(amountStr)
    const unitMs = DURATION_UNIT_MS[unitWord]
    if (unitMs === undefined) {
      throw parseError(input)
    }
    const sign = relative !== null ? 1 : -1
    const isCalendarUnit = unitWord.startsWith('day') || unitWord.startsWith('week')
    if (isCalendarUnit) {
      // Calendar-day arithmetic, same as "today"/"tomorrow": keep the same
      // wall-clock time in `timezone`. Raw millisecond addition (used below
      // for hours/minutes) would silently drift by an hour whenever the
      // span crosses a DST boundary.
      const days = unitWord.startsWith('week') ? amount * 7 : amount
      const nowParts = zonedDateTimeParts(now.getTime(), timezone)
      const targetYmd = addDaysToYmd(
        { year: nowParts.year, month: nowParts.month, day: nowParts.day },
        sign * days,
      )
      const epochMs = zonedTimeToEpoch(
        targetYmd.year,
        targetYmd.month,
        targetYmd.day,
        nowParts.hour,
        nowParts.minute,
        nowParts.second,
        timezone,
      )
      if (epochMs === null) {
        throw parseError(input)
      }
      return { epochMs, iso: formatDate(epochMs, timezone) }
    }
    // Elapsed-time units (hours/minutes): raw millisecond addition is
    // correct here, since "2 hours" means 7,200,000 ms of elapsed time
    // regardless of any DST boundary crossed in between.
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

/**
 * Formats a millisecond duration as "1h 30m" (or "45m" / "2h" when one part
 * is zero, "0m" for a zero duration). The inverse of `parseDuration`'s
 * milliseconds-in direction, and the only place this server should ever
 * turn a duration into text: this project has already shipped three
 * separate defects where a date or duration reached the agent unformatted,
 * and a raw millisecond count (or ClickUp's own negative-while-running
 * convention) is exactly that class of bug. Negative input (ClickUp's
 * convention for "still running") is rendered using its absolute value,
 * since an elapsed duration is never itself negative.
 */
export function formatDurationHm(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) {
    return `${minutes}m`
  }
  if (minutes === 0) {
    return `${hours}h`
  }
  return `${hours}h ${minutes}m`
}
