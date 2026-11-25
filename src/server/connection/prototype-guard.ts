/**
 * @fileoverview The refusal of a polluted `Object.prototype`. BullMQ and ioredis build ordinary
 * objects of their own and read names off them that the library never set, so a key planted on
 * `Object.prototype` (prototype pollution in another dependency) is found there as if it were an
 * option: a planted `path` or `ca` redirects or reconfigures the connection, and no list of names
 * can be complete. The guard refuses while the realm's `Object.prototype` holds anything beyond what
 * the language gives it. It runs on the built-ins as they were when this module loaded and reads
 * nothing through an iterator or a method of an object it did not make, so a built-in replaced
 * afterwards cannot blind it.
 * @layer server/connection
 */

import { runInNewContext } from 'node:vm'
import { types } from 'node:util'
import { HttpStatus } from '@nestjs/common'
import { QUEUE_ERROR_CODES } from '../constants/error-codes'
import { QueueException } from '../errors/queue-exception'
import { at } from '../utils/at'

/** The built-ins the guard runs on, taken when this module loaded. */
const getOwnPropertyNames = Object.getOwnPropertyNames
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const hasOwn = Object.hasOwn
const is = Object.is
const create = Object.create
const getPrototypeOf = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys
const getOwnPropertySymbols = Object.getOwnPropertySymbols
const registered = Symbol.for
const apply = Reflect.apply
const capturedIsEnumerable: unknown = Object.getOwnPropertyDescriptor(
  Object.prototype,
  'propertyIsEnumerable',
)?.value
/** The engine's method, or one that reports every key enumerable when it was removed or replaced before load. */
const isEnumerable: (this: object, key: PropertyKey) => boolean =
  typeof capturedIsEnumerable === 'function'
    ? (capturedIsEnumerable as (this: object, key: PropertyKey) => boolean)
    : () => true
const isProxy = types.isProxy
const objectPrototype = Object.prototype
const min = Math.min
const nativeToString = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')?.value as (
  this: unknown,
) => string
const regExpTest = Object.getOwnPropertyDescriptor(RegExp.prototype, 'test')?.value as (
  this: RegExp,
  text: string,
) => boolean
const NATIVE_CODE = /\{\s*\[native code\]\s*\}\s*$/

/** The standard string keys of `Object.prototype`, in the order the snapshots below use. */
const STANDARD_NAMES: readonly string[] = [
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
]

/**
 * The string keys `Object.prototype` holds in every Node version the library supports. Anything else
 * is a key another part of the process planted there. Exported for the specs; the guard does not read it.
 */
export const STANDARD_KEYS: ReadonlySet<string> = new Set(STANDARD_NAMES)

/** The six fields of a property descriptor, each present (`undefined` when the descriptor lacks it). */
interface DescriptorFields {
  readonly value: unknown
  readonly get: unknown
  readonly set: unknown
  readonly writable: unknown
  readonly enumerable: unknown
  readonly configurable: unknown
}

const FIELD_NAMES = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'] as const

/**
 * Copy the fields a descriptor holds of its own into an object with no prototype. A descriptor is an
 * ordinary object, so reading `get`, `set` or `value` off a data descriptor would find, and run, an
 * accessor planted on `Object.prototype` under that name.
 */
function copyFields(descriptor: PropertyDescriptor): DescriptorFields {
  const fields = create(null) as Record<string, unknown>
  let position = 0
  while (position < FIELD_NAMES.length) {
    const field = at(FIELD_NAMES, position)
    fields[field] = hasOwn(descriptor, field)
      ? (descriptor as unknown as Record<string, unknown>)[field]
      : undefined
    position += 1
  }
  return fields as unknown as DescriptorFields
}

/** The copied fields of a descriptor, or `undefined` when the key is missing. */
function fieldsOf(descriptor: PropertyDescriptor | undefined): DescriptorFields | undefined {
  return descriptor === undefined ? undefined : copyFields(descriptor)
}

/** The descriptor of the standard key at `position`, now. */
function descriptorNow(position: number): DescriptorFields | undefined {
  return fieldsOf(getOwnPropertyDescriptor(objectPrototype, at(STANDARD_NAMES, position)))
}

/** The descriptors of the standard keys as they were when this module loaded. */
const SNAPSHOT: readonly (DescriptorFields | undefined)[] = (() => {
  // Stryker disable next-line ArrayDeclaration: the only mutant on this line seeds the list with one element, and every index from zero is assigned below before the list is read, so the seed is overwritten
  const taken: (DescriptorFields | undefined)[] = []
  let position = 0
  while (position < STANDARD_NAMES.length) {
    taken[position] = descriptorNow(position)
    position += 1
  }
  return taken
})()

/** Whether `value` is a function the engine implements: not written in JavaScript, not a proxy. */
function isNative(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    !isProxy(value) &&
    regExpTest.call(NATIVE_CODE, apply<unknown, [], string>(nativeToString, value, []))
  )
}

/**
 * Whether what a standard key holds is what the language gives it: a native function with the key's
 * own name (`constructor` holds `Object`), and for `__proto__` a native getter and setter, or none.
 */
function hasExpectedKind(name: string, descriptor: DescriptorFields | undefined): boolean {
  // A runtime started with `--disable-proto=delete` has no `__proto__` accessor at all: that is what
  // the language gives it there, and a later appearance of one counts as planted.
  if (name === '__proto__' && descriptor === undefined) return true
  if (descriptor === undefined) return false
  if (name === '__proto__') return isNative(descriptor.get) && isNative(descriptor.set)
  const expectedName = name === 'constructor' ? 'Object' : name
  return isNative(descriptor.value) && (descriptor.value as { name: string }).name === expectedName
}

/** Whether the standard key at each position was not what the language gives it when this module loaded. */
const BASELINE_DEFECT: readonly boolean[] = (() => {
  // Stryker disable next-line ArrayDeclaration: the only mutant on this line seeds the list with one element, and every index from zero is assigned below before the list is read, so the seed is overwritten
  const flags: boolean[] = []
  let position = 0
  while (position < STANDARD_NAMES.length) {
    flags[position] = !hasExpectedKind(at(STANDARD_NAMES, position), SNAPSHOT[position])
    position += 1
  }
  return flags
})()

/** Whether the standard key at `position` is not what it was when this module loaded. */
function isOverwritten(position: number): boolean {
  const was = SNAPSHOT[position]
  const now = descriptorNow(position)
  if (was === undefined || now === undefined) return was !== now
  return (
    !is(was.value, now.value) ||
    was.get !== now.get ||
    was.set !== now.set ||
    was.writable !== now.writable ||
    was.enumerable !== now.enumerable ||
    was.configurable !== now.configurable
  )
}

/**
 * The one symbol key a test runner puts on `Object.prototype` of every test: Jest's own registry key,
 * non-enumerable. It is exempt only while it is exactly this registered symbol and not enumerable.
 */
const TEST_RUNNER_SYMBOL = registered('$$jest-protect-from-deletion')

/** How many symbol keys `Object.prototype` holds beyond the test runner's own, enumerable or not. */
function plantedSymbols(): number {
  const symbols = getOwnPropertySymbols(objectPrototype)
  let count = 0
  let position = 0
  while (position < symbols.length) {
    const symbol = at(symbols, position)
    if (
      symbol !== TEST_RUNNER_SYMBOL ||
      apply<object, [PropertyKey], boolean>(isEnumerable, objectPrototype, [symbol])
    ) {
      count += 1
    }
    position += 1
  }
  return count
}

/** Whether `name` is one of the standard keys, by comparison and not by a lookup in a collection. */
function isStandard(name: string): boolean {
  let position = 0
  while (position < STANDARD_NAMES.length) {
    if (at(STANDARD_NAMES, position) === name) return true
    position += 1
  }
  return false
}

/**
 * The built-ins the options and the job paths call, and the globals that name them. Promise and Date
 * are left out: a library that patches them for its own scheduling must not stop the queue.
 */
const BASELINE_GLOBALS = [
  'Object',
  'Reflect',
  'Array',
  'Number',
  'String',
  'Function',
  'Symbol',
  'JSON',
  'Set',
  'Map',
  'RegExp',
  'WeakMap',
  'WeakSet',
  'Boolean',
  'BigInt',
] as const

/** One entry of the baseline: an object, one of its keys, and what the key held when this module loaded. */
interface BaselineEntry {
  readonly owner: object
  readonly key: PropertyKey
  readonly was: DescriptorFields
}

/** Add `owner` to `owners` unless it is already there. */
function addOwner(owners: object[], owner: object): void {
  let position = 0
  while (position < owners.length) {
    if (at(owners, position) === owner) return
    position += 1
  }
  owners[owners.length] = owner
}

/** `Reflect` as it was when this module loaded: the one built-in whose own keys are not all the language's. */
const languageReflect = Reflect

/**
 * What the language puts on `Reflect`. A `reflect-metadata` copy loaded later defines its own functions on
 * `Reflect` again, which is a legitimate host setup and not a replaced built-in, so only these keys are
 * baselined for it.
 */
const REFLECT_KEYS: readonly PropertyKey[] = [
  'apply',
  'construct',
  'defineProperty',
  'deleteProperty',
  'get',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'has',
  'isExtensible',
  'ownKeys',
  'preventExtensions',
  'set',
  'setPrototypeOf',
  Symbol.toStringTag,
]

/** The keys of `owner` the baseline covers: every own key, except on `Reflect`, where only the language's. */
function baselinedKeys(owner: object): readonly PropertyKey[] {
  return owner === languageReflect ? REFLECT_KEYS : ownKeys(owner)
}

/** Every baselined property of each owner, with the descriptor it has now. */
function describeOwners(owners: readonly object[]): BaselineEntry[] {
  const entries: BaselineEntry[] = []
  let position = 0
  while (position < owners.length) {
    const owner = at(owners, position)
    const keys = baselinedKeys(owner)
    let keyPosition = 0
    while (keyPosition < keys.length) {
      const key = at(keys, keyPosition)
      const descriptor = getOwnPropertyDescriptor(owner, key)
      // A function the language defines on `Reflect` that a host removed before this module loaded has
      // nothing to compare against, as an own key that was never there never did.
      if (descriptor !== undefined) {
        entries[entries.length] = { owner, key, was: copyFields(descriptor) }
      }
      keyPosition += 1
    }
    position += 1
  }
  return entries
}

/** Every own property of the built-ins above and of their prototypes, as they were at load. */
const BASELINE: readonly BaselineEntry[] = (() => {
  const owners: object[] = []
  let position = 0
  while (position < BASELINE_GLOBALS.length) {
    const constructor = (globalThis as unknown as Record<string, { prototype?: object }>)[
      at(BASELINE_GLOBALS, position)
    ]
    if (constructor !== undefined) {
      owners[owners.length] = constructor
      // `Object.prototype` is checked above, key by key, and counted there.
      if (constructor.prototype !== undefined && constructor.prototype !== objectPrototype) {
        owners[owners.length] = constructor.prototype
      }
    }
    position += 1
  }
  // The prototypes of the iterators that for-of and spread create, and the one above them: their
  // `next` is what a loop calls.
  const samples: object[] = [
    [][Symbol.iterator](),
    new Set()[Symbol.iterator](),
    new Map()[Symbol.iterator](),
    ''[Symbol.iterator](),
  ]
  position = 0
  while (position < samples.length) {
    const iterator = getPrototypeOf(at(samples, position)) as object
    addOwner(owners, iterator)
    addOwner(owners, getPrototypeOf(iterator) as object)
    position += 1
  }
  return describeOwners(owners)
})()

/** The globals that name the built-ins above, as they were at load. */
const GLOBAL_BINDINGS: readonly unknown[] = (() => {
  // Stryker disable next-line ArrayDeclaration: the only mutant on this line seeds the list with one element, and every index from zero is assigned below before the list is read, so the seed is overwritten
  const bound: unknown[] = []
  let position = 0
  while (position < BASELINE_GLOBALS.length) {
    bound[position] = (globalThis as unknown as Record<string, unknown>)[
      at(BASELINE_GLOBALS, position)
    ]
    position += 1
  }
  return bound
})()

/** How many of the built-ins, and the globals that name them, are not what they were at load. */
function replacedBuiltins(): number {
  let count = 0
  let position = 0
  while (position < BASELINE_GLOBALS.length) {
    const now = (globalThis as unknown as Record<string, unknown>)[at(BASELINE_GLOBALS, position)]
    if (now !== at(GLOBAL_BINDINGS, position)) count += 1
    position += 1
  }
  position = 0
  while (position < BASELINE.length) {
    const entry = at(BASELINE, position)
    const now = fieldsOf(getOwnPropertyDescriptor(entry.owner, entry.key))
    if (!sameFields(entry.was, now)) count += 1
    position += 1
  }
  return count
}

/** Whether the descriptor a listed key held at load is the one it holds now; a removed key is not. */
function sameFields(was: DescriptorFields, now: DescriptorFields | undefined): boolean {
  if (now === undefined) return false
  return (
    is(was.value, now.value) &&
    was.get === now.get &&
    was.set === now.set &&
    was.writable === now.writable &&
    was.enumerable === now.enumerable &&
    was.configurable === now.configurable
  )
}

/** The prototype of the promise an async function returns: the intrinsic one, whatever `constructor` says. */
const NATIVE_PROMISE_PROTOTYPE: object = getPrototypeOf(
  (async (): Promise<void> => {
    // Nothing to await: only the intrinsic promise this returns is wanted.
  })(),
) as object

/** The source of `Promise` in a fresh realm, which no host code has had a chance to replace. */
const NATIVE_PROMISE_SOURCE: string = nativeToString.call(runInNewContext('Promise'))

/**
 * Whether `candidate` is the intrinsic promise constructor: a function whose `prototype` is the
 * intrinsic promise prototype and whose source is the engine's, so a host function given that
 * prototype is not taken for it.
 */
function constructsNativePromises(candidate: unknown): candidate is PromiseConstructor {
  return (
    typeof candidate === 'function' &&
    (candidate as { prototype?: unknown }).prototype === NATIVE_PROMISE_PROTOTYPE &&
    nativeToString.call(candidate) === NATIVE_PROMISE_SOURCE
  )
}

/**
 * The intrinsic `Promise`, read from the prototype of the promise an async function returns and
 * never from the global binding, which a host may have replaced with its own class before this
 * module loaded. `await` and the promises the library builds both resolve against it, so it is the
 * one the guard watches. A host that replaced that `constructor` before load (with `Object`, say)
 * leaves nothing this module can read the intrinsic one from, so the module refuses to load: a wait
 * built on a constructor that does not build promises would never settle.
 */
export const NativePromise: PromiseConstructor = (
  NATIVE_PROMISE_PROTOTYPE as { constructor: PromiseConstructor }
).constructor

/**
 * How many of the promise defects are present: a `then` on `Array.prototype` or `Function.prototype`
 * (one on `Object.prototype` is counted with the other planted keys), which an object or array
 * resolved into a promise would call; and a `constructor` of the intrinsic promise that is not the
 * intrinsic one, which makes `await` call the `then` of the promise it is given.
 */
function promiseDefects(): number {
  let count = 0
  if (hasOwn(Array.prototype, 'then')) count += 1
  if (hasOwn(Function.prototype, 'then')) count += 1
  if (
    fieldsOf(getOwnPropertyDescriptor(NATIVE_PROMISE_PROTOTYPE, 'constructor'))?.value !==
    NativePromise
  )
    count += 1
  return count
}

/** The most distinct counts a refusal reports; a larger count is reported as this one. */
const MOST_COUNTED = 64

/**
 * The refusals, one frozen exception for each count, built when this module loads: building one at use
 * time would run live string and object built-ins and read a `message` planted on `Object.prototype`,
 * so a blinded guard would answer with an untyped error. Each is frozen with its details, so a host
 * that catches one cannot change what the next throw carries.
 */
const REFUSALS: readonly QueueException[] = ((): readonly QueueException[] => {
  const built: QueueException[] = []
  for (let count = 1; count <= MOST_COUNTED; count += 1) {
    const details = Object.freeze({
      reason: 'Object.prototype holds keys the libraries would read as their own',
      count,
    })
    const refusal = new QueueException(
      QUEUE_ERROR_CODES.INVALID_OPTIONS,
      HttpStatus.INTERNAL_SERVER_ERROR,
      details,
    )
    Object.freeze(refusal)
    built.push(refusal)
  }
  return Object.freeze(built)
})()

/** The frozen refusal that reports `count` defects. */
function refusalFor(count: number): QueueException {
  return at(REFUSALS, min(count, MOST_COUNTED) - 1)
}

if (!constructsNativePromises(NativePromise)) throw refusalFor(1)

/**
 * Refuse a native promise that carries a `constructor` of its own that is not the intrinsic one and
 * cannot be replaced: an `await` of it would read that constructor, and the `then` of the promise it
 * builds, instead of attaching directly. The refusal is the one the guard throws, with a count of one.
 *
 * @throws {QueueException} `INVALID_OPTIONS`, always.
 */
export function refuseForeignPromise(): never {
  throw refusalFor(1)
}

/**
 * Refuse while `Object.prototype` holds a string key it does not hold by default, or a standard key that
 * is not what the language gives it or not what it was when this module loaded, or while a built-in
 * the options and job paths call (or the global that names it) is not what it was when this module
 * loaded, or while a symbol key sits on `Object.prototype` (a planted `Symbol.iterator` changes how
 * objects are iterated; only the test runner's own non-enumerable key is exempt). A name added to a
 * built-in prototype after load is not counted, only a replaced or removed one, and the prototype of
 * `Buffer` is not covered; a key planted after the last check is still read by the objects built later.
 *
 * @throws {QueueException} `INVALID_OPTIONS` with the count of the keys, never a key or a value.
 */
export function assertPrototypeClean(): void {
  let count = 0
  const names = getOwnPropertyNames(objectPrototype)
  let position = 0
  while (position < names.length) {
    if (!isStandard(at(names, position))) count += 1
    position += 1
  }
  position = 0
  while (position < STANDARD_NAMES.length) {
    if (BASELINE_DEFECT[position] === true || isOverwritten(position)) count += 1
    position += 1
  }
  count += plantedSymbols()
  count += replacedBuiltins()
  count += promiseDefects()
  if (count > 0) {
    throw refusalFor(count)
  }
}

/**
 * Whether `err` is the refusal this module throws, by identity: a caller that logs a refusal tells it
 * from an ordinary failure without reading any property of it.
 */
export function isGuardRefusal(err: unknown): boolean {
  let position = 0
  while (position < REFUSALS.length) {
    if (err === at(REFUSALS, position)) return true
    position += 1
  }
  return false
}
