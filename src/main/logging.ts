/**
 * Diagnostic logging that cannot take the app down with it.
 *
 * A GUI launch can leave the stdio streams attached to a pipe whose reader is
 * gone: a terminal that was closed, or a launcher that starts the app and exits.
 * The next write then fails with EPIPE, and an unhandled stream error becomes an
 * uncaught main-process exception — an update check, a boot trace or a warning
 * would abort the app for no user-visible reason.
 */

/** A console-like sink, so tests can supply a failing one. */
export interface LogSink {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export type LogLevel = keyof LogSink

/**
 * Keep a lost reader from aborting the process. Without a listener the stream
 * emits its error as an uncaught exception. The stdio streams carry diagnostics
 * only, so their failures are not errors the app can act on or report anywhere.
 */
export function tolerateBrokenStdio(stream: NodeJS.EventEmitter): void {
  stream.on('error', () => undefined)
}

/**
 * Write one diagnostic line, tolerating a stream that has already failed. This
 * is deliberately silent: if the log destination is gone there is nowhere left
 * to report that logging failed, and the caller's work must still finish.
 */
export function safeLog(sink: LogSink, prefix: string, level: LogLevel, message?: unknown): void {
  try {
    sink[level](prefix, message)
  } catch {
    // The destination is closed; logging is best-effort by definition.
  }
}
