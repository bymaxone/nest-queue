/**
 * @fileoverview Pins what `./stryker-scope.data` says the shipped closure must contain. The scope check
 * reads those values only as containment and a floor, so a dropped entry or a moved floor passes it.
 * @layer tests
 */

import { EXPECTED } from './stryker-scope.data'

describe('mutation scope data', () => {
  /** A literal copy: a value derived from the data would move with it. */
  it('names every package entry and the floor of the shipped closure', () => {
    expect(EXPECTED).toEqual({
      entries: 3,
      includes: ['src/server/index.ts', 'src/shared/index.ts', 'src/observability/index.ts'],
      minShipped: 30,
    })
  })
})
