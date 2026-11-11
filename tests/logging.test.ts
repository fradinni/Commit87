import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { safeLog, tolerateBrokenStdio } from '../src/main/logging'
import type { LogSink } from '../src/main/logging'

function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

describe('diagnostic logging', () => {
  it('keeps a broken stdio pipe from raising an uncaught exception', () => {
    const stream = new EventEmitter()
    // Without a listener, EventEmitter rethrows a stream 'error' event.
    expect(() => stream.emit('error', brokenPipe())).toThrow('write EPIPE')
    tolerateBrokenStdio(stream)
    expect(() => stream.emit('error', brokenPipe())).not.toThrow()
  })

  it('passes a log line to a working sink', () => {
    const sink: LogSink = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    safeLog(sink, '[commit87:update]', 'info', 'Checking for update')
    expect(sink.info).toHaveBeenCalledWith('[commit87:update]', 'Checking for update')
    safeLog(sink, '[commit87:update]', 'debug')
    expect(sink.debug).toHaveBeenCalledWith('[commit87:update]', undefined)
  })

  it('does not let a failed log write abort the caller', () => {
    const failing = (): never => {
      throw brokenPipe()
    }
    const sink: LogSink = { info: failing, warn: failing, error: failing, debug: failing }
    expect(() => safeLog(sink, '[commit87:update]', 'info', 'Checking for update')).not.toThrow()
    expect(() => safeLog(sink, '[commit87:update]', 'error', new Error('boom'))).not.toThrow()
  })
})
