/**
 * @fileoverview Closes an ioredis client with `quit()` inside a time bound.
 * @layer server/utils
 */

import type { Redis } from 'ioredis'
import { disconnectUnlessEnded } from './disconnect-unless-ended'

/**
 * Ask `client` to quit and wait at most `timeoutMs` for the answer. A quit that fails, or that is
 * still unanswered when the bound ends (a frozen Redis answers nothing, and ioredis' own command
 * deadline can be set far longer than a shutdown can wait), is followed by a disconnect, unless the
 * client has already ended. It never rejects, and its timer does not keep the process alive.
 *
 * @param client - The client to close.
 * @param timeoutMs - The longest the quit may take, in milliseconds.
 * @example
 * await quitWithin(client, 1000)
 */
export async function quitWithin(client: Redis, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const unanswered = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
    timer.unref()
  })
  const quit = client.quit().then(
    () => true,
    () => false,
  )
  const answered = await Promise.race([quit, unanswered]).finally(() => {
    clearTimeout(timer)
  })
  if (!answered) disconnectUnlessEnded(client)
}
