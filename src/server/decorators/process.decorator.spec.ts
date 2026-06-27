/**
 * @fileoverview Unit tests for the `@Process` method decorator.
 * @layer server/decorators
 */

import 'reflect-metadata'
import { Process } from './process.decorator'
import { PROCESS_HANDLERS_METADATA_KEY } from './metadata-keys.constants'
import type { ProcessHandlerMetadata } from '../interfaces/processor-metadata.interface'

describe('@Process decorator', () => {
  it('pushes a catch-all entry (no jobName) when called without arguments', () => {
    // @Process() with no name registers as the catch-all handler for all jobs.
    class Proc {
      @Process()
      handle(): void {}
    }

    const entries = Reflect.getMetadata(
      PROCESS_HANDLERS_METADATA_KEY,
      Proc,
    ) as ProcessHandlerMetadata[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.jobName).toBeUndefined()
    expect(entries[0]!.methodKey).toBe('handle')
  })

  it('pushes a named entry when a jobName is supplied', () => {
    // @Process('send') registers a handler targeted at jobs named 'send'.
    class Proc {
      @Process('send')
      handleSend(): void {}
    }

    const entries = Reflect.getMetadata(
      PROCESS_HANDLERS_METADATA_KEY,
      Proc,
    ) as ProcessHandlerMetadata[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.jobName).toBe('send')
    expect(entries[0]!.methodKey).toBe('handleSend')
  })

  it('accumulates multiple @Process entries without overwriting', () => {
    // Multiple decorators on the same class must all be preserved.
    class Proc {
      @Process('send')
      handleSend(): void {}

      @Process('retry')
      handleRetry(): void {}

      @Process()
      handleDefault(): void {}
    }

    const entries = Reflect.getMetadata(
      PROCESS_HANDLERS_METADATA_KEY,
      Proc,
    ) as ProcessHandlerMetadata[]
    expect(entries).toHaveLength(3)
    const keys = entries.map((e) => e.methodKey)
    expect(keys).toContain('handleSend')
    expect(keys).toContain('handleRetry')
    expect(keys).toContain('handleDefault')
  })

  it('records the correct method key for symbol-keyed methods', () => {
    // Symbol keys must be preserved exactly for the discovery service to resolve handlers.
    const sym = Symbol('myHandler')
    class Proc {
      @Process('task')
      [sym](): void {}
    }

    const entries = Reflect.getMetadata(
      PROCESS_HANDLERS_METADATA_KEY,
      Proc,
    ) as ProcessHandlerMetadata[]
    expect(entries[0]!.methodKey).toBe(sym)
  })
})
