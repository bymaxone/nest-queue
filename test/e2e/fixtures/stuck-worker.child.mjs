// A host that closes the application while a handler that never settles is running, then does
// nothing else: only what the library itself left behind can keep this process alive.
import 'reflect-metadata'
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
      shutdown: { drainTimeoutMs: 1000 },
    }),
  ],
})(Host)

try {
  const app = await NestFactory.createApplicationContext(Host, { logger: ['error', 'warn'] })
  let active = false
  app.get(WorkerRegistry).register({
    queueName: 'stuck',
    handler: () =>
      new Promise(() => {
        active = true
      }),
    options: { lockDuration: 2000 },
  })
  await app.get(QueueService).enqueue('stuck', 'job', {})
  for (let i = 0; i < 100 && !active; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  await app.close()
  console.log('CLOSED')
} catch (error) {
  console.error('CHILD ERROR', error)
  process.exit(1)
}
