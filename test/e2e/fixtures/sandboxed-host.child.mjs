/**
 * @fileoverview A host that closes the application while a sandboxed job is running, then does
 * nothing else: only what the library and BullMQ left behind can keep this process alive. It prints
 * CLOSING just before `app.close()` and CLOSED when it returns.
 * @layer test/e2e/fixtures
 */
import 'reflect-metadata'
import { fileURLToPath } from 'node:url'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
// The build under test; a run can point this at another build of the package.
const { BymaxQueueModule, QueueService, WorkerRegistry } = await import(
  process.env.NEST_QUEUE_ENTRY ?? '../../../dist/server/index.mjs'
)

/** The host module: a constructor function, which Nest decorates like a class. */
const Host = Object.assign(function Host() {
  return undefined
}, {})
Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: process.env.REDIS_URL },
      shutdown: { drainTimeoutMs: Number(process.env.DRAIN_TIMEOUT_MS ?? 1000) },
    }),
  ],
})(Host)

const queueName = process.env.QUEUE_NAME

try {
  const app = await NestFactory.createApplicationContext(Host, { logger: ['error', 'warn'] })
  const worker = app.get(WorkerRegistry).registerSandboxed({
    queueName,
    processorFile: fileURLToPath(
      new URL('./processors/sandboxed-timer.processor.cjs', import.meta.url),
    ),
    options: {
      lockDuration: 2000,
      stalledInterval: 1000,
      useWorkerThreads: process.env.USE_THREADS === 'true',
    },
  })
  const active = new Promise((resolve) => worker.once('active', resolve))
  await app
    .get(QueueService)
    .enqueue(
      queueName,
      'job',
      { ms: Number(process.env.JOB_MS), progressMs: Number(process.env.PROGRESS_MS ?? 0) },
      { jobId: 'only' },
    )
  await active
  // The job is active before the child has it: give the processor time to start.
  await new Promise((resolve) => setTimeout(resolve, 500))
  console.log('CLOSING')
  await app.close()
  console.log('CLOSED')
} catch (error) {
  console.error('CHILD ERROR', error)
  process.exit(1)
}
