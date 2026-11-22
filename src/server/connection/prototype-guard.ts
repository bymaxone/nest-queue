/**
 * @fileoverview The refusal of a polluted `Object.prototype`. BullMQ and ioredis build ordinary
 * objects of their own and read names off them that the library never set, so a key planted on
 * `Object.prototype` is found there as if it were an option: a planted `path` or `ca` redirects or
 * reconfigures the connection, and no list of names can be complete. The guard refuses while the
 * realm's `Object.prototype` holds anything beyond what the language gives it.
 * @layer server/connection
 */

import { types } from 'node:util'
import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'

/**
 * The string keys `Object.prototype` holds in every Node version the library supports. Anything else
 * is a key another part of the process planted there.
 */
export const STANDARD_KEYS: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
])

/** `Object.hasOwn` as it was when this module loaded. */
const hasOwn = Object.hasOwn

/** The six fields of a property descriptor, each present (`undefined` when the descriptor lacks it). */
interface DescriptorFields {
  readonly value: unknown
  readonly get: unknown
  readonly set: unknown
  readonly writable: unknown
  readonly enumerable: unknown
  readonly configurable: unknown
}

/**
 * Copy the fields a descriptor holds of its own into an object with no prototype. A descriptor is an
 * ordinary object, so reading `get`, `set` or `value` off a data descriptor would find, and run, an
 * accessor planted on `Object.prototype` under that name.
 */
function fieldsOf(descriptor: PropertyDescriptor | undefined): DescriptorFields | undefined {
  if (descriptor === undefined) return undefined
  const fields = Object.create(null) as Record<string, unknown>
  for (const field of ['value', 'get', 'set', 'writable', 'enumerable', 'configurable']) {
    fields[field] = hasOwn(descriptor, field)
      ? (descriptor as unknown as Record<string, unknown>)[field]
      : undefined
  }
  return fields as unknown as DescriptorFields
}

/** The descriptors of the standard keys as they were when this module loaded. */
const STANDARD_DESCRIPTORS: ReadonlyMap<string, DescriptorFields | undefined> = new Map(
  [...STANDARD_KEYS].map((name) => [
    name,
    fieldsOf(Object.getOwnPropertyDescriptor(Object.prototype, name)),
  ]),
)

/** `Function.prototype.toString` as it was when this module loaded. */
const fnToString = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')?.value as (
  this: unknown,
) => string

/** Whether `value` is a function the engine implements: not written in JavaScript, not a proxy. */
function isNative(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    !types.isProxy(value) &&
    /\{\s*\[native code\]\s*\}\s*$/.test(Reflect.apply<unknown, [], string>(fnToString, value, []))
  )
}

/**
 * Whether what a standard key holds is what the language gives it: a native function with the key's
 * own name (`constructor` holds `Object`), and for `__proto__` a native getter and setter.
 */
function hasExpectedKind(name: string, descriptor: DescriptorFields | undefined): boolean {
  if (descriptor === undefined) return false
  if (name === '__proto__') return isNative(descriptor.get) && isNative(descriptor.set)
  const expectedName = name === 'constructor' ? 'Object' : name
  return isNative(descriptor.value) && (descriptor.value as { name: string }).name === expectedName
}

/** The standard keys that were not what the language gives them when this module loaded. */
const BASELINE_DEFECTS: ReadonlySet<string> = new Set(
  [...STANDARD_KEYS].filter((name) => !hasExpectedKind(name, STANDARD_DESCRIPTORS.get(name))),
)

/** Whether a standard key is not what it was when this module loaded. */
function isOverwritten(name: string): boolean {
  const was = STANDARD_DESCRIPTORS.get(name)
  const now = fieldsOf(Object.getOwnPropertyDescriptor(Object.prototype, name))
  if (was === undefined || now === undefined) return was !== now
  return (
    !Object.is(was.value, now.value) ||
    was.get !== now.get ||
    was.set !== now.set ||
    was.writable !== now.writable ||
    was.enumerable !== now.enumerable ||
    was.configurable !== now.configurable
  )
}

/**
 * Refuse while `Object.prototype` holds a string key it does not hold by default, or a standard key that
 * is not what the language gives it or not what it was when this module loaded. A symbol key is not a
 * name the libraries read. It does not cover `Array.prototype`, `Function.prototype` or the prototype
 * of `Buffer`, and a key planted after the last check is still read by the objects built later.
 *
 * @throws {QueueException} `INVALID_OPTIONS` with the count of the keys, never a key or a value.
 */
export function assertPrototypeClean(): void {
  const added = Object.getOwnPropertyNames(Object.prototype).filter(
    (name) => !STANDARD_KEYS.has(name),
  )
  const replaced = [...STANDARD_KEYS].filter(
    (name) => BASELINE_DEFECTS.has(name) || isOverwritten(name),
  )
  const count = added.length + replaced.length
  if (count > 0) {
    throw new QueueException(QUEUE_ERROR_CODES.INVALID_OPTIONS, HttpStatus.INTERNAL_SERVER_ERROR, {
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count,
    })
  }
}
