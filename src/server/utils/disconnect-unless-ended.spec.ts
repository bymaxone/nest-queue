/**
 * @fileoverview Unit tests for the guard every `disconnect()` of the library goes through, and a
 * scan that keeps it that way. ioredis arms a 2 s teardown timer on `disconnect()` and clears it
 * only when the stream emits `close`, which a client already in `end` never does again.
 * @layer server/utils
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Redis } from 'ioredis'
import { disconnectUnlessEnded } from './disconnect-unless-ended'

/** A client stub in the given status. */
function clientIn(status: string): { client: Redis; disconnect: jest.Mock } {
  const disconnect = jest.fn()
  return { client: { status, disconnect } as unknown as Redis, disconnect }
}

describe('disconnectUnlessEnded', () => {
  it.each(['wait', 'connecting', 'connect', 'ready', 'reconnecting', 'close', 'disconnecting'])(
    'disconnects a client that is %s',
    (status) => {
      const { client, disconnect } = clientIn(status)

      disconnectUnlessEnded(client)

      expect(disconnect).toHaveBeenCalledTimes(1)
    },
  )

  it('leaves a client that has already ended alone', () => {
    const { client, disconnect } = clientIn('end')

    disconnectUnlessEnded(client)

    expect(disconnect).not.toHaveBeenCalled()
  })
})

describe('every disconnect of the library goes through the guard', () => {
  const root = resolve(__dirname, '..')

  /** Every non-spec source file under `src/server`. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : []
    })
  }

  it('calls `.disconnect(` only inside the guard itself', () => {
    const offenders = sources(root).flatMap((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      const calls = code.match(/\.disconnect\(/g)?.length ?? 0
      return calls > 0 && !file.endsWith('utils/disconnect-unless-ended.ts')
        ? [`${file.slice(root.length + 1)}: ${String(calls)}`]
        : []
    })

    expect(offenders).toEqual([])
  })
})
