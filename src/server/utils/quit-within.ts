/**
 * @fileoverview Closes an ioredis client with `quit()` inside a time bound.
 * @layer server/utils
 */

import type { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { assertPrototypeClean } from '../connection/prototype-guard'
import { startWait } from './bounded-wait'
import { disconnectUnlessEnded } from './disconnect-unless-ended'
import { reportRefusal } from './log-event'

/**
 * Ask `client` to quit and wait at most `timeoutMs` for the answer. A quit that fails, or that is
 * still unanswered when the bound ends (a frozen Redis answers nothing, and ioredis' own command
 * deadline can be set far longer than a shutdown can wait), is followed by a disconnect, unless the
 * client has already ended. A prototype the guard refuses is the same failure, and is logged: the
 * client is disconnected, never left open. It never rejects, and its timer does not keep the process
 * alive.
 *
 * @param client - The client to close.
 * @param timeoutMs - The longest the quit may take, in milliseconds.
 * @param logger - Where a refusal of the guard is reported.
 */
export async function quitWithin(
  client: Redis,
  timeoutMs: number,
  logger: Pick<Logger, 'log' | 'warn' | 'error'>,
): Promise<void> {
  let answered = false
  try {
    assertPrototypeClean()
    const wait = startWait(client.quit(), timeoutMs, { unref: true })
    try {
      assertPrototypeClean()
      answered = (await wait.result).state === 'done'
    } finally {
      wait.release()
    }
  } catch (error) {
    reportRefusal(logger, error, 'teardown')
  }
  if (!answered) disconnectUnlessEnded(client)
}
