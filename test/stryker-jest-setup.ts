/**
 * @fileoverview Stryker-only Jest setup. A mutated source file can throw in an
 * asynchronous context that settles after the triggering test has finished (for
 * example a Redis client emitting an `error` once its listener wiring is
 * mutated). Left unhandled, that would crash the long-lived mutation-test worker
 * and abort the whole run. Swallowing these post-test async errors keeps the
 * worker alive; a mutant whose only effect is such an error is reported as a
 * survivor rather than crashing the run. This setup is wired ONLY into the
 * Stryker Jest config, never the regular test runs.
 * @layer test/setup
 */

process.on('unhandledRejection', () => undefined)
process.on('uncaughtException', () => undefined)
