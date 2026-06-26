/**
 * @fileoverview Symbol injection tokens for the module's providers.
 * @layer server/constants
 */

/** Token for the raw, user-supplied module options. */
export const BYMAX_QUEUE_OPTIONS = Symbol('BYMAX_QUEUE_OPTIONS')

/** Token for the resolved Redis client used by the Queue role. */
export const BYMAX_QUEUE_REDIS_CLIENT = Symbol('BYMAX_QUEUE_REDIS_CLIENT')

/** Token for the resolved connection mode (`mode-a-byo` or `mode-b-owned`). */
export const BYMAX_QUEUE_CONNECTION_MODE = Symbol('BYMAX_QUEUE_CONNECTION_MODE')

/** Token for the frozen, defaults-applied module options. */
export const BYMAX_QUEUE_RESOLVED_OPTIONS = Symbol('BYMAX_QUEUE_RESOLVED_OPTIONS')
