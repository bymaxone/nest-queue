/**
 * @fileoverview Unit tests for the `@Processor` class decorator.
 * @layer server/decorators
 */

import 'reflect-metadata'
import { Processor } from './processor.decorator'
import { PROCESSOR_METADATA_KEY } from './metadata-keys.constants'
import type { ProcessorMetadata } from '../interfaces/processor-metadata.interface'
import { DEFAULT_WORKER_CONCURRENCY } from '../constants/default-options'

describe('@Processor decorator', () => {
  it('writes ProcessorMetadata to the target class with default options', () => {
    // A class decorated with only a queue name should get default concurrency and autorun.
    @Processor('email')
    class EmailProcessor {}

    const meta = Reflect.getMetadata(PROCESSOR_METADATA_KEY, EmailProcessor) as ProcessorMetadata
    expect(meta.queueName).toBe('email')
    expect(meta.workerOptions.concurrency).toBe(DEFAULT_WORKER_CONCURRENCY)
    expect(meta.workerOptions.autorun).toBe(true)
  })

  it('sets _warnedNoConcurrency:true when concurrency is omitted', () => {
    // The decorator must flag the omission so discovery can log a warning.
    @Processor('email')
    class EmailProcessor {}

    const meta = Reflect.getMetadata(PROCESSOR_METADATA_KEY, EmailProcessor) as ProcessorMetadata
    expect(meta._warnedNoConcurrency).toBe(true)
  })

  it('does NOT set _warnedNoConcurrency when concurrency is explicit', () => {
    // Explicit concurrency means no warning is needed at discovery time.
    @Processor('email', { concurrency: 5 })
    class EmailProcessor {}

    const meta = Reflect.getMetadata(PROCESSOR_METADATA_KEY, EmailProcessor) as ProcessorMetadata
    expect(meta._warnedNoConcurrency).toBeUndefined()
  })

  it('merges explicit workerOptions into the defaults', () => {
    // Caller overrides should overwrite defaults but autorun should remain true.
    @Processor('email', { concurrency: 10, autorun: false })
    class EmailProcessor {}

    const meta = Reflect.getMetadata(PROCESSOR_METADATA_KEY, EmailProcessor) as ProcessorMetadata
    expect(meta.workerOptions.concurrency).toBe(10)
    expect(meta.workerOptions.autorun).toBe(false)
  })

  it('stores the correct queueName in metadata', () => {
    // Each decorator call is tied to the queue name supplied by the caller.
    @Processor('sms')
    class SmsProcessor {}

    const meta = Reflect.getMetadata(PROCESSOR_METADATA_KEY, SmsProcessor) as ProcessorMetadata
    expect(meta.queueName).toBe('sms')
  })

  it('stores limiter options when provided', () => {
    // Limiter options must be forwarded verbatim to BullMQ.
    @Processor('throttled', { limiter: { max: 5, duration: 1000 } })
    class ThrottledProcessor {}

    const meta = Reflect.getMetadata(
      PROCESSOR_METADATA_KEY,
      ThrottledProcessor,
    ) as ProcessorMetadata
    expect(meta.workerOptions.limiter).toEqual({ max: 5, duration: 1000 })
  })
})
