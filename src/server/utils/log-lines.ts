/**
 * @fileoverview What a spec reads back from a spied Nest `Logger`: the object events the library
 * logs, never the text of a string. A line that is not an event object fails the read, so a spec
 * cannot pass by looking for text in a message the library no longer writes that way, and a negative
 * check runs against the whole object, fields included.
 * @layer server/utils
 */

import type { QueueLogMessage } from './log-event'

/** A spied logger method: only the calls are read. */
interface LoggerSpy {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] }
}

/**
 * The events a spied logger method was called with, in order.
 *
 * @param spy - A `jest.spyOn(logger, 'warn' | 'error' | 'log')` spy.
 * @throws When a call's first argument is not an object with a string `event` and `message`.
 */
export function loggedEvents(spy: LoggerSpy): QueueLogMessage[] {
  return spy.mock.calls.map((call) => {
    const first = call[0]
    const { event, message } = (first ?? {}) as { event?: unknown; message?: unknown }
    if (typeof event !== 'string' || typeof message !== 'string') {
      throw new Error(`the logger was called with something that is not an event: ${String(first)}`)
    }
    return first as QueueLogMessage
  })
}

/** The `message` of each event a spied logger method was called with. */
export function loggedMessages(spy: LoggerSpy): string[] {
  return loggedEvents(spy).map((event) => event.message)
}

/** Every call of a spied logger method, serialised whole, so a negative check covers each field. */
export function loggedText(spy: LoggerSpy): string {
  return JSON.stringify(spy.mock.calls)
}
