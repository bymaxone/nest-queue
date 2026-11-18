/**
 * @fileoverview The seam between the queue and what watches it. The main entry imports no metrics or
 * tracing library: an observer, registered here, wraps the enqueue of a job and its processing, and
 * hears how each attempt ended. The optional `observability` subpath ships one that feeds Prometheus
 * and OpenTelemetry; a host may register its own.
 * @layer server/observability
 */

import { Injectable } from '@nestjs/common'

/** How one attempt of a job ended. `retried` means BullMQ will run the job again. */
export type JobOutcome = 'completed' | 'failed' | 'retried'

/** The headers of a W3C trace context, as a propagator writes them (`traceparent`, `tracestate`). */
export type TraceCarrier = Record<string, string>

/** What an observer is told about the operation it wraps. */
export interface QueueObserveInfo {
  /** The queue the job is added to or taken from. */
  readonly queue: string
  /** The job name, absent when one operation adds jobs of several names. */
  readonly job?: string
}

/** How one attempt of a job ended, and how long it ran. */
export interface JobFinishedEvent {
  /** The queue the job ran in. */
  readonly queue: string
  /** How the attempt ended. */
  readonly outcome: JobOutcome
  /** Time the processor ran, in seconds. */
  readonly durationSeconds: number
}

/**
 * Watches the queue. Every hook is optional. A hook must not throw: it runs on the path of a job.
 *
 * @example
 * registry.register({
 *   jobFinished: ({ queue, outcome }) => counter.inc({ queue, outcome }),
 * })
 */
export interface QueueObserver {
  /**
   * Wrap the enqueue of a job. Write the trace context of the span you open into `carrier`; the queue
   * stores it with the job, outside its data, and hands it to {@link QueueObserver.traceProcess}.
   *
   * @param info - The queue and the job name.
   * @param carrier - Where to write the trace headers.
   * @param run - The enqueue itself; call it and return what it returns.
   */
  traceEnqueue?<T>(info: QueueObserveInfo, carrier: TraceCarrier, run: () => Promise<T>): Promise<T>
  /**
   * Wrap the processing of one attempt of a job.
   *
   * @param info - The queue and the job name.
   * @param carrier - The headers stored with the job, empty when it carries none.
   * @param run - The processor; call it and return what it returns.
   */
  traceProcess?<T>(
    info: QueueObserveInfo,
    carrier: Readonly<TraceCarrier>,
    run: () => Promise<T>,
  ): Promise<T>
  /** Hear how an attempt ended. */
  jobFinished?(event: JobFinishedEvent): void
}

/**
 * Holds the observers of one module and runs them around the queue's operations. With none
 * registered every method runs the operation and nothing else.
 */
@Injectable()
export class QueueObserverRegistry {
  readonly #observers: QueueObserver[] = []

  /**
   * Add an observer.
   *
   * @param observer - The observer to add.
   * @returns A function that removes it.
   */
  register(observer: QueueObserver): () => void {
    this.#observers.push(observer)
    return () => {
      const index = this.#observers.indexOf(observer)
      if (index !== -1) this.#observers.splice(index, 1)
    }
  }

  /** Whether any observer is registered. */
  get active(): boolean {
    return this.#observers.length > 0
  }

  /**
   * Run `run` inside the enqueue span of every observer, handing it the trace headers they wrote.
   *
   * @param info - The queue and the job name.
   * @param run - The enqueue; receives the headers, empty when no observer wrote any.
   */
  traceEnqueue<T>(info: QueueObserveInfo, run: (carrier: TraceCarrier) => Promise<T>): Promise<T> {
    const carrier: TraceCarrier = {}
    const inner = (): Promise<T> => run(carrier)
    return this.#observers.reduceRight<() => Promise<T>>(
      (next, observer) => () =>
        observer.traceEnqueue === undefined ? next() : observer.traceEnqueue(info, carrier, next),
      inner,
    )()
  }

  /**
   * Run `run` inside the process span of every observer.
   *
   * @param info - The queue and the job name.
   * @param carrier - The headers stored with the job.
   * @param run - The processor.
   */
  traceProcess<T>(
    info: QueueObserveInfo,
    carrier: Readonly<TraceCarrier>,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.#observers.reduceRight<() => Promise<T>>(
      (next, observer) => () =>
        observer.traceProcess === undefined ? next() : observer.traceProcess(info, carrier, next),
      run,
    )()
  }

  /**
   * Tell every observer how an attempt ended. An observer that throws is ignored, since the job has
   * already finished and its result must not change.
   *
   * @param event - The outcome of the attempt.
   */
  jobFinished(event: JobFinishedEvent): void {
    for (const observer of [...this.#observers]) {
      try {
        observer.jobFinished?.(event)
      } catch {
        // An observer is not allowed to fail a job; what it throws is its own to report.
      }
    }
  }
}
