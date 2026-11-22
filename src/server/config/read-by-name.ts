/**
 * @fileoverview One read of a named option of a host object that ignores what was planted on the
 * realm's root prototype. A property access walks the whole chain, so a key added to
 * `Object.prototype` (by a dependency, or by a prototype-pollution bug) answers for every object
 * that does not hold it, and `drainOnShutdown` read that way would turn the shutdown drain on for a
 * module whose consumer never set it.
 * @layer server/config
 */

/**
 * Whether `level` is the root prototype of its realm: it has no prototype of its own, and it is the
 * `prototype` of its own `constructor`. A host-built ancestor made with no prototype holds no such
 * constructor, so it is a level of the host's chain and is read, and the root of another realm
 * (another `vm` context, a driver's own copy of `Object`) is recognised the same way.
 */
function isRealmRoot(level: object): boolean {
  if (Reflect.getPrototypeOf(level) !== null) return false
  const constructorOfLevel: unknown = Object.hasOwn(level, 'constructor')
    ? Reflect.get(level, 'constructor')
    : undefined
  return (
    typeof constructorOfLevel === 'function' &&
    (constructorOfLevel as { prototype?: unknown }).prototype === level
  )
}

/**
 * Read `key` of `source`, once, as property access would, except that a value found only on the
 * realm's root prototype is not a value the host gave and reads as `undefined`. An own property, a
 * class getter and an ancestor the host built all count, and so does the answer of a Proxy whose
 * target holds nothing, which no descriptor lookup can see.
 *
 * @param source - The host object, or a group of options.
 * @param key - The name of the option.
 * @returns The value the host gave, or `undefined`.
 */
export function readByName(source: object, key: string): unknown {
  let level: object | null = source
  while (level !== null && !isRealmRoot(level)) {
    if (Object.hasOwn(level, key)) return Reflect.get(source, key)
    level = Reflect.getPrototypeOf(level)
  }
  const value: unknown = Reflect.get(source, key)
  const planted = level !== null && Object.hasOwn(level, key) && Reflect.get(level, key) === value
  return planted ? undefined : value
}
