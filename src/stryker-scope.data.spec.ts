/**
 * @fileoverview Pins what `./stryker-scope.data` says the shipped closure must contain. The scope check
 * reads those paths only as containment, so an entry dropped from `includes` passes it.
 * @layer tests
 */

import { EXPECTED } from './stryker-scope.data'

describe('mutation scope data', () => {
  /** A literal copy: a value derived from the data would move with it. */
  it('names every package entry and the size of the shipped closure', () => {
    expect(EXPECTED).toEqual({
      entries: 3,
      includes: ['src/server/index.ts', 'src/shared/index.ts', 'src/observability/index.ts'],
      shipped: 73,
    })
  })
})
