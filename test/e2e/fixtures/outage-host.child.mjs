/**
 * @fileoverview A host whose Redis starts refusing it around `app.close()`, then does nothing else:
 * only what the library itself left behind can keep this process alive. A loopback proxy in the
 * host stands for the outage and is unref'd, so it holds nothing open on its own. It prints CLOSED
 * when `app.close()` returns.
 * @layer test/e2e/fixtures
 */
import 'reflect-metadata'
import net from 'node:net'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
// The build under test; a run can point this at another build of the package.
const { BymaxQueueModule, QueueService, WorkerRegistry } = await import(
  process.env.NEST_QUEUE_ENTRY ?? '../../../dist/server/index.mjs'
)

const upstream = new URL(process.env.REDIS_URL)
const open = new Set()
let refusing = false
const proxy = net.createServer((socket) => {
  open.add(socket)
  socket.on('error', () => undefined)
  socket.on('close', () => open.delete(socket))
  if (refusing) {
    socket.on('data', () => socket.write('-NOAUTH Authentication required.\r\n'))
    return
  }
  const server = net.connect(Number(upstream.port), upstream.hostname)
  server.on('error', () => socket.destroy())
  server.on('close', () => socket.destroy())
  socket.on('close', () => server.destroy())
  socket.pipe(server).pipe(socket)
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
proxy.unref()
const refuse = () => {
  refusing = true
  for (const socket of open) socket.destroy()
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The host module: a constructor function, which Nest decorates like a class. */
const Host = Object.assign(function Host() {
  return undefined
}, {})
Module({
  imports: [
    BymaxQueueModule.forRoot({
      connection: { url: `redis://127.0.0.1:${String(proxy.address().port)}` },
      shutdown: { drainTimeoutMs: Number(process.env.DRAIN_TIMEOUT_MS) },
    }),
  ],
})(Host)

try {
  const app = await NestFactory.createApplicationContext(Host, { logger: false })
  const jobMs = Number(process.env.JOB_MS ?? 0)
  let active = false
  app.get(WorkerRegistry).register({
    queueName: process.env.QUEUE_NAME,
    handler: async () => {
      active = true
      await sleep(jobMs)
    },
  })
  await sleep(500)
  if (jobMs > 0) {
    await app.get(QueueService).enqueue(process.env.QUEUE_NAME, 'job', {})
    for (let i = 0; i < 100 && !active; i++) await sleep(100)
    // The outage starts while the shutdown is waiting for the running job.
    setTimeout(refuse, 500)
  } else {
    // The outage is already there when the shutdown starts.
    refuse()
    await sleep(1000)
  }
  await app.close()
  console.log('CLOSED')
} catch (error) {
  console.error('CHILD ERROR', error)
}
