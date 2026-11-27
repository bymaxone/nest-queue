/**
 * @fileoverview What the library passes on of an error Redis answered a command with: the reply's
 * code under a fixed message, and nothing else of the reply or the command.
 * @layer server/utils
 */

/** The only text a replaced error carries. */
export const REDIS_FAILURE_MESSAGE =
  'A Redis command failed; the reply text and the command are not kept'

/** A reply code: the upper-case word a Redis reply begins with, such as `NOPERM` or `WRONGPASS`. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,31}(?= |$)/

/** How many errors of a chain are looked at; a longer one is replaced without being read further. */
const MAX_LINKS = 16

/** One replacement for each error replaced, so that two reports of it are the same value. */
const replacements = new WeakMap<object, Error>()

/** The code `value` carries, from its `code` or the first word of its message, if it has that shape. */
function codeOf(value: unknown): string | undefined {
  try {
    const { code, message } = value as { code?: unknown; message?: unknown }
    for (const candidate of [code, message]) {
      const found = typeof candidate === 'string' ? CODE_SHAPE.exec(candidate) : null
      if (found !== null) return found[0]
    }
  } catch {
    // A member that throws is read as no code.
  }
  return undefined
}

/**
 * The error that stands for `reply`: the fixed message, the name `RedisCommandError`, and the reply
 * code as `code` when the reply has one. Nothing else of `reply` is kept, its `cause` included.
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
  const failure = new Error(REDIS_FAILURE_MESSAGE)
  failure.name = 'RedisCommandError'
  const code = codeOf(reply)
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

/** Whether a reply is `root`, or sits in its `cause` or `errors` chain. */
function holdsReply(root: unknown): boolean {
  const links: unknown[] = [root]
  for (let index = 0; index < links.length; index += 1) {
    if (index === MAX_LINKS) return true
    const link = links[index]
    if (typeof link !== 'object' || link === null) continue
    if (isReply(link)) return true
    const { cause, errors } = link as { cause?: unknown; errors?: unknown }
    if (cause !== undefined) links.push(cause)
    if (Array.isArray(errors)) links.push(...(errors as unknown[]))
  }
  return false
}

/**
 * What may leave the library of an error: a log line, the `cause` of a library error, the rejection
 * of a call, the rejection an observer sees. An error that is, or wraps, a Redis reply or a command
 * ioredis gave up on is replaced by {@link redisFailure}; any other value (a refused connection, a
 * timeout, the host's own error) is returned as it is. A value that cannot be read is replaced.
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
