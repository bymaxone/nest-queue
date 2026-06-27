/**
 * @fileoverview Unit tests for ProcessorDiscoveryService. NestJS DiscoveryService
 * and BullMQ Worker / QueueEvents are mocked — no real Redis needed.
 * @layer server/services
 */

import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import type { DiscoveryService } from '@nestjs/core'
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper'
import type { Job, Worker } from 'bullmq'
import { ProcessorDiscoveryService } from './processor-discovery.service'
import { WorkerRegistry } from './worker-registry.service'
import { QueueEventsRegistry } from './queue-events-registry.service'
import { Processor } from '../decorators/processor.decorator'
import { Process } from '../decorators/process.decorator'
import { OnWorkerEvent } from '../decorators/on-worker-event.decorator'
import { OnQueueEvent } from '../decorators/on-queue-event.decorator'
import {
  PROCESSOR_METADATA_KEY,
  WORKER_EVENT_LISTENERS_METADATA_KEY,
  QUEUE_EVENT_LISTENERS_METADATA_KEY,
} from '../decorators/metadata-keys.constants'
import type { ProcessorMetadata } from '../interfaces/processor-metadata.interface'
import { QueueException } from '../errors/queue-exception'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'

/** Minimal mock Worker — tracks `on` calls so we can replay events in tests. */
interface MockWorker {
  on: jest.MockedFunction<(event: string, listener: (...args: unknown[]) => unknown) => unknown>
}

/** Minimal mock QueueEvents — tracks `on` calls. */
interface MockQueueEvents {
  on: jest.MockedFunction<(event: string, listener: (...args: unknown[]) => unknown) => unknown>
}

/** Build a provider wrapper mimicking NestJS InstanceWrapper. */
function makeWrapper(instance: object): InstanceWrapper {
  return { instance } as unknown as InstanceWrapper
}

/** Build a DiscoveryService stub returning the given wrappers. */
function mockDiscovery(wrappers: InstanceWrapper[]): DiscoveryService {
  return {
    getProviders: jest.fn<InstanceWrapper[], []>().mockReturnValue(wrappers),
  } as unknown as DiscoveryService
}

/** Create a WorkerRegistry stub whose register() returns a mock Worker. */
function mockRegistry(worker: MockWorker): WorkerRegistry {
  return {
    register: jest.fn<Worker, [unknown]>().mockReturnValue(worker as unknown as Worker),
  } as unknown as WorkerRegistry
}

/** Create a QueueEventsRegistry stub whose getOrCreate() returns a mock QueueEvents. */
function mockEventsRegistry(qe: MockQueueEvents): QueueEventsRegistry {
  return {
    getOrCreate: jest.fn<MockQueueEvents, [string]>().mockReturnValue(qe),
  } as unknown as QueueEventsRegistry
}

describe('ProcessorDiscoveryService.onModuleInit', () => {
  it('skips providers without an instance (null)', () => {
    // Lazy / request-scoped providers may resolve to null — skip gracefully.
    const discovery = mockDiscovery([makeWrapper(null as unknown as object)])
    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(discovery, workers, eventsReg)
    expect(() => { svc.onModuleInit() }).not.toThrow()
    expect(workers.register).not.toHaveBeenCalled()
  })

  it('skips providers without PROCESSOR_METADATA_KEY', () => {
    // Plain providers without @Processor are not queue processors and must be ignored.
    class NotAProcessor {}
    const discovery = mockDiscovery([makeWrapper(new NotAProcessor())])
    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(discovery, workers, eventsReg)
    svc.onModuleInit()
    expect(workers.register).not.toHaveBeenCalled()
  })

  it('registers a Worker when a @Processor class is discovered', () => {
    // The happy-path: a @Processor class causes WorkerRegistry.register to be called.
    @Processor('email', { concurrency: 3 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }

    const instance = new EmailProcessor()
    const mockWorker: MockWorker = { on: jest.fn() }
    const workers = mockRegistry(mockWorker)
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    expect(workers.register).toHaveBeenCalledWith(
      expect.objectContaining({ queueName: 'email' }),
    )
  })

  it('throws DUPLICATE_PROCESSOR when two providers target the same queue', () => {
    // At most one processor per queue is allowed — registering two must fail.
    @Processor('email', { concurrency: 2 })
    class ProcessorA {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }

    @Processor('email', { concurrency: 2 })
    class ProcessorB {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }

    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(new ProcessorA()), makeWrapper(new ProcessorB())]),
      workers,
      eventsReg,
    )
    expect(() => { svc.onModuleInit() }).toThrow(QueueException)
    try {
      svc.onModuleInit()
    } catch (err) {
      const qe = err as QueueException
      expect((qe.getResponse() as { error: { code: string } }).error.code).toBe(
        QUEUE_ERROR_CODES.DUPLICATE_PROCESSOR,
      )
    }
  })

  it('logs a warn when @Processor omits concurrency (_warnedNoConcurrency)', () => {
    // The warning must name the queue and the fallback value; it must NOT fire for explicit concurrency.
    @Processor('email')
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }

    const instance = new EmailProcessor()
    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    // Spy on Logger.prototype.warn so we capture the warning without accessing private fields.
    const loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('email'))
    loggerWarnSpy.mockRestore()
  })

  it('does NOT log a warn when @Processor has explicit concurrency', () => {
    // No concurrency warning should fire when the caller provided an explicit value.
    @Processor('email', { concurrency: 5 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }

    const instance = new EmailProcessor()
    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    expect(loggerWarnSpy).not.toHaveBeenCalled()
    loggerWarnSpy.mockRestore()
  })

  it('binds @OnWorkerEvent listeners to the Worker with the full Job', () => {
    // Worker-local listeners must be wired via worker.on(), and the listener
    // receives the FULL Job instance (not a serialized payload).
    const completedSpy = jest.fn<undefined, [Job, unknown, string]>()

    @Processor('email', { concurrency: 2 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }

      @OnWorkerEvent('completed')
      onCompleted(job: Job, result: unknown, prev: string): void {
        completedSpy(job, result, prev)
      }
    }

    const instance = new EmailProcessor()
    const mockWorker: MockWorker = { on: jest.fn() }
    const workers = mockRegistry(mockWorker)
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()

    // Find the 'completed' listener that was bound to the worker.
    const workerOnCalls = mockWorker.on.mock.calls
    const completedCall = workerOnCalls.find(([ev]) => ev === 'completed')
    expect(completedCall).toBeDefined()

    // Emit the event with a full Job object — the handler must receive it.
    const mockJob = { id: '1', name: 'send', data: { to: 'test@example.com' } } as unknown as Job
    completedCall?.[1]?.(mockJob, 'ok', 'active')
    expect(completedSpy).toHaveBeenCalledWith(mockJob, 'ok', 'active')
    expect(completedSpy.mock.calls[0]?.[0]).toBe(mockJob)
  })

  it('does NOT call getOrCreate when the class has no @OnQueueEvent', () => {
    // QueueEvents connections must only be opened when needed.
    @Processor('email', { concurrency: 2 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }
    }

    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(new EmailProcessor())]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    expect(eventsReg.getOrCreate).not.toHaveBeenCalled()
  })

  it('calls getOrCreate and binds @OnQueueEvent listeners when present', () => {
    // Global queue-event listeners require a QueueEvents connection, opened lazily.
    @Processor('email', { concurrency: 2 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }

      @OnQueueEvent('completed')
      onQueueCompleted(_payload: { jobId: string; returnvalue: string }): void {}
    }

    const mockQe: MockQueueEvents = { on: jest.fn() }
    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry(mockQe)
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(new EmailProcessor())]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    expect(eventsReg.getOrCreate).toHaveBeenCalledWith('email')
    expect(mockQe.on).toHaveBeenCalledWith('completed', expect.any(Function))
  })

  it('registers a Worker when @Processor class has no @Process handlers (empty handler list)', () => {
    // When PROCESS_HANDLERS_METADATA_KEY is absent, the ?? [] fallback is taken and a
    // dispatcher with no handlers is registered — WorkerRegistry.register is still called.
    @Processor('empty', { concurrency: 1 })
    class EmptyProcessor {
      // Intentionally no @Process methods — exercises the `?? []` branch on line 156.
    }

    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(new EmptyProcessor())]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    expect(workers.register).toHaveBeenCalledWith(expect.objectContaining({ queueName: 'empty' }))
  })
})

describe('ProcessorDiscoveryService.buildDispatcher', () => {
  /** Helper: create a bare service without any discovered providers. */
  function bareService(): ProcessorDiscoveryService {
    return new ProcessorDiscoveryService(
      mockDiscovery([]),
      mockRegistry({ on: jest.fn() }),
      mockEventsRegistry({ on: jest.fn() }),
    )
  }

  it('routes job.name to the matching named handler', async () => {
    // Named handlers are invoked first when job.name matches.
    const sendSpy = jest.fn<Promise<void>, [Job]>().mockResolvedValue(undefined)
    const instance: Record<string | symbol, unknown> = { sendEmail: sendSpy }
    const handlers = [{ jobName: 'send-email', methodKey: 'sendEmail' }]
    const dispatcher = bareService().buildDispatcher(instance, handlers)
    const job = { name: 'send-email' } as unknown as Job
    await dispatcher(job)
    expect(sendSpy).toHaveBeenCalledWith(job)
  })

  it('falls back to the catch-all when job.name has no named handler', async () => {
    // A catch-all (@Process()) handles jobs that don't match any named handler.
    const defaultSpy = jest.fn<Promise<void>, [Job]>().mockResolvedValue(undefined)
    const sendSpy = jest.fn<Promise<void>, [Job]>().mockResolvedValue(undefined)
    const instance: Record<string | symbol, unknown> = { handleDefault: defaultSpy, sendEmail: sendSpy }
    const handlers = [
      { jobName: 'send-email', methodKey: 'sendEmail' },
      { methodKey: 'handleDefault' },
    ]
    const dispatcher = bareService().buildDispatcher(instance, handlers)
    const job = { name: 'unknown-type' } as unknown as Job
    await dispatcher(job)
    expect(defaultSpy).toHaveBeenCalledWith(job)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('throws a clear Error when no handler matches and there is no catch-all', async () => {
    // Without a catch-all, unrecognised job names must fail loudly.
    const instance: Record<string | symbol, unknown> = {}
    const handlers = [{ jobName: 'specific-task', methodKey: 'noop' }]
    const dispatcher = bareService().buildDispatcher(instance, handlers)
    const job = { name: 'unmatched-job' } as unknown as Job
    await expect(dispatcher(job)).rejects.toThrow(/unmatched-job/)
  })

  it('skips a handler entry whose method key is not a function', async () => {
    // Non-function values on the instance must be skipped gracefully.
    const realSpy = jest.fn<Promise<void>, [Job]>().mockResolvedValue(undefined)
    const instance: Record<string | symbol, unknown> = { realHandler: realSpy, notAFunction: 42 }
    const handlers = [
      { methodKey: 'notAFunction' },
      { jobName: 'ok', methodKey: 'realHandler' },
    ]
    const dispatcher = bareService().buildDispatcher(instance, handlers)
    const job = { name: 'ok' } as unknown as Job
    await dispatcher(job)
    expect(realSpy).toHaveBeenCalledWith(job)
  })
})

describe('ProcessorDiscoveryService — @OnWorkerEvent receives full Job (not serialized payload)', () => {
  it('the bound handler is invoked with the job.data intact (worker-local distinction)', () => {
    // This test locks in the critical behavioral distinction:
    // @OnWorkerEvent handlers receive a real Job with job.data accessible,
    // unlike @OnQueueEvent handlers which receive a serialized payload.
    const receivedJobs: Job[] = []

    @Processor('email', { concurrency: 2 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }

      @OnWorkerEvent('completed')
      onCompleted(job: Job): void {
        receivedJobs.push(job)
      }
    }

    const instance = new EmailProcessor()
    const mockWorker: MockWorker = { on: jest.fn() }
    const workers = mockRegistry(mockWorker)
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()

    const onCalls = mockWorker.on.mock.calls
    const completedListener = onCalls.find(([ev]) => ev === 'completed')?.[1]
    expect(completedListener).toBeDefined()

    // Pass a rich Job object with job.data — the listener must receive it intact.
    const fullJob = {
      id: 'job-1',
      name: 'send',
      data: { recipient: 'user@example.com', subject: 'Hello' },
      returnvalue: 'sent',
      attemptsMade: 1,
    } as unknown as Job

    completedListener?.(fullJob, 'sent', 'active')

    expect(receivedJobs).toHaveLength(1)
    // Identity check: the exact fullJob reference was received, proving no copy or serialization occurred.
    expect(receivedJobs[0]).toBe(fullJob)
  })
})

describe('ProcessorDiscoveryService — method-not-function guard (coverage of skip branches)', () => {
  it('skips @OnWorkerEvent entries whose method key resolves to a non-function', () => {
    // If the instance property for a registered listener key is not callable, skip it silently.
    // Metadata is injected manually so no method decorator is applied to a non-function property.
    @Processor('email', { concurrency: 2 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }

      // notAFunction is a non-callable property; metadata for it is written manually below.
      notAFunction = 'not-callable'
    }

    // Inject listener metadata pointing to the non-function property to exercise the skip guard.
    Reflect.defineMetadata(
      WORKER_EVENT_LISTENERS_METADATA_KEY,
      [{ eventName: 'completed', methodKey: 'notAFunction' }],
      EmailProcessor,
    )

    const instance = new EmailProcessor()
    const mockWorker: MockWorker = { on: jest.fn() }
    const workers = mockRegistry(mockWorker)
    const eventsReg = mockEventsRegistry({ on: jest.fn() })
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    // on() must NOT be called because the property is not a function.
    expect(mockWorker.on).not.toHaveBeenCalled()
  })

  it('skips @OnQueueEvent entries whose method key resolves to a non-function', () => {
    // Same guard applies to QueueEvent listeners — non-callable properties are skipped silently.
    @Processor('email', { concurrency: 2 })
    class EmailProcessor {
      @Process()
      handle(_job: Job): Promise<void> {
        return Promise.resolve()
      }

      // notAFunction is a non-callable property; metadata for it is written manually below.
      notAFunction = 42
    }

    // Inject listener metadata pointing to the non-function property to exercise the skip guard.
    Reflect.defineMetadata(
      QUEUE_EVENT_LISTENERS_METADATA_KEY,
      [{ eventName: 'completed', methodKey: 'notAFunction' }],
      EmailProcessor,
    )

    const instance = new EmailProcessor()
    const mockQe: MockQueueEvents = { on: jest.fn() }
    const workers = mockRegistry({ on: jest.fn() })
    const eventsReg = mockEventsRegistry(mockQe)
    const svc = new ProcessorDiscoveryService(
      mockDiscovery([makeWrapper(instance)]),
      workers,
      eventsReg,
    )
    svc.onModuleInit()
    // getOrCreate was called (queue has QueueEvent metadata) but on() was skipped.
    expect(eventsReg.getOrCreate).toHaveBeenCalledWith('email')
    expect(mockQe.on).not.toHaveBeenCalled()
  })
})

describe('ProcessorDiscoveryService — PROCESSOR_METADATA_KEY written on constructor', () => {
  it('reads metadata from instance.constructor (not from instance directly)', () => {
    // Decorators write metadata on the class (constructor), not the instance.
    @Processor('verify', { concurrency: 2 })
    class VerifyProcessor {}

    const instance = new VerifyProcessor()
    const meta = Reflect.getMetadata(
      PROCESSOR_METADATA_KEY,
      (instance as { constructor: object }).constructor,
    ) as ProcessorMetadata | undefined
    expect(meta).toBeDefined()
    expect(meta?.queueName).toBe('verify')
  })
})
