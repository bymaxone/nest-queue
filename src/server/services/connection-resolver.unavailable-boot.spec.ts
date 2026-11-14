/**
 * @fileoverview A Mode B client that ends before it is ready because Redis could not be reached is
 * `CONNECTION_TIMEOUT` (503, a retry may help); one that ends for a reason a retry cannot change
 * (a refused credential, no error at all) stays `CONNECTION_INVALID` (500). The causes are real
 * ioredis 6.0.0 errors: a refused port, a reset socket, an unresolvable host, and a server that
 * accepts the connection and never answers, which ends the client through the ready check's
 * command timeout. `retryStrategy` returns null so the first failure ends the client.
 * @layer server/services
 */

import { createServer, type Server, type Socket } from 'node:net'
import type { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { ConnectionResolver } from './connection-resolver.service'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        }),
    ),
  )
})

/** A port nothing listens on: bind one, then release it. */
async function closedPort(): Promise<number> {
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

/** A server that runs `onConnection` for every socket, and the port it listens on. */
async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    // Read and discard, or the client's FIN is never seen and the server cannot close.
    socket.resume()
    onConnection(socket)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

/** The exception a failed startup against `host:port` rejects with. */
async function startupFailure(
  host: string,
  port: number,
  extra: { commandTimeoutMs?: number } = {},
): Promise<QueueException> {
  const resolver = new ConnectionResolver({
    connection: { url: `redis://${host}:${String(port)}`, options: { retryStrategy: () => null } },
    connectionReadyTimeoutMs: 20_000,
    ...extra,
  })
  const failure = await resolver.init().then(
    () => undefined,
    (err: unknown) => err,
  )
  return failure as QueueException
}

/** The code and details of the exception's response body. */
function bodyOf(err: QueueException): { code: string; details: unknown } {
  const { error } = err.getResponse() as { error: { code: string; details: unknown } }
  return { code: error.code, details: error.details }
}

/** What the response says when Redis was unreachable: the code of a timeout, never the cause. */
const UNAVAILABLE = {
  code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
  details: { operation: 'connect', reason: 'unavailable' },
}

describe('ConnectionResolver — a client that ends because Redis could not be reached', () => {
  it('reports a refused port as CONNECTION_TIMEOUT 503, with the ioredis error as the cause', async () => {
    const err = await startupFailure('127.0.0.1', await closedPort())

    expect(err.getStatus()).toBe(503)
    expect(bodyOf(err)).toStrictEqual(UNAVAILABLE)
    expect((err.cause as { code?: string }).code).toBe('ECONNREFUSED')
  })

  it('reports a socket the server resets as CONNECTION_TIMEOUT 503', async () => {
    const port = await listen((socket) => {
      socket.destroy()
    })

    const err = await startupFailure('127.0.0.1', port)

    expect(err.getStatus()).toBe(503)
    expect(bodyOf(err)).toStrictEqual(UNAVAILABLE)
    expect((err.cause as { code?: string }).code).toBe('ECONNRESET')
  })

  // `.invalid` never resolves (RFC 6761); a resolver that cannot answer at all raises EAI_AGAIN,
  // which is in the same set.
  it('reports an unresolvable host as CONNECTION_TIMEOUT 503', async () => {
    const err = await startupFailure('no-such-host.invalid', 6379)

    expect(err.getStatus()).toBe(503)
    expect(bodyOf(err)).toStrictEqual(UNAVAILABLE)
    expect(['ENOTFOUND', 'EAI_AGAIN']).toContain((err.cause as { code?: string }).code)
  })

  // A server that accepts the connection and never answers: the connect timer is already cleared,
  // so what ends the client is the command deadline on the ready check's INFO, an error with no
  // `code` that ioredis raises as a plain `Error('Command timed out')`.
  it('reports a server that never answers as CONNECTION_TIMEOUT 503, through the ready check', async () => {
    const port = await listen(() => undefined)

    const err = await startupFailure('127.0.0.1', port, { commandTimeoutMs: 300 })

    expect(err.getStatus()).toBe(503)
    expect(bodyOf(err)).toStrictEqual(UNAVAILABLE)
    expect((err.cause as Error).message).toBe('Command timed out')
  }, 20_000)

  it('keeps the error code out of the response body', async () => {
    const err = await startupFailure('127.0.0.1', await closedPort())

    expect(JSON.stringify(err.getResponse())).not.toContain('ECONNREFUSED')
  })
})

// A server that accepts the connection and never answers keeps the client in `connect`: nothing in
// ioredis ends it, so the startup budget is the only exit. Only the timer functions are faked, so
// the sockets and the events are real and the budget is advanced by hand.
describe('ConnectionResolver — a server that never answers, ended by the startup budget', () => {
  const BUDGET_MS = 400

  /** Fake only the timer functions; the sockets and the event loop primitives stay real. */
  function fakeOnlyTimers(): void {
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
  }

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  /** Start a resolver against `port`, wait for the TCP connection, and return both. */
  async function startAgainstSilent(
    port: number,
    budgetMs: number,
  ): Promise<{ resolver: ConnectionResolver; outcome: Promise<unknown> }> {
    const resolver = new ConnectionResolver({
      connection: { url: `redis://127.0.0.1:${String(port)}` },
      connectionReadyTimeoutMs: budgetMs,
    })
    const outcome = resolver.init().then(
      () => undefined,
      (err: unknown) => err,
    )
    const client = resolver.getClient()
    await new Promise<void>((resolve) => {
      if (client.status === 'connect') resolve()
      else
        client.once('connect', () => {
          resolve()
        })
    })
    return { resolver, outcome }
  }

  it('is CONNECTION_TIMEOUT 503 when the budget ends, and disconnects the client it opened', async () => {
    fakeOnlyTimers()
    const port = await listen(() => undefined)
    const { resolver, outcome } = await startAgainstSilent(port, BUDGET_MS)
    const client = resolver.getClient()
    expect(client.status).toBe('connect')
    const disconnect = jest.spyOn(client, 'disconnect')

    await jest.advanceTimersByTimeAsync(BUDGET_MS)
    const err = (await outcome) as QueueException

    expect(err.getStatus()).toBe(503)
    expect(bodyOf(err)).toStrictEqual({
      code: QUEUE_ERROR_CODES.CONNECTION_TIMEOUT,
      details: { timeoutMs: BUDGET_MS },
    })
    // Legal here: the client is in `connect`, not `end`, so ioredis still has a stream to tear down.
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('leaves no timer pending once the client it opened has ended', async () => {
    fakeOnlyTimers()
    const port = await listen(() => undefined)
    const { resolver, outcome } = await startAgainstSilent(port, BUDGET_MS)
    const client = resolver.getClient()
    const ended = new Promise<void>((resolve) => {
      client.once('end', () => {
        resolve()
      })
    })

    await jest.advanceTimersByTimeAsync(BUDGET_MS)
    await outcome
    await ended

    expect(client.status).toBe('end')
    expect(jest.getTimerCount()).toBe(0)
  })
})
