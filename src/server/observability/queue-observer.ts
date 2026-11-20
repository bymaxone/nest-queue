/**
 * @fileoverview The seam between the queue and what watches it. The main entry imports no metrics or
 * tracing library: an observer, registered here, wraps the enqueue of a job and its processing, and
 * hears how each attempt ended. The optional `observability` subpath ships one that feeds Prometheus
 * and OpenTelemetry; a host may register its own.
 * @layer server/observability
 */

import { Injectable, Logger } from '@nestjs/common'
import { logEvent, QUEUE_LOG_EVENTS, writeLog } from '../utils/log-event'

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
 * Watches the queue. Every hook is optional. A hook runs on the path of a job and must not break it:
 * one that throws or rejects is ignored and logged as `QUEUE_OBSERVER_FAILED`, and the job, the enqueue
 * and the error of the processor are not affected.
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
  /**
   * Hear how an attempt ended. The event is a frozen copy made for this observer. A promise the hook
   * returns is not awaited: its rejection is logged, and nothing waits for it to settle.
   */
  jobFinished?(event: JobFinishedEvent): void
}

/**
 * Holds the observers of one module and runs them around the queue's operations. With none
 * registered every method runs the operation and nothing else.
 */
@Injectable()
export class QueueObserverRegistry {
  readonly #observers: QueueObserver[] = []
  private readonly logger = new Logger(QueueObserverRegistry.name)

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
      (next, observer) => () => {
        const hook = observer.traceEnqueue?.bind(observer)
        return hook === undefined
          ? next()
          : this.#guarded('traceEnqueue', (once) => hook<T>(info, carrier, once), next)
      },
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
      (next, observer) => () => {
        const hook = observer.traceProcess?.bind(observer)
        return hook === undefined
          ? next()
          : this.#guarded('traceProcess', (once) => hook<T>(info, carrier, once), next)
      },
      run,
    )()
  }

  /**
   * Tell every observer how an attempt ended. An observer that throws, or returns a promise that
   * rejects, is ignored and the failure is logged as `QUEUE_OBSERVER_FAILED`, since the job has
   * already finished and its result must not change. Each observer gets a frozen copy of the event.
   *
   * @param event - The outcome of the attempt.
   */
  jobFinished(event: JobFinishedEvent): void {
    for (const observer of [...this.#observers]) {
      try {
        const returned: unknown = observer.jobFinished?.(Object.freeze({ ...event }))
        // A hook typed to return nothing can still be an `async` function, and its rejection would
        // reach no one: the registry does not await it, so it is caught here.
        Promise.resolve(returned).catch(() => {
          this.#failed('jobFinished')
        })
      } catch {
        this.#failed('jobFinished')
      }
    }
  }

  /**
   * Run one observer's trace hook so that a failure of the observer never fails the operation. The
   * operation runs once however the observer behaves: when the hook throws or rejects without calling
   * `once`, or returns without calling it, the operation runs afterwards in its place. What the
   * operation itself rejects with reaches the caller untouched, and an observer that fails is logged.
   * The operation's promise always has a handler here, so an observer that starts it and does not
   * await it can never leave an unhandled rejection that ends the process, and its rejection reaches
   * the caller even when the observer returned a result of its own.
   *
   * @param hook - The hook, for the log line.
   * @param call - Calls the observer's hook with `once` as the operation.
   * @param next - The rest of the chain, ending in the operation.
   */
  async #guarded<T>(
    hook: 'traceEnqueue' | 'traceProcess',
    call: (once: () => Promise<T>) => Promise<T> | undefined,
    next: () => Promise<T>,
  ): Promise<T> {
    let started: Promise<T> | undefined
    // The promise constructor turns a synchronous throw of the operation into the rejection stored
    // here, so `started` is set once the operation has been called, however it fails.
    const once = (): Promise<T> => {
      if (started === undefined) {
        started = new Promise<T>((resolve) => {
          resolve(next())
        })
        started.catch(() => undefined)
      }
      return started
    }
    let traced: T | undefined
    let failure: { readonly error: unknown } | undefined
    try {
      traced = await call(once)
    } catch (error) {
      failure = { error }
    }
    if (failure === undefined && started !== undefined) {
      // The observer ran the operation and did not fail, so what it returns is the result. The
      // operation is waited for first: its rejection reaches the caller whatever the observer did
      // with it, since a job whose processor failed must not be reported as done.
      const outcome = await started
      // A hook that awaited the operation and resolved with nothing (`undefined`, written in
      // JavaScript or cast) has not replaced the result, so the result of the operation is what the
      // caller gets. `null` is a value and stays.
      if (traced === undefined) return outcome
      return traced
    }
    // The observer failed, or returned without running the operation. The operation's own outcome decides.
    try {
      const outcome = await once()
      this.#failed(hook)
      return outcome
    } catch (error) {
      // An observer that rethrew the error of the operation is only passing it on.
      if (failure?.error !== error) this.#failed(hook)
      throw error
    }
  }

  #failed(hook: string): void {
    // An observer is not allowed to fail a job. What it threw is not logged: it is the observer's
    // own value, and an event carries closed values only.
    writeLog(
      this.logger,
      'warn',
      logEvent(
        QUEUE_LOG_EVENTS.OBSERVER_FAILED,
        `A queue observer threw from ${hook}; it is ignored and the job is not affected`,
        { hook },
      ),
    )
  }
}
