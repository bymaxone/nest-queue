/**
 * @fileoverview Runs the README Quick Start flow as written: the module options,
 * the enqueue call, and the `@Processor` / `@Process` handler, through a real
 * Nest application context. BullMQ and ioredis are replaced by in-memory
 * doubles, so what executes for real is the library's own option validation,
 * DI wiring, decorator discovery and argument shapes.
 *
 * Guards the README "Quick Start" section. The snippets below are copies of the
 * README's, apart from the handler body, which the README leaves to the reader and which here
 * records the user id it received; when the Quick Start changes, this test changes with it.
 * @layer test
 */

import 'reflect-metadata'
import { EventEmitter } from 'node:events'
import { NestFactory } from '@nestjs/core'
import { Injectable, Module } from '@nestjs/common'
import type { INestApplicationContext } from '@nestjs/common'
import { BymaxQueueModule, Process, Processor, QueueService } from './server'
import type { Job } from './server'

/** A job as the Queue double stores it. */
interface AddedJob {
  readonly id: string
  readonly queueName: string
  readonly name: string
  readonly data: unknown
}

const added: AddedJob[] = []
/** What the README handler received, in order. */
const received: string[] = []
/** The processor function each Worker double was constructed with, by queue name. */
const processors = new Map<string, (job: unknown) => Promise<unknown>>()

jest.mock('ioredis', () => {
  class FakeRedis extends EventEmitter {
    readonly status = 'ready'
    duplicate(): FakeRedis {
      return new FakeRedis()
    }
    quit(): Promise<string> {
      return Promise.resolve('OK')
    }
    disconnect(): void {}
  }
  return { Redis: FakeRedis }
})

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((queueName: string) =>
    Object.assign(new EventEmitter(), {
      add: (name: string, data: unknown) => {
        const job = { id: String(added.length + 1), queueName, name, data }
        added.push(job)
        return Promise.resolve(job)
      },
      close: () => Promise.resolve(),
    }),
  ),
  Worker: jest
    .fn()
    .mockImplementation((queueName: string, processor: (job: unknown) => Promise<unknown>) => {
      processors.set(queueName, processor)
      return Object.assign(new EventEmitter(), { close: () => Promise.resolve() })
    }),
}))

// --- README: "Wire the module in your root AppModule" ---
@Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
      isGlobal: true,
    }),
  ],
})
class AppModule {}

// --- README: "Enqueue a job from any service" ---
@Injectable()
class EmailService {
  constructor(private readonly queue: QueueService) {}

  async sendWelcome(userId: string): Promise<void> {
    await this.queue.enqueue<{ userId: string }, void>('email', 'welcome', { userId })
  }
}

// The unit suite compiles without `emitDecoratorMetadata`, which a NestJS application has on.
// This is the entry that compiler writes for the constructor above, so the class resolves its
// `QueueService` the way it does in a consumer's build.
Reflect.defineMetadata('design:paramtypes', [QueueService], EmailService)

// --- README: "Process jobs with a decorated handler" ---
@Injectable()
@Processor('email')
class EmailProcessor {
  @Process('welcome')
  async handleWelcome(job: Job<{ userId: string }, void>): Promise<void> {
    // handle job.data.userId
    received.push(job.data.userId)
  }
}

// --- README: "Register the processor in your module alongside BymaxQueueModule" ---
@Module({
  providers: [EmailProcessor, EmailService],
})
class EmailModule {}

@Module({ imports: [AppModule, EmailModule] })
class RootModule {}

describe('README Quick Start', () => {
  let app: INestApplicationContext

  beforeEach(async () => {
    added.length = 0
    processors.clear()
    received.length = 0
    app = await NestFactory.createApplicationContext(RootModule, { logger: false })
    await app.init()
  })

  afterEach(async () => {
    await app.close()
  })

  it('enqueues a welcome job and delivers it to the decorated handler', async () => {
    // The README's stated flow: a service enqueues ('email', 'welcome', { userId }) and the
    // @Process('welcome') method of the @Processor('email') class receives that job.
    await app.get(EmailService).sendWelcome('user-1')

    expect(added).toEqual([
      { id: '1', queueName: 'email', name: 'welcome', data: { userId: 'user-1' } },
    ])
    const process = processors.get('email')
    expect(process).toBeDefined()

    // The worker is handed the job the queue stored for this enqueue, not a job built here.
    await process?.(added[0])

    expect(received).toEqual(['user-1'])
  })
})
