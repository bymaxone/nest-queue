/**
 * @fileoverview A failed Mode B startup must leave no timer behind. ioredis arms a 2 s teardown
 * timer on `disconnect()` and clears it when the stream emits `close`; a client that already ended
 * has a closed stream, so the timer would keep the host process alive for two more seconds. Real
 * ioredis against a port nothing listens on, with the timer functions faked so the leftover can
 * be counted.
 * @layer server/services
 */

import { createServer } from 'node:net'
import { ConnectionResolver } from './connection-resolver.service'

/** A port nothing listens on: bind one, then release it. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  return port
}

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

describe('ConnectionResolver — a failed startup', () => {
  it('leaves no timer pending once the client has ended', async () => {
    // Only the timer functions are faked, so the sockets and the events run for real.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'queueMicrotask',
        'Date',
        'performance',
        'hrtime',
      ],
    })
    const port = await freePort()
    const resolver = new ConnectionResolver({
      connection: {
        url: `redis://127.0.0.1:${String(port)}`,
        options: { retryStrategy: () => null },
      },
      connectionReadyTimeoutMs: 60_000,
    })

    const failure = await resolver.init().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeDefined()
    expect(resolver.getClient().status).toBe('end')
    expect(jest.getTimerCount()).toBe(0)
  })
})
