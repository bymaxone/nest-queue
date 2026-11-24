/**
 * @fileoverview Unit tests for `pingResult`: the readiness answer as objects that have no prototype.
 * @layer server/utils
 */

import { pingResult } from './ping-result'

describe('pingResult', () => {
  it('builds up and down answers with the mode, none of it inherited', () => {
    expect(pingResult(true, 'mode-a-byo')).toEqual({
      status: 'up',
      details: { mode: 'mode-a-byo' },
    })
    expect(pingResult(false, 'mode-a-byo')).toEqual({
      status: 'down',
      details: { mode: 'mode-a-byo' },
    })
  })

  it('has no prototype, at either level, so no then planted on Object.prototype is read', () => {
    const result = pingResult(true, 'mode-a-byo')

    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(Object.getPrototypeOf(result.details)).toBeNull()
  })
})
