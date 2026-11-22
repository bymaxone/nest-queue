/**
 * @fileoverview One read of a named option of a host object that ignores what was planted on the
 * realm's root prototype. A property access walks the whole chain, so a key added to
 * `Object.prototype` (by a dependency, or by a prototype-pollution bug) answers for every object
 * that does not hold it, and `drainOnShutdown` read that way would turn the shutdown drain on for a
 * module whose consumer never set it.
 * @layer server/config
 */

/**
 * Whether `level` ends the chain of `source` without being `source`: a prototype of no prototype is
 * taken for the realm's root, and none of its properties is read to confirm it, because the root's
 * `constructor` is exactly what a polluted root can answer for. A host-built ancestor with no
 * prototype cannot be told from it, so it is not read either.
 */
function isChainEnd(level: object, source: object): boolean {
  return level !== source && Reflect.getPrototypeOf(level) === null
}

/**
 * Read `key` of `source`, once, as property access would, except that a value found only on the
 * realm's root prototype is not a value the host gave and reads as `undefined`, and neither is one
 * found only on an ancestor with no prototype. The holder alone decides that, and a holder that is
 * the root is not read at all, so a getter planted there never runs. Otherwise the key is read once,
 * as property access would: an own property, a class getter, and the answer of a Proxy whose target
 * holds nothing all count.
 *
 * @param source - The host object, or a group of options.
 * @param key - The name of the option.
 * @returns The value the host gave, or `undefined`.
 */
export function readByName(source: object, key: string): unknown {
  let holder: object | null = source
  while (holder !== null && Reflect.getOwnPropertyDescriptor(holder, key) === undefined) {
    holder = Reflect.getPrototypeOf(holder)
  }
  return holder !== null && isChainEnd(holder, source) ? undefined : Reflect.get(source, key)
}

/**
 * Copy every field of `source` that a read by name would find, once each: the own keys, symbols
 * included, and those of every ancestor below the realm's root prototype, so a getter a class
 * defines is a field of the copy, and a field the root prototype holds is not. The copy has no
 * prototype. A value that is not an object, and an array, is returned as it is.
 *
 * @param source - A host object whose fields go on to a driver, such as the options of a client.
 * @returns A plain copy with each field as an enumerable data property.
 */
export function copyFields<T>(source: T): T {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return source
  const copy: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>
  for (let level: object | null = source; level !== null && !isChainEnd(level, source);) {
    for (const key of Reflect.ownKeys(level)) {
      if (key === 'constructor' || Object.hasOwn(copy, key)) continue
      Object.defineProperty(copy, key, {
        value: Reflect.get(source, key),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    level = Reflect.getPrototypeOf(level)
  }
  return copy as T
}

/**
 * Take one named field of `source` and copy the rest, each field read once. The named field is read
 * by name, so a value planted on the root prototype is not it and a getter planted there never runs;
 * the rest is every own enumerable field, symbols included, as an ordinary data property of a copy
 * with no prototype, so a key such as `__proto__` stays a key and a getter is read once.
 *
 * @param source - The host object.
 * @param key - The field to take out of the copy.
 * @returns The value of the named field, `undefined` when the host did not give it, and the rest.
 */
export function splitField(
  source: object,
  key: string,
): { value: unknown; rest: Record<PropertyKey, unknown> } {
  const value = readByName(source, key)
  const rest = Object.create(null) as Record<PropertyKey, unknown>
  for (const own of Reflect.ownKeys(source)) {
    if (own === key || !Object.prototype.propertyIsEnumerable.call(source, own)) continue
    Object.defineProperty(rest, own, {
      value: Reflect.get(source, own),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return { value, rest }
}
