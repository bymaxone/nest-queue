/**
 * @fileoverview Unit tests for the job-option check where `null` is the value of a whole group.
 * `typeof null` is `'object'`, so a `removeOnComplete`, `removeOnFail` or `backoff` of `null` must
 * be refused by name as a value that is not a number or an object, and never reach the destructuring
 * of its `age`, `count`, `delay` or `jitter`, which would throw a `TypeError` that names nothing.
 * @layer server/utils
 */

import { jobOptionsProblem } from './job-defaults-problem'

describe('jobOptionsProblem — a group that holds null', () => {
  it.each(['removeOnComplete', 'removeOnFail', 'backoff'])(
    'refuses %s: null by name, as a value that is not a whole number',
    (key) => {
      expect(jobOptionsProblem({ [key]: null }, 'opts')).toBe(
        `opts.${key} must be a whole number >= 0, received null`,
      )
    },
  )
})
