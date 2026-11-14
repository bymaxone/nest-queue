/**
 * @fileoverview The one place the library calls `disconnect()` on an ioredis client.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'

/**
 * Disconnect a client unless it has already ended. ioredis arms a 2 s teardown timer on
 * `disconnect()` and clears it only when the stream emits `close`; the stream of a client in
 * `end` has already closed and never emits it again, so the timer would keep the host process
 * alive for two more seconds.
 *
 * @param client - The client to release.
 * @example
 * disconnectUnlessEnded(connection)
 */
export function disconnectUnlessEnded(client: Redis): void {
  if (client.status !== 'end') client.disconnect()
}
