/**
 * @fileoverview Application bootstrap — creates and starts the NestJS app.
 * Requires a running Redis instance (default: redis://127.0.0.1:6379 or REDIS_URL).
 * @layer infrastructure
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

/**
 * Bootstrap the NestJS application.
 * Listens on PORT (default 3000).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const port = process.env['PORT'] ? Number(process.env['PORT']) : 3000
  await app.listen(port)
  console.log(`Application listening on http://localhost:${port}`)
}

void bootstrap()
