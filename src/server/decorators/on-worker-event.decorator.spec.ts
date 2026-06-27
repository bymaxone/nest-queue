/**
 * @fileoverview Unit tests for the `@OnWorkerEvent` method decorator.
 * @layer server/decorators
 */

import 'reflect-metadata'
import { OnWorkerEvent } from './on-worker-event.decorator'
import {
  WORKER_EVENT_LISTENERS_METADATA_KEY,
  QUEUE_EVENT_LISTENERS_METADATA_KEY,
} from './metadata-keys.constants'
import type { QueueEventListenerMetadata } from '../interfaces/processor-metadata.interface'

describe('@OnWorkerEvent decorator', () => {
  it('writes a listener entry under the WORKER key for the completed event', () => {
    // Worker-local listeners must live under the worker-specific metadata key.
    class Proc {
      @OnWorkerEvent('completed')
      onCompleted(): void {}
    }

    const entries = Reflect.getMetadata(
      WORKER_EVENT_LISTENERS_METADATA_KEY,
      Proc,
    ) as QueueEventListenerMetadata[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.eventName).toBe('completed')
    expect(entries[0]!.methodKey).toBe('onCompleted')
  })

  it('accumulates multiple @OnWorkerEvent decorators without overwriting', () => {
    // Multiple worker-event listeners on the same class must all be preserved.
    class Proc {
      @OnWorkerEvent('completed')
      onCompleted(): void {}

      @OnWorkerEvent('failed')
      onFailed(): void {}

      @OnWorkerEvent('progress')
      onProgress(): void {}
    }

    const entries = Reflect.getMetadata(
      WORKER_EVENT_LISTENERS_METADATA_KEY,
      Proc,
    ) as QueueEventListenerMetadata[]
    expect(entries).toHaveLength(3)
    const events = entries.map((e) => e.eventName)
    expect(events).toContain('completed')
    expect(events).toContain('failed')
    expect(events).toContain('progress')
  })

  it('does NOT write to the QUEUE_EVENT key (separate Symbol keys for worker vs global)', () => {
    // Worker listeners and queue-event listeners must use separate metadata keys.
    class Proc {
      @OnWorkerEvent('active')
      onActive(): void {}
    }

    const queueEntries: unknown = Reflect.getMetadata(QUEUE_EVENT_LISTENERS_METADATA_KEY, Proc)
    expect(queueEntries).toBeUndefined()
  })

  it('records the error event correctly', () => {
    // Infrastructure events like error, closing, closed must also be storable.
    class Proc {
      @OnWorkerEvent('error')
      onError(): void {}
    }

    const entries = Reflect.getMetadata(
      WORKER_EVENT_LISTENERS_METADATA_KEY,
      Proc,
    ) as QueueEventListenerMetadata[]
    expect(entries[0]!.eventName).toBe('error')
  })
})
