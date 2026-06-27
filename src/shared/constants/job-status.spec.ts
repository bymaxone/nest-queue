/**
 * @fileoverview Unit tests for the JOB_STATUS constant object.
 * @layer shared/constants
 */

import { JOB_STATUS } from './job-status'

describe('JOB_STATUS', () => {
  it('maps each canonical key to its BullMQ status string', () => {
    // The constant mirrors the six BullMQ statuses with literal values.
    expect(JOB_STATUS).toEqual({
      WAITING: 'waiting',
      ACTIVE: 'active',
      COMPLETED: 'completed',
      FAILED: 'failed',
      DELAYED: 'delayed',
      PAUSED: 'paused',
    })
  })
})
