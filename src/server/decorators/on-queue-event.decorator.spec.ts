/**
 * @fileoverview Unit tests for the `@OnQueueEvent` method decorator.
 * @layer server/decorators
 */

import 'reflect-metadata'
import { OnQueueEvent } from './on-queue-event.decorator'
import {
  QUEUE_EVENT_LISTENERS_METADATA_KEY,
  WORKER_EVENT_LISTENERS_METADATA_KEY,
} from './metadata-keys.constants'
import type { QueueEventListenerMetadata } from '../interfaces/processor-metadata.interface'

describe('@OnQueueEvent decorator', () => {
  it('writes a listener entry under the QUEUE_EVENT key for the completed event', () => {
    // Global queue-event listeners must live under the queue-event-specific metadata key.
    class Proc {
      @OnQueueEvent('completed')
      onCompleted(): void {}
    }

    const entries = Reflect.getMetadata(
      QUEUE_EVENT_LISTENERS_METADATA_KEY,
      Proc,
    ) as QueueEventListenerMetadata[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.eventName).toBe('completed')
    expect(entries[0]!.methodKey).toBe('onCompleted')
  })

  it('accumulates multiple @OnQueueEvent decorators without overwriting', () => {
    // Multiple queue-event listeners on the same class must all be preserved.
    class Proc {
      @OnQueueEvent('completed')
      onCompleted(): void {}

      @OnQueueEvent('failed')
      onFailed(): void {}

      @OnQueueEvent('waiting')
      onWaiting(): void {}
    }

    const entries = Reflect.getMetadata(
      QUEUE_EVENT_LISTENERS_METADATA_KEY,
      Proc,
    ) as QueueEventListenerMetadata[]
    expect(entries).toHaveLength(3)
    const events = entries.map((e) => e.eventName)
    expect(events).toContain('completed')
    expect(events).toContain('failed')
    expect(events).toContain('waiting')
  })

  it('does NOT write to the WORKER_EVENT key (separate Symbol keys for worker vs global)', () => {
    // Worker listeners and queue-event listeners must use separate metadata keys.
    class Proc {
      @OnQueueEvent('active')
      onActive(): void {}
    }

    const workerEntries: unknown = Reflect.getMetadata(WORKER_EVENT_LISTENERS_METADATA_KEY, Proc)
    expect(workerEntries).toBeUndefined()
  })

  it('records the cleaned event correctly', () => {
    // All QueueEventName values including cleaned must be storable.
    class Proc {
      @OnQueueEvent('cleaned')
      onCleaned(): void {}
    }

    const entries = Reflect.getMetadata(
      QUEUE_EVENT_LISTENERS_METADATA_KEY,
      Proc,
    ) as QueueEventListenerMetadata[]
    expect(entries[0]!.eventName).toBe('cleaned')
  })
})
