/**
 * @fileoverview Unit tests for `writeLog`: the event reaches the logger at the level asked for, and
 * a logger that throws does not escape. The path through Nest's own `Logger` is held by the process
 * spec next to this one.
 * @layer test
 */

import { writeLog } from './log-event'

const event = { event: 'QUEUE_CLIENT_ERROR', message: 'text' } as const

describe('writeLog', () => {
  it.each(['log', 'warn', 'error'] as const)(
    'hands the event to the %s method, and to no other',
    (level) => {
      const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }

      writeLog(logger, level, event)

      expect(logger[level]).toHaveBeenCalledWith(event)
      const others = (['log', 'warn', 'error'] as const).filter((other) => other !== level)
      for (const other of others) expect(logger[other]).not.toHaveBeenCalled()
    },
  )

  it('absorbs a logger that throws', () => {
    const throwing = {
      log: jest.fn(),
      warn: () => {
        throw new Error('sync transport')
      },
      error: jest.fn(),
    }

    expect(() => {
      writeLog(throwing, 'warn', event)
    }).not.toThrow()
    expect(throwing.log).not.toHaveBeenCalled()
  })
})
