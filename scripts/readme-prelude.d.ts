/**
 * @fileoverview The names a README snippet uses without declaring them, typed against the
 * published package. `readme-snippets.mjs` copies this file into the throwaway consumer it
 * compiles the snippets in, so a call made through one of these names is checked against the
 * real types instead of resolving to `any`.
 * @layer scripts
 *
 * Only names the surrounding prose introduces belong here. A wrong option, method or field
 * on a package type is a real error and must stay one.
 */
import type {
  FlowService,
  MetricsService,
  QueueService,
  WorkerRegistry,
} from '@bymax-one/nest-queue'

declare global {
  /** What `this` holds in a snippet that shows service calls without a class around them. */
  interface SnippetContext {
    queue: QueueService
    flows: FlowService
    metricsService: MetricsService
  }

  /** The base of the class a decorated-method fragment is placed in. */
  const SnippetBase: new () => SnippetContext

  const queue: QueueService
  const registry: WorkerRegistry
  const userId: string

  /** The payload type the handler example names. */
  interface EmailPayload {
    to: string
  }
}
