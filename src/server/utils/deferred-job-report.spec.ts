/**
 * @fileoverview The report of deferred jobs writes one line a minute and carries the count.
 * @layer server/utils
 */

import { deferredJobReport } from './log-event'

describe('deferredJobReport', () => {
  // A line per refused job would flood the log at the delay's pace, and no line leaves an operator
  // with a queue that loops in silence: the first job is reported, the rest of the minute is counted.
  it('logs the first deferred job, then one line a minute with the count since the last one', () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    let at = 0
    const deferred = deferredJobReport(logger, 'email', () => at)

    for (const time of [0, 1, 59_999, 60_000, 119_999, 120_000]) {
      at = time
      deferred()
    }

    expect(logger.warn.mock.calls).toEqual(
      [1, 3, 2].map((count) => [
        {
          event: 'QUEUE_JOB_DEFERRED_GUARD_REFUSED',
          message: 'The prototype guard refused before a job ran; it went back to the delayed set',
          queue: 'email',
          deferred: count,
        },
      ]),
    )
    expect(logger.log).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  // A line that waited for the window to close would leave a loop silent for its first minute, or
  // for ever when it stops sooner: the first deferral of each window writes before it returns.
  it('writes inside the call that opens each window', () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    let at = 0
    const deferred = deferredJobReport(logger, 'email', () => at)

    deferred()
    expect(logger.warn).toHaveBeenCalledTimes(1)

    at = 60_000
    deferred()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})
