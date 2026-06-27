/**
 * @fileoverview Boots a disposable Redis container for the E2E suite via
 * Testcontainers. The image is pinned by digest for a reproducible, trusted
 * supply chain. Exposes the connection URL and a stop handle.
 * @layer test/e2e/setup
 */

import { GenericContainer, type StartedTestContainer } from 'testcontainers'

/** A started Redis container together with its connection URL and stop handle. */
export interface RedisContainer {
  /** The started Testcontainers handle. */
  container: StartedTestContainer
  /** The `redis://host:port` URL for the mapped port. */
  url: string
  /** Stop and remove the container. */
  stop: () => Promise<void>
}

/** Pinned, trusted Redis image (the digest of the official `redis:7-alpine`). */
const REDIS_IMAGE =
  'redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'

/** Default Redis port inside the container. */
const REDIS_PORT = 6379

/**
 * Start a Redis container and resolve its connection details.
 *
 * @returns The started container, its URL, and a stop handle.
 */
export async function startRedisContainer(): Promise<RedisContainer> {
  const container = await new GenericContainer(REDIS_IMAGE).withExposedPorts(REDIS_PORT).start()
  const url = `redis://${container.getHost()}:${String(container.getMappedPort(REDIS_PORT))}`
  return {
    container,
    url,
    stop: async () => {
      await container.stop()
    },
  }
}
