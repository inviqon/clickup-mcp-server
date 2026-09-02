import type { ServerConfig } from './config.js'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type LogLevel = (typeof LEVELS)[number]

function levelRank(level: LogLevel): number {
  return LEVELS.indexOf(level)
}

/**
 * True when a message at `level` should be emitted given the configured
 * minimum `configured` level, using the standard `debug < info < warn <
 * error` ordering. `LOG_LEVEL` (`src/core/config.ts`, Task 1) is parsed and
 * validated at startup but was never consumed anywhere - this is the gate
 * that finally reads it: `LOG_LEVEL=warn` suppresses an `info` line,
 * `LOG_LEVEL=debug` keeps it.
 */
export function shouldLog(configured: LogLevel, level: LogLevel): boolean {
  return levelRank(level) >= levelRank(configured)
}

/**
 * Writes `message` to stderr when `level` clears the `configured`
 * threshold, otherwise does nothing. stderr only, matching every other
 * line this server writes - a write to stdout is forbidden under `src/`
 * (`tests/stdout-guard.test.ts`). Deliberately not a logging framework:
 * one function, no levels beyond the four already defined by `LOG_LEVEL`,
 * no new dependency.
 */
export function logStderr(configured: LogLevel, level: LogLevel, message: string): void {
  if (shouldLog(configured, level)) {
    console.error(message)
  }
}

/** Convenience overload that reads the configured level off a `ServerConfig` directly. */
export function log(config: Pick<ServerConfig, 'logLevel'>, level: LogLevel, message: string): void {
  logStderr(config.logLevel, level, message)
}
