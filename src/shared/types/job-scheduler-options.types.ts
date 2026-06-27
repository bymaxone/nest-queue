/**
 * @fileoverview Discriminated union for the BullMQ Job Schedulers (recurring jobs) API.
 * @layer shared/types
 */

/**
 * Discriminated union for the BullMQ Job Schedulers API — the current
 * recurring-jobs surface (the legacy repeatable API is removed in BullMQ v6).
 * Either `pattern` (cron) OR `every` (ms interval) is provided, never both.
 *
 * A thin, validated projection of BullMQ's `RepeatOptions` minus the internal
 * scheduler `key`.
 *
 * @example Cron schedule
 * const daily: JobSchedulerRepeatOptions = { pattern: '0 3 * * *', tz: 'America/Sao_Paulo' }
 * @example Fixed interval
 * const everyMinute: JobSchedulerRepeatOptions = { every: 60_000 }
 */
export type JobSchedulerRepeatOptions =
  | {
      /** Crontab expression (5-field, or 6-field with seconds). */
      pattern: string
      /** IANA timezone (e.g. 'America/Sao_Paulo'). Default: UTC. */
      tz?: string
      /** Optional cap on the number of runs. */
      limit?: number
      /** Start time (epoch ms or ISO string). */
      startDate?: number | string
      /** Stop time (epoch ms or ISO string). Must be in the future or BullMQ throws. */
      endDate?: number | string
    }
  | {
      /** Interval in milliseconds between runs. */
      every: number
      /** Optional cap on the number of runs. */
      limit?: number
      /** Phase offset (ms) applied to interval schedulers. */
      offset?: number
      /** Start time (epoch ms or ISO string). */
      startDate?: number | string
      /** Stop time (epoch ms or ISO string). */
      endDate?: number | string
    }
