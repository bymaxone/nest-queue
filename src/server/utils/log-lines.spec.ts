/**
 * @fileoverview Unit tests for the helper that reads a spied logger back as events: it returns the
 * event objects and refuses a line that is plain text, so a spec cannot pass on a string.
 * @layer server/utils
 */

import { loggedEvents, loggedMessages, loggedText } from './log-lines'

describe('log-lines', () => {
  const event = { event: 'QUEUE_CLIENT_ERROR', message: 'text', role: 'owned' }

  it('returns the events of a spy, their messages, and the whole calls as text', () => {
    const spy = { mock: { calls: [[event], [{ ...event, message: 'again' }]] } }

    expect(loggedEvents(spy)).toEqual([event, { ...event, message: 'again' }])
    expect(loggedMessages(spy)).toEqual(['text', 'again'])
    expect(loggedText(spy)).toContain('"role":"owned"')
  })

  it.each([
    ['a string', 'plain text'],
    ['null', null],
    ['an object without an event', { message: 'text' }],
    ['an object without a message', { event: 'QUEUE_CLIENT_ERROR' }],
    ['an event that is not a string', { event: 1, message: 'text' }],
    ['a message that is not a string', { event: 'QUEUE_CLIENT_ERROR', message: 1 }],
  ])('refuses %s', (_label, first) => {
    expect(() => loggedEvents({ mock: { calls: [[first]] } })).toThrow('not an event')
  })
})
