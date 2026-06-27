/**
 * @fileoverview Application bootstrap — creates and starts the NestJS app.
 * Requires a running Redis instance (default: redis://127.0.0.1:6379 or REDIS_URL).
 * @layer infrastructure
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { AppModule } from './app.module.js'

const logger = new Logger('Bootstrap')

/**
 * Bootstrap the NestJS application on the Fastify adapter.
 * Listens on PORT (default 3000).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())
  // Enable shutdown hooks so the library's bounded graceful shutdown drains and
  // closes its connections on SIGTERM/SIGINT.
  app.enableShutdownHooks()
  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000
  await app.listen(port, '0.0.0.0')
  logger.log(`Application listening on http://localhost:${port}`)
}

void bootstrap()
