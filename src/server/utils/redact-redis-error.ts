/**
 * @fileoverview What the library passes on of an error Redis answered a command with: the reply's
 * code under a fixed message, and nothing else of the reply or the command.
 * @layer server/utils
 */

/** The message of a replacement, other than for the errors of {@link WRAPPERS}. */
export const REDIS_FAILURE_MESSAGE =
  'A Redis command failed; the reply text and the command are not kept'

/** A reply code: the upper-case word a Redis reply begins with, such as `NOPERM` or `WRONGPASS`. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,31}(?= |$)/

/**
 * The plain errors ioredis and BullMQ build out of another error's message: how each opens, what
 * precedes the copied text, and the message of its replacement. `coded` says whether the copied text
 * is an error's, so that its first word may be read as a reply code.
 */
const WRAPPERS = [
  {
    opening: 'All sentinels are unreachable',
    marker: ' Last error: ',
    message: 'All sentinels are unreachable; the text of the last error is not kept',
    coded: true,
  },
  // Before the error form: a data reply is copied whole and may hold the other marker.
  {
    opening: 'Command queue state error',
    marker: ' Last reply: ',
    message: 'Command queue state error; the text of the last reply is not kept',
    coded: false,
  },
  {
    opening: 'Command queue state error',
    marker: ' Last error: ',
    message: 'Command queue state error; the text of the last reply is not kept',
    coded: true,
  },
  {
    opening: 'Failed to add repeatable job for next iteration: ',
    marker: 'iteration: ',
    message: 'A job scheduler iteration was not added; the text of the cause is not kept',
    coded: true,
  },
] as const

/** How many errors of a chain are looked at; a longer one is replaced without being read further. */
const MAX_LINKS = 16

/** One replacement for each error replaced, so that two reports of it are the same value. */
const replacements = new WeakMap<object, Error>()

/** The reply code `text` begins with, if it is text and begins with one. */
function leadingCode(text: unknown): string | undefined {
  return typeof text === 'string' ? CODE_SHAPE.exec(text)?.[0] : undefined
}

/** The code `value` carries, from its `code` or the first word of its message, if it has that shape. */
function codeOf(value: unknown): string | undefined {
  try {
    const { code, message } = value as { code?: unknown; message?: unknown }
    return leadingCode(code) ?? leadingCode(message)
  } catch {
    // A member that throws is read as no code.
    return undefined
  }
}

/** What replaces `value` when it is one of {@link WRAPPERS}: its message and the copied code. */
function wrapperOf(value: unknown): { message: string; code: string | undefined } | undefined {
  try {
    const { message: text } = value as { message?: unknown }
    if (typeof text !== 'string') return undefined
    for (const { opening, marker, message, coded } of WRAPPERS) {
      const at = text.startsWith(opening) ? text.indexOf(marker) : -1
      if (at < 0) continue
      return { message, code: coded ? leadingCode(text.slice(at + marker.length)) : undefined }
    }
  } catch {
    // A value or a message that cannot be read is no wrapper.
  }
  return undefined
}

/**
 * The error that stands for `reply`: a fixed message, the name `RedisCommandError`, and the reply
 * code as `code` when there is one to read. Nothing else of `reply` is kept, its `cause` included.
 *
 * @param reply - The error being replaced.
 * @returns The same replacement each time the same object is given.
 * @example
 * redisFailure(new Error('NOPERM no permission')) // code: 'NOPERM'
 */
export function redisFailure(reply: unknown): Error {
  const key = typeof reply === 'object' && reply !== null ? reply : undefined
  const known = key === undefined ? undefined : replacements.get(key)
  if (known !== undefined) return known
  const wrapper = wrapperOf(reply)
  const failure = new Error(wrapper?.message ?? REDIS_FAILURE_MESSAGE)
  failure.name = 'RedisCommandError'
  const code = wrapper === undefined ? codeOf(reply) : wrapper.code
  if (code !== undefined) Object.assign(failure, { code })
  if (key !== undefined) replacements.set(key, failure)
  return failure
}

/** Whether `link` is named as Redis replies are; a name that cannot be read names nothing. */
function isNamedReply(link: object): boolean {
  try {
    return (link as { name?: unknown }).name === 'ReplyError'
  } catch {
    return false
  }
}

/**
 * Whether `link` is itself what ioredis rejected a command with: it carries the command as
 * `{ name, args }`, or the errors of an aborted transaction, or is a reply by name.
 */
function isReply(link: object): boolean {
  const { command } = link as { command?: { args?: unknown } | null }
  return Array.isArray(command?.args) || 'previousErrors' in link || isNamedReply(link)
}

/** Whether a reply or a copy of one is `root`, or sits in its `cause` or `errors` chain. */
function holdsReply(root: unknown): boolean {
  const links: unknown[] = [root]
  for (let index = 0; index < links.length; index += 1) {
    if (index === MAX_LINKS) return true
    const link = links[index]
    if (typeof link !== 'object' || link === null) continue
    if (isReply(link) || wrapperOf(link) !== undefined) return true
    const { cause, errors, lastNodeError } = link as {
      cause?: unknown
      errors?: unknown
      lastNodeError?: unknown
    }
    if (cause !== undefined) links.push(cause)
    if (lastNodeError !== undefined && lastNodeError !== null) links.push(lastNodeError)
    if (Array.isArray(errors)) links.push(...(errors as unknown[]))
  }
  return false
}

/**
 * What may leave the library of an error: a log line, the `cause` of a library error, the rejection
 * of a call, the rejection an observer sees. An error that is, or wraps, a Redis reply, an error
 * carrying a command or one of {@link WRAPPERS} is replaced by {@link redisFailure}; any other value
 * (a refused connection, a timeout, the host's own error) is returned as it is. A value that cannot
 * be read is replaced.
 *
 * @param err - What was thrown, rejected or emitted.
 * @returns `err` itself, or its replacement.
 * @example
 * throw redactRedisError(err)
 */
export function redactRedisError(err: unknown): unknown {
  try {
    return holdsReply(err) ? redisFailure(err) : err
  } catch {
    return redisFailure(err)
  }
}
