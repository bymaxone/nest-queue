/**
 * @fileoverview Runs one attempt of a job inside the observers' process span and tells them how it
 * ended and how long it took. The result and the error of the processor pass through untouched.
 * @layer server/observability
 */

import type { Job } from 'bullmq'
import { assertPrototypeClean } from '../connection/prototype-guard'
import { optionsOf, reportFailedMove } from './job-outcome'
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
 * @remarks A completed attempt is reported here, and a failed one once BullMQ has moved the job.
 * A prototype left polluted by the trace hooks is refused before `jobFinished` runs, so no observer is told the
 * attempt completed. A `jobFinished` hook that pollutes it fails the attempt after the observers were told `completed`.
 */
export async function observeAttempt<TResult>(
  registry: QueueObserverRegistry,
  queue: string,
  job: Job,
  run: () => Promise<TResult>,
): Promise<TResult> {
  const started = performance.now()
  const seconds = (): number => (performance.now() - started) / 1000
  let result: TResult
  try {
    result = await registry.traceProcess(
      { queue, job: job.name },
      readTraceMetadata(optionsOf(job)?.telemetry?.metadata),
      run,
    )
  } catch (error) {
    const durationSeconds = seconds()
    reportFailedMove(job, (outcome) => {
      registry.jobFinished({ queue, outcome, durationSeconds })
    })
    throw error
  }
  // The await above and the hooks run the host's code; the guard runs before each hook and the return
  // reads whatever a hook planted.
  assertPrototypeClean()
  registry.jobFinished({ queue, outcome: 'completed', durationSeconds: seconds() })
  assertPrototypeClean()
  return result
}
