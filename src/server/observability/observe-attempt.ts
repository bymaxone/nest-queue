/**
 * @fileoverview Runs one attempt of a job inside the observers' process span and tells them how it
 * ended and how long it took. The result and the error of the processor pass through untouched.
 * @layer server/observability
 */

import type { Job } from 'bullmq'
import { failureOutcome } from './job-outcome'
import type { QueueObserverRegistry } from './queue-observer'
import { readTraceMetadata } from './trace-carrier'

/**
 * Observe one attempt of `job`.
 *
 * @param registry - The observers of the module.
 * @param queue - The queue the job is taken from.
 * @param job - The job, as the worker received it.
 * @param run - The processor for this attempt.
 * @returns What `run` returns; a rejection of `run` is rethrown as it is.
 */
export async function observeAttempt<TResult>(
  registry: QueueObserverRegistry,
  queue: string,
  job: Job,
  run: () => Promise<TResult>,
): Promise<TResult> {
  const started = performance.now()
  const seconds = (): number => (performance.now() - started) / 1000
  try {
    const result = await registry.traceProcess(
      { queue, job: job.name },
      readTraceMetadata(job.opts.telemetry?.metadata),
      run,
    )
    registry.jobFinished({ queue, outcome: 'completed', durationSeconds: seconds() })
    return result
  } catch (error) {
    const outcome = failureOutcome(job, error)
    if (outcome !== undefined) registry.jobFinished({ queue, outcome, durationSeconds: seconds() })
    throw error
  }
}
